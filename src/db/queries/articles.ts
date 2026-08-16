import type { DB } from "../sqlite.ts";
import { nowSecs } from "../sqlite.ts";
import { toArticle, placeholders, type Article, type ArticleRow } from "../types.ts";

export interface InsertArticleParams {
  boardId: number;
  urlId: string;
  urlTimestamp: number | null;
  postedAt: number | null;
  title: string | null;
  author: string | null;
  content: string | null;
  ip: string | null;
  mark: string | null;
  nrecRaw: string | null;
  pushCount: number | null;
  booCount: number | null;
  neutralCount: number | null;
  netCount: number | null;
}

export interface ArticleQueries {
  // Insert new article or update on re-fetch (push update).
  // ON CONFLICT updates content + push counts and CLEARS deleted_at (a
  // successful crawl is direct evidence the article exists on PTT);
  // preserves first_seen_at, posted_at, and mark.
  insertArticle(p: InsertArticleParams): Article;
  getArticleByBoardUrlID(boardId: number, urlId: string): Article | null;
  updateArticleFromIndex(boardId: number, urlId: string, nrecRaw: string | null, mark: string | null): void;
  markArticleDeleted(boardId: number, urlId: string): void;
  // Undo a soft deletion — used when an article reappears on a live index page.
  resurrectArticle(boardId: number, urlId: string): void;
  // Stored articles newer than the fetched index page's oldest entry but absent
  // from it — deletion candidates (they cannot have scrolled off: scrolling makes
  // an article OLDER than the page's oldest entry).
  findVanishedArticles(boardId: number, urlTimestamp: number, present: string[]): { id: number; urlId: string }[];
  countArticlesByBoard(boardId: number): number;
  // Deletion-audit support: pick soft-deleted articles in the audit window
  // (deleted long enough ago for a meaningful re-check, recently enough to
  // still matter) that have not been audited yet.
  listUnauditedDeletions(
    minAgeSecs: number,
    maxAgeSecs: number,
    limit: number,
  ): { boardId: number; urlId: string; boardName: string }[];
  // Record the audit outcome; PK (board_id, url_id) makes it once-per-article.
  recordDeletionAudit(boardId: number, urlId: string, result: "gone" | "alive"): void;
}

export function createArticleQueries(db: DB): ArticleQueries {
  return {
    insertArticle(p: InsertArticleParams): Article {
      const row = db
        .prepare(
          `INSERT INTO articles (
             board_id, url_id, url_timestamp, posted_at,
             title, author, content, ip, mark,
             nrec_raw, push_count, boo_count, neutral_count, net_count,
             last_fetched_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (board_id, url_id) DO UPDATE SET
             title         = excluded.title,
             author        = excluded.author,
             content       = excluded.content,
             ip            = excluded.ip,
             nrec_raw      = excluded.nrec_raw,
             push_count    = excluded.push_count,
             boo_count     = excluded.boo_count,
             neutral_count = excluded.neutral_count,
             net_count     = excluded.net_count,
             last_fetched_at = excluded.last_fetched_at,
             -- A successful crawl fetched the article page = it exists on PTT.
             -- Undo any (possibly false-positive) vanish mark; deep-page
             -- articles otherwise have no resurrection path at all.
             deleted_at    = NULL
           RETURNING *`,
        )
        .get(
          p.boardId,
          p.urlId,
          p.urlTimestamp,
          p.postedAt,
          p.title,
          p.author,
          p.content,
          p.ip,
          p.mark,
          p.nrecRaw,
          p.pushCount,
          p.booCount,
          p.neutralCount,
          p.netCount,
          nowSecs(),
        ) as ArticleRow;
      return toArticle(row);
    },

    getArticleByBoardUrlID(boardId: number, urlId: string): Article | null {
      const row = db
        .prepare(`SELECT * FROM articles WHERE board_id = ? AND url_id = ?`)
        .get(boardId, urlId) as ArticleRow | undefined;
      return row ? toArticle(row) : null;
    },

    updateArticleFromIndex(
      boardId: number,
      urlId: string,
      nrecRaw: string | null,
      mark: string | null,
    ): void {
      db.prepare(
        `UPDATE articles SET nrec_raw = ?, mark = ? WHERE board_id = ? AND url_id = ?`,
      ).run(nrecRaw, mark, boardId, urlId);
    },

    markArticleDeleted(boardId: number, urlId: string): void {
      db.prepare(
        `UPDATE articles SET deleted_at = ? WHERE board_id = ? AND url_id = ? AND deleted_at IS NULL`,
      ).run(nowSecs(), boardId, urlId);
    },

    // Undo a soft deletion — used when an article reappears on a live index
    // page (direct evidence it exists on PTT; earlier vanish marks may have
    // been false positives from anomalous snapshots).
    resurrectArticle(boardId: number, urlId: string): void {
      db.prepare(
        `UPDATE articles SET deleted_at = NULL WHERE board_id = ? AND url_id = ? AND deleted_at IS NOT NULL`,
      ).run(boardId, urlId);
    },

    findVanishedArticles(
      boardId: number,
      urlTimestamp: number,
      present: string[],
    ): { id: number; urlId: string }[] {
      const notIn =
        present.length > 0 ? `AND url_id NOT IN (${placeholders(present.length)})` : "";
      const rows = db
        .prepare(
          `SELECT id, url_id FROM articles
           WHERE board_id = ?
             AND deleted_at IS NULL
             AND url_timestamp IS NOT NULL
             AND url_timestamp > ?
             ${notIn}`,
        )
        .all(boardId, urlTimestamp, ...present) as { id: number; url_id: string }[];
      return rows.map((r) => ({ id: r.id, urlId: r.url_id }));
    },

    countArticlesByBoard(boardId: number): number {
      return (db.prepare(`SELECT count(*) AS c FROM articles WHERE board_id = ?`).get(boardId) as { c: number }).c;
    },

    listUnauditedDeletions(
      minAgeSecs: number,
      maxAgeSecs: number,
      limit: number,
    ): { boardId: number; urlId: string; boardName: string }[] {
      return db
        .prepare(
          `SELECT a.board_id AS boardId, a.url_id AS urlId, b.name AS boardName
             FROM articles a JOIN boards b ON b.id = a.board_id
            WHERE a.deleted_at IS NOT NULL
              AND a.deleted_at <= unixepoch() - ?
              AND a.deleted_at >= unixepoch() - ?
              AND NOT EXISTS (
                    SELECT 1 FROM deletion_audits x
                     WHERE x.board_id = a.board_id AND x.url_id = a.url_id)
            ORDER BY a.deleted_at DESC
            LIMIT ?`,
        )
        .all(minAgeSecs, maxAgeSecs, limit) as { boardId: number; urlId: string; boardName: string }[];
    },

    recordDeletionAudit(boardId: number, urlId: string, result: "gone" | "alive"): void {
      db.prepare(
        `INSERT OR REPLACE INTO deletion_audits (board_id, url_id, checked_at, result)
         VALUES (?, ?, ?, ?)`,
      ).run(boardId, urlId, nowSecs(), result);
    },
  };
}
