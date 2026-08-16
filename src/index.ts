import { writeFileSync } from "node:fs";
import { openDB } from "./db/sqlite.ts";
import { migrate } from "./db/migrate.ts";
import { createStore } from "./db/store.ts";
import { Fetcher } from "./crawler/ptt/fetcher.ts";
import { discoverHotBoards, discoverBoards } from "./crawler/crawl/discovery.ts";
import { runBackfillWorker, releaseOrphanedClaims } from "./crawler/crawl/backfill.ts";
import { runIncremental } from "./crawler/crawl/incremental.ts";
import { isAborted } from "./crawler/crawl/util.ts";
import { LLMClient } from "./llm/client.ts";
import { InsightWorker } from "./insight/worker.ts";
import { HotBoardsCache, HOT_BOARDS_URL } from "./crawler/ptt/hotboards.ts";
import { createServer } from "./server/server.ts";

function envStr(key: string, def: string): string {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : def;
}

function envFloat(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return def;
  const f = Number(v);
  return Number.isFinite(f) ? f : def;
}

function envInt(key: string, def: number, min = Number.NEGATIVE_INFINITY): number {
  const v = process.env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isInteger(n) && n >= min ? n : def;
}

// Accepts Go-style durations ("5m", "90s") or plain seconds.
function envSecs(key: string, defSecs: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return defSecs;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(v);
  if (!m) return defSecs;
  const n = Number(m[1]!);
  switch (m[2]) {
    case "ms": return n / 1000;
    case "m": return n * 60;
    case "h": return n * 3600;
    default: return n;
  }
}

function writeHeartbeat(): void {
  writeFileSync("/tmp/heartbeat", new Date().toISOString());
}

async function main(): Promise<void> {
  const dbPath = envStr("DB_PATH", "ptt.db");

  // subsystem toggles — the merged binary runs everything by default
  const runCrawler = envStr("RUN_CRAWLER", "1") !== "0";
  const runWorker = envStr("RUN_WORKER", "1") !== "0";
  const runWeb = envStr("RUN_WEB", "1") !== "0";

  // crawler config
  const rateLimit = envFloat("RATE_LIMIT", 3);
  const skipDiscovery = envStr("SKIP_DISCOVERY", "") === "1";
  const backfillWorkers = envInt("BACKFILL_WORKERS", 1, 1);
  const batchPages = envInt("BACKFILL_BATCH_PAGES", 200, 1);
  const crawlConcurrency = envInt("CRAWL_CONCURRENCY", 3, 1);
  const windowDays = envInt("BACKFILL_RECENT_DAYS", 90, 0);

  // insight worker config
  const llmBaseURL = envStr("LLM_BASE_URL", "http://localhost:18905");
  const llmAPIKey = envStr("LLM_API_KEY", "");
  const llmModel = envStr("LLM_MODEL", "glm-5.2");
  const fallbackBaseURL = envStr("FALLBACK_LLM_BASE_URL", "");
  const fallbackAPIKey = envStr("FALLBACK_LLM_API_KEY", "");
  const fallbackModel = envStr("FALLBACK_LLM_MODEL", "gpt-5.6-luna");
  const workerBatch = envInt("WORKER_BATCH", 10);
  const workerConcurrency = envInt("WORKER_CONCURRENCY", 3, 1);
  const workerMinNet = envInt("WORKER_MIN_NET", 20);
  const workerInterval = envSecs("WORKER_INTERVAL", 0);
  const insightRefreshDays = envInt("INSIGHT_REFRESH_DAYS", 7, 0);
  const workerOffPeak = envStr("WORKER_OFFPEAK", "1") !== "0";

  // web config
  const addr = envStr("ADDR", ":8088");
  const pageSize = envInt("PAGE_SIZE", 30);
  const hotboardsURL = envStr("HOTBOARDS_URL", HOT_BOARDS_URL);
  const hotboardsTTL = envSecs("HOTBOARDS_TTL", 60);

  const ctrl = new AbortController();
  process.on("SIGINT", () => ctrl.abort());
  process.on("SIGTERM", () => ctrl.abort());
  const sig = ctrl.signal;

  const db = openDB(dbPath);
  migrate(db); // idempotent, tracked in schema_migrations
  const store = createStore(db);

  const tasks: Promise<void>[] = [];

  if (runCrawler) {
    // Split rate limit: incremental gets 40% (guaranteed, never starved by
    // backfill), backfill+discovery gets 60%.
    const incrementalRate = rateLimit * 0.4;
    const backfillRate = rateLimit * 0.6;
    const backfillFetcher = new Fetcher(backfillRate);

    console.log("discovering hot boards...");
    try {
      await discoverHotBoards(backfillFetcher, store, sig);
    } catch (e) {
      if (!isAborted(e, sig)) console.error("hot boards discovery error:", e);
    }

    const released = releaseOrphanedClaims(store);
    if (released > 0) console.log(`released ${released} orphaned backfill claim(s) from previous run`);

    const incrementalFetcher = new Fetcher(incrementalRate);
    console.log(
      `crawler starting (incremental: ${incrementalRate.toFixed(1)} req/s, ` +
        `backfill: ${backfillRate.toFixed(1)} req/s, workers: ${backfillWorkers}, ` +
        `batch: ${batchPages} pages, window-step: ${windowDays}d)`,
    );

    for (let i = 0; i < backfillWorkers; i++) {
      tasks.push(runBackfillWorker(backfillFetcher, store, batchPages, windowDays * 86400, sig, crawlConcurrency));
    }
    tasks.push(runIncremental(incrementalFetcher, store, sig, crawlConcurrency));

    // Periodic stats logging + heartbeat (Docker/systemd healthcheck reads /tmp/heartbeat)
    const statsBoards = db.prepare("SELECT count(*) AS c FROM boards");
    const statsArticles = db.prepare("SELECT count(*) AS c FROM articles");
    const statsPushes = db.prepare("SELECT count(*) AS c FROM pushes");
    const statsBackfillDone = db.prepare("SELECT count(*) AS c FROM boards WHERE backfill_complete = 1");
    const statsTimer = setInterval(() => {
      const boards = (statsBoards.get() as { c: number }).c;
      const articles = (statsArticles.get() as { c: number }).c;
      const pushes = (statsPushes.get() as { c: number }).c;
      const backfillDone = (statsBackfillDone.get() as { c: number }).c;
      console.log(`stats: ${boards} boards (${backfillDone} backfilled), ${articles} articles, ${pushes} pushes`);
      writeHeartbeat();
    }, 60_000);
    statsTimer.unref?.();
    writeHeartbeat();

    // Full /cls/ discovery in background (adds remaining ~19K boards over time)
    if (!skipDiscovery) {
      tasks.push(
        (async () => {
          console.log("discovering all boards from /cls/ tree (background)...");
          try {
            await discoverBoards(backfillFetcher, store, sig);
            if (!sig.aborted) console.log(`full discovery complete: ${store.countBoards()} boards total`);
          } catch (e) {
            if (!isAborted(e, sig)) console.error("full discovery error:", e);
          }
        })(),
      );
    }
  } else {
    console.log("crawler disabled (RUN_CRAWLER=0)");
  }

  if (runWorker) {
    const client = new LLMClient(llmBaseURL, llmAPIKey, llmModel);
    const fallback = fallbackBaseURL !== "" ? new LLMClient(fallbackBaseURL, fallbackAPIKey, fallbackModel) : undefined;
    const worker = new InsightWorker({
      db,
      client,
      model: llmModel,
      batch: workerBatch,
      concurrency: workerConcurrency,
      minNet: workerMinNet,
      intervalSecs: workerInterval,
      offPeak: workerOffPeak,
      fallback,
      fallbackModel,
      refreshDays: insightRefreshDays,
    });
    tasks.push(worker.run(sig));
  } else {
    console.log("insight worker disabled (RUN_WORKER=0)");
  }

  let web: ReturnType<typeof createServer> | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  if (runWeb) {
    web = createServer({
      db,
      pageSize,
      hot: new HotBoardsCache(hotboardsURL, hotboardsTTL * 1000),
      minNet: workerMinNet,
    });
    const port = addr.startsWith(":") ? Number(addr.slice(1)) : Number(addr);
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: (req) => web!.handler(req),
    });
    console.log(`ptt-insight web ready (addr=${server.url})`);
  } else {
    console.log("web disabled (RUN_WEB=0)");
  }

  await new Promise<void>((resolve) => {
    sig.addEventListener("abort", () => resolve(), { once: true });
  });
  console.log("shutting down...");
  web?.stop();
  server?.stop(true);
  await Promise.allSettled(tasks);
  db.close();
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
