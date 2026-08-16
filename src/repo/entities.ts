import type { DB } from "../db/sqlite.ts";

// Entity index over article_insights.entities (derived, rebuildable).
// Lookup key is a normalized name (NFKC, no whitespace, lowercase) so that
// ＦＧＯ / FGO / fgo collapse to one row; display keeps the raw first-seen form.

export interface EntityHit {
  nameNorm: string;
  name: string;
  kind: string;
  count: number;
}

export interface TimelinePoint {
  day: string; // YYYY-MM-DD (UTC+8)
  articles: number;
  sentiment: number; // avg in [-1, 1]; 0 when unknown
}

export function normEntity(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

// Sync refs for one article inside storeInsight's transaction: replace-set.
export function syncEntityRefs(db: DB, articleId: number, entities: { name: string; type: string }[]): void {
  db.prepare(`DELETE FROM entity_refs WHERE article_id = ?`).run(articleId);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO entity_refs (name_norm, name, kind, article_id) VALUES (?, ?, ?, ?)`,
  );
  for (const e of entities) {
    const norm = normEntity(e.name);
    if (norm === "") continue;
    ins.run(norm, e.name.trim().slice(0, 60), (e.type || "其他").slice(0, 10), articleId);
  }
}

// One-shot backfill from article_insights.entities JSON (replaces all refs).
export function backfillEntityRefs(db: DB): void {
  const rows = db.prepare(
    `SELECT ai.article_id AS id, je.value AS e
     FROM article_insights ai, json_each(ai.entities) je
     WHERE ai.error IS NULL AND ai.entities IS NOT NULL AND ai.entities != '[]'`,
  ).all() as { id: number; e: string }[];
  const tx = db.transaction(() => {
    db.exec(`DELETE FROM entity_refs`);
    const ins = db.prepare(
      `INSERT OR IGNORE INTO entity_refs (name_norm, name, kind, article_id) VALUES (?, ?, ?, ?)`,
    );
    for (const row of rows) {
      let e: { name?: unknown; type?: unknown };
      try {
        e = JSON.parse(row.e) as { name?: unknown; type?: unknown };
      } catch {
        continue;
      }
      if (typeof e.name !== "string") continue;
      const norm = normEntity(e.name);
      if (norm === "") continue;
      const name = e.name.trim().slice(0, 60);
      const kind = typeof e.type === "string" && e.type !== "" ? e.type.slice(0, 10) : "其他";
      ins.run(norm, name, kind, row.id);
    }
  });
  tx();
}

// Expand a normalized query through the alias table → set of names to match.
function expandNames(db: DB, query: string): string[] {
  const canonical = (
    db.prepare(`SELECT canonical FROM entity_aliases WHERE alias = ?`).get(query) as { canonical: string } | undefined
  )?.canonical ?? query;
  const names = new Set<string>([canonical]);
  const aliases = db.prepare(`SELECT alias FROM entity_aliases WHERE canonical = ?`).all(canonical) as { alias: string }[];
  for (const a of aliases) names.add(a.alias);
  return [...names];
}

export function searchEntities(db: DB, query: string, limit = 30): EntityHit[] {
  const q = normEntity(query).replace(/[%_\\]/g, "");
  if (q === "") return [];
  const like = `%${q}%`;
  const prefix = `${q}%`;
  const rows = db.prepare(
    `SELECT name_norm, name, kind, COUNT(*) AS c FROM entity_refs
     WHERE name_norm = ? OR name_norm LIKE ? OR name_norm LIKE ?
     GROUP BY name_norm, name, kind
     ORDER BY c DESC, name_norm LIMIT ?`,
  ).all(q, prefix, like, limit) as { name_norm: string; name: string; kind: string; c: number }[];
  return rows.map((r) => ({ nameNorm: r.name_norm, name: r.name, kind: r.kind, count: r.c }));
}

export function entityTimeline(db: DB, query: string, days = 60): TimelinePoint[] {
  const names = expandNames(db, normEntity(query));
  const ph = names.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT date(a.posted_at, 'unixepoch', '+8 hours') AS d,
            COUNT(*) AS n,
            SUM(CASE ai.sentiment WHEN '正面' THEN 1 WHEN '負面' THEN -1 ELSE 0 END) AS s
     FROM entity_refs er
     JOIN articles a ON a.id = er.article_id AND a.deleted_at IS NULL
     JOIN article_insights ai ON ai.article_id = er.article_id AND ai.error IS NULL
     WHERE er.name_norm IN (${ph}) AND a.posted_at IS NOT NULL
     GROUP BY d ORDER BY d DESC LIMIT ?`,
  ).all(...names, days) as { d: string; n: number; s: number | null }[];
  return rows.map((r) => ({ day: r.d, articles: r.n, sentiment: r.n > 0 ? (r.s ?? 0) / r.n : 0 }));
}

export interface EntityArticle {
  articleId: number;
  boardName: string;
  urlId: string;
  title: string;
  postedAt: number;
  netCount: number;
  tldr: string | null;
  sentiment: string | null;
  controversy: string | null;
}

export function entityArticles(db: DB, query: string, limit = 50): EntityArticle[] {
  const names = expandNames(db, normEntity(query));
  const ph = names.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT er.article_id AS id, b.name AS board, a.url_id, a.title, a.posted_at, a.net_count,
            ai.tldr, ai.sentiment, ai.controversy
     FROM entity_refs er
     JOIN articles a ON a.id = er.article_id AND a.deleted_at IS NULL
     JOIN boards b ON b.id = a.board_id
     JOIN article_insights ai ON ai.article_id = er.article_id AND ai.error IS NULL
     WHERE er.name_norm IN (${ph})
     ORDER BY a.posted_at DESC LIMIT ?`,
  ).all(...names, limit) as {
    id: number; board: string; url_id: string; title: string; posted_at: number;
    net_count: number; tldr: string | null; sentiment: string | null; controversy: string | null;
  }[];
  return rows.map((r) => ({
    articleId: r.id,
    boardName: r.board,
    urlId: r.url_id,
    title: r.title,
    postedAt: r.posted_at,
    netCount: r.net_count,
    tldr: r.tldr,
    sentiment: r.sentiment,
    controversy: r.controversy,
  }));
}

export function entityRefCount(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM entity_refs`).get() as { c: number }).c;
}
