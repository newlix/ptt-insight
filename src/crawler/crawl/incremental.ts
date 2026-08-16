import { Fetcher } from "../ptt/fetcher.ts";
import { parseIndexPage } from "../ptt/index_parser.ts";
import type { Board } from "../../db/types.ts";
import type { Store } from "../../db/store.ts";
import { urlIdTimestamp } from "../ptt/url.ts";
import { nextInterval, MIN_INTERVAL_SECS, MAX_INTERVAL_SECS } from "./backoff.ts";
import { secsAfter } from "../../db/sqlite.ts";
import { sleepSecs, isAborted, mapLimit } from "./util.ts";
import {
  processArticle,
  updateArticlePushes,
  updateNrecOnly,
  nrecChanged,
  indexMetaChanged,
} from "./backfill.ts";

// runIncremental runs the adaptive-backoff incremental crawl loop.
// Continuously claims the next-due board, fetches its index page,
// discovers new articles, detects push-count changes, and reschedules.
// Runs until the signal aborts.
export async function runIncremental(
  fetcher: Fetcher,
  store: Store,
  signal?: AbortSignal,
  concurrency = 1,
  minIntervalSecs: number = MIN_INTERVAL_SECS,
  maxIntervalSecs: number = MAX_INTERVAL_SECS,
): Promise<void> {
  for (;;) {
    if (signal?.aborted) return;

    const board = store.claimNextBoard();
    if (!board) {
      // No board due — wait briefly
      if (!(await sleepSecs(10, signal))) return;
      continue;
    }

    await processBoardIncremental(fetcher, store, board, signal, concurrency, minIntervalSecs, maxIntervalSecs);
  }
}

export async function processBoardIncremental(
  fetcher: Fetcher,
  store: Store,
  board: Board,
  signal?: AbortSignal,
  concurrency = 1,
  minIntervalSecs: number = MIN_INTERVAL_SECS,
  maxIntervalSecs: number = MAX_INTERVAL_SECS,
): Promise<void> {
  let html: string;
  try {
    html = await fetcher.fetchIndexPage(board.name, 0, signal);
  } catch (e) {
    if (!isAborted(e, signal)) console.error(`incremental fetch ${board.name}:`, e);
    return;
  }

  const { entries, maxPageIndex } = parseIndexPage(html);

  // Update latest page index for backfill tracking (don't touch last_backfill_page)
  if (maxPageIndex > 0) {
    store.updateLatestPageIndex(board.id, maxPageIndex);
  }

  let newArticles = false;
  const todo = entries.filter((e) => !e.deleted && e.urlId !== "");
  await mapLimit(
    todo,
    concurrency,
    async (entry) => {
      const existing = store.getArticleByBoardUrlID(board.id, entry.urlId);
      if (!existing) {
        // New article — fetch and insert
        newArticles = true;
        await processArticle(fetcher, store, board, entry, signal);
        return;
      }

      // Listed on the current index page = exists on PTT (direct evidence).
      // Undo any earlier vanish mark — those can be false positives from
      // anomalous snapshots (see VANISH_GUARD_MAX below).
      if (existing.deletedAt) {
        store.resurrectArticle(board.id, entry.urlId);
        console.log(`resurrected: ${board.name}/${entry.urlId}`);
      }

      // Existing article — check push count change
      if (nrecChanged(existing.nrecRaw, entry)) {
        await updateArticlePushes(fetcher, store, board, entry, signal);
      }

      // Rewrite index metadata only when it actually changed — no-op UPDATEs
      // would otherwise dominate write volume across ~20K boards per sweep.
      if (indexMetaChanged(existing, entry)) {
        updateNrecOnly(store, board.id, entry);
      }    },
    signal,
  );

  // Deletion detection: articles newer than the page's oldest entry but absent
  // from it must have been deleted (they can't have scrolled off).
  await detectVanishedArticles(fetcher, store, board, entries, signal);

  // Adjust adaptive backoff interval
  const newIntervalSecs = nextInterval(board.checkIntervalSecs, newArticles, minIntervalSecs, maxIntervalSecs);
  store.setBoardInterval(board.id, newIntervalSecs, secsAfter(newIntervalSecs));

  if (newArticles) {
    console.log(`incremental ${board.name}: new articles found, reset interval to ${newIntervalSecs}s`);
  }
}

// Refuse implausible mass deletions: real author/board deletions run ~1–13
// articles/hour board-wide (measured 2026-08-15 histogram). An anomalous index
// snapshot instead yields thousands of candidates in a single check — the
// 2026-08-16 incident (PTT maintenance window served stale index pages) marked
// 47K articles deleted in one hour before this guard existed. When tripped,
// skip the round entirely and leave a loud journal line for the operator.
const VANISH_GUARD_MAX = 100;

// detectVanishedArticles marks articles as deleted when they vanish from the
// index while still being newer than the page's oldest entry.
//
// An article that scrolls off the latest page becomes OLDER than that page's
// oldest entry — so "newer than the oldest entry but absent" can only mean the
// article was removed. Protection layers, in order:
//   1. Re-fetch the latest page and recompute candidates — a single anomalous
//      (stale/partial) snapshot self-heals; if the fresh fetch shows the
//      articles present, nothing is deleted.
//   2. Mass guard — more than VANISH_GUARD_MAX candidates is treated as an
//      anomalous snapshot, not a deletion event.
//   3. Scroll verification — the second-newest page (where a busy board's
//      articles actually scroll to) is fetched once; candidates present there
//      are alive. Older-than-that-page's-oldest candidates stay untouched
//      (gray zone).
async function detectVanishedArticles(
  fetcher: Fetcher,
  store: Store,
  board: Board,
  entries: Awaited<ReturnType<typeof parseIndexPage>>["entries"],
  signal?: AbortSignal,
): Promise<void> {
  const first = vanishedCandidates(store, board, entries);
  if (first.length === 0) return;

  // Stage 1 — re-fetch the latest page and recompute.
  let freshEntries: typeof entries;
  let freshMaxPageIndex = 0;
  try {
    const html = await fetcher.fetchIndexPage(board.name, 0, signal);
    ({ entries: freshEntries, maxPageIndex: freshMaxPageIndex } = parseIndexPage(html));
  } catch (e) {
    if (!isAborted(e, signal)) console.error(`vanished recheck ${board.name}:`, e);
    return; // cannot confirm — prefer not deleting
  }
  const candidates = vanishedCandidates(store, board, freshEntries);
  if (candidates.length === 0) {
    console.log(`vanished ${board.name}: ${first.length} candidates evaporated on re-fetch (anomalous snapshot), skipping`);
    return;
  }

  // Stage 2 — refuse implausible mass deletions.
  if (candidates.length > VANISH_GUARD_MAX) {
    console.error(
      `vanished ${board.name}: refusing mass deletion of ${candidates.length} candidates (guard ${VANISH_GUARD_MAX}) — snapshot likely anomalous`,
    );
    return;
  }

  // Stage 3 — verify against the second-newest page before concluding deletion.
  const prevPage = freshMaxPageIndex - 1;
  if (prevPage < 1) {
    // No older page exists — candidates can't be anywhere else.
    for (const c of candidates) {
      store.markArticleDeleted(board.id, c.urlId);
      console.log(`deleted: ${board.name}/${c.urlId}`);
    }
    return;
  }

  let prevEntries: typeof entries;
  try {
    const html = await fetcher.fetchIndexPage(board.name, prevPage, signal);
    ({ entries: prevEntries } = parseIndexPage(html));
  } catch (e) {
    if (!isAborted(e, signal)) console.error(`vanished verify ${board.name} page ${prevPage}:`, e);
    return;
  }

  const prevPresent = new Set<string>();
  let prevOldest = 0;
  for (const e of prevEntries) {
    if (e.deleted || e.urlId === "") continue;
    prevPresent.add(e.urlId);
    const ts = urlIdTimestamp(e.urlId);
    if (ts !== null && (prevOldest === 0 || ts < prevOldest)) prevOldest = ts;
  }

  for (const c of candidates) {
    if (prevPresent.has(c.urlId)) continue; // merely scrolled to the previous page — still alive
    const ts = urlIdTimestamp(c.urlId);
    if (ts !== null && prevOldest > 0 && ts <= prevOldest) continue; // older than the previous page's coverage — gray zone
    store.markArticleDeleted(board.id, c.urlId);
    console.log(`deleted: ${board.name}/${c.urlId}`);
  }
}

// vanishedCandidates returns stored articles newer than the snapshot's oldest
// entry but absent from it. oldest === 0 (no parseable entries) means the
// snapshot is unusable — no candidates.
function vanishedCandidates(
  store: Store,
  board: Board,
  entries: Awaited<ReturnType<typeof parseIndexPage>>["entries"],
): { id: number; urlId: string }[] {
  const present: string[] = [];
  let oldest = 0;
  for (const e of entries) {
    if (e.deleted || e.urlId === "") continue;
    present.push(e.urlId);
    const ts = urlIdTimestamp(e.urlId);
    if (ts !== null && (oldest === 0 || ts < oldest)) oldest = ts;
  }
  if (oldest === 0) return [];
  return store.findVanishedArticles(board.id, oldest, present);
}
