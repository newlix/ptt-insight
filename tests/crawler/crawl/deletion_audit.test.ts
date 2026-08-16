import { test, expect } from "bun:test";
import { setupTestEnv, pathServer, type TestEnv } from "./testutil.ts";
import { runDeletionAudit } from "../../../src/crawler/crawl/deletion_audit.ts";
import { nowSecs } from "../../../src/db/sqlite.ts";

function insertArticle(e: TestEnv, boardId: number, urlId: string, deletedAtSecsAgo: number): void {
  const r = e.store.insertArticle({
    boardId,
    urlId,
    urlTimestamp: 1500000000,
    postedAt: null,
    title: "Article",
    author: "user",
    content: "x".repeat(40),
    ip: null,
    mark: "",
    nrecRaw: "5",
    pushCount: 0,
    booCount: 0,
    neutralCount: 0,
    netCount: 5,
  });
  e.db.prepare("UPDATE articles SET deleted_at = ? WHERE id = ?").run(nowSecs() - deletedAtSecsAgo, r.id);
}

function articlePage(urlId: string): string {
  return `<html><body><div id="main-content">
	<div class="article-metaline"><span class="article-meta-tag">作者</span><span class="article-meta-value">user (nick)</span></div>
	<div class="article-metaline"><span class="article-meta-tag">標題</span><span class="article-meta-value">${urlId}</span></div>
	<div class="article-metaline"><span class="article-meta-tag">時間</span><span class="article-meta-value">Mon Jan  1 12:00:00 2024</span></div>
	body text for ${urlId}
	<span class="f2">※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4 (臺灣)</span>
</div></body></html>`;
}

test("audit: URL alive (200) resurrects the article and records 'alive'", async () => {
  const e = env(
    pathServer({
      "/bbs/AudBoard/M.1500000000.A.BACK.html": articlePage("M.1500000000.A.BACK"),
    }),
  );
  const board = e.store.upsertBoard({ name: "AudBoard" });
  insertArticle(e, board.id, "M.1500000000.A.BACK", 25 * 3600); // 25h ago — inside audit window

  const c = await runDeletionAudit(e.fetcher, e.store);

  expect(c.checked).toBe(1);
  expect(c.resurrected).toBe(1);
  expect(e.store.getArticleByBoardUrlID(board.id, "M.1500000000.A.BACK")!.deletedAt).toBeNull();
  const row = e.db.prepare("SELECT result FROM deletion_audits WHERE board_id = ? AND url_id = ?").get(board.id, "M.1500000000.A.BACK") as { result: string };
  expect(row.result).toBe("alive");
});

test("audit: URL 404 keeps the article deleted and records 'gone'", async () => {
  const e = env(pathServer({})); // no route → 404
  const board = e.store.upsertBoard({ name: "AudBoard" });
  insertArticle(e, board.id, "M.1500000001.A.GONE", 25 * 3600);

  const c = await runDeletionAudit(e.fetcher, e.store);

  expect(c.gone).toBe(1);
  expect(e.store.getArticleByBoardUrlID(board.id, "M.1500000001.A.GONE")!.deletedAt).not.toBeNull();
  const row = e.db.prepare("SELECT result FROM deletion_audits WHERE board_id = ? AND url_id = ?").get(board.id, "M.1500000001.A.GONE") as { result: string };
  expect(row.result).toBe("gone");
});

test("audit: transient 5xx records nothing — retried next run", async () => {
  const e = env((req: Request) => new Response("boom", { status: 500 }));
  const board = e.store.upsertBoard({ name: "AudBoard" });
  insertArticle(e, board.id, "M.1500000002.A.FLAKY", 25 * 3600);

  const c = await runDeletionAudit(e.fetcher, e.store);

  expect(c.checked).toBe(0);
  expect(c.gone).toBe(0);
  expect(c.resurrected).toBe(0);
  const n = e.db.prepare("SELECT count(*) AS c FROM deletion_audits").get() as { c: number };
  expect(n.c).toBe(0);
  expect(e.store.getArticleByBoardUrlID(board.id, "M.1500000002.A.FLAKY")!.deletedAt).not.toBeNull();
});

test("audit: deletion younger than the 24h delay is not selected", async () => {
  const e = env(pathServer({})); // would 404 — but must not even be fetched
  const board = e.store.upsertBoard({ name: "AudBoard" });
  insertArticle(e, board.id, "M.1500000003.A.FRESH", 1 * 3600); // 1h ago

  const c = await runDeletionAudit(e.fetcher, e.store);

  expect(c.checked).toBe(0);
  const n = e.db.prepare("SELECT count(*) AS c FROM deletion_audits").get() as { c: number };
  expect(n.c).toBe(0);
});

test("audit: each article is audited exactly once", async () => {
  const e = env(pathServer({}));
  const board = e.store.upsertBoard({ name: "AudBoard" });
  insertArticle(e, board.id, "M.1500000004.A.ONCE", 25 * 3600);

  const first = await runDeletionAudit(e.fetcher, e.store);
  expect(first.checked).toBe(1);

  const second = await runDeletionAudit(e.fetcher, e.store);
  expect(second.checked).toBe(0);
});

// env() wraps setupTestEnv with the standard fetcher used by crawl tests.
function env(routes: Parameters<typeof pathServer>[0] | ((req: Request) => Response)): TestEnv {
  if (typeof routes === "function") {
    return setupTestEnv(routes);
  }
  return setupTestEnv(pathServer(routes));
}
