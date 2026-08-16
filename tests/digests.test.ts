import { test, expect, afterAll } from "bun:test";
import { openMemoryDB } from "../src/db/sqlite.ts";
import { migrate } from "../src/db/migrate.ts";
import { LLMClient } from "../src/llm/client.ts";
import { digestCandidates, buildDigestPrompt, generateDigest, storeDigest, hasDigest, listDigests } from "../src/repo/digests.ts";

const stubLLM = Bun.serve({
  port: 0,
  fetch: async () =>
    Response.json({
      choices: [{ message: { content: "板上的主要話題是遊戲更新；最大爭議是平衡性改動；整體氣氛偏正面。" } }],
      usage: { prompt_tokens: 200, completion_tokens: 60 },
    }),
});
afterAll(() => stubLLM.stop(true));

function seed() {
  const db = openMemoryDB();
  migrate(db);
  db.prepare(`INSERT INTO boards (id, name, is_hot) VALUES (1, 'C_Chat', 1)`).run();
  db.prepare(`INSERT INTO boards (id, name, is_hot) VALUES (2, 'Cold', 0)`).run();
  const ins = db.prepare(`INSERT INTO articles (board_id, url_id, content, net_count, posted_at) VALUES (1, ?, ?, 50, ?)`);
  const insI = db.prepare(
    `INSERT INTO article_insights (article_id, tldr, model, schema_ver, sentiment, controversy, generated_at) VALUES (?, ?, 'glm-5.2', 2, '正面', '低', ?)`,
  );
  for (let i = 1; i <= 4; i++) {
    ins.run(`M.${i}.A.D`, "x".repeat(30), Math.floor(Date.now() / 1000) - i * 3600);
    const id = (db.prepare(`SELECT id FROM articles WHERE url_id = ?`).get(`M.${i}.A.D`) as { id: number }).id;
    insI.run(id, `文章${i}摘要`, Math.floor(Date.now() / 1000) - 600);
  }
  return db;
}

test("digestCandidates: trailing-24h insights only, net desc", () => {
  const db = seed();
  const c = digestCandidates(db, 1, Math.floor(Date.now() / 1000) - 24 * 3600);
  expect(c.length).toBe(4);
  // outside window → excluded
  db.prepare(`UPDATE article_insights SET generated_at = ?`).run(Math.floor(Date.now() / 1000) - 25 * 3600);
  expect(digestCandidates(db, 1, Math.floor(Date.now() / 1000) - 24 * 3600).length).toBe(0);
});

test("generateDigest: needs ≥3 articles, stores via stub LLM", async () => {
  const db = seed();
  const client = new LLMClient(`http://localhost:${stubLLM.port}`, "", "stub");
  const d = await generateDigest(db, client, "stub", 1, "C_Chat", "2026-08-16", Math.floor(Date.now() / 1000) - 24 * 3600);
  expect(d).not.toBeNull();
  expect(d!.digest).toContain("遊戲更新");
  expect(d!.articleCount).toBe(4);
  expect(buildDigestPrompt("C_Chat", digestCandidates(db, 1, 0))).toContain("看板：C_Chat");

  storeDigest(db, d!);
  expect(hasDigest(db, 1, "2026-08-16")).toBe(true);
  expect(hasDigest(db, 1, "2026-08-15")).toBe(false);

  const list = listDigests(db);
  expect(list.length).toBe(1); // only hot boards
  expect(list[0]!.boardName).toBe("C_Chat");
  expect(list[0]!.digest).toContain("遊戲更新");
});

test("generateDigest: skips when fuel < 3", async () => {
  const db = seed();
  db.prepare(`DELETE FROM articles WHERE url_id IN ('M.1.A.D','M.2.A.D')`).run();
  const client = new LLMClient(`http://localhost:${stubLLM.port}`, "", "stub");
  const d = await generateDigest(db, client, "stub", 1, "C_Chat", "2026-08-16", Math.floor(Date.now() / 1000) - 24 * 3600);
  expect(d).toBeNull();
});
