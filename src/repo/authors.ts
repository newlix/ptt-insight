import type { DB } from "../db/sqlite.ts";

// Per-author article listing across hot boards (PTT IDs are public on every
// post — this mirrors PTT's own 作者查詢, extended cross-board).

export interface AuthorArticle {
  articleId: number;
  boardName: string;
  urlId: string;
  title: string;
  postedAt: number | null;
  netCount: number;
  pushCount: number;
  booCount: number;
  tldr: string | null;
}

export function listArticlesByAuthor(db: DB, author: string, limit = 50): AuthorArticle[] {
  const rows = db
    .prepare(
      `SELECT a.id, b.name AS board, a.url_id, COALESCE(a.title, '(無標題)') AS title,
              a.posted_at, a.net_count, a.push_count, a.boo_count, ai.tldr
       FROM articles a
       JOIN boards b ON b.id = a.board_id
       LEFT JOIN article_insights ai ON ai.article_id = a.id AND ai.error IS NULL
       WHERE a.author = ? AND b.is_hot = 1 AND a.deleted_at IS NULL
       ORDER BY a.posted_at DESC
       LIMIT ?`,
    )
    .all(author, limit) as {
    id: number; board: string; url_id: string; title: string; posted_at: number | null;
    net_count: number; push_count: number; boo_count: number; tldr: string | null;
  }[];
  return rows.map((r) => ({
    articleId: r.id,
    boardName: r.board,
    urlId: r.url_id,
    title: r.title,
    postedAt: r.posted_at,
    netCount: r.net_count,
    pushCount: r.push_count,
    booCount: r.boo_count,
    tldr: r.tldr,
  }));
}

export function authorStats(db: DB, author: string): { boards: number; total: number; netSum: number } {
  const r = db
    .prepare(
      `SELECT COUNT(DISTINCT a.board_id) AS boards, COUNT(*) AS total, COALESCE(SUM(a.net_count), 0) AS net_sum
       FROM articles a JOIN boards b ON b.id = a.board_id
       WHERE a.author = ? AND b.is_hot = 1 AND a.deleted_at IS NULL`,
    )
    .get(author) as { boards: number; total: number; net_sum: number };
  return { boards: r.boards, total: r.total, netSum: r.net_sum };
}
