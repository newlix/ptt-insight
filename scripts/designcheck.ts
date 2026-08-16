// One-off render probe for the PTT-design audit (LEDGER card 7).
// Seeds an in-memory DB, serves the PTT-clone pages on :18123, stays alive for curl.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openMemoryDB } from "../src/db/sqlite.ts";
import { migrate } from "../src/db/migrate.ts";
import { createServer } from "../src/server/server.ts";
import { HotBoardsCache } from "../src/crawler/ptt/hotboards.ts";

const FIXTURE = join(import.meta.dir, "../testdata/hotboards.html");
const fixture = Bun.serve({
  port: 0,
  fetch: () => new Response(readFileSync(FIXTURE), { headers: { "Content-Type": "text/html; charset=utf-8" } }),
});

const db = openMemoryDB();
migrate(db);
db.prepare(`INSERT INTO boards (id, name, title, user_count) VALUES (1, 'TestBoard', '◎[測試] 測試板', 10)`).run();

const ins = db.prepare(
  `INSERT INTO articles (board_id, url_id, url_timestamp, posted_at, title, author, content, ip, nrec_raw, mark, net_count, push_count, boo_count)
   VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insPush = db.prepare(
  `INSERT INTO pushes (article_id, seq, tag, user_id, content, ipdatetime) VALUES (?, ?, ?, ?, ?, ?)`,
);

// articleTime() renders from posted_at; Aug 2026 dates → " 8/16" style month <10 path covered.
const base = 1786800000; // 2026-08-15-ish epoch
const rows: Array<[string, string, string, string | null, number]> = [
  // [url_id, title, author, nrec_raw, offsetSec]
  ["M.1006.A.A6", "[討論] nrec empty", "writer1", null, 3600],
  ["M.1005.A.A5", "[討論] nrec 5", "writer2", "5", 3000],
  ["M.1004.A.A4", "[討論] nrec 99", "writer3", "99", 2400],
  ["M.1003.A.A3", "[討論] nrec 爆", "writer4", "爆", 1800],
  ["M.1002.A.A2", "[討論] nrec X5", "writer5", "X5", 1200],
  ["M.1001.A.A1", "[公告] pinned post", "writer6", "", 600],
];
let artId = 0;
for (const [urlId, title, author, nrec, off] of rows) {
  ins.run(urlId, 1000 + Number(urlId.slice(2, 6)), base + off, title, author, `第一行內容\n第二行內容\n--\n`, "1.2.3.4", nrec, title.startsWith("[公告]") ? "M" : "", 5, 5, 0);
  const r = db.prepare(`SELECT id FROM articles WHERE url_id = ?`).get(urlId) as { id: number };
  artId = r.id;
}
// pushes + one insight on the newest article
insPush.run(artId, 0, "推", "pusherA", "good comment", "140.112.1.1 08/16 01:19");
insPush.run(artId, 1, "→", "pusherB", "neutral comment", "140.112.1.2 08/16 01:20");
insPush.run(artId, 2, "噓", "pusherC", "boo comment", "140.112.1.3 08/16 01:21");
db.prepare(
  `INSERT INTO article_insights (article_id, tldr, community_take, top_comments, sentiment, tags, model, generated_at)
   VALUES (?, '這是摘要。', '社群看法。', '「精選一」', '正面', '["tagA","tagB"]', 'test-model', ?)`,
).run(artId, base + 400);

const app = createServer({
  db,
  pageSize: 30,
  hot: new HotBoardsCache(`http://localhost:${fixture.port}`, 60_000),
});
const server = Bun.serve({ port: 18123, fetch: app.handler });
console.log(`READY http://localhost:${server.port} (fixture :${fixture.port})`);
setInterval(() => {}, 1e9);
