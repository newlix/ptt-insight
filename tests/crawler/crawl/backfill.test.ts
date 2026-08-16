import { test, expect, afterEach } from "bun:test";
import {
  setupTestEnv,
  pathServer,
  cannedIndexPage,
  cannedIndex1Page,
  cannedArticleAAA,
  cannedArticleBBB,
  cannedArticleCCC,
  type TestEnv,
} from "./testutil.ts";
import { backfillBoard, processArticle, nrecChanged } from "../../../src/crawler/crawl/backfill.ts";
import type { IndexEntry } from "../../../src/crawler/ptt/types.ts";

const envs: TestEnv[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.stop();
});

function env(handler: (req: Request) => Response | Promise<Response>): TestEnv {
  const e = setupTestEnv(handler);
  envs.push(e);
  return e;
}

test("backfillBoard inserts articles (full 2-page board)", async () => {
  const e = env(
    pathServer({
      "/bbs/TestBoard/index.html": cannedIndexPage, // latest (page 2)
      "/bbs/TestBoard/index2.html": cannedIndexPage, // same content
      "/bbs/TestBoard/index1.html": cannedIndex1Page,
      "/bbs/TestBoard/M.1000000000.A.AAA.html": cannedArticleAAA,
      "/bbs/TestBoard/M.2000000000.A.BBB.html": cannedArticleBBB,
      "/bbs/TestBoard/M.500000000.A.CCC.html": cannedArticleCCC,
    }),
  );

  const board = e.store.upsertBoard({ name: "TestBoard" });
  await backfillBoard(e.fetcher, e.store, board, 0, 0, undefined, 3);

  // 3 articles inserted
  expect(e.store.countArticlesByBoard(board.id)).toBe(3);

  // AAA has 1 push + 1 boo
  const aaa = e.store.getArticleByBoardUrlID(board.id, "M.1000000000.A.AAA")!;
  expect(aaa.pushCount).toBe(1);
  expect(aaa.booCount).toBe(1);

  // BBB has 0 pushes
  const bbb = e.store.getArticleByBoardUrlID(board.id, "M.2000000000.A.BBB")!;
  expect(bbb.pushCount).toBe(0);

  // Board marked complete
  expect(e.store.getBoardByID(board.id)!.backfillComplete).toBe(true);
});

test("backfillBoard resumes without re-fetching page 2", async () => {
  let page2Hits = 0;
  const e = env((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/bbs/TestBoard/index2.html" || path === "/bbs/TestBoard/index.html") {
      page2Hits++;
    }
    switch (path) {
      case "/bbs/TestBoard/index1.html":
        return new Response(cannedIndex1Page);
      case "/bbs/TestBoard/M.500000000.A.CCC.html":
        return new Response(cannedArticleCCC);
      default:
        return new Response("not found", { status: 404 });
    }
  });

  const created = e.store.upsertBoard({ name: "TestBoard" });
  e.store.updateBackfillProgress(created.id, 2, 2); // page 2 already crawled
  const board = e.store.getBoardByID(created.id)!;

  await backfillBoard(e.fetcher, e.store, board, 0, 0, undefined, 3);

  // Page 2 (index.html/index2.html) should NOT have been fetched
  expect(page2Hits).toBe(0);

  // Article CCC from page 1 should be in DB
  expect(e.store.countArticlesByBoard(board.id)).toBe(1);

  // Board complete
  expect(e.store.getBoardByID(board.id)!.backfillComplete).toBe(true);
});

test("backfillBoard stops at window boundary", async () => {
  const e = env(
    pathServer({
      "/bbs/TestBoard/index.html": cannedIndexPage, // latest (page 2)
      "/bbs/TestBoard/index2.html": cannedIndexPage,
      "/bbs/TestBoard/M.1000000000.A.AAA.html": cannedArticleAAA,
      "/bbs/TestBoard/M.2000000000.A.BBB.html": cannedArticleBBB,
      // page 1 (CCC) intentionally absent — must never be fetched
    }),
  );

  const board = e.store.upsertBoard({ name: "TestBoard" });

  // Window bottom between AAA (2001) and BBB (2033)
  await backfillBoard(e.fetcher, e.store, board, 0, 1100000000);

  // Both articles on the boundary page are stored (no data loss)
  expect(e.store.countArticlesByBoard(board.id)).toBe(2);

  // Board records contiguous coverage, NOT fully complete
  const got = e.store.getBoardByID(board.id)!;
  expect(got.windowFloor).toBe(1000000000);
  expect(got.backfillComplete).toBe(false);
  expect(got.lastBackfillPage).toBe(2);
});

test("backfillBoard full crawl when boundary older than everything", async () => {
  const e = env(
    pathServer({
      "/bbs/TestBoard/index.html": cannedIndexPage,
      "/bbs/TestBoard/index2.html": cannedIndexPage,
      "/bbs/TestBoard/index1.html": cannedIndex1Page,
      "/bbs/TestBoard/M.1000000000.A.AAA.html": cannedArticleAAA,
      "/bbs/TestBoard/M.2000000000.A.BBB.html": cannedArticleBBB,
      "/bbs/TestBoard/M.500000000.A.CCC.html": cannedArticleCCC,
    }),
  );

  const board = e.store.upsertBoard({ name: "TestBoard" });
  await backfillBoard(e.fetcher, e.store, board, 0, 400000000); // 1982

  expect(e.store.countArticlesByBoard(board.id)).toBe(3);
  expect(e.store.getBoardByID(board.id)!.backfillComplete).toBe(true);
});

test("processArticle marks article deleted on 404", async () => {
  const e = env(pathServer({})); // 404 for everything

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
    nrecRaw: "5",
    pushCount: null,
    booCount: null,
    neutralCount: null,
    netCount: null,
  });

  const entry: IndexEntry = { urlId: "M.1000000000.A.AAA", title: "Test", author: "-", date: "1/01", nrecRaw: "5", mark: "", deleted: false };
  await processArticle(e.fetcher, e.store, board, entry);

  expect(e.store.getArticleByBoardUrlID(board.id, "M.1000000000.A.AAA")!.deletedAt).not.toBeNull();
});

test("nrecChanged table", () => {
  const entryOf = (nrecRaw: string): IndexEntry => ({
    urlId: "x", title: "", author: "", date: "", nrecRaw, mark: "", deleted: false,
  });
  expect(nrecChanged("", entryOf(""))).toBe(false); // both empty
  expect(nrecChanged("5", entryOf("5"))).toBe(false); // same value
  expect(nrecChanged("5", entryOf("10"))).toBe(true); // changed
  expect(nrecChanged(null, entryOf(""))).toBe(false); // stored nil entry empty
  expect(nrecChanged(null, entryOf("5"))).toBe(true); // stored nil entry nonempty
  expect(nrecChanged("", entryOf("5"))).toBe(true); // stored empty entry nonempty
});

test("backfillBoard releases claim on batch pause (not just at boundary)", async () => {
  const e = env(
    pathServer({
      "/bbs/TestBoard/index.html": cannedIndexPage, // latest (page 2)
      "/bbs/TestBoard/index2.html": cannedIndexPage,
      "/bbs/TestBoard/index1.html": cannedIndex1Page,
      "/bbs/TestBoard/M.1000000000.A.AAA.html": cannedArticleAAA,
      "/bbs/TestBoard/M.2000000000.A.BBB.html": cannedArticleBBB,
    }),
  );

  const created = e.store.upsertBoard({ name: "TestBoard" });
  e.store.markBoardsHot(["TestBoard"]);
  // Production always has the window_bottom meta row (migration-seeded to a
  // recent date); canned pages use 2001-era timestamps, so pin the boundary
  // low enough that this board reads as mid-window (floor > bottom).
  e.db
    .prepare("UPDATE backfill_meta SET value = 1 WHERE key = 'window_bottom'")
    .run();

  // Simulate the worker claiming the board before its batch.
  const claimed = e.store.claimBackfillBoard();
  expect(claimed).not.toBeNull();
  expect(claimed!.backfillClaimedAt).not.toBeNull();

  // batchPages=1 on a 2-page board: crawls page 2 only, pauses (endPage=2 > 1).
  await backfillBoard(e.fetcher, e.store, claimed!, 1, 0, undefined, 3);

  const got = e.store.getBoardByName("TestBoard")!;
  expect(got.backfillComplete).toBe(false);
  expect(got.lastBackfillPage).toBe(2);
  // Claim released — board immediately re-claimable instead of 6h-excluded.
  expect(got.backfillClaimedAt).toBeNull();
  const reclaimed = e.store.claimBackfillBoard();
  expect(reclaimed).not.toBeNull();
});
