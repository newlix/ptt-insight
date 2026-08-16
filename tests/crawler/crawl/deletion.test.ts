import { test, expect, afterEach } from "bun:test";
import { setupTestEnv, pathServer, type TestEnv } from "./testutil.ts";
import { processBoardIncremental } from "../../../src/crawler/crawl/incremental.ts";

const envs: TestEnv[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.stop();
});

function env(handler: (req: Request) => Response | Promise<Response>): TestEnv {
  const e = setupTestEnv(handler);
  envs.push(e);
  return e;
}

// deletionIndexPage renders an index page with the given article URLIDs.
function deletionIndexPage(page: number, _older: number, ...urlIds: string[]): string {
  const ents = urlIds
    .map(
      (id) => `
	<div class="r-ent">
		<div class="nrec"><span>5</span></div>
		<div class="title"><a href="/bbs/DelBoard/${id}.html">Article</a></div>
		<div class="meta"><div class="author">user</div><div class="date">1/01</div><div class="mark"></div></div>
	</div>`,
    )
    .join("");
  return `<html><body><div class="r-list-container">${ents}</div>
<div class="btn-group btn-group-paging">
	<a class="btn" href="/bbs/DelBoard/index${page - 1}.html">上頁</a>
	<a class="btn disabled">下頁</a>
	<a class="btn" href="/bbs/DelBoard/index.html">最新</a>
</div></body></html>`;
}

function insertArticle(e: TestEnv, boardId: number, urlId: string, urlTimestamp: number): void {
  e.store.insertArticle({
    boardId,
    urlId,
    urlTimestamp,
    postedAt: null,
    title: null,
    author: null,
    content: null,
    ip: null,
    mark: null,
    nrecRaw: "5",
    pushCount: null,
    booCount: null,
    neutralCount: null,
    netCount: null,
  });
}

test("deletion detected: absent from both pages, newer than each page's oldest", async () => {
  // Latest page: OLD (ts 1000000000) and NEW (ts 2000000000); VANISHED (1500000000) missing.
  const e = env(
    pathServer({
      "/bbs/DelBoard/index.html": deletionIndexPage(2, 1, "M.1000000000.A.OLD", "M.2000000000.A.NEW"),
      "/bbs/DelBoard/index1.html": deletionIndexPage(1, 0, "M.900000000.A.OLDER"),
    }),
  );

  const board = e.store.upsertBoard({ name: "DelBoard" });
  insertArticle(e, board.id, "M.1500000000.A.VANISHED", 1500000000);

  await processBoardIncremental(e.fetcher, e.store, board);

  const art = e.store.getArticleByBoardUrlID(board.id, "M.1500000000.A.VANISHED");
  expect(art).not.toBeNull();
  expect(art!.deletedAt).not.toBeNull();
});

test("scrolled article (on previous page) NOT deleted", async () => {
  const e = env(
    pathServer({
      "/bbs/DelBoard/index.html": deletionIndexPage(3, 2, "M.2000000000.A.NEW"),
      "/bbs/DelBoard/index2.html": deletionIndexPage(2, 1, "M.1500000000.A.SCROLLED", "M.1000000000.A.OLD"),
    }),
  );

  const board = e.store.upsertBoard({ name: "DelBoard" });
  insertArticle(e, board.id, "M.1500000000.A.SCROLLED", 1500000000);

  await processBoardIncremental(e.fetcher, e.store, board);

  const art = e.store.getArticleByBoardUrlID(board.id, "M.1500000000.A.SCROLLED");
  expect(art!.deletedAt).toBeNull();
});

// articlePage renders a minimal valid article page for index entries that
// get crawled as "new" during a check (stale-snapshot scenarios).
function articlePage(urlId: string): string {
  return `<html><body><div id="main-content">
	<div class="article-metaline"><span class="article-meta-tag">作者</span><span class="article-meta-value">user (nick)</span></div>
	<div class="article-metaline"><span class="article-meta-tag">標題</span><span class="article-meta-value">${urlId}</span></div>
	<div class="article-metaline"><span class="article-meta-tag">時間</span><span class="article-meta-value">Mon Jan  1 12:00:00 2024</span></div>
	body text for ${urlId}
	<span class="f2">※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4 (臺灣)
	</span>
</div></body></html>`;
}

// --- 2026-08-16 incident re-enactment: PTT maintenance window served stale
// index pages; the old code mass-deleted 47K articles (C_Chat 29.5K) from one
// snapshot. The three defenses below must each stop that failure mode. ---

test("mass-deletion guard: stale snapshot yielding 150 candidates is refused", async () => {
  // Stale snapshot: only two ancient entries — every stored article is newer
  // than its oldest entry and absent from it. Static route = both the first
  // fetch and the Stage-1 re-fetch see the same stale page.
  const e = env(
    pathServer({
      "/bbs/DelBoard/index.html": deletionIndexPage(600, 599, "M.1000000000.A.S1", "M.1000000001.A.S2"),
      "/bbs/DelBoard/M.1000000000.A.S1.html": articlePage("M.1000000000.A.S1"),
      "/bbs/DelBoard/M.1000000001.A.S2.html": articlePage("M.1000000001.A.S2"),
    }),
  );

  const board = e.store.upsertBoard({ name: "DelBoard" });
  for (let i = 0; i < 150; i++) {
    insertArticle(e, board.id, `M.${1000100000 + i}.A.N${i}`, 1000100000 + i);
  }

  await processBoardIncremental(e.fetcher, e.store, board);

  const n = e.db.prepare("SELECT count(*) AS c FROM articles WHERE deleted_at IS NOT NULL").get() as {
    c: number;
  };
  expect(n.c).toBe(0);
});

test("transient anomalous snapshot: fresh re-fetch clears candidates — nothing deleted", async () => {
  const stale = deletionIndexPage(600, 599, "M.1000000000.A.S1");
  const fresh = deletionIndexPage(600, 599, "M.1500000001.A.A", "M.1500000002.A.B", "M.1500000003.A.C");
  let indexFetches = 0;
  const e = env((req: Request) => {
    if (new URL(req.url).pathname === "/bbs/DelBoard/index.html") {
      const html = indexFetches++ === 0 ? stale : fresh;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  });

  const board = e.store.upsertBoard({ name: "DelBoard" });
  // B is inside the fresh page's coverage but absent from the stale one.
  insertArticle(e, board.id, "M.1500000002.A.B", 1500000002);

  await processBoardIncremental(e.fetcher, e.store, board);

  const art = e.store.getArticleByBoardUrlID(board.id, "M.1500000002.A.B");
  expect(art).not.toBeNull();
  expect(art!.deletedAt).toBeNull();
});

test("verify page fetch failure leaves candidates untouched", async () => {
  // index2.html (second-newest page) is missing → verification cannot run.
  const e = env(
    pathServer({
      "/bbs/DelBoard/index.html": deletionIndexPage(3, 2, "M.2000000000.A.NEW", "M.1000000000.A.OLD"),
    }),
  );

  const board = e.store.upsertBoard({ name: "DelBoard" });
  insertArticle(e, board.id, "M.1500000000.A.MAYBE", 1500000000);

  await processBoardIncremental(e.fetcher, e.store, board);

  const art = e.store.getArticleByBoardUrlID(board.id, "M.1500000000.A.MAYBE");
  expect(art).not.toBeNull();
  expect(art!.deletedAt).toBeNull();
});

test("Stage-1 re-fetch failure (network) leaves candidates untouched", async () => {
  // First fetch succeeds and produces a candidate; the re-fetch 500s out.
  const good = deletionIndexPage(3, 2, "M.2000000000.A.NEW", "M.1000000000.A.OLD");
  let indexFetches = 0;
  const e = env((req: Request) => {
    if (new URL(req.url).pathname === "/bbs/DelBoard/index.html") {
      if (indexFetches++ === 0) {
        return new Response(good, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response("boom", { status: 500 });
    }
    return new Response("not found", { status: 404 });
  });

  const board = e.store.upsertBoard({ name: "DelBoard" });
  insertArticle(e, board.id, "M.1500000000.A.MAYBE", 1500000000);

  await processBoardIncremental(e.fetcher, e.store, board);

  const art = e.store.getArticleByBoardUrlID(board.id, "M.1500000000.A.MAYBE");
  expect(art).not.toBeNull();
  expect(art!.deletedAt).toBeNull();
});

test("resurrection: article listed on the index page clears its deletion mark", async () => {
  const e = env(
    pathServer({
      "/bbs/DelBoard/index.html": deletionIndexPage(2, 1, "M.1500000000.A.BACK"),
    }),
  );

  const board = e.store.upsertBoard({ name: "DelBoard" });
  insertArticle(e, board.id, "M.1500000000.A.BACK", 1500000000);
  e.db.prepare("UPDATE articles SET deleted_at = 1000").run();

  await processBoardIncremental(e.fetcher, e.store, board);

  const art = e.store.getArticleByBoardUrlID(board.id, "M.1500000000.A.BACK");
  expect(art).not.toBeNull();
  expect(art!.deletedAt).toBeNull();
});

test("gray-zone article (older than verified page) stays untouched", async () => {
  const e = env(
    pathServer({
      "/bbs/DelBoard/index.html": deletionIndexPage(3, 2, "M.2000000000.A.NEW"),
      "/bbs/DelBoard/index2.html": deletionIndexPage(2, 1, "M.1800000000.A.OLD2"),
    }),
  );

  const board = e.store.upsertBoard({ name: "DelBoard" });
  // GRAY is older than page2's oldest (1800000000).
  insertArticle(e, board.id, "M.1500000000.A.GRAY", 1500000000);

  await processBoardIncremental(e.fetcher, e.store, board);

  const art = e.store.getArticleByBoardUrlID(board.id, "M.1500000000.A.GRAY");
  expect(art!.deletedAt).toBeNull();
});
