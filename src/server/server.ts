import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../db/sqlite.ts";
import * as repo from "../repo/articles.ts";
import { listDeletedArticles } from "../repo/deleted.ts";
import { insightStats } from "../repo/insights.ts";
import type { HotBoardsCache } from "../crawler/ptt/hotboards.ts";
import { parseIndexSlug, totalPages } from "../views/helpers.ts";
import { hotBoardsPage, boardNotCollectedPage } from "../views/ptt.ts";
import { pttBoardPage } from "../views/board.ts";
import { pttArticlePage } from "../views/article.ts";
import { searchPage } from "../views/search.ts";
import { entityPage } from "../views/entity.ts";
import { deletedPage } from "../views/deleted.ts";
import { digestPage } from "../views/digest.ts";
import { listDigests } from "../repo/digests.ts";
import { trendsPage, risingPage } from "../views/trends.ts";
import { trendingEntities, risingArticles, velocityCalibration } from "../repo/trends.ts";
import { listArticlesByAuthor, authorStats } from "../repo/authors.ts";
import { listPushesByUser, pushStats } from "../repo/authors.ts";
import { userPage } from "../views/user.ts";
import { searchEntities, entityTimeline, entityArticles } from "../repo/entities.ts";
import { boardsListPage } from "../views/pages.ts";

const APP_CSS = readFileSync(join(import.meta.dir, "app.css"), "utf-8");

export interface ServerOptions {
  db: DB;
  pageSize: number;
  hot: HotBoardsCache;
  minNet?: number; // WORKER_MIN_NET — keeps /healthz "total" consistent with the worker's claim threshold
  deletedToken?: string; // DELETED_ARCHIVE_TOKEN — when set, /deleted requires ?token=; unset → 404 (not a public feature: respect PTT deletion authority)
}

const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=30" },
  });

const notFound = (): Response => html("not found", 404);

export function createServer(opts: ServerOptions) {
  let navBoards: repo.Board[] = [];
  const refreshNav = () => {
    try {
      navBoards = repo.listBoards(opts.db, 5);
      console.log(`loaded boards for nav (count=${navBoards.length})`);
    } catch (e) {
      console.warn("list boards for nav:", e);
    }
  };
  refreshNav();
  const navTimer = setInterval(refreshNav, 300_000);
  navTimer.unref?.();

  function safeDecode(s: string): string {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // -- static --
      if (path === "/static/app.css") {
        return new Response(APP_CSS, {
          headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600" },
        });
      }

      // -- hot boards (PTT clone homepage) --
      if (path === "/" || path === "/bbs/hotboards.html") {
        try {
          const boards = await opts.hot.get(req.signal);
          return html(hotBoardsPage(boards));
        } catch (e) {
          console.error("fetch hot boards:", e);
          return html("hot boards unavailable", 503);
        }
      }

      // -- entity search --
      if (path === "/search") {
        const q = url.searchParams.get("q")?.trim() ?? "";
        return html(searchPage(q, searchEntities(opts.db, q, 30)));
      }
      if (path === "/deleted") {
        // Internal archive only: requires a token and is unreachable when the
        // token is unset (deleted content is preserved in the mirror, but not
        // republished — PTT authors/moderators hold the deletion authority).
        const token = opts.deletedToken ?? "";
        if (token === "" || url.searchParams.get("token") !== token) return notFound();
        return html(deletedPage(listDeletedArticles(opts.db, 200)));
      }      if (path === "/digest") {
        return html(digestPage(listDigests(opts.db)));
      }
      if (path === "/trends") {
        return html(trendsPage(trendingEntities(opts.db, 30)));
      }
      if (path === "/rising") {
        return html(risingPage(risingArticles(opts.db, 12, 30), velocityCalibration(opts.db, 10)));
      }
      const user = path.match(/^\/u\/([^/]+)$/);
      if (user) {
        const author = safeDecode(user[1]!);
        const stats = authorStats(opts.db, author);
        const pstats = pushStats(opts.db, author);
        if (stats.total === 0 && pstats.total === 0) return html(userPage(author, stats, [], pstats, []), 404);
        return html(
          userPage(author, stats, listArticlesByAuthor(opts.db, author, 50), pstats, listPushesByUser(opts.db, author, 50)),
        );
      }      const ent = path.match(/^\/e\/([^/]+)$/);
      if (ent) {
        const raw = safeDecode(ent[1]!);
        const hits = searchEntities(opts.db, raw, 1);
        const timeline = entityTimeline(opts.db, raw, 60);
        const articles = entityArticles(opts.db, raw, 50);
        if (hits.length === 0 && timeline.length === 0 && articles.length === 0) {
          return html(searchPage(raw, []), 404);
        }
        return html(entityPage(hits[0]?.name ?? raw, hits[0]?.kind ?? "其他", timeline, articles));
      }

      // -- /bbs/{board}/{slug}: PTT-shape URLs --
      const bbs = path.match(/^\/bbs\/([^/]+)\/([^/]+)$/);
      if (bbs) {
        const boardName = bbs[1]!;
        const slug = bbs[2]!;
        if (slug === "index.html") {
          return renderBoard(opts, boardName, 1);
        }
        const n = parseIndexSlug(slug);
        if (n !== null) {
          const board = repo.getBoardByName(opts.db, boardName);
          if (!board) return notCollected(boardName);
          const total = totalPages(board.articleCount, opts.pageSize);
          const page = total - n + 1;
          if (page < 1 || n < 1) return notFound();
          return renderBoard(opts, boardName, page);
        }
        if (slug.endsWith(".html")) {
          const urlId = slug.slice(0, -5);
          const d = repo.getArticleByURLID(opts.db, boardName, urlId);
          if (!d) return notFound();
          return html(pttArticlePage(d));
        }
        return notFound();
      }

      // -- /b/{board} --
      const b = path.match(/^\/b\/([^/]+)$/);
      if (b) {
        return renderBoard(opts, b[1]!, parsePage(url));
      }

      // -- /a/{id} (DB id alias) --
      const a = path.match(/^\/a\/(\d+)$/);
      if (a) {
        const d = repo.getArticle(opts.db, Number(a[1]));
        if (!d) return notFound();
        return html(pttArticlePage(d));
      }

      // -- /boards (legacy light list) --
      if (path === "/boards") {
        const boards = repo.listBoards(opts.db, 1);
        return html(boardsListPage(boards, navBoards));
      }

      // -- /healthz --
      if (path === "/healthz") {
        const stats = insightStats(opts.db, opts.minNet ?? 20);
        return new Response(`{"status":"ok","analyzed":${stats.analyzed},"total":${stats.total}}`, {
          headers: { "Content-Type": "application/json" },
        });
      }

      return notFound();
    } catch (e) {
      console.error(`handle ${path}:`, e);
      return html("internal error", 500);
    }
  }

  // Wrap every response with the per-path cache policy (single choke point).
  const cachedHandler = (req: Request): Response | Promise<Response> => {
    const path = new URL(req.url).pathname;
    const res = handler(req);
    const apply = (r: Response): Response => {
      try {
        r.headers.set("Cache-Control", cacheFor(path));
      } catch {
        /* immutable response — keep its own headers */
      }
      return r;
    };
    return res instanceof Promise ? res.then(apply) : apply(res);
  };

  return { handler: cachedHandler, stop: () => clearInterval(navTimer) };
}

function parsePage(url: URL): number {
  const p = Number(url.searchParams.get("page"));
  return Number.isInteger(p) && p >= 1 ? p : 1;
}

// Per-path edge-cache policy (Cloudflare respects s-maxage; stale-while-
// revalidate keeps a page served while refreshing). Private/internal pages
// never cache. See docs/SPEC.md 任務 9.17.
function cacheFor(path: string): string {
  if (path === "/healthz" || path.startsWith("/deleted")) return "no-store";
  if (path.startsWith("/static/")) return "public, max-age=3600";
  if (path === "/" || path === "/bbs/hotboards.html") return "public, s-maxage=300, stale-while-revalidate=600";
  if (path === "/digest") return "public, s-maxage=3600";
  if (path === "/trends") return "public, s-maxage=600";
  if (path === "/rising") return "public, s-maxage=60";
  if (path.startsWith("/search") || path.startsWith("/e/")) return "public, s-maxage=600";
  if (path.startsWith("/u/")) return "public, s-maxage=300";
  const m = path.match(/^\/bbs\/[^/]+\/index\.html$/);
  if (m) return "public, s-maxage=60, stale-while-revalidate=120";
  if (/^\/bbs\/[^/]+\/[^/]+\.html$/.test(path)) return "public, s-maxage=300, stale-while-revalidate=600";
  return "public, max-age=30";
}

function renderBoard(opts: ServerOptions, boardName: string, page: number): Response {
  const board = repo.getBoardByName(opts.db, boardName);
  if (!board) return notCollected(boardName);
  const p = page < 1 ? 1 : page;
  const total = totalPages(board.articleCount, opts.pageSize);
  if (p > total) return notFound();
  const articles = repo.listBoardArticles(opts.db, board.id, opts.pageSize, (p - 1) * opts.pageSize);
  return html(pttBoardPage(board, articles, p, total));
}

function notCollected(boardName: string): Response {
  return html(boardNotCollectedPage(boardName));
}
