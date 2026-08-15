import { test, expect, afterEach } from "bun:test";
import { setupTestEnv, pathServer, type TestEnv } from "./testutil.ts";
import { discoverHotBoards, discoverBoards } from "../../../src/crawler/crawl/discovery.ts";

const envs: TestEnv[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.stop();
});

function env(handler: (req: Request) => Response | Promise<Response>): TestEnv {
  const e = setupTestEnv(handler);
  envs.push(e);
  return e;
}

test("discoverHotBoards upserts boards with user counts", async () => {
  const hotHTML = `<html><body>
	<div class="b-list-container">
		<div class="b-ent">
			<a class="board" href="/bbs/Gossiping/index.html">
				<div class="board-name">Gossiping</div>
				<div class="board-nuser"><span class="hl f1">4000</span></div>
				<div class="board-class">綜合</div>
				<div class="board-title">◎[八卦] test</div>
			</a>
		</div>
		<div class="b-ent">
			<a class="board" href="/bbs/Stock/index.html">
				<div class="board-name">Stock</div>
				<div class="board-nuser"><span class="hl f1">3000</span></div>
				<div class="board-class">學術</div>
				<div class="board-title">◎[股票]</div>
			</a>
		</div>
		<div class="b-ent">
			<a class="board" href="/bbs/Soft_Job/index.html">
				<div class="board-name">Soft_Job</div>
				<div class="board-nuser">10</div>
				<div class="board-class">工作</div>
				<div class="board-title">◎[軟工]</div>
			</a>
		</div>
	</div></body></html>`;

  const e = env(pathServer({ "/bbs/hotboards.html": hotHTML }));

  await discoverHotBoards(e.fetcher, e.store);

  const gossiping = e.store.getBoardByName("Gossiping")!;
  expect(gossiping).not.toBeNull();
  expect(gossiping.userCount).toBe(4000);
  expect(gossiping.isHot).toBe(true); // marked hot for window-sweep priority

  expect(e.store.getBoardByName("Stock")!.userCount).toBe(3000);
  expect(e.store.getBoardByName("Soft_Job")!.userCount).toBe(10);

  // Boards should have next_check_at set (ready for incremental)
  expect(gossiping.nextCheckAt).not.toBeNull();
});

test("discoverBoards recurses /cls/ tree", async () => {
  const cls1HTML = `<html><body>
	<div class="b-list-container">
		<div class="b-ent">
			<a class="board" href="/cls/100">
				<div class="board-name">H_Group</div>
				<div class="board-nuser"></div>
				<div class="board-class">一一</div>
				<div class="board-title">Σ戰略高手</div>
			</a>
		</div>
	</div></body></html>`;

  const cls100HTML = `<html><body>
	<div class="b-list-container">
		<div class="b-ent">
			<a class="board" href="/bbs/Gossiping/index.html">
				<div class="board-name">Gossiping</div>
				<div class="board-nuser"><span class="hl">100</span></div>
				<div class="board-class">綜合</div>
				<div class="board-title">◎[八卦]</div>
			</a>
		</div>
		<div class="b-ent">
			<a class="board" href="/bbs/Stock/index.html">
				<div class="board-name">Stock</div>
				<div class="board-nuser">50</div>
				<div class="board-class">學術</div>
				<div class="board-title">◎[股票]</div>
			</a>
		</div>
	</div></body></html>`;

  const e = env(
    pathServer({
      "/cls/1": cls1HTML,
      "/cls/100": cls100HTML,
    }),
  );

  await discoverBoards(e.fetcher, e.store);

  expect(e.store.countBoards()).toBe(2);
  const g = e.store.getBoardByName("Gossiping")!;
  expect(g.categoryPath).toBe("H_Group > Gossiping");
});
