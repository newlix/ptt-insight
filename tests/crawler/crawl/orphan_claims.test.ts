import { test, expect, afterEach } from "bun:test";
import {
  setupTestEnv,
  pathServer,
  type TestEnv,
} from "./testutil.ts";
import { runBackfillWorker, releaseOrphanedClaims } from "../../src/crawler/crawl/backfill.ts";

const envs: TestEnv[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.stop();
});

function env(handler: (req: Request) => Response | Promise<Response>): TestEnv {
  const e = setupTestEnv(handler);
  envs.push(e);
  return e;
}

test("releaseOrphanedClaims clears stale claims so boards are reclaimable after restart", async () => {
  const e = env(pathServer({}));

  // simulate a previous process that claimed a board then died mid-batch
  const board = e.store.upsertBoard({ name: "TestBoard" });
  e.db.prepare("UPDATE boards SET backfill_claimed_at = ?, window_floor = NULL WHERE id = ?").run(
    Math.floor(Date.now() / 1000) - 60, // claimed 1 min ago — inside the 6h exclusion
    board.id,
  );

  // claim excluded → null
  expect(e.store.claimBackfillBoard()!.id).not.toBe(board.id);

  // startup release clears it and the board becomes claimable again
  expect(releaseOrphanedClaims(e.store)).toBe(1);
  const claimed = e.store.claimBackfillBoard();
  expect(claimed).not.toBeNull();
  expect(claimed!.name).toBe("TestBoard");
});
