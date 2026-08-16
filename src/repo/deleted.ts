import type { DB } from "../db/sqlite.ts";

// Deleted-article archive: the mirror keeps soft-deleted articles (content and
// pushes preserved). This surfaces them — PTT removes deleted articles from
// the live site, so this page is the only record.

export interface DeletedArticle {
  articleId: number;
  boardName: string;
  urlId: string;
  title: string;
  author: string | null;
  postedAt: number | null;
  deletedAt: number | null;
  netCount: number;
  pushCount: number;
  booCount: number;
  contentExcerpt: string;
  tldr: string | null;
}

export function listDeletedArticles(db: DB, limit = 100): DeletedArticle[] {
  const rows = db
    .prepare(
      `SELECT a.id, b.name AS board, a.url_id, a.title, a.author, a.posted_at, a.deleted_at,
              a.net_count, a.push_count, a.boo_count, a.content, ai.tldr
       FROM articles a
       JOIN boards b ON b.id = a.board_id
       LEFT JOIN article_insights ai ON ai.article_id = a.id AND ai.error IS NULL
       WHERE a.deleted_at IS NOT NULL AND a.deleted_at > 0
       ORDER BY a.deleted_at DESC
       LIMIT ?`,
    )
    .all(limit) as {
      id: number; board: string; url_id: string; title: string; author: string | null;
      posted_at: number | null; deleted_at: number | null; net_count: number;
      push_count: number; boo_count: number; content: string | null; tldr: string | null;
    }[];
  return rows.map((r) => ({
    articleId: r.id,
    boardName: r.board,
    urlId: r.url_id,
    title: r.title,
    author: r.author,
    postedAt: r.posted_at,
    deletedAt: r.deleted_at,
    netCount: r.net_count,
    pushCount: r.push_count,
    booCount: r.boo_count,
    contentExcerpt: (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    tldr: r.tldr,
  }));
}
