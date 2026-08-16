import { test, expect, afterAll } from "bun:test";
import { openMemoryDB } from "../src/db/sqlite.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/repo/articles.ts";
import {
  claimPendingArticles,
  claimStaleArticles,
  claimFilteredArticles,
  storeInsight,
  markInsightError,
  insightStats,
  type InsightResult,
} from "../src/repo/insights.ts";

// Fresh DB with the full merged schema (0001 crawler + 0002 insights).
function seedDB() {
  const db = openMemoryDB();
  migrate(db); // adds article_insights
  return db;
}

function insertArticle(
  db: ReturnType<typeof seedDB>,
  urlId: string,
  content: string,
  netCount: number,
  deleted = false,
) {
  db.prepare(
    `INSERT INTO articles (board_id, url_id, url_timestamp, posted_at, title, author, content, net_count, deleted_at)
     VALUES (1, ?, 1000, 1000, 't', 'a', ?, ?, ?)`,
  ).run(urlId, content, netCount, deleted ? 1 : null);
  return (db.prepare(`SELECT id FROM articles WHERE url_id = ?`).get(urlId) as { id: number }).id;
}

test("repo roundtrip: pending claim → store → stats", () => {
  const db = seedDB();
  db.prepare(`INSERT INTO boards (id, name) VALUES (1, 'Test')`).run();

  const hot = insertArticle(db, "M.1.A.HOT", "x".repeat(50), 50);
  const cold = insertArticle(db, "M.2.A.COLD", "x".repeat(50), 5); // below min_net
  const thin = insertArticle(db, "M.3.A.THIN", "short", 99); // content ≤ 20 chars
  const del = insertArticle(db, "M.4.A.DEL", "x".repeat(50), 99, true); // deleted
  db.prepare(`INSERT INTO pushes (article_id, seq, tag, user_id, content) VALUES (?, 0, '推', 'u1', 'nice')`).run(hot);

  const pending = claimPendingArticles(db, 10, 20);
  expect(pending.map((p) => p.id)).toEqual([hot]); // only hot qualifies
  expect(pending[0]!.pushes.length).toBe(1);
  expect(pending[0]!.pushes[0]!.userId).toBe("u1");
  void cold;
  void thin;
  void del;

  const result: InsightResult = {
    articleId: hot,
    tldr: "摘要",
    communityTake: "推文一致叫好",
    topComments: "推 u1: nice",
    sentiment: "正面",
    controversy: "低",
    tags: ["tag1", "tag2"],
    model: "stub",
    promptTokens: 10,
    completionTokens: 20,
  };
  storeInsight(db, result);

  // no longer pending
  expect(claimPendingArticles(db, 10, 20)).toEqual([]);

  // card join sees the insight
  const cards = repo.listBoardArticles(db, 1, 10, 0);
  const card = cards.find((c) => c.urlId === "M.1.A.HOT")!;
  expect(card.hasInsight).toBe(true);
  expect(card.tldr).toBe("摘要");
  expect(card.tags).toEqual(["tag1", "tag2"]);
  expect(card.sentiment).toBe("正面");

  // detail includes pushes
  const detail = repo.getArticleByURLID(db, "Test", "M.1.A.HOT")!;
  expect(detail.pushes.length).toBe(1);
  expect(repo.getArticle(db, hot)!.id).toBe(hot);
  expect(repo.getArticleByURLID(db, "Test", "nope")).toBeNull();

  // stats: analyzed counts insight, total counts eligible articles
  const stats = insightStats(db);
  expect(stats.analyzed).toBe(1);
  expect(stats.total).toBe(1); // default minNet=20: cold(5) excluded
  expect(insightStats(db, 5).total).toBe(2); // lowered threshold includes cold

  // upsert path: re-store overwrites
  storeInsight(db, { ...result, tldr: "v2" });
  expect(repo.getArticle(db, hot)!.tldr).toBe("v2");
});

test("markInsightError + filtered reclaim + fallback store", () => {
  const db = seedDB();
  db.prepare(`INSERT INTO boards (id, name) VALUES (1, 'Test')`).run();
  const id = insertArticle(db, "M.1.A.BLOCKED", "x".repeat(50), 99);

  markInsightError(db, id, "content_filter");
  expect(claimPendingArticles(db, 10, 20)).toEqual([]); // has insight row (error) → not pending

  const filtered = claimFilteredArticles(db, 10);
  expect(filtered.map((f) => f.id)).toEqual([id]);

  // fallback re-analysis overwrites the error row
  storeInsight(db, {
    articleId: id, tldr: "ok now", communityTake: "", topComments: "",
    sentiment: "中立", controversy: "低", tags: [], model: "fallback",
    promptTokens: 1, completionTokens: 1,
  });
  expect(claimFilteredArticles(db, 10)).toEqual([]);
  expect(insightStats(db).analyzed).toBe(1); // error cleared
});

test("claimStaleArticles: re-analyze when data changed, only fresh articles, hourly gate", () => {
  const db = seedDB();
  db.prepare(`INSERT INTO boards (id, name) VALUES (1, 'Test')`).run();
  const now = Math.floor(Date.now() / 1000);

  const mk = (urlId: string, postedAt: number) => {
    const id = insertArticle(db, urlId, "x".repeat(50), 99);
    db.prepare(`UPDATE articles SET posted_at = ? WHERE id = ?`).run(postedAt, id);
    storeInsight(db, {
      articleId: id, tldr: "v1", communityTake: "", topComments: "",
      sentiment: "中立", controversy: "低", tags: [], model: "m",
      promptTokens: 1, completionTokens: 1,
    });
    return id;
  };
  const setGen = (id: number, t: number) =>
    db.prepare(`UPDATE article_insights SET generated_at = ? WHERE article_id = ?`).run(t, id);
  const setFetched = (id: number, t: number) =>
    db.prepare(`UPDATE articles SET last_fetched_at = ? WHERE id = ?`).run(t, id);

  // stale candidate: fresh article, pushes changed after analysis, analysis > 1h old
  const stale = mk("M.1.A.STALE", now - 3600);
  setGen(stale, now - 7200);
  setFetched(stale, now - 1800); // crawler re-fetched pushes 30min ago

  // not stale: data never changed after analysis
  const unchanged = mk("M.2.A.SAME", now - 3600);
  setGen(unchanged, now - 7200);
  setFetched(unchanged, now - 9000); // fetched before analysis

  // too old: article posted 30 days ago (outside refresh window)
  const old = mk("M.3.A.OLD", now - 30 * 86400);
  setGen(old, now - 7200);
  setFetched(old, now - 1800);

  // hourly gate: analysis was 5 minutes ago
  const recent = mk("M.4.A.RECENT", now - 3600);
  setGen(recent, now - 300);
  setFetched(recent, now - 100);

  const claimed = claimStaleArticles(db, 10, 20, now - 7 * 86400);
  expect(claimed.map((p) => p.id)).toEqual([stale]);

  // after re-analysis succeeds, generated_at moves past last_fetched_at → gone
  storeInsight(db, {
    articleId: stale, tldr: "v2", communityTake: "", topComments: "",
    sentiment: "中立", controversy: "低", tags: [], model: "m",
    promptTokens: 1, completionTokens: 1,
  });
  expect(claimStaleArticles(db, 10, 20, now - 7 * 86400)).toEqual([]);
  expect(db.prepare(`SELECT tldr FROM article_insights WHERE article_id = ?`).get(stale)).toEqual({ tldr: "v2" });
});

test("transient insight errors retry after cooldown; fresh ones don't", () => {
  const db = seedDB();
  db.prepare(`INSERT INTO boards (id, name) VALUES (1, 'Test')`).run();
  const a1 = insertArticle(db, "M.1.A.R429", "x".repeat(50), 90);
  const a2 = insertArticle(db, "M.2.A.NET", "x".repeat(50), 80);

  markInsightError(db, a1, "llm status 429: rate limited");
  markInsightError(db, a2, "network down");

  // fresh errors (< 1h): not claimed
  expect(claimPendingArticles(db, 10, 20)).toEqual([]);

  // a1's error ages past the cooldown → retried; a2's stays fresh
  db.prepare(`UPDATE article_insights SET generated_at = ? WHERE article_id = ?`).run(Math.floor(Date.now() / 1000) - 3700, a1);
  const claimed = claimPendingArticles(db, 10, 20);
  expect(claimed.map((p) => p.id)).toEqual([a1]);

  // a successful store during retry clears the error permanently
  storeInsight(db, {
    articleId: a1, tldr: "recovered", communityTake: "", topComments: "",
    sentiment: "中立", controversy: "低", tags: [], model: "m",
    promptTokens: 1, completionTokens: 1,
  });
  expect(claimPendingArticles(db, 10, 20)).toEqual([]);
});

test("boards: list + get with article counts", () => {
  const db = seedDB();
  db.prepare(`INSERT INTO boards (id, name, title, user_count) VALUES (1, 'A', '◎A', 100)`).run();
  db.prepare(`INSERT INTO boards (id, name, title, user_count) VALUES (2, 'B', '◎B', 50)`).run();
  insertArticle(db, "M.1.A.X", "x".repeat(50), 10);
  insertArticle(db, "M.2.A.Y", "x".repeat(50), 10);
  insertArticle(db, "M.3.A.Z", "x".repeat(50), 10);

  const boards = repo.listBoards(db, 1);
  expect(boards.length).toBe(1); // only A has articles (insertArticle targets board 1)
  expect(boards[0]!.name).toBe("A");
  expect(boards[0]!.articleCount).toBe(3);

  const got = repo.getBoardByName(db, "B")!;
  expect(got.articleCount).toBe(0);
  expect(repo.getBoardByName(db, "nope")).toBeNull();
});
