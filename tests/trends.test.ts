import { test, expect } from "bun:test";
import { openMemoryDB } from "../src/db/sqlite.ts";
import { migrate } from "../src/db/migrate.ts";
import { trendingEntities, risingArticles, velocityCalibration, hotProbability } from "../src/repo/trends.ts";

function seed() {
  const db = openMemoryDB();
  migrate(db);
  db.prepare(`INSERT INTO boards (id, name, is_hot) VALUES (1, 'Test', 1)`).run();
  return db;
}

test("trendingEntities: 7d window, momentum = h48*2 + d7, needs ≥3", () => {
  const db = seed();
  const now = Math.floor(Date.now() / 1000);
  const insA = db.prepare(`INSERT INTO articles (board_id, url_id, content, net_count, posted_at) VALUES (1, ?, ?, 50, ?)`);
  const mk = (urlId: string, postedAt: number, entity: string): number => {
    insA.run(urlId, "x".repeat(30), postedAt);
    const id = (db.prepare(`SELECT id FROM articles WHERE url_id = ?`).get(urlId) as { id: number }).id;
    db.prepare(`INSERT INTO article_insights (article_id, tldr, model, schema_ver) VALUES (?, 't', 'm', 2)`).run(id);
    db.prepare(`INSERT INTO entity_refs (name_norm, name, kind, article_id) VALUES (?, ?, '遊戲', ?)`).run(entity, entity, id);
    return id;
  };
  // hot entity: 3 articles, 2 within 48h → score 2*2+3=7
  mk("M.H1.A.T", now - 3600, "gta6");
  mk("M.H2.A.T", now - 7200, "gta6");
  mk("M.H3.A.T", now - 5 * 86400, "gta6");
  // old entity: 3 articles but all older than 7d → excluded
  mk("M.O1.A.T", now - 8 * 86400, "oldgame");
  mk("M.O2.A.T", now - 9 * 86400, "oldgame");
  mk("M.O3.A.T", now - 9 * 86400, "oldgame");
  // sparse entity: 2 articles → excluded (<3)
  mk("M.S1.A.T", now - 3600, "sparse");
  mk("M.S2.A.T", now - 3600, "sparse");

  const t = trendingEntities(db, 10);
  expect(t.length).toBe(1);
  expect(t[0]!.nameNorm).toBe("gta6");
  expect(t[0]!.d7).toBe(3);
  expect(t[0]!.h48).toBe(2);
});

test("risingArticles: <12h, push_count>5, ordered by velocity", () => {
  const db = seed();
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(`INSERT INTO articles (board_id, url_id, content, net_count, push_count, posted_at) VALUES (1, ?, ?, 50, ?, ?)`);
  ins.run("M.F1.A.R", "x".repeat(30), 60, now - 3600);   // 60/h → fastest
  ins.run("M.F2.A.R", "x".repeat(30), 40, now - 6 * 3600); // 6.7/h
  ins.run("M.F3.A.R", "x".repeat(30), 3, now - 3600);    // push_count<=5 → out
  ins.run("M.F4.A.R", "x".repeat(30), 99, now - 20 * 3600); // too old → out

  const r = risingArticles(db, 12, 10);
  expect(r.length).toBe(2);
  expect(r[0]!.urlId).toBe("M.F1.A.R");
  expect(r[0]!.vph).toBeGreaterThan(r[1]!.vph);
});

test("velocityCalibration + hotProbability: matured articles base rate", () => {
  const db = seed();
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(`INSERT INTO articles (board_id, url_id, content, net_count, push_count, posted_at) VALUES (1, ?, ?, ?, ?, ?)`);
  // bucket ~10 vph: 5 matured articles (3d old → 72h, push 720 → 10/h), 4 hit net 90
  for (let i = 0; i < 4; i++) ins.run(`M.C1.${i}.A.R`, "x".repeat(30), 95, 720, now - 3 * 86400);
  ins.run("M.C1.9.A.R", "x".repeat(30), 20, 720, now - 3 * 86400);
  // bucket ~0.1 vph: slow articles, none hot
  for (let i = 0; i < 3; i++) ins.run(`M.C2.${i}.A.R`, "x".repeat(30), 5, 10, now - 3 * 86400);

  const calib = velocityCalibration(db, 10);
  const fast = calib.find((c) => c.bucketVph === 10);
  const slow = calib.find((c) => c.bucketVph === 0);
  expect(fast).toBeDefined();
  // (4+1)/(5+2) Laplace
  expect(Math.round(fast!.pHot * 1000)).toBe(Math.round((5 / 7) * 1000));
  expect(slow!.pHot).toBeLessThan(0.5);

  expect(hotProbability(calib, 12)).toBe(fast!.pHot); // falls into 10-bucket
  expect(hotProbability(calib, 0.05)).toBe(slow!.pHot);
  expect(hotProbability([], 5)).toBe(0); // no data → 0
});
