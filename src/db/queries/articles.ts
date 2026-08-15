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
  // ON CONFLICT updates content + push counts; preserves first_seen_at,
  // posted_at, mark, and deleted_at.
  insertArticle(p: InsertArticleParams): Article;
  getArticleByBoardUrlID(boardId: number, urlId: string): Article | null;
  updateArticleFromIndex(boardId: number, urlId: string, nrecRaw: string | null, mark: string | null): void;
  markArticleDeleted(boardId: number, urlId: string): void;
  // Stored articles newer than the fetched index page's oldest entry but absent
  // from it — deletion candidates (they cannot have scrolled off: scrolling makes
  // an article OLDER than the page's oldest entry).
  findVanishedArticles(boardId: number, urlTimestamp: number, present: string[]): { id: number; urlId: string }[];
  countArticlesByBoard(boardId: number): number;
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
             last_fetched_at = excluded.last_fetched_at
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
  };
}
