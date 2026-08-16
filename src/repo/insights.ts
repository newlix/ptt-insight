import type { DB } from "../db/sqlite.ts";
import { nowSecs } from "../db/sqlite.ts";
import { parseTags, type Push } from "./articles.ts";

export interface InsightResult {
  articleId: number;
  tldr: string;
  communityTake: string;
  topComments: string;
  sentiment: string;
  controversy: string;
  tags: string[];
  model: string;
  promptTokens: number;
  completionTokens: number;
  // v2 fields (schema_ver=2)
  articleType: string;
  entities: { name: string; type: string }[];
  adLikelihood: string;
  factuality: string;
  aiGenerated: string;
  pushStance: { pro: number; con: number; neutral: number };
  pushFacts: string;
  qaSummary: string;
}

export interface PendingArticle {
  id: number;
  boardId: number;
  title: string | null;
  author: string | null;
  content: string | null;
  netCount: number | null;
  pushes: Push[];
}

function getPushes(db: DB, articleId: number): Push[] {
  const rows = db
    .prepare(`SELECT seq, tag, user_id, content FROM pushes WHERE article_id = ? ORDER BY seq`)
    .all(articleId) as { seq: number; tag: string; user_id: string; content: string | null }[];
  return rows.map((p) => ({ seq: p.seq, tag: p.tag, userId: p.user_id, content: p.content, ipDatetime: null }));
}

function loadPending(db: DB, sql: string, ...params: (string | number)[]): PendingArticle[] {
  const rows = db
    .prepare(sql)
    .all(...params) as { id: number; board_id: number; title: string | null; author: string | null; content: string | null; net_count: number | null }[];
  return rows.map((r) => ({
    id: r.id,
    boardId: r.board_id,
    title: r.title,
    author: r.author,
    content: r.content,
    netCount: r.net_count,
    pushes: getPushes(db, r.id),
  }));
}

// Transient errors (429/network/parse) are retried after this cooldown;
// content_filter is excluded (handled by the fallback loop instead).
const RETRY_ERROR_COOLDOWN_SECS = 3600;

export function claimPendingArticles(db: DB, limit: number, minNet: number, minAgeSecs = 0): PendingArticle[] {
  return loadPending(
    db,
    `SELECT a.id, a.board_id, a.title, a.author, a.content, a.net_count
     FROM articles a
     LEFT JOIN article_insights ai ON ai.article_id = a.id
     WHERE a.deleted_at IS NULL
       AND a.content IS NOT NULL
       AND length(a.content) > 20
       AND COALESCE(a.net_count, 0) >= ?
       AND (? = 0 OR a.posted_at IS NULL OR a.posted_at < ?)
       AND (
         ai.id IS NULL
         OR (ai.error IS NOT NULL AND ai.error != 'content_filter' AND ai.generated_at < ?)
         OR (ai.error IS NULL AND ai.schema_ver < 2)
       )
     ORDER BY a.net_count DESC, a.posted_at DESC
     LIMIT ?`,
    minNet,
    minAgeSecs,
    nowSecs() - minAgeSecs,
    nowSecs() - RETRY_ERROR_COOLDOWN_SECS,
    limit,
  );
}

// Articles whose underlying data changed since their insight was generated
// (crawler re-fetched pushes → last_fetched_at moved past generated_at), while
// the article is still fresh enough for the discussion to be evolving.
// Re-analysis is rate-limited to once per hour per article.
export function claimStaleArticles(
  db: DB,
  limit: number,
  minNet: number,
  freshAfterSecs: number, // only articles posted after this epoch
  recheckGapSecs = 3600,
): PendingArticle[] {
  const now = nowSecs();
  return loadPending(
    db,
    `SELECT a.id, a.board_id, a.title, a.author, a.content, a.net_count
     FROM articles a
     JOIN article_insights ai ON ai.article_id = a.id
     WHERE a.deleted_at IS NULL
       AND a.content IS NOT NULL
       AND length(a.content) > 20
       AND COALESCE(a.net_count, 0) >= ?
       AND ai.error IS NULL
       AND a.posted_at > ?
       AND a.last_fetched_at IS NOT NULL
       AND a.last_fetched_at > ai.generated_at
       AND ai.generated_at < ?
     ORDER BY a.posted_at DESC
     LIMIT ?`,
    minNet,
    freshAfterSecs,
    now - recheckGapSecs,
    limit,
  );
}

// Articles whose primary-provider analysis was blocked by content filter
// (ai.error = 'content_filter'), for retry with a fallback provider.
export function claimFilteredArticles(db: DB, limit: number, minAgeSecs = 0): PendingArticle[] {
  return loadPending(
    db,
    `SELECT a.id, a.board_id, a.title, a.author, a.content, a.net_count
     FROM articles a
     JOIN article_insights ai ON ai.article_id = a.id
     WHERE ai.error = 'content_filter'
       AND (? = 0 OR a.posted_at IS NULL OR a.posted_at < ?)
     ORDER BY a.net_count DESC
     LIMIT ?`,
    minAgeSecs,
    nowSecs() - minAgeSecs,
    limit,
  );
}

export function storeInsight(db: DB, r: InsightResult): void {
  db.prepare(
    `INSERT INTO article_insights
       (article_id, tldr, community_take, top_comments, sentiment, controversy, tags, model, prompt_tokens, completion_tokens,
        schema_ver, article_type, entities, ad_likelihood, factuality, ai_generated, push_stance, push_facts, qa_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (article_id) DO UPDATE SET
       tldr              = excluded.tldr,
       community_take    = excluded.community_take,
       top_comments      = excluded.top_comments,
       sentiment         = excluded.sentiment,
       controversy       = excluded.controversy,
       tags              = excluded.tags,
       model             = excluded.model,
       prompt_tokens     = excluded.prompt_tokens,
       completion_tokens = excluded.completion_tokens,
       generated_at      = unixepoch(),
       error             = NULL,
       schema_ver        = 2,
       article_type      = excluded.article_type,
       entities          = excluded.entities,
       ad_likelihood     = excluded.ad_likelihood,
       factuality        = excluded.factuality,
       ai_generated      = excluded.ai_generated,
       push_stance       = excluded.push_stance,
       push_facts        = excluded.push_facts,
       qa_summary        = excluded.qa_summary`,
  ).run(
    r.articleId,
    r.tldr,
    r.communityTake,
    r.topComments,
    r.sentiment,
    r.controversy,
    JSON.stringify(r.tags),
    r.model,
    r.promptTokens,
    r.completionTokens,
    r.articleType,
    JSON.stringify(r.entities),
    r.adLikelihood,
    r.factuality,
    r.aiGenerated,
    JSON.stringify(r.pushStance),
    r.pushFacts,
    r.qaSummary,
  );
}

export function markInsightError(db: DB, articleId: number, errMsg: string): void {
  db.prepare(
    `INSERT INTO article_insights (article_id, tldr, model, error)
     VALUES (?, '(分析失敗)', 'error', ?)
     ON CONFLICT (article_id) DO UPDATE SET error = excluded.error, generated_at = ?`,
  ).run(articleId, errMsg, nowSecs());
}

export function insightStats(db: DB, minNet = 20): { analyzed: number; total: number } {
  const row = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM article_insights WHERE error IS NULL) AS analyzed,
         (SELECT count(*) FROM articles
          WHERE deleted_at IS NULL AND content IS NOT NULL AND length(content) > 20
            AND COALESCE(net_count, 0) >= ?) AS total`,
    )
    .get(minNet) as { analyzed: number; total: number };
  return { analyzed: row.analyzed, total: row.total };
}

export { parseTags };
