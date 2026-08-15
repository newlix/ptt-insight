import { Fetcher, NotFoundError } from "../ptt/fetcher.ts";
import { parseIndexPage } from "../ptt/index_parser.ts";
import { parseArticlePage } from "../ptt/article_parser.ts";
import type { Board } from "../../db/types.ts";
import type { Store } from "../../db/store.ts";
import type { IndexEntry } from "../ptt/types.ts";
import { urlIdTimestamp } from "../ptt/url.ts";
import { buildArticleParams, buildPushParams, articleURL } from "./store.ts";
import { sleepSecs, isAborted, mapLimit } from "./util.ts";

// backfillBoard crawls a single board's history backward from newest to oldest page.
// If batchPages > 0, only crawls that many pages before returning (breadth-first).
// If batchPages <= 0, crawls the entire board (depth-first).
// If windowBottom (epoch seconds) is non-zero, stops once a page's oldest regular
// article is older than the boundary — the global sweep window (see runBackfillWorker).
// Records progress in last_backfill_page so restarts resume without re-crawling.
export async function backfillBoard(
  fetcher: Fetcher,
  store: Store,
  board: Board,
  batchPages: number,
  windowBottom: number,
  signal?: AbortSignal,
  concurrency = 1,
): Promise<void> {
  console.log(`backfill start: ${board.name} (from page ${board.lastBackfillPage})`);

  // Determine latest page index
  let latestPage = board.latestPageIndex ?? 0;
  if (latestPage === 0) {
    // Fetch index.html to discover latest page number
    const html = await fetcher.fetchIndexPage(board.name, 0, signal);
    ({ maxPageIndex: latestPage } = parseIndexPage(html));
  }

  // Resume point: last_backfill_page - 1 (next uncrawled page)
  // Default (1) means not started → begin from latest
  let startPage = board.lastBackfillPage - 1;
  if (startPage < 1 || startPage > latestPage) {
    startPage = latestPage;
  }

  // Calculate end page for this batch (breadth-first)
  let endPage = 1;
  if (batchPages > 0 && startPage - batchPages + 1 > 1) {
    endPage = startPage - batchPages + 1;
  }

  let pagesCrawled = 0;
  let articlesNew = 0;
  let pushesUpdated = 0;
  let errorsCount = 0;
  let runStatus = "completed";

  const run = store.createCrawlRun(board.id, "backfill");
  try {
    let reachedBoundary = false;
    for (let page = startPage; page >= endPage; page--) {
      if (signal?.aborted) {
        runStatus = "failed";
        return;
      }

      let entries: IndexEntry[];
      try {
        const html = await fetcher.fetchIndexPage(board.name, page, signal);
        ({ entries } = parseIndexPage(html));
      } catch (e) {
        if (!isAborted(e, signal)) console.error(`backfill ${board.name} page ${page}:`, e);
        errorsCount++;
        continue;
      }
      pagesCrawled++;

      const todo = entries.filter((e) => !e.deleted && e.urlId !== "");
      await mapLimit(
        todo,
        concurrency,
        async (entry) => {
          const { stored, pushCount } = await processArticle(fetcher, store, board, entry, signal);
          if (stored) {
            articlesNew++;
            pushesUpdated += pushCount;
          } else {
            errorsCount++;
          }
        },
        signal,
      );

      store.updateBackfillProgress(board.id, page, latestPage);

      // Window sweep: track contiguous coverage; when the oldest regular article
      // on this page predates the boundary, everything below is older — stop.
      const oldest = oldestTimestamp(entries);
      if (oldest > 0) {
        store.setWindowFloor(board.id, oldest);
        if (windowBottom > 0 && oldest < windowBottom) {
          reachedBoundary = true;
          store.releaseBackfillClaim(board.id);
          console.log(
            `backfill window boundary: ${board.name} reached ${new Date(windowBottom * 1000).toISOString().slice(0, 10)} at page ${page}`,
          );
          break;
        }
      }
    }

    if (!reachedBoundary) {
      if (endPage <= 1) {
        store.completeBackfill(board.id);
        console.log(`backfill done: ${board.name} (${pagesCrawled} pages, ${articlesNew} articles)`);
      } else {
        console.log(
          `backfill batch: ${board.name} (${pagesCrawled} pages, ${articlesNew} articles), paused at page ${endPage}`,
        );
      }
    }
  } finally {
    store.finishCrawlRun({
      id: run.id,
      status: runStatus,
      pagesCrawled,
      articlesNew,
      articlesUpdated: 0,
      pushesUpdated,
      errors: errorsCount,
    });
  }
}

// oldestTimestamp returns the oldest URL-timestamp among regular articles on a
// page (epoch seconds, 0 when none). Pinned posts (mark "!") repeat on every
// page and are skipped; deleted entries and entries without timestamps are ignored.
export function oldestTimestamp(entries: IndexEntry[]): number {
  let oldest = 0;
  for (const e of entries) {
    if (e.deleted || e.mark === "!") continue;
    const ts = urlIdTimestamp(e.urlId);
    if (ts === null) continue;
    if (oldest === 0 || ts < oldest) oldest = ts;
  }
  return oldest;
}

// releaseOrphanedClaims clears every backfill claim at startup. This service
// is the only backfill writer, so any claim present at boot was orphaned by
// the previous process's death (SIGTERM mid-batch) — without this, those
// boards stay excluded for 6h and backfill stalls after every restart.
export function releaseOrphanedClaims(store: Store): number {
  return store.releaseAllBackfillClaims();
}

// runBackfillWorker is a single backfill worker that atomically claims boards.
// Multiple workers can run concurrently — the claim transaction serializes
// access (SQLite single-writer; PG used FOR UPDATE SKIP LOCKED).
// batchPages > 0 enables breadth-first (process N pages per board, then move on).
// windowStepSeconds > 0 enables the globally-sequenced window sweep: hot boards
// first; every hot board must reach the current window boundary (window_bottom)
// before any board continues into the next window (boundary -= windowStepSeconds).
// Runs until the signal aborts or no boards remain.
export async function runBackfillWorker(
  fetcher: Fetcher,
  store: Store,
  batchPages: number,
  windowStepSeconds: number,
  signal?: AbortSignal,
  concurrency = 1,
): Promise<void> {
  let idleLoggedAt = 0;
  for (;;) {
    if (signal?.aborted) return;

    const board = store.claimBackfillBoard();
    if (!board) {
      // Nothing claimable — maybe every hot board is waiting at the boundary.
      // Try to advance the sweep window (no-op when boards are still mid-window).
      if (windowStepSeconds > 0) {
        const newBottom = store.advanceBackfillWindow(windowStepSeconds);
        if (newBottom !== null) {
          console.log(`backfill window advanced to ${new Date(newBottom * 1000).toISOString().slice(0, 10)}`);
          continue;
        }
      }
      if (idleLoggedAt === 0 || Date.now() - idleLoggedAt > 10 * 60_000) {
        idleLoggedAt = Date.now();
        console.log("backfill idle: no claimable board (all in-window boards claimed or at boundary)");
      }
      if (!(await sleepSecs(60, signal))) return;
      continue;
    }
    idleLoggedAt = 0;

    const windowBottom = store.getBackfillWindow() ?? 0; // sweep meta missing — fall back to ungated
    try {
      await backfillBoard(fetcher, store, board, batchPages, windowBottom, signal, concurrency);
    } catch (e) {
      if (signal?.aborted) return;
      if (!isAborted(e, signal)) console.error(`backfill ${board.name} failed:`, e);
    }
  }
}

// processArticle fetches and stores a single article (shared by backfill + incremental).
// Returns { stored, pushCount } so callers can track stats.
export async function processArticle(
  fetcher: Fetcher,
  store: Store,
  board: Board,
  entry: IndexEntry,
  signal?: AbortSignal,
): Promise<{ stored: boolean; pushCount: number }> {
  let html: string;
  try {
    html = await fetcher.fetchArticlePage(board.name, entry.urlId, signal);
  } catch (e) {
    if (e instanceof NotFoundError) {
      store.markArticleDeleted(board.id, entry.urlId);
      return { stored: false, pushCount: 0 };
    }
    if (!isAborted(e, signal)) console.error(`fetch article ${board.name}/${entry.urlId}:`, e);
    return { stored: false, pushCount: 0 };
  }

  let article;
  try {
    article = parseArticlePage(html, articleURL(board.name, entry.urlId));
  } catch (e) {
    console.error(`parse article ${board.name}/${entry.urlId}:`, e);
    return { stored: false, pushCount: 0 };
  }

  const result = store.insertArticle(buildArticleParams(board.id, entry, article));

  // Always delete + re-insert pushes (handles upsert + pinned articles appearing on multiple pages)
  store.deletePushesByArticle(result.id);
  if (article.pushes.length > 0) {
    store.insertPushes(buildPushParams(result.id, article.pushes));
  }
  return { stored: true, pushCount: article.pushes.length };
}

// nrecChanged checks if the stored nrec_raw differs from the index page entry.
export function nrecChanged(stored: string | null, entry: IndexEntry): boolean {
  if (stored === null) {
    return entry.nrecRaw !== "";
  }
  return stored !== entry.nrecRaw;
}

// updateArticlePushes re-fetches an article and updates its pushes.
export async function updateArticlePushes(
  fetcher: Fetcher,
  store: Store,
  board: Board,
  entry: IndexEntry,
  signal?: AbortSignal,
): Promise<void> {
  let html: string;
  try {
    html = await fetcher.fetchArticlePage(board.name, entry.urlId, signal);
  } catch (e) {
    if (e instanceof NotFoundError) {
      store.markArticleDeleted(board.id, entry.urlId);
      return;
    }
    if (!isAborted(e, signal)) console.error(`refetch article ${board.name}/${entry.urlId}:`, e);
    return;
  }

  let article;
  try {
    article = parseArticlePage(html, articleURL(board.name, entry.urlId));
  } catch (e) {
    console.error(`reparse article ${board.name}/${entry.urlId}:`, e);
    return;
  }

  // Upsert article (updates content + push counts)
  const result = store.insertArticle(buildArticleParams(board.id, entry, article));

  // Delete + re-insert pushes
  store.deletePushesByArticle(result.id);
  if (article.pushes.length > 0) {
    store.insertPushes(buildPushParams(result.id, article.pushes));
  }
}

// updateNrecOnly updates just the nrec_raw from the index page (no full fetch).
export function updateNrecOnly(store: Store, boardId: number, entry: IndexEntry): void {
  store.updateArticleFromIndex(boardId, entry.urlId, emptyToNull(entry.nrecRaw), emptyToNull(entry.mark));
}

function emptyToNull(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}
