import { test, expect, afterAll } from "bun:test";
import { openMemoryDB } from "../src/db/sqlite.ts";
import { migrate } from "../src/db/migrate.ts";
import { LLMClient } from "../src/llm/client.ts";
import { buildPrompt, parseAnalysis, extractJSON, analyze } from "../src/insight/analyze.ts";
import { claimPendingArticles, storeInsight } from "../src/repo/insights.ts";
import { isPeak } from "../src/insight/worker.ts";
import type { PendingArticle } from "../src/repo/insights.ts";

test("buildPrompt", () => {
  const a: PendingArticle = {
    id: 1,
    boardId: 1,
    title: "測試標題",
    author: "author1",
    content: "內文".repeat(10),
    netCount: 10,
    pushes: [
      { seq: 0, tag: "推", userId: "u1", content: "推文一", ipDatetime: null },
      { seq: 1, tag: "噓", userId: "u2", content: "推文二", ipDatetime: null },
    ],
  };
  const p = buildPrompt(a);
  expect(p).toContain("標題：測試標題");
  expect(p).toContain("作者：author1");
  expect(p).toContain("--- 文章內容 ---");
  expect(p).toContain("--- 推文（共 2 則）---");
  expect(p).toContain("推 u1: 推文一");
  expect(p).toContain("噓 u2: 推文二");

  // no pushes variant
  const p2 = buildPrompt({ ...a, pushes: [], title: null, author: null });
  expect(p2).toContain("標題：(無標題)");
  expect(p2).toContain("--- 推文：（無）---");

  // truncation
  const p3 = buildPrompt({ ...a, content: "x".repeat(4000) });
  expect(p3).toContain("...(內容過長已截斷)");
});

test("parseAnalysis + extractJSON", () => {
  const raw = '```json\n{"tldr":"摘要","community_take":"看法","top_comments":["c1"],"sentiment":"有點正面","controversy":"很高","tags":["t1"]}\n```';
  const an = parseAnalysis(raw);
  expect(an.tldr).toBe("摘要");
  expect(an.sentiment).toBe("正面"); // normalized
  expect(an.controversy).toBe("高"); // normalized
  expect(an.tags).toEqual(["t1"]);

  // malformed then fixed — extractJSON recovers brace-embedded JSON
  expect(extractJSON('前置文字 {"a":1} 後置')).toBe('{"a":1}');
  expect(() => parseAnalysis('{"community_take":"no tldr"}')).toThrow(/empty tldr/);
});

test("isPeak (Mon-Fri 14-18 UTC+8; weekends off)", () => {
  // 2026-08-14 = Friday; 16:00 Taipei = 08:00 UTC
  const fri = { weekday: 5, hour: 16, dateMs: 0 };
  expect(isPeak(fri)).toBe(true);
  expect(isPeak({ ...fri, hour: 13 })).toBe(false);
  expect(isPeak({ ...fri, hour: 18 })).toBe(false);
  // Saturday any hour
  expect(isPeak({ weekday: 6, hour: 16, dateMs: 0 })).toBe(false);
  expect(isPeak({ weekday: 0, hour: 16, dateMs: 0 })).toBe(false); // Sunday
});

// LLM stub server: returns fixed JSON analysis.
const stubLLM = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = (await req.json()) as { messages: { role: string; content: string }[] };
    if (body.messages?.[0]?.role !== "system") {
      return Response.json({ error: "bad request" }, { status: 400 });
    }
    return Response.json({
      choices: [{ message: { content: JSON.stringify({
        tldr: "這是摘要", community_take: "推文叫好", top_comments: ["推 u1: 讚"],
        sentiment: "正面", controversy: "低", tags: ["tagA"],
      }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
  },
});
afterAll(() => stubLLM.stop(true));

test("analyze end-to-end with stub LLM", async () => {
  const client = new LLMClient(`http://localhost:${stubLLM.port}`, "", "stub-model");
  const a: PendingArticle = {
    id: 7, boardId: 1, title: "T", author: "A", content: "正文內容".repeat(5), netCount: 30,
    pushes: [{ seq: 0, tag: "推", userId: "u1", content: "讚", ipDatetime: null }],
  };
  const result = await analyze(client, a, "stub-model");
  expect(result.articleId).toBe(7);
  expect(result.tldr).toBe("這是摘要");
  expect(result.topComments).toBe("推 u1: 讚");
  expect(result.model).toBe("stub-model");
  expect(result.promptTokens).toBe(100);
  expect(result.completionTokens).toBe(50);
});

test("insight writes through storeInsight (worker happy path, in-memory)", async () => {
  const db = openMemoryDB();
  migrate(db);
  db.prepare(`INSERT INTO boards (id, name) VALUES (1, 'Test')`).run();
  db.prepare(`INSERT INTO articles (board_id, url_id, content, net_count) VALUES (1, ?, ?, 99)`).run("M.1.A.X", "x".repeat(30));

  const client = new LLMClient(`http://localhost:${stubLLM.port}`, "", "stub-model");
  const pending = claimPendingArticles(db, 5, 20);
  expect(pending.length).toBe(1);
  const result = await analyze(client, pending[0]!, "stub-model");
  storeInsight(db, result);

  const row = db.prepare(`SELECT tldr, error FROM article_insights WHERE article_id = ?`).get(pending[0]!.id) as { tldr: string; error: string | null };
  expect(row.tldr).toBe("這是摘要");
  expect(row.error).toBeNull();
  expect(claimPendingArticles(db, 5, 20)).toEqual([]);
});
