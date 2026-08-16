import type { DB } from "../db/sqlite.ts";

// /status — operational aggregates (public-safe: counts and estimates only).
// Credit estimate: GLM-5.3-tier multipliers (in 6.9 / out 24 per 10K tokens),
// all off-peak (the worker pauses exactly during peak hours).

export interface StatusData {
  v2Total: number;
  v1Remaining: number;
  pendingEligible: number;
  pendingGated: number;
  errorCooldown: number;
  last1h: number;
  last24h: number;
  credits24h: number;
  credits7d: number;
  weeklyBudget: number;
  digestsToday: number;
  dbSizeMB: number;
}

export function gatherStatus(db: DB, weeklyBudget = 140_000): StatusData {
  const now = Math.floor(Date.now() / 1000);
  const one = <T>(sql: string, ...params: (string | number)[]): T =>
    db.prepare(sql).get(...params) as T;

  const counts = one<{
    v2: number; v1: number; err: number; h1: number; h24: number;
    c24: number; c7: number; pending: number; gated: number;
  }>(
    `SELECT
      (SELECT COUNT(*) FROM article_insights WHERE error IS NULL AND schema_ver = 2) AS v2,
      (SELECT COUNT(*) FROM article_insights WHERE error IS NULL AND schema_ver = 1) AS v1,
      (SELECT COUNT(*) FROM article_insights WHERE error IS NOT NULL AND generated_at > ? - 3600) AS err,
      (SELECT COUNT(*) FROM article_insights WHERE error IS NULL AND generated_at > ? - 3600) AS h1,
      (SELECT COUNT(*) FROM article_insights WHERE error IS NULL AND generated_at > ? - 86400) AS h24,
      (SELECT COALESCE(ROUND(SUM(prompt_tokens * 6.9 + completion_tokens * 24) / 10000.0 * 0.5), 0)
         FROM article_insights WHERE error IS NULL AND generated_at > ? - 86400) AS c24,
      (SELECT COALESCE(ROUND(SUM(prompt_tokens * 6.9 + completion_tokens * 24) / 10000.0 * 0.5), 0)
         FROM article_insights WHERE error IS NULL AND generated_at > ? - 7 * 86400) AS c7,
      (SELECT COUNT(*) FROM articles a LEFT JOIN article_insights ai ON ai.article_id = a.id
         WHERE a.net_count BETWEEN 20 AND 999999 AND a.deleted_at IS NULL
           AND (a.posted_at IS NULL OR a.posted_at < ? - 7 * 86400)
           AND (ai.id IS NULL OR ai.schema_ver = 1)) AS pending,
      (SELECT COUNT(*) FROM articles a LEFT JOIN article_insights ai ON ai.article_id = a.id
         WHERE a.net_count BETWEEN 20 AND 999999 AND a.deleted_at IS NULL
           AND a.posted_at BETWEEN ? - 7 * 86400 AND ? + 86400
           AND (ai.id IS NULL OR ai.schema_ver = 1)) AS gated`,
    now, now, now, now, now, now, now, now,
  );
  const digests = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM board_digests WHERE day = date(? - 28800, 'unixepoch')`, // UTC+8 day
    now,
  ) as { c: number };
  const sizeRow = one<{ b: number }>(`SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()`) as { b: number };

  return {
    v2Total: counts.v2,
    v1Remaining: counts.v1,
    pendingEligible: counts.pending,
    pendingGated: counts.gated,
    errorCooldown: counts.err,
    last1h: counts.h1,
    last24h: counts.h24,
    credits24h: counts.c24,
    credits7d: counts.c7,
    weeklyBudget,
    digestsToday: digests.c,
    dbSizeMB: Math.round(sizeRow.b / 1048576),
  };
}
