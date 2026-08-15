import { test, expect } from "bun:test";
import { openMemoryDB } from "../../src/db/sqlite.ts";
import { migrate } from "../../src/db/migrate.ts";
import { createStore } from "../../src/db/store.ts";
import { nowSecs, secsAfter } from "../../src/db/sqlite.ts";

test("migrate + full query smoke roundtrip", () => {
  const db = openMemoryDB();
  migrate(db);
  migrate(db); // idempotent
  const store = createStore(db);

  // boards: upsert insert
  const gossiping = store.upsertBoard({ name: "Gossiping", title: "◎[八卦]" , userCount: 123 });
  expect(gossiping.id).toBeGreaterThan(0);
  expect(gossiping.backfillComplete).toBe(false);
  expect(gossiping.checkIntervalSecs).toBe(600);
  expect(typeof gossiping.createdAt).toBe("number");

  // upsert conflict: refresh metadata, preserve crawl state
  db.prepare("UPDATE boards SET backfill_complete = 1 WHERE id = ?").run(gossiping.id);
  const again = store.upsertBoard({ name: "Gossiping", title: "◎[八卦]v2" });
  expect(again.id).toBe(gossiping.id);
  expect(again.title).toBe("◎[八卦]v2");
  expect(again.backfillComplete).toBe(true); // preserved

  // boards: hot marking + claim ordering
  store.upsertBoard({ name: "Baseball", userCount: 456 });
  store.markBoardsHot(["Gossiping", "Baseball"]);
  expect(store.getBoardByName("Baseball")!.isHot).toBe(true);

  // claimNextBoard: newly upserted boards are due immediately (by design);
  // claim reschedules from a single clock read (nextCheckAt == lastCheckAt + interval)
  const claimed = store.claimNextBoard();
  expect(claimed!.id).toBe(gossiping.id);
  expect(claimed!.nextCheckAt).toBe(claimed!.lastCheckAt! + claimed!.checkIntervalSecs);
  expect(store.claimNextBoard()!.name).toBe("Baseball"); // also freshly upserted
  expect(store.claimNextBoard()).toBeNull(); // nothing due anymore

  // articles: insert + upsert + lookup
  const art = store.insertArticle({
    boardId: gossiping.id,
    urlId: "M.1786545600.A.D1C",
    urlTimestamp: 1786545600,
    postedAt: 1786545600,
    title: "Test",
    author: "tester",
    content: "body",
    ip: "1.2.3.4",
    mark: "",
    nrecRaw: "5",
    pushCount: 3,
    booCount: 1,
    neutralCount: 0,
    netCount: 2,
  });
  const updated = store.insertArticle({
    boardId: gossiping.id,
    urlId: "M.1786545600.A.D1C",
    urlTimestamp: 1786545600,
    postedAt: 1786545600,
    title: "Test v2",
    author: "tester",
    content: "body v2",
    ip: "1.2.3.4",
    mark: "",
    nrecRaw: "爆",
    pushCount: 100,
    booCount: 1,
    neutralCount: 0,
    netCount: 99,
  });
  expect(updated.id).toBe(art.id); // upsert same row
  expect(updated.nrecRaw).toBe("爆");
  expect(updated.firstSeenAt).toBe(art.firstSeenAt); // preserved on conflict
  const lookup = store.getArticleByBoardUrlID(gossiping.id, "M.1786545600.A.D1C");
  expect(lookup!.pushCount).toBe(100);

  // pushes: delete + batch reinsert
  store.insertPushes([
    { articleId: art.id, seq: 0, tag: "推", userId: "u1", content: "hi", ipdatetime: "1.1.1.1 08/15 12:00" },
    { articleId: art.id, seq: 1, tag: "噓", userId: "u2", content: "no", ipdatetime: "2.2.2.2 08/15 12:01" },
  ]);
  store.deletePushesByArticle(art.id);
  store.insertPushes([
    { articleId: art.id, seq: 0, tag: "推", userId: "u1", content: "hi", ipdatetime: "1.1.1.1 08/15 12:00" },
  ]);
  const pushCount = (db.prepare("SELECT count(*) AS c FROM pushes WHERE article_id = ?").get(art.id) as { c: number }).c;
  expect(pushCount).toBe(1);

  // soft delete + vanished detection
  store.markArticleDeleted(gossiping.id, "M.1786545600.A.D1C");
  expect(store.getArticleByBoardUrlID(gossiping.id, "M.1786545600.A.D1C")!.deletedAt).not.toBeNull();
  store.insertArticle({
    boardId: gossiping.id, urlId: "M.1786545700.A.FFF", urlTimestamp: 1786545700,
    postedAt: 1786545700, title: "t2", author: "a2", content: "c2", ip: null, mark: "",
    nrecRaw: "", pushCount: 0, booCount: 0, neutralCount: 0, netCount: 0,
  });
  const vanished = store.findVanishedArticles(gossiping.id, 1786545650, ["M.1786545700.A.FFF"]);
  expect(vanished.map((v) => v.urlId)).toEqual([]); // deleted article excluded
  const vanished2 = store.findVanishedArticles(gossiping.id, 1786545650, []);
  expect(vanished2.length).toBe(1); // t2 is newer than threshold and absent

  // backfill claim: highest user_count first (Gossiping's was nulled by the
  // metadata-refresh upsert — Go behavior: user_count = EXCLUDED.user_count always)
  db.prepare("UPDATE boards SET backfill_complete = 0, is_hot = 1, window_floor = NULL WHERE id = ?").run(gossiping.id);
  const claimedBoard = store.claimBackfillBoard();
  expect(claimedBoard!.name).toBe("Baseball");
  expect(claimedBoard!.backfillClaimedAt).toBe(nowSecs());
  expect(store.claimBackfillBoard()!.id).not.toBe(claimedBoard!.id); // claimed board excluded for 6h

  // window sweep: advance blocked while a hot board hasn't reached the boundary
  db.prepare("UPDATE boards SET backfill_complete = 0, is_hot = 1, window_floor = NULL, backfill_claimed_at = NULL WHERE id IN (?, ?)").run(gossiping.id, store.getBoardByName("Baseball")!.id);
  expect(store.advanceBackfillWindow(7776000)).toBeNull(); // some hot board has window_floor NULL (> bottom)
  db.prepare("UPDATE boards SET window_floor = 0 WHERE is_hot = 1").run();
  const bottomBefore = store.getBackfillWindow()!;
  expect(store.advanceBackfillWindow(7776000)).toBe(bottomBefore - 7776000);
  expect(store.getBackfillWindow()).toBe(bottomBefore - 7776000);

  // crawl_runs lifecycle
  const run = store.createCrawlRun(gossiping.id, "backfill");
  store.finishCrawlRun({ id: run.id, status: "completed", pagesCrawled: 5, articlesNew: 10, articlesUpdated: 0, pushesUpdated: 3, errors: 0 });
  const done = db.prepare("SELECT * FROM crawl_runs WHERE id = ?").get(run.id) as { status: string; finished_at: number };
  expect(done.status).toBe("completed");
  expect(done.finished_at).toBeGreaterThanOrEqual(run.startedAt);

  // boards.updated_at trigger
  const before = (db.prepare("SELECT updated_at FROM boards WHERE id = ?").get(gossiping.id) as { updated_at: number }).updated_at;
  db.prepare("UPDATE boards SET title = 'x' WHERE id = ?").run(gossiping.id);
  const after = (db.prepare("SELECT updated_at FROM boards WHERE id = ?").get(gossiping.id) as { updated_at: number }).updated_at;
  expect(after).toBeGreaterThanOrEqual(before);

  expect(secsAfter(600)).toBe(nowSecs() + 600);
});
