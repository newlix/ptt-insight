import { Fetcher } from "../ptt/fetcher.ts";
import { parseIndexPage } from "../ptt/index_parser.ts";
import type { Board } from "../../db/types.ts";
import type { Store } from "../../db/store.ts";
import { urlIdTimestamp } from "../ptt/url.ts";
import { nextInterval } from "./backoff.ts";
import { secsAfter } from "../../db/sqlite.ts";
import { sleepSecs, isAborted } from "./util.ts";
import {
  processArticle,
  updateArticlePushes,
  updateNrecOnly,
  nrecChanged,
} from "./backfill.ts";

// runIncremental runs the adaptive-backoff incremental crawl loop.
// Continuously claims the next-due board, fetches its index page,
// discovers new articles, detects push-count changes, and reschedules.
// Runs until the signal aborts.
export async function runIncremental(fetcher: Fetcher, store: Store, signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (signal?.aborted) return;

    const board = store.claimNextBoard();
    if (!board) {
      // No board due — wait briefly
      if (!(await sleepSecs(10, signal))) return;
      continue;
    }

    await processBoardIncremental(fetcher, store, board, signal);
  }
}

export async function processBoardIncremental(
  fetcher: Fetcher,
  store: Store,
  board: Board,
  signal?: AbortSignal,
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
  for (const entry of entries) {
    if (entry.deleted || entry.urlId === "") continue;

    const existing = store.getArticleByBoardUrlID(board.id, entry.urlId);
    if (!existing) {
      // New article — fetch and insert
      newArticles = true;
      await processArticle(fetcher, store, board, entry, signal);
      continue;
    }

    // Existing article — check push count change
    if (nrecChanged(existing.nrecRaw, entry)) {
      await updateArticlePushes(fetcher, store, board, entry, signal);
    }

    // Update nrec from index (cheap, always do it)
    updateNrecOnly(store, board.id, entry);
  }

  // Deletion detection: articles newer than the page's oldest entry but absent
  // from it must have been deleted (they can't have scrolled off).
  await detectVanishedArticles(fetcher, store, board, entries, maxPageIndex, signal);

  // Adjust adaptive backoff interval
  const newIntervalSecs = nextInterval(board.checkIntervalSecs, newArticles);
  store.setBoardInterval(board.id, newIntervalSecs, secsAfter(newIntervalSecs));

  if (newArticles) {
    console.log(`incremental ${board.name}: new articles found, reset interval to ${newIntervalSecs}s`);
  }
}

// detectVanishedArticles marks articles as deleted when they vanish from the
// index while still being newer than the page's oldest entry.
//
// An article that scrolls off the latest page becomes OLDER than that page's
// oldest entry — so "newer than the oldest entry but absent" can only mean the
// article was removed. When candidates exist, the previous index page is fetched
// once to rule out articles that merely moved down during a busy interval;
// anything absent there too (and still newer than that page's oldest) is
// confirmed deleted. Older-than-both-pages candidates stay untouched (gray zone).
async function detectVanishedArticles(
  fetcher: Fetcher,
  store: Store,
  board: Board,
  entries: Awaited<ReturnType<typeof parseIndexPage>>["entries"],
  maxPage: number,
  signal?: AbortSignal,
): Promise<void> {
  const present: string[] = [];
  let oldest = 0;
  for (const e of entries) {
    if (e.deleted || e.urlId === "") continue;
    present.push(e.urlId);
    const ts = urlIdTimestamp(e.urlId);
    if (ts !== null && (oldest === 0 || ts < oldest)) oldest = ts;
  }
  if (oldest === 0) return;

  const candidates = store.findVanishedArticles(board.id, oldest, present);
  if (candidates.length === 0) return;

  // Verify against the previous page before concluding deletion.
  const prevPage = maxPage - 1;
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
