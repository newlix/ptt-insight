import type { DB } from "../db/sqlite.ts";

// Read-side types over the crawler's tables (epoch-seconds timestamps).

export interface ArticleCard {
  id: number;
  boardId: number;
  boardName: string;
  urlId: string;
  title: string;
  author: string | null;
  postedAt: number | null;
  netCount: number | null;
  pushCount: number | null;
  booCount: number | null;
  nrecRaw: string | null;
  mark: string | null;
  contentLen: number;

  hasInsight: boolean;
  tldr: string | null;
  communityTake: string | null;
  sentiment: string | null;
  controversy: string | null;
  tags: string[];
}

export interface Push {
  seq: number;
  tag: string;
  userId: string;
  content: string | null;
  ipDatetime: string | null;
}

export interface ArticleDetail extends ArticleCard {
  content: string | null;
  ip: string | null;
  keyPoints: string | null;
  topComments: string | null;
  model: string | null;
  insightGeneratedAt: number | null;
  pushes: Push[];
}

export interface Board {
  id: number;
  name: string;
  title: string | null;
  userCount: number | null;
  articleCount: number;
}

interface CardRow {
  id: number;
  board_id: number;
  name: string;
  url_id: string;
  title: string;
  author: string | null;
  posted_at: number | null;
  net_count: number | null;
  push_count: number | null;
  boo_count: number | null;
  nrec_raw: string | null;
  mark: string | null;
  content_len: number;
  has_insight: number;
  tldr: string | null;
  community_take: string | null;
  sentiment: string | null;
  controversy: string | null;
  tags: string | null;
}

const CARD_COLS = `
  a.id, a.board_id, b.name, a.url_id,
  COALESCE(a.title, '(無標題)') AS title, a.author, a.posted_at,
  a.net_count, a.push_count, a.boo_count, a.nrec_raw, a.mark,
  COALESCE(length(a.content), 0) AS content_len`;

const INSIGHT_COLS = `
  (ai.id IS NOT NULL) AS has_insight, ai.tldr, ai.community_take, ai.sentiment, ai.controversy, ai.tags`;

function toCard(r: CardRow): ArticleCard {
  return {
    id: r.id,
    boardId: r.board_id,
    boardName: r.name,
    urlId: r.url_id,
    title: r.title,
    author: r.author,
    postedAt: r.posted_at,
    netCount: r.net_count,
    pushCount: r.push_count,
    booCount: r.boo_count,
    nrecRaw: r.nrec_raw,
    mark: r.mark,
    contentLen: r.content_len,
    hasInsight: r.has_insight === 1,
    tldr: r.tldr,
    communityTake: r.community_take,
    sentiment: r.sentiment,
    controversy: r.controversy,
    tags: parseTags(r.tags),
  };
}

export function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function cardQueryBody(where: string, order: string): string {
  return `SELECT ${CARD_COLS}, ${INSIGHT_COLS}
    FROM articles a JOIN boards b ON b.id = a.board_id
    LEFT JOIN article_insights ai ON ai.article_id = a.id
    WHERE ${where}
    ORDER BY ${order}
    LIMIT ? OFFSET ?`;
}

export function listBoardArticles(db: DB, boardId: number, limit: number, offset: number): ArticleCard[] {
  const rows = db
    .prepare(cardQueryBody("a.deleted_at IS NULL AND a.board_id = ?", "a.posted_at DESC"))
    .all(boardId, limit, offset) as CardRow[];
  return rows.map(toCard);
}

interface DetailRow extends CardRow {
  content: string | null;
  ip: string | null;
  key_points: string | null;
  top_comments: string | null;
  model: string | null;
  insight_generated_at: number | null;
}

function getArticleWhere(db: DB, where: string, ...params: (string | number)[]): ArticleDetail | null {
  const row = db
    .prepare(
      `SELECT ${CARD_COLS}, ${INSIGHT_COLS}, a.content, a.ip, ai.key_points, ai.top_comments, ai.model, ai.generated_at AS insight_generated_at
       FROM articles a JOIN boards b ON b.id = a.board_id
       LEFT JOIN article_insights ai ON ai.article_id = a.id
       WHERE ${where}`,
    )
    .get(...params) as DetailRow | undefined;
  if (!row) return null;

  const pushes = db
    .prepare(`SELECT seq, tag, user_id, content, ipdatetime FROM pushes WHERE article_id = ? ORDER BY seq`)
    .all(row.id) as { seq: number; tag: string; user_id: string; content: string | null; ipdatetime: string | null }[];

  return {
    ...toCard(row),
    content: row.content,
    ip: row.ip,
    keyPoints: row.key_points,
    topComments: row.top_comments,
    model: row.model,
    insightGeneratedAt: row.insight_generated_at,
    pushes: pushes.map((p) => ({
      seq: p.seq,
      tag: p.tag,
      userId: p.user_id,
      content: p.content,
      ipDatetime: p.ipdatetime,
    })),
  };
}

// Fetches an article by board name and PTT url_id (M.1786718386.A.925).
export function getArticleByURLID(db: DB, boardName: string, urlId: string): ArticleDetail | null {
  return getArticleWhere(db, "b.name = ? AND a.url_id = ? AND a.deleted_at IS NULL", boardName, urlId);
}

export function getArticle(db: DB, id: number): ArticleDetail | null {
  return getArticleWhere(db, "a.id = ? AND a.deleted_at IS NULL", id);
}

export function listBoards(db: DB, minArticles: number): Board[] {
  const rows = db
    .prepare(
      `SELECT b.id, b.name, b.title, b.user_count, count(a.id) AS n
       FROM boards b
       JOIN articles a ON a.board_id = b.id AND a.deleted_at IS NULL
       GROUP BY b.id, b.name, b.title, b.user_count
       HAVING count(a.id) >= ?
       ORDER BY n DESC, b.user_count DESC`,
    )
    .all(minArticles) as { id: number; name: string; title: string | null; user_count: number | null; n: number }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    title: r.title,
    userCount: r.user_count,
    articleCount: r.n,
  }));
}

export function getBoardByName(db: DB, name: string): Board | null {
  const row = db
    .prepare(
      `SELECT b.id, b.name, b.title, b.user_count,
              (SELECT count(*) FROM articles a WHERE a.board_id = b.id AND a.deleted_at IS NULL) AS n
       FROM boards b WHERE b.name = ?`,
    )
    .get(name) as { id: number; name: string; title: string | null; user_count: number | null; n: number } | undefined;
  if (!row) return null;
  return { id: row.id, name: row.name, title: row.title, userCount: row.user_count, articleCount: row.n };
}
