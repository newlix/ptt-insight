import { openDB } from "./db/sqlite.ts";
import { migrate } from "./db/migrate.ts";
import { LLMClient } from "./llm/client.ts";
import { InsightWorker } from "./insight/worker.ts";
import { HotBoardsCache, HOT_BOARDS_URL } from "./ptt/hotboards.ts";
import { createServer } from "./server/server.ts";

function envStr(key: string, def: string): string {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : def;
}

function envInt(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isInteger(n) ? n : def;
}

function envSecs(key: string, defSecs: number): number {
  // Accepts Go-style durations ("5m", "90s") or plain seconds.
  const v = process.env[key];
  if (v === undefined || v === "") return defSecs;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(v);
  if (!m) return defSecs;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms": return n / 1000;
    case "m": return n * 60;
    case "h": return n * 3600;
    default: return n;
  }
}

async function main(): Promise<void> {
  const addr = envStr("ADDR", ":8088");
  const dbPath = envStr("DB_PATH", "/home/newlix/ptt/ptt.db");
  const runWorker = envStr("RUN_WORKER", "1") !== "0";
  const llmBaseURL = envStr("LLM_BASE_URL", "http://localhost:18905");
  const llmAPIKey = envStr("LLM_API_KEY", "");
  const llmModel = envStr("LLM_MODEL", "glm-5.2");
  const fallbackBaseURL = envStr("FALLBACK_LLM_BASE_URL", "");
  const fallbackAPIKey = envStr("FALLBACK_LLM_API_KEY", "");
  const fallbackModel = envStr("FALLBACK_LLM_MODEL", "gpt-5.6-luna");
  const workerBatch = envInt("WORKER_BATCH", 10);
  const workerMinNet = envInt("WORKER_MIN_NET", 20);
  const workerInterval = envSecs("WORKER_INTERVAL", 0);
  const workerOffPeak = envStr("WORKER_OFFPEAK", "1") !== "0";
  const pageSize = envInt("PAGE_SIZE", 30);
  const hotboardsURL = envStr("HOTBOARDS_URL", HOT_BOARDS_URL);
  const hotboardsTTL = envSecs("HOTBOARDS_TTL", 60);

  const db = openDB(dbPath);
  migrate(db);

  const ctrl = new AbortController();
  process.on("SIGINT", () => ctrl.abort());
  process.on("SIGTERM", () => ctrl.abort());

  if (runWorker) {
    const client = new LLMClient(llmBaseURL, llmAPIKey, llmModel);
    const fallback = fallbackBaseURL !== "" ? new LLMClient(fallbackBaseURL, fallbackAPIKey, fallbackModel) : undefined;
    const worker = new InsightWorker({
      db,
      client,
      model: llmModel,
      batch: workerBatch,
      minNet: workerMinNet,
      intervalSecs: workerInterval,
      offPeak: workerOffPeak,
      fallback,
      fallbackModel,
    });
    void worker.run(ctrl.signal);
    console.log(
      `insight worker enabled (off_peak=${workerOffPeak} batch=${workerBatch} min_net=${workerMinNet} fallback=${fallbackModel})`,
    );
  } else {
    console.log("insight worker disabled (RUN_WORKER=0)");
  }

  const hot = new HotBoardsCache(hotboardsURL, hotboardsTTL * 1000);
  const srv = createServer({ db, pageSize, hot });

  const port = addr.startsWith(":") ? Number(addr.slice(1)) : Number(addr);
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: (req) => srv.handler(req),
  });
  console.log(`ptt-insight ready (addr=${server.url})`);

  await new Promise<void>((resolve) => {
    ctrl.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  console.log("shutting down...");
  srv.stop();
  server.stop(true);
  db.close();
}

main();
