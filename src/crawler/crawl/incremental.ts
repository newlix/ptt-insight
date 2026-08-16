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
// index while provably inside its coverage.
//
// The original heuristic ("newer than the page's oldest entry but absent")
// breaks on boards with 置底文: C_Chat's page 1 carries 2-month-old pinned
// entries, so `oldest` is ancient and EVERY scrolled-off article qualifies as
// vanished — that alone soft-deleted 29.5K C_Chat articles (2026-08-16,
// 65K total across boards). Protection layers, in order:
//   1. Re-fetch the latest page and recompute candidates — a transient
//      anomalous (stale/partial) snapshot self-heals here.
//   2. Contradiction bound — an article NEWER than the snapshot's newest
//      entry cannot be judged: a healthy page would list it. Skip (the
//      snapshot must be stale).
//   3. Scroll boundary — the second-newest page's NEWEST entry is the true
//      boundary of pages 1–2 coverage (a max over timestamps, immune to
//      ancient pinned entries). An article newer than that boundary must be
//      on page 1 if alive; older ones are beyond coverage (gray zone).
//   4. Mass guard — more than VANISH_GUARD_MAX confirmed candidates is
//      treated as an anomaly, not a deletion event.
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
  const broad = vanishedCandidates(store, board, freshEntries);
  if (broad.length === 0) {
    console.log(`vanished ${board.name}: ${first.length} candidates evaporated on re-fetch (anomalous snapshot), skipping`);
    return;
  }

  // Stage 2 — contradiction bound: newer than the snapshot's newest entry
  // means the snapshot cannot judge this article.
  const freshNewest = newestTimestamp(freshEntries);
  let candidates = freshNewest > 0 ? broad.filter((c) => (urlIdTimestamp(c.urlId) ?? 0) <= freshNewest) : [];

  // Stage 3 — fetch the second-newest page and apply the scroll boundary.
  let prevPresent = new Set<string>();
  let prevNewest = 0;
  const prevPage = freshMaxPageIndex - 1;
  if (prevPage >= 1) {
    let prevEntries: typeof entries;
    try {
      const html = await fetcher.fetchIndexPage(board.name, prevPage, signal);
      ({ entries: prevEntries } = parseIndexPage(html));
    } catch (e) {
      if (!isAborted(e, signal)) console.error(`vanished verify ${board.name} page ${prevPage}:`, e);
      return; // cannot verify — prefer not deleting
    }
    for (const e of prevEntries) {
      if (e.deleted || e.urlId === "") continue;
      prevPresent.add(e.urlId);
      const ts = urlIdTimestamp(e.urlId);
      if (ts !== null && ts > prevNewest) prevNewest = ts;
    }
    // Newer than the second-newest page's top entry → must be on page 1 if
    // alive. At/below it → beyond pages 1–2 coverage, gray zone.
    candidates = candidates.filter((c) => {
      if (prevPresent.has(c.urlId)) return false; // merely scrolled — still alive
      const ts = urlIdTimestamp(c.urlId);
      return ts !== null && prevNewest > 0 && ts > prevNewest;
    });
  }
  if (candidates.length === 0) return;

  // Stage 4 — refuse implausible mass deletions.
  if (candidates.length > VANISH_GUARD_MAX) {
    console.error(
      `vanished ${board.name}: refusing mass deletion of ${candidates.length} candidates (guard ${VANISH_GUARD_MAX}) — snapshot likely anomalous`,
    );
    return;
  }

  for (const c of candidates) {
    store.markArticleDeleted(board.id, c.urlId);
    console.log(`deleted: ${board.name}/${c.urlId}`);
  }
}

// newestTimestamp returns the max entry timestamp on a parsed index page
// (0 when none parse). Pinned 置底文 are ancient, so a max is immune to them.
function newestTimestamp(entries: Awaited<ReturnType<typeof parseIndexPage>>["entries"]): number {
  let newest = 0;
  for (const e of entries) {
    if (e.deleted || e.urlId === "") continue;
    const ts = urlIdTimestamp(e.urlId);
    if (ts !== null && ts > newest) newest = ts;
  }
  return newest;
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
