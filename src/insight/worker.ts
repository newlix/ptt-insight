import type { DB } from "../db/sqlite.ts";
import { nowSecs } from "../db/sqlite.ts";
import { mapLimit } from "../crawler/crawl/util.ts";
import type { LLMClient } from "../llm/client.ts";
import { ContentFilterError } from "../llm/client.ts";
import { analyze } from "./analyze.ts";
import {
  claimPendingArticles,
  claimStaleArticles,
  claimFilteredArticles,
  storeInsight,
  markInsightError,
  type PendingArticle,
} from "../repo/insights.ts";
import { abortableSleep } from "./sleep.ts";

// Z.AI peak hours: Mon–Fri 14:00–18:00 UTC+8.
// Off-peak = everything else, credits charged at 50%.
const PEAK_START_HOUR = 14;
const PEAK_END_HOUR = 18;
const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;

interface TaipeiParts {
  weekday: number; // 0=Sun … 6=Sat
  hour: number;
  dateMs: number;  // ms since epoch of this Taipei-midnight-anchored instant
}

function taipeiNow(): TaipeiParts {
  const now = new Date(Date.now() + TAIPEI_OFFSET_MS);
  return { weekday: now.getUTCDay(), hour: now.getUTCHours(), dateMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) };
}

export function isPeak(t: TaipeiParts): boolean {
  if (t.weekday === 0 || t.weekday === 6) return false;
  return t.hour >= PEAK_START_HOUR && t.hour < PEAK_END_HOUR;
}

export interface WorkerOptions {
  db: DB;
  client: LLMClient;
  model: string;
  batch: number;
  minNet: number;
  minAgeSecs: number; // skip articles posted within this window (0 = analyze all; pre-launch churn guard)
  intervalSecs: number; // 0 = continuous
  offPeak: boolean;
  fallback?: LLMClient;
  fallbackModel?: string;
  refreshDays: number; // re-analyze changed articles posted within N days; 0 = off
  concurrency?: number; // max simultaneous LLM calls (default 3)
}

export class InsightWorker {
  constructor(private readonly opts: WorkerOptions) {}

  async run(signal: AbortSignal): Promise<void> {
    const mode = this.opts.offPeak
      ? "off-peak (skip Mon-Fri 14:00-18:00 UTC+8, 50% credit)"
      : "continuous (24h)";
    console.log(
      `insight worker started (model=${this.opts.model} batch=${this.opts.batch} concurrency=${this.opts.concurrency ?? 3} min_net=${this.opts.minNet} min_age=${Math.round(this.opts.minAgeSecs / 86400)}d mode=${mode} fallback=${this.opts.fallbackModel ?? "none"} schema_ver=2)`,
    );

    // Fallback loop: retry content-filtered articles with the fallback
    // provider. Runs independently of off-peak gating (fallback is
    // pay-per-token, no peak pricing).
    if (this.opts.fallback) {
      void this.loopFallback(signal);
    }

    if (this.opts.offPeak) {
      await this.loopOffPeak(signal);
      return;
    }
    if (this.opts.intervalSecs > 0) {
      await this.loopScheduled(signal);
      return;
    }
    await this.loopContinuous(signal);
  }

  private async loopFallback(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      let articles: PendingArticle[];
      try {
        articles = claimFilteredArticles(this.opts.db, this.opts.batch, this.opts.minAgeSecs);
      } catch (e) {
        console.error("claim filtered articles:", e);
        if (!(await sleep(60, signal))) return;
        continue;
      }
      if (articles.length === 0) {
        if (!(await sleep(300, signal))) return;
        continue;
      }
      for (const a of articles) {
        if (signal.aborted) return;
        await this.analyzeWithFallback(a, signal);
      }
    }
  }

  private async analyzeWithFallback(a: PendingArticle, signal: AbortSignal): Promise<void> {
    try {
      const result = await analyze(this.opts.fallback!, a, this.opts.fallbackModel ?? "", signal);
      storeInsight(this.opts.db, result);
      console.log(`insight stored via fallback (article_id=${a.id} model=${result.model} tldr=${result.tldr})`);
    } catch (e) {
      if (signal.aborted) return;
      console.warn(`fallback analyze failed (article_id=${a.id}):`, e);
      markInsightError(this.opts.db, a.id, `fallback: ${truncateErr(String(e))}`);
    }
  }

  private async loopOffPeak(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const now = taipeiNow();
      if (isPeak(now)) {
        // Wait until 18:00 Taipei (end of today's peak window).
        const taipeiNowMs = now.dateMs + now.hour * 3600 * 1000;
        const peakEndMs = now.dateMs + PEAK_END_HOUR * 3600 * 1000;
        const waitMs = peakEndMs - taipeiNowMs;
        console.log(
          `peak hours — pausing to save credits (resume in ${Math.ceil(waitMs / 60000)} min)`,
        );
        if (!(await sleep(waitMs / 1000, signal))) return;
        continue;
      }
      await this.processUntilPeak(signal);
    }
  }

  private async processUntilPeak(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      if (isPeak(taipeiNow())) {
        console.log("peak hours starting — pausing");
        return;
      }
      const processed = await this.processBatch(signal);
      if (processed === 0) {
        if (!(await sleep(30, signal))) return;
      }
    }
  }

  private async loopScheduled(signal: AbortSignal): Promise<void> {
    await this.processBatch(signal);
    for (;;) {
      if (!(await sleep(this.opts.intervalSecs, signal))) return;
      await this.processBatch(signal);
    }
  }

  private async loopContinuous(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const processed = await this.processBatch(signal);
      if (processed === 0) {
        if (!(await sleep(30, signal))) return;
      }
    }
  }

  // One scheduling quantum: new articles first, then stale re-analyses.
  // Returns total processed; 0 = nothing to do (caller sleeps).
  private async processBatch(signal: AbortSignal): Promise<number> {
    const fresh = await this.processClaim(signal, "new", (limit) =>
      claimPendingArticles(this.opts.db, limit, this.opts.minNet, this.opts.minAgeSecs),
    );
    const stale = this.opts.refreshDays > 0
      ? await this.processClaim(signal, "reanalyze", (limit) =>
          claimStaleArticles(
            this.opts.db, limit, this.opts.minNet,
            nowSecs() - this.opts.refreshDays * 86400,
          ),
        )
      : 0;
    return fresh + stale;
  }

  private async processClaim(
    signal: AbortSignal,
    kind: string,
    claim: (limit: number) => PendingArticle[],
  ): Promise<number> {
    let articles: PendingArticle[];
    try {
      articles = claim(this.opts.batch);
    } catch (e) {
      console.error(`claim ${kind} articles:`, e);
      return 0;
    }
    if (articles.length === 0) return 0;

    let ok = 0;
    let failed = false;
    await mapLimit(
      articles,
      this.opts.concurrency ?? 3,
      async (a) => {
        try {
          await this.analyzeOne(a, signal, kind);
          ok++;
        } catch {
          failed = true; // details already logged in analyzeOne
        }
      },
      signal,
    );
    if (failed) return 0; // errors occurred; return 0 so caller retries sooner
    return ok;
  }

  private async analyzeOne(a: PendingArticle, signal: AbortSignal, kind = "new"): Promise<void> {
    let result;
    try {
      result = await analyze(this.opts.client, a, this.opts.model, signal);
    } catch (e) {
      if (signal.aborted) return; // shutdown — not a real failure, don't mark
      if (e instanceof ContentFilterError) {
        console.warn(`content filter blocked, deferring to fallback (article_id=${a.id} has_fallback=${this.opts.fallback !== undefined})`);
        markInsightError(this.opts.db, a.id, "content_filter");
        throw e;
      }
      console.warn(`analyze article (article_id=${a.id}):`, e);
      markInsightError(this.opts.db, a.id, truncateErr(String(e)));
      throw e;
    }

    storeInsight(this.opts.db, result);
    console.log(
      `insight stored (kind=${kind} article_id=${a.id} board_id=${a.boardId} prompt_tokens=${result.promptTokens} completion_tokens=${result.completionTokens} tldr=${result.tldr})`,
    );
  }
}

async function sleep(secs: number, signal: AbortSignal): Promise<boolean> {
  await abortableSleep(secs * 1000, signal);
  return !signal.aborted;
}

function truncateErr(s: string): string {
  return s.length > 300 ? s.slice(0, 300) : s;
}
