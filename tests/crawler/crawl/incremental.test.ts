import { test, expect, afterEach } from "bun:test";
import {
  setupTestEnv,
  pathServer,
  cannedArticleAAA,
  type TestEnv,
} from "./testutil.ts";
import { processBoardIncremental } from "../../../src/crawler/crawl/incremental.ts";
import { indexMetaChanged } from "../../../src/crawler/crawl/backfill.ts";

const envs: TestEnv[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.stop();
});

function env(handler: (req: Request) => Response | Promise<Response>): TestEnv {
  const e = setupTestEnv(handler);
  envs.push(e);
  return e;
}

function idxHTML(nrec: string): string {
  return `<html><body>
	<div class="r-list-container">
		<div class="r-ent">
			<div class="nrec"><span class="hl f2">${nrec}</span></div>
			<div class="title"><a href="/bbs/TestBoard/M.1000000000.A.AAA.html">Article One</a></div>
			<div class="meta"><div class="author">user1</div><div class="date"> 1/01</div><div class="mark"></div></div>
		</div>
	</div>
	<div class="btn-group btn-group-paging">
		<a class="btn" href="/bbs/TestBoard/index1.html">最舊</a>
		<a class="btn" href="/bbs/TestBoard/index1.html">&lsaquo; 上頁</a>
		<a class="btn disabled">下頁</a>
		<a class="btn" href="/bbs/TestBoard/index.html">最新</a>
	</div>
	</body></html>`;
}

test("incremental: new article fetched + inserted", async () => {
  const e = env(
    pathServer({
      "/bbs/TestBoard/index.html": idxHTML("3"),
      "/bbs/TestBoard/M.1000000000.A.AAA.html": cannedArticleAAA,
    }),
  );

  const board = e.store.upsertBoard({ name: "TestBoard" });
  await processBoardIncremental(e.fetcher, e.store, board, undefined, 3);

  const art = e.store.getArticleByBoardUrlID(board.id, "M.1000000000.A.AAA");
  expect(art).not.toBeNull();
  expect(art!.title).toBe("Article One");
  expect(art!.pushCount).toBe(1);
});

test("incremental: interval resets to configured floor on new articles, doubles when quiet", async () => {
  const e = env(
    pathServer({
      "/bbs/TestBoard/index.html": idxHTML("3"),
      "/bbs/TestBoard/M.1000000000.A.AAA.html": cannedArticleAAA,
    }),
  );

  // Active board: new article discovered → reset to the passed floor (60s)
  const board = e.store.upsertBoard({ name: "TestBoard" });
  e.store.setBoardInterval(board.id, 3600, 0);
  await processBoardIncremental(e.fetcher, e.store, e.store.getBoardByName("TestBoard")!, undefined, 3, 60, 86400);
  expect(e.store.getBoardByName("TestBoard")!.checkIntervalSecs).toBe(60);

  // Quiet board: same index, nothing new → double from current, capped by max
  e.store.setBoardInterval(board.id, 5000, 0);
  await processBoardIncremental(e.fetcher, e.store, e.store.getBoardByName("TestBoard")!, undefined, 3, 60, 7200);
  expect(e.store.getBoardByName("TestBoard")!.checkIntervalSecs).toBe(7200);
});

test("incremental: nrec change triggers push re-fetch", async () => {
  const e = env(
    pathServer({
      "/bbs/TestBoard/index.html": idxHTML("10"),
      "/bbs/TestBoard/M.1000000000.A.AAA.html": cannedArticleAAA,
    }),
  );

  const board = e.store.upsertBoard({ name: "TestBoard" });
  const old = e.store.insertArticle({
    boardId: board.id,
    urlId: "M.1000000000.A.AAA",
    urlTimestamp: 1000000000,
    postedAt: null,
    title: "Article One",
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

  await processBoardIncremental(e.fetcher, e.store, board, undefined, 3);

  const updated = e.store.getArticleByBoardUrlID(board.id, "M.1000000000.A.AAA")!;
  expect(updated.nrecRaw).toBe("10");
  expect(updated.pushCount).toBe(1); // re-fetched

  // Old article had 0 pushes; re-fetched article has 2 (推 + 噓)
  const n = (e.db.prepare("SELECT count(*) AS c FROM pushes WHERE article_id = ?").get(old.id) as { c: number }).c;
  expect(n).toBe(2);
});

test("incremental: same nrec → no refetch, interval doubles", async () => {
  let articleHits = 0;
  const e = env((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/bbs/TestBoard/index.html") return new Response(idxHTML("5"));
    if (path === "/bbs/TestBoard/M.1000000000.A.AAA.html") {
      articleHits++;
      return new Response(cannedArticleAAA);
    }
    return new Response("not found", { status: 404 });
  });

  const created = e.store.upsertBoard({ name: "TestBoard" });
  e.store.insertArticle({
    boardId: created.id,
    urlId: "M.1000000000.A.AAA",
    urlTimestamp: 1000000000,
    postedAt: null,
    title: null,
    author: null,
    content: null,
    ip: null,
    mark: null,
    nrecRaw: "5", // SAME nrec → no change
    pushCount: null,
    booCount: null,
    neutralCount: null,
    netCount: null,
  });

  const board = e.store.getBoardByName("TestBoard")!;
  await processBoardIncremental(e.fetcher, e.store, board, undefined, 3);

  // Interval should have doubled: 600 → 1200
  expect(e.store.getBoardByID(created.id)!.checkIntervalSecs).toBe(1200);
  // Article page should NOT have been fetched
  expect(articleHits).toBe(0);
});

test("incremental: 404 on re-fetch marks deleted", async () => {
  const e = env(
    pathServer({
      "/bbs/TestBoard/index.html": idxHTML("99"),
      // Article page NOT served → 404
    }),
  );

  const board = e.store.upsertBoard({ name: "TestBoard" });
  e.store.insertArticle({
    boardId: board.id,
    urlId: "M.1000000000.A.AAA",
    urlTimestamp: 1000000000,
    postedAt: null,
    title: null,
    author: null,
    content: null,
    ip: null,
    mark: null,
    nrecRaw: "5", // old nrec triggers re-fetch → 404 → delete
    pushCount: null,
    booCount: null,
    neutralCount: null,
    netCount: null,
  });

  const fresh = e.store.getBoardByName("TestBoard")!;
  await processBoardIncremental(e.fetcher, e.store, fresh);

  expect(e.store.getArticleByBoardUrlID(board.id, "M.1000000000.A.AAA")!.deletedAt).not.toBeNull();
});

test("incremental: mark-only change persists without article refetch", async () => {
  let articleHits = 0;
  const e = env((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/bbs/TestBoard/index.html") {
      return new Response(idxHTML("5").replace('<div class="mark"></div>', '<div class="mark">!</div>'));
    }
    if (path === "/bbs/TestBoard/M.1000000000.A.AAA.html") {
      articleHits++;
      return new Response(cannedArticleAAA);
    }
    return new Response("not found", { status: 404 });
  });

  const board = e.store.upsertBoard({ name: "TestBoard" });
  e.store.insertArticle({
    boardId: board.id,
    urlId: "M.1000000000.A.AAA",
    urlTimestamp: 1000000000,
    postedAt: null,
    title: "Article One",
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

  await processBoardIncremental(e.fetcher, e.store, board, undefined, 3);

  const updated = e.store.getArticleByBoardUrlID(board.id, "M.1000000000.A.AAA")!;
  expect(updated.mark).toBe("!"); // gate tripped by mark alone → written
  expect(articleHits).toBe(0); // nrec unchanged → no article refetch
});

test("indexMetaChanged: no-op rewrite gate", () => {
  const mk = (nrecRaw: string | null, mark: string | null) =>
    ({ nrecRaw, mark }) as import("../../../src/db/types.ts").Article;
  const ent = (nrecRaw: string, mark: string) =>
    ({ nrecRaw, mark }) as import("../../../src/crawler/ptt/types.ts").IndexEntry;

  expect(indexMetaChanged(mk("5", null), ent("5", ""))).toBe(false); // unchanged
  expect(indexMetaChanged(mk(null, "M"), ent("", "M"))).toBe(false); // empty == absent
  expect(indexMetaChanged(mk("5", null), ent("10", ""))).toBe(true); // nrec changed
  expect(indexMetaChanged(mk("5", null), ent("5", "!"))).toBe(true); // mark changed
});
