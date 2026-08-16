import { Fetcher, NotFoundError } from "../ptt/fetcher.ts";
import type { Store } from "../../db/store.ts";
import { isAborted } from "./util.ts";

// Deletion audit: re-verify soft deletions AFTER the fact.
//
// Every deletion path eventually rests on the article URL returning 404 —
// ground truth for a single observation. The residual risk is PTT itself
// serving a false 404 (side incident): the article gets marked, scrolls past
// page 1, and the automatic resurrections (index listing, backfill re-crawl)
// may not revisit it for weeks. This audit closes that to day-level: 24h
// after a deletion mark, the URL is fetched once more — 200 resurrects the
// article, 404 confirms. A batch of resurrections is the alarm that PTT
// (not the crawler) misbehaved.
//
// Sizing: real deletions run ~1-13/hour board-wide, so MAX_PER_RUN=50 with an
// hourly cadence keeps up comfortably while bounding the worst case.

const DELAY_SECS = 24 * 3600; // audit deletions aged >= 24h
const LOOKBACK_SECS = 7 * 86400; // ... and <= 7d (older marks are history)
const MAX_PER_RUN = 50;
const RUN_INTERVAL_SECS = 3600;
const ALARM_THRESHOLD = 10;

export interface DeletionAuditCounts {
  checked: number;
  resurrected: number;
  gone: number;
}

export async function runDeletionAudit(
  fetcher: Fetcher,
  store: Store,
  signal?: AbortSignal,
): Promise<DeletionAuditCounts> {
  const rows = store.listUnauditedDeletions(DELAY_SECS, LOOKBACK_SECS, MAX_PER_RUN);
  const counts: DeletionAuditCounts = { checked: 0, resurrected: 0, gone: 0 };

  for (const r of rows) {
    try {
      await fetcher.fetchArticlePage(r.boardName, r.urlId, signal);
      // 200 — the article exists on PTT after all. Undo the mark.
      store.resurrectArticle(r.boardId, r.urlId);
      store.recordDeletionAudit(r.boardId, r.urlId, "alive");
      counts.resurrected++;
      console.warn(`deletion audit: ${r.boardName}/${r.urlId} URL alive — resurrected (PTT-side anomaly?)`);
    } catch (e) {
      if (e instanceof NotFoundError) {
        store.recordDeletionAudit(r.boardId, r.urlId, "gone");
        counts.gone++;
        counts.checked++;
        continue;
      }
      if (isAborted(e, signal)) return counts;
      // Transient (5xx/network): leave unaudited so the next run retries.
      console.error(`deletion audit ${r.boardName}/${r.urlId}:`, e);
      continue;
    }
    counts.checked++;
  }

  if (counts.resurrected >= ALARM_THRESHOLD) {
    console.error(
      `deletion audit ALARM: ${counts.resurrected}/${counts.checked} deleted articles came back alive ` +
        `— PTT likely served false 404s; inspect deletion_audits for the window`,
    );
  }
  return counts;
}

export async function runDeletionAuditor(
  fetcher: Fetcher,
  store: Store,
  signal: AbortSignal,
): Promise<void> {
  console.log(
    `deletion auditor starting (delay ${DELAY_SECS / 3600}h, lookback ${LOOKBACK_SECS / 86400}d, ` +
      `max ${MAX_PER_RUN}/run, every ${RUN_INTERVAL_SECS}s)`,
  );
  while (!signal.aborted) {
    try {
      const c = await runDeletionAudit(fetcher, store, signal);
      if (c.checked > 0) console.log(`deletion audit: checked ${c.checked}, gone ${c.gone}, resurrected ${c.resurrected}`);
    } catch (e) {
      if (!isAborted(e, signal)) console.error("deletion auditor error:", e);
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, RUN_INTERVAL_SECS * 1000);
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
