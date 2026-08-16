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
     VALUES (1, ?, ?, ?, ?, 'author1', 'body text here long enough to count', '1.2.3.4', '5', 5, 5, 0)`,
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
  expect(body).toContain(`>${"u1".padEnd(12)}<`);
  expect(body).toContain(": good");
});

test("GET /bbs/{board}/{url_id}.html renders insight v2 fields", async () => {  const aid = (db.prepare(`SELECT id FROM articles WHERE url_id = 'M.1001.A.A1'`).get() as { id: number }).id;
  db.prepare(
    `INSERT INTO article_insights
       (article_id, tldr, community_take, top_comments, sentiment, controversy, tags, model, prompt_tokens, completion_tokens,
        schema_ver, article_type, entities, ad_likelihood, factuality, ai_generated, push_stance, push_facts, qa_summary)
     VALUES (?, '摘要v2', '推文叫好', '', '正面', '低', '[]', 'glm-5.2', 1, 1,
        2, '問卦', ?, '高度', '未證實', '人寫', ?, '推文爆料原文作者領錢辦事', '鄉民：要等七月')`,
  ).run(aid, JSON.stringify([{ name: "FGO", type: "遊戲" }]), JSON.stringify({ pro: 60, con: 30, neutral: 10 }));

  const resp = await GET("/bbs/TestBoard/M.1001.A.A1.html");
  const body = await resp.text();
  expect(body).toContain("類型 <span>[問卦]</span>");
  expect(body).toContain("FGO"); // entity chip
  expect(body).toContain("業配 <span class=\"c-f1\">[高度]</span>");
  expect(body).toContain("事實 <span>[未證實]</span>");
  expect(body).toContain("鄉民回答"); // qa_summary
  expect(body).toContain("推文情報"); // push_facts
  expect(body).toContain("推 <span class=\"c-f3\">60%</span>"); // stance
  // legacy/no-value badges stay hidden
  expect(body).not.toContain("[人寫]");

  // shared seeded db — remove the insight row so /healthz counts stay pristine
  db.prepare(`DELETE FROM article_insights WHERE article_id = ?`).run(aid);
});

test("GET /search and /e/:name serve entity pages", async () => {
  const aid = (db.prepare(`SELECT id FROM articles WHERE url_id = 'M.1001.A.A1'`).get() as { id: number }).id;
  db.prepare(
    `INSERT INTO article_insights
       (article_id, tldr, community_take, sentiment, controversy, tags, model, schema_ver, entities)
     VALUES (?, 'GTA 相關摘要', 'c', '正面', '低', '[]', 'm', 2, ?)`,
  ).run(aid, JSON.stringify([{ name: "GTA6", type: "遊戲" }]));
  db.prepare(`INSERT INTO entity_refs (name_norm, name, kind, article_id) VALUES ('gta6', 'GTA6', '遊戲', ?)`).run(aid);

  const s = await GET("/search?q=gta");
  expect(s.status).toBe(200);
  const sbody = await s.text();
  expect(sbody).toContain("entity-result");
  expect(sbody).toContain("GTA6");

  const e = await GET("/e/gta6");
  expect(e.status).toBe(200);
  const ebody = await e.text();
  expect(ebody).toContain("entity-timeline");
  expect(ebody).toContain("GTA 相關摘要");

  const miss = await GET("/search?q=zzzznotfound");
  expect(await miss.text()).toContain("沒有找到");

  const none = await GET("/e/zzzznotfound");
  expect(none.status).toBe(404);

  db.prepare(`DELETE FROM entity_refs WHERE article_id = ?`).run(aid);
  db.prepare(`DELETE FROM article_insights WHERE article_id = ?`).run(aid);
});

test("GET /deleted renders soft-deleted archive", async () => {  const empty = await GET("/deleted");
  expect(empty.status).toBe(200);
  expect(await empty.text()).toContain("刪文存檔");

  // seed: soft-delete one seeded article with an insight
  const aid = (db.prepare(`SELECT id FROM articles WHERE url_id = 'M.1005.A.A5'`).get() as { id: number }).id;
  db.prepare(
    `INSERT INTO article_insights (article_id, tldr, model, schema_ver) VALUES (?, '刪文摘要', 'm', 2)`,
  ).run(aid);
  db.prepare(`UPDATE articles SET deleted_at = ? WHERE id = ?`).run(Math.floor(Date.now() / 1000) - 3600, aid);

  const page = await GET("/deleted");
  const body = await page.text();
  expect(body).toContain("deleted-page");
  expect(body).toContain("article 5");
  expect(body).toContain("刪文摘要");
  expect(body).toContain("del-excerpt");

  db.prepare(`UPDATE articles SET deleted_at = NULL WHERE id = ?`).run(aid);
  db.prepare(`DELETE FROM article_insights WHERE article_id = ?`).run(aid);
});

test("GET /digest renders board digests", async () => {
  const empty = await GET("/digest");
  expect(empty.status).toBe(200);
  expect(await empty.text()).toContain("日報生成中");

  db.prepare(`UPDATE boards SET is_hot = 1 WHERE id = 1`).run();
  db.prepare(
    `INSERT INTO board_digests (board_id, day, digest, article_count, model) VALUES (1, '2026-08-16', '測試日報內容', 5, 'stub')`,
  ).run();
  const page = await GET("/digest");
  const body = await page.text();
  expect(body).toContain("digest-page");
  expect(body).toContain("TestBoard");
  expect(body).toContain("測試日報內容");
  db.prepare(`DELETE FROM board_digests`).run();
  db.prepare(`UPDATE boards SET is_hot = 0 WHERE id = 1`).run();
});

test("GET /b/{board} renders board, unknown board → not-collected page", async () => {
  const ok = await GET("/b/TestBoard");
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain("article 35");

  const unknown = await GET("/b/NoSuchBoard");
  expect(unknown.status).toBe(200);
  expect(await unknown.text()).toContain("此看板尚未收錄：NoSuchBoard");
});

test("GET /b/{board}?page out of range → 404, in range → 200", async () => {
  // 35 articles at PAGE_SIZE=30 → 2 pages
  expect((await GET("/b/TestBoard?page=2")).status).toBe(200);
  expect((await GET("/b/TestBoard?page=3")).status).toBe(404); // p > total early return
  expect((await GET("/b/TestBoard?page=0")).status).toBe(200); // clamped to 1
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
  expect(json.total).toBe(0); // seeded net_count=5 below default minNet=20
});

test("GET /healthz honors configured minNet", async () => {
  const app5 = createServer({
    db,
    pageSize: 30,
    hot: new HotBoardsCache(`http://localhost:${fixtureServer.port}`, 60_000),
    minNet: 5,
  });
  try {
    const resp = await app5.handler(new Request("http://localhost/healthz"));
    const json = JSON.parse(await resp.text()) as { total: number };
    expect(json.total).toBe(35); // all 35 seeded articles pass the lowered threshold
  } finally {
    app5.stop();
  }
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
