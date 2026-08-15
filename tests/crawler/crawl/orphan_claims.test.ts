import { test, expect, afterEach } from "bun:test";
import {
  setupTestEnv,
  pathServer,
  type TestEnv,
} from "./testutil.ts";
import { runBackfillWorker, releaseOrphanedClaims } from "../../../src/crawler/crawl/backfill.ts";

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

  // sole board claimed → inside the 6h exclusion → nothing claimable
  expect(e.store.claimBackfillBoard()).toBeNull();

  // startup release clears it and the board becomes claimable again
  // (run().changes counts trigger updates too — assert the invariant, not the count)
  expect(releaseOrphanedClaims(e.store)).toBeGreaterThan(0);
  expect(
    (e.db.prepare("SELECT count(*) AS c FROM boards WHERE backfill_claimed_at IS NOT NULL").get() as { c: number }).c,
  ).toBe(0);
  const claimed = e.store.claimBackfillBoard();
  expect(claimed).not.toBeNull();
  expect(claimed!.name).toBe("TestBoard");
});
