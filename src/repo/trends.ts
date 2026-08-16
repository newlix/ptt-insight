import type { DB } from "../db/sqlite.ts";

// /trends — trending entities (7d volume + 48h momentum, no LLM).
// /rising — fresh articles ranked by push velocity, with a historically
// calibrated P(net≥90) per velocity bucket (Laplace-smoothed base rate).

export interface TrendingEntity {
  nameNorm: string;
  name: string;
  kind: string;
  d7: number;
  h48: number;
}

export function trendingEntities(db: DB, limit = 30): TrendingEntity[] {
  const now = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT er.name_norm, MAX(er.name) AS name, MAX(er.kind) AS kind,
              COUNT(DISTINCT CASE WHEN a.posted_at > ? THEN a.id END) AS d7,
              COUNT(DISTINCT CASE WHEN a.posted_at > ? THEN a.id END) AS h48
       FROM entity_refs er
       JOIN articles a ON a.id = er.article_id AND a.deleted_at IS NULL
       JOIN article_insights ai ON ai.article_id = er.article_id AND ai.error IS NULL
       WHERE a.posted_at > ?
       GROUP BY er.name_norm
       HAVING d7 >= 3
       ORDER BY h48 * 2 + d7 DESC, d7 DESC
       LIMIT ?`,
    )
    .all(now - 7 * 86400, now - 48 * 3600, now - 7 * 86400, limit) as {
    name_norm: string; name: string; kind: string; d7: number; h48: number;
  }[];
  return rows.map((r) => ({ nameNorm: r.name_norm, name: r.name, kind: r.kind, d7: r.d7, h48: r.h48 }));
}

export interface RisingArticle {
  articleId: number;
  boardName: string;
  urlId: string;
  title: string;
  postedAt: number;
  pushCount: number;
  booCount: number;
  netCount: number;
  vph: number; // pushes per hour since posting
}

export function risingArticles(db: DB, maxAgeHours = 12, limit = 30): RisingArticle[] {
  const now = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT a.id, b.name AS board, a.url_id, a.title, a.posted_at, a.push_count, a.boo_count, a.net_count,
              (? - a.posted_at) AS age_secs
       FROM articles a JOIN boards b ON b.id = a.board_id
       WHERE a.deleted_at IS NULL AND a.posted_at IS NOT NULL AND a.posted_at > ?
         AND a.push_count > 5
       ORDER BY a.push_count * 3600.0 / MAX(? - a.posted_at, 1800) DESC
       LIMIT ?`,
    )
    .all(now, now - maxAgeHours * 3600, now, limit) as {
    id: number; board: string; url_id: string; title: string; posted_at: number;
    push_count: number; boo_count: number; net_count: number; age_secs: number;
  }[];
  return rows.map((r) => ({
    articleId: r.id,
    boardName: r.board,
    urlId: r.url_id,
    title: r.title,
    postedAt: r.posted_at,
    pushCount: r.push_count,
    booCount: r.boo_count,
    netCount: r.net_count,
    vph: r.age_secs > 0 ? (r.push_count * 3600) / r.age_secs : r.push_count,
  }));
}

// Historical base rate: among matured articles (2-30d old) in the same
// lifetime velocity bucket, what fraction ever reached net >= 90 (爆).
export interface VelocityBucket {
  bucketVph: number; // bucket lower bound
  n: number;
  pHot: number; // Laplace-smoothed share
}

export function velocityCalibration(db: DB, bucketSize = 10): VelocityBucket[] {
  const now = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT (a.push_count * 3600.0 / MAX(? - a.posted_at, 3600)) / ? AS b,
              COUNT(*) AS n,
              SUM(CASE WHEN a.net_count >= 90 THEN 1 ELSE 0 END) AS hot
       FROM articles a
       WHERE a.deleted_at IS NULL AND a.posted_at IS NOT NULL
         AND a.posted_at BETWEEN ? AND ? AND a.push_count > 5
       GROUP BY CAST(b AS INT)
       HAVING n >= 3`,
    )
    .all(now, bucketSize, now - 30 * 86400, now - 2 * 86400) as { b: number; n: number; hot: number }[];
  return rows.map((r) => ({
    bucketVph: Math.floor(r.b) * bucketSize,
    n: r.n,
    pHot: (r.hot + 1) / (r.n + 2),
  }));
}

export function hotProbability(calib: VelocityBucket[], vph: number): number {
  let best: VelocityBucket | undefined;
  for (const c of calib) {
    if (vph >= c.bucketVph && (best === undefined || c.bucketVph > best.bucketVph)) best = c;
  }
  if (best === undefined) {
    // no historical data at this velocity — fall back to the lowest bucket
    return calib.length > 0 ? calib[0]!.pHot : 0;
  }
  return best.pHot;
}
