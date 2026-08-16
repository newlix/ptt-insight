import { test, expect } from "bun:test";
import { openMemoryDB } from "../../../src/db/sqlite.ts";
import { migrate } from "../../../src/db/migrate.ts";
import { createStore } from "../../../src/db/store.ts";

// is_hot=1 hard filter on board claiming: we only track hot boards.

function seed() {
  const db = openMemoryDB();
  migrate(db);
  const store = createStore(db);
  const mk = (name: string, hot: number) =>
    db.prepare(`INSERT INTO boards (name, is_hot, user_count) VALUES (?, ?, 100)`).run(name, hot);
  mk("Hot", 1);
  mk("Cold", 0);
  return { db, store };
}

test("claimNextBoard only returns hot boards", () => {
  const { db, store } = seed();
  // make both claimable
  db.prepare(`UPDATE boards SET next_check_at = ?`).run(Math.floor(Date.now() / 1000) - 10);

  const first = store.claimNextBoard();
  expect(first?.name).toBe("Hot");
  // Cold never becomes claimable, even after Hot's next check is pushed forward
  db.prepare(`UPDATE boards SET next_check_at = ? WHERE is_hot = 1`).run(Math.floor(Date.now() / 1000) + 9999);
  expect(store.claimNextBoard()).toBeNull();
});

test("claimBackfillBoard only claims hot boards, even when all hot are done", () => {
  const { db, store } = seed();
  const cold = (db.prepare(`SELECT id FROM boards WHERE name = 'Cold'`).get() as { id: number }).id;
  void cold;

  const claimed = store.claimBackfillBoard();
  expect(claimed?.name).toBe("Hot");

  // mark hot complete → backfill stops entirely (no fallthrough to cold)
  db.prepare(`UPDATE boards SET backfill_complete = 1 WHERE is_hot = 1`).run();
  db.prepare(`UPDATE boards SET backfill_complete = 0 WHERE name = 'Cold'`).run();
  expect(store.claimBackfillBoard()).toBeNull();
});
