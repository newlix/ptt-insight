import { test, expect } from "bun:test";
import { openMemoryDB } from "../src/db/sqlite.ts";
import { migrate } from "../src/db/migrate.ts";
import { storeInsight } from "../src/repo/insights.ts";
import {
  normEntity,
  backfillEntityRefs,
  searchEntities,
  entityTimeline,
  entityArticles,
  entityRefCount,
} from "../src/repo/entities.ts";
import type { InsightResult } from "../src/repo/insights.ts";

function seed(): { db: ReturnType<typeof openMemoryDB>; ids: number[] } {
  const db = openMemoryDB();
  migrate(db);
  db.prepare(`INSERT INTO boards (id, name) VALUES (1, 'Test')`).run();
  const ins = db.prepare(`INSERT INTO articles (board_id, url_id, content, net_count, posted_at) VALUES (1, ?, ?, 50, ?)`);
  const ids: number[] = [];
  for (let i = 1; i <= 3; i++) {
    ins.run(`M.${i}.A.E`, "x".repeat(30), Math.floor(Date.now() / 1000) - i * 86400);
    ids.push((db.prepare(`SELECT id FROM articles WHERE url_id = ?`).get(`M.${i}.A.E`) as { id: number }).id);
  }
  return { db, ids };
}

function mkInsight(articleId: number, entities: { name: string; type: string }[], sentiment: string, postedFix = 0): InsightResult {
  void postedFix;
  return {
    articleId,
    tldr: `t${articleId}`,
    communityTake: "", topComments: "",
    sentiment, controversy: "低", tags: [], model: "m",
    promptTokens: 1, completionTokens: 1,
    articleType: "心得", entities,
    adLikelihood: "無", factuality: "觀點", aiGenerated: "人寫",
    pushStance: { pro: 0, con: 0, neutral: 0 }, pushFacts: "", qaSummary: "",
  };
}

test("normEntity: NFKC + spaces + case", () => {
  expect(normEntity("ＦＧＯ")).toBe("fgo");
  expect(normEntity(" 俠盜獵車手 VI ")).toBe("俠盜獵車手vi");
});

test("storeInsight syncs entity_refs (replace-set on re-store)", () => {
  const { db, ids } = seed();
  storeInsight(db, mkInsight(ids[0]!, [{ name: "FGO", type: "遊戲" }, { name: "PS5", type: "產品" }], "正面"));
  expect(entityRefCount(db)).toBe(2);
  // re-store with different entities → old refs replaced
  storeInsight(db, mkInsight(ids[0]!, [{ name: "Switch", type: "產品" }], "中立"));
  expect(entityRefCount(db)).toBe(1);
  expect(searchEntities(db, "PS5")).toEqual([]);
  expect(searchEntities(db, "switch")[0]!.count).toBe(1);
});

test("search: exact → prefix → substring, escaped LIKE", () => {
  const { db, ids } = seed();
  storeInsight(db, mkInsight(ids[0]!, [{ name: "俠盜獵車手VI", type: "遊戲" }], "正面"));
  storeInsight(db, mkInsight(ids[1]!, [{ name: "俠盜獵車手V", type: "遊戲" }], "負面"));
  storeInsight(db, mkInsight(ids[2]!, [{ name: "GTA", type: "遊戲" }], "中立"));
  const exact = searchEntities(db, "GTA");
  expect(exact.length).toBe(1);
  expect(exact[0]!.nameNorm).toBe("gta");
  const prefix = searchEntities(db, "俠盜獵車手");
  expect(prefix.length).toBe(2); // VI + V both match
  const sub = searchEntities(db, "獵車手v");
  expect(sub.map((h) => h.nameNorm).sort()).toEqual(["俠盜獵車手v", "俠盜獵車手vi"]);
  // % and _ in query don't explode the LIKE
  expect(searchEntities(db, "%").length).toBe(0);
  expect(searchEntities(db, "_").length).toBe(0);
});

test("timeline: per-day aggregation with sentiment weighting", () => {
  const { db, ids } = seed();
  storeInsight(db, mkInsight(ids[0]!, [{ name: "FGO", type: "遊戲" }], "正面"));
  storeInsight(db, mkInsight(ids[1]!, [{ name: "FGO", type: "遊戲" }], "負面"));
  storeInsight(db, mkInsight(ids[2]!, [{ name: "FGO", type: "遊戲" }], "中立"));
  const tl = entityTimeline(db, "FGO", 10);
  expect(tl.length).toBe(3); // one per distinct day
  // latest day = ids[0] (1 day ago) positive → +1
  const latest = tl[0]!;
  expect(latest.articles).toBe(1);
  expect(latest.sentiment).toBe(1);
});

test("aliases expand the name set", () => {
  const { db, ids } = seed();
  storeInsight(db, mkInsight(ids[0]!, [{ name: "GTA6", type: "遊戲" }], "正面"));
  storeInsight(db, mkInsight(ids[1]!, [{ name: "俠盜獵車手VI", type: "遊戲" }], "負面"));
  db.prepare(`INSERT INTO entity_aliases (alias, canonical) VALUES ('gta6', '俠盜獵車手vi'), ('俠盜獵車手6', '俠盜獵車手vi')`).run();
  const arts = entityArticles(db, "俠盜獵車手VI", 10);
  expect(arts.length).toBe(2); // both spellings via alias set
  const tl = entityTimeline(db, "GTA6"); // queried by alias → canonical set
  expect(tl.length).toBeGreaterThan(0);
});

test("backfill from raw insight rows (incl. fullwidth names)", () => {
  const db = openMemoryDB();
  migrate(db);
  db.prepare(`INSERT INTO boards (id, name) VALUES (1, 'Test')`).run();
  const id = (db.prepare(`INSERT INTO articles (board_id, url_id, content, net_count) VALUES (1, 'M.1.A.B', ?, 50)`).run("x".repeat(30)), (db.prepare(`SELECT id FROM articles WHERE url_id='M.1.A.B'`).get() as { id: number }).id);
  db.prepare(
    `INSERT INTO article_insights (article_id, tldr, model, schema_ver, entities) VALUES (?, 't', 'm', 2, ?)`,
  ).run(id, JSON.stringify([{ name: "ＦＧＯ", type: "遊戲" }, { name: "GTA", type: "遊戲" }]));
  backfillEntityRefs(db);
  expect(entityRefCount(db)).toBe(2);
  // fullwidth ＦＧＯ normalized to fgo, same bucket as a storeInsight-written FGO
  const hits = searchEntities(db, "fgo");
  expect(hits.length).toBe(1);
  expect(hits[0]!.count).toBe(1);
});
