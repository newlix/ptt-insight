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
