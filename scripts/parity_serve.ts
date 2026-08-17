// Parity harness: serve the SNAPSHOT DB web-only on :8099 (basis for
// byte-diffing against the Go/PG server imported from the same snapshot).
import { openDB } from "../src/db/sqlite.ts";
import { migrate } from "../src/db/migrate.ts";
import { createServer } from "../src/server/server.ts";
import { HotBoardsCache, HOT_BOARDS_URL } from "../src/crawler/ptt/hotboards.ts";

const db = openDB("/home/newlix/ptt-insight/backups/ptt-2026-08-17.db");
migrate(db);
const web = createServer({
  db,
  pageSize: 30,
  hot: new HotBoardsCache(process.env.HOTBOARDS_URL ?? HOT_BOARDS_URL, 60_000),
});
const port = 8099;
Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => web.handler(req) });
console.log(`parity ts-server ready :${port}`);
