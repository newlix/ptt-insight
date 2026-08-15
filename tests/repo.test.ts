import { test, expect, afterAll } from "bun:test";
import { openMemoryDB } from "../src/db/sqlite.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/repo/articles.ts";
import {
  claimPendingArticles,
  claimFilteredArticles,
  storeInsight,
  markInsightError,
  insightStats,
  type InsightResult,
} from "../src/repo/insights.ts";

// Seed a minimal crawler-schema DB (boards/articles/pushes from the crawler's
// 0001_init migration shape — we create just the columns insight queries touch).
function seedDB() {
  const db = openMemoryDB();
  db.exec(`
    CREATE TABLE boards (id INTEGER PRIMARY KEY, name TEXT UNIQUE, title TEXT, user_count INTEGER);
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY,
      board_id INTEGER REFERENCES boards(id),
      url_id TEXT,
      url_timestamp INTEGER,
      posted_at INTEGER,
      title TEXT, author TEXT, content TEXT, ip TEXT, mark TEXT,
      nrec_raw TEXT, push_count INTEGER, boo_count INTEGER, neutral_count INTEGER, net_count INTEGER,
      first_seen_at INTEGER, last_fetched_at INTEGER, deleted_at INTEGER,
      UNIQUE(board_id, url_id)
    );
    CREATE TABLE pushes (
      id INTEGER PRIMARY KEY,
      article_id INTEGER REFERENCES articles(id),
      seq INTEGER, tag TEXT, user_id TEXT, content TEXT, ipdatetime TEXT,
      UNIQUE(article_id, seq)
    );
  `);
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
  const cards = repo.listHotArticles(db, 10, 0);
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
  expect(stats.total).toBe(1);

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
