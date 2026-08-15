import { test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openMemoryDB } from "../src/db/sqlite.ts";
import { migrate } from "../src/db/migrate.ts";
import { createServer } from "../src/server/server.ts";
import { HotBoardsCache } from "../src/crawler/ptt/hotboards.ts";
import type { DB } from "../src/db/sqlite.ts";

const FIXTURE = join(import.meta.dir, "../testdata/hotboards.html");

function seedDB(): DB {
  const db = openMemoryDB();
  migrate(db);

  db.prepare(`INSERT INTO boards (id, name, title, user_count) VALUES (1, 'TestBoard', '◎測試', 10)`).run();
  // 35 articles → 2 pages at PAGE_SIZE=30
  const ins = db.prepare(
    `INSERT INTO articles (board_id, url_id, url_timestamp, posted_at, title, author, content, ip, nrec_raw, net_count, push_count, boo_count)
     VALUES (1, ?, ?, ?, ?, 'author1', 'body text here', '1.2.3.4', '5', 5, 5, 0)`,
  );
  const insPush = db.prepare(`INSERT INTO pushes (article_id, seq, tag, user_id, content, ipdatetime) VALUES (?, 0, '推', 'u1', 'good', '1.1.1.1 01/01 12:00')`);
  for (let i = 1; i <= 35; i++) {
    ins.run(`M.${1000 + i}.A.A${i}`, 1000 + i, 1000 + i, i === 1 ? "[公告] pinned post" : `[討論] article ${i}`);
    const id = (db.prepare(`SELECT id FROM articles WHERE url_id = ?`).get(`M.${1000 + i}.A.A${i}`) as { id: number }).id;
    if (i === 1) insPush.run(id);
  }
  return db;
}

const fixtureServer = Bun.serve({
  port: 0,
  fetch: () => new Response(readFileSync(FIXTURE), { headers: { "Content-Type": "text/html; charset=utf-8" } }),
});

const db = seedDB();
const app = createServer({
  db,
  pageSize: 30,
  hot: new HotBoardsCache(`http://localhost:${fixtureServer.port}`, 60_000),
});

async function GET(path: string): Promise<Response> {
  return await app.handler(new Request(`http://localhost${path}`));
}

afterAll(() => {
  fixtureServer.stop(true);
  app.stop();
});

test("GET / serves hot boards clone", async () => {
  const resp = await GET("/");
  expect(resp.status).toBe(200);
  const body = await resp.text();
  expect(body).toContain('class="hotboard-row"');
  expect(body).toContain("Gossiping");
  expect(body).toContain("批踢踢實業坊");
});

test("GET /bbs/hotboards.html aliases /", async () => {
  const resp = await GET("/bbs/hotboards.html");
  expect(resp.status).toBe(200);
  expect(await resp.text()).toContain("hotboard-row");
});

test("GET /bbs/{board}/index.html renders board list (page 1, pinned split)", async () => {
  const resp = await GET("/bbs/TestBoard/index.html");
  expect(resp.status).toBe(200);
  const body = await resp.text();
  expect(body).toContain("article 35"); // newest first
  expect(body).not.toContain("r-list-sep"); // [公告] is the oldest → page 2, not here
  expect(body).toContain("r-ent");
});

test("GET /bbs/{board}/index{N}.html maps PTT pagination", async () => {
  // total = ceil(35/30) = 2 pages; index2.html = page 1 (newest), index1.html = page 2 (oldest)
  const p1 = await GET("/bbs/TestBoard/index2.html");
  expect(p1.status).toBe(200);
  expect(await p1.text()).toContain("article 35");

  const p2 = await GET("/bbs/TestBoard/index1.html");
  expect(p2.status).toBe(200);
  const p2body = await p2.text();
  expect(p2body).toContain("article 5"); // oldest articles on last page
  expect(p2body).toContain('class="r-list-sep"'); // [公告] pinned at bottom of its page
  expect(p2body.indexOf("r-list-sep")).toBeLessThan(p2body.indexOf("[公告] pinned post"));

  const beyond = await GET("/bbs/TestBoard/index3.html");
  expect(beyond.status).toBe(404);
});

test("GET /bbs/{board}/{url_id}.html renders article with pushes", async () => {
  const resp = await GET("/bbs/TestBoard/M.1001.A.A1.html");
  expect(resp.status).toBe(200);
  const body = await resp.text();
  expect(body).toContain("[公告] pinned post");
  expect(body).toContain("article-meta-tag");
  expect(body).toContain("push-line");
  expect(body).toContain(">u1<");
  expect(body).toContain(": good");
});

test("GET /b/{board} renders board, unknown board → not-collected page", async () => {
  const ok = await GET("/b/TestBoard");
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain("article 35");

  const unknown = await GET("/b/NoSuchBoard");
  expect(unknown.status).toBe(200);
  expect(await unknown.text()).toContain("此看板尚未收錄：NoSuchBoard");
});

test("GET /a/{id} renders article by DB id", async () => {
  const resp = await GET("/a/1");
  expect(resp.status).toBe(200);
  expect(await resp.text()).toContain("[公告] pinned post");

  expect((await GET("/a/99999")).status).toBe(404);
  expect((await GET("/a/abc")).status).toBe(404);
});

test("GET /boards lists boards with counts", async () => {
  const resp = await GET("/boards");
  expect(resp.status).toBe(200);
  const body = await resp.text();
  expect(body).toContain("TestBoard");
  expect(body).toContain(">35<");
});

test("GET /healthz returns JSON stats", async () => {
  const resp = await GET("/healthz");
  expect(resp.status).toBe(200);
  const json = JSON.parse(await resp.text()) as { status: string; analyzed: number; total: number };
  expect(json.status).toBe("ok");
  expect(json.analyzed).toBe(0);
});

test("GET /static/app.css serves plain CSS", async () => {
  const resp = await GET("/static/app.css");
  expect(resp.status).toBe(200);
  expect(resp.headers.get("content-type")).toContain("text/css");
  const css = await resp.text();
  expect(css).not.toContain("tailwind");
  expect(css).toContain(".ptt-body");
});

test("404 for unknown paths", async () => {
  expect((await GET("/nope")).status).toBe(404);
  expect((await GET("/bbs/TestBoard/weird.png")).status).toBe(404);
});
