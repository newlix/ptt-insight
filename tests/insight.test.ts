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

test("parseAnalysis v2 fields", () => {
  const raw = JSON.stringify({
    tldr: "摘要", community_take: "看法", top_comments: ["c1"],
    sentiment: "正面", controversy: "高", tags: ["t1"],
    article_type: "這是一則問卦", entities: [{ name: "FGO", type: "遊戲" }, { name: "", type: "人物" }],
    ad_likelihood: "高度疑似", factuality: "未證實的爆料", ai_generated: "疑似AI生成的模板文",
    push_stance: { pro: 150, con: -5, neutral: "x" },
    push_facts: " 推文有人貼出官網公告 ", qa_summary: "推文說要等 7 月",
  });
  const an = parseAnalysis(raw);
  expect(an.article_type).toBe("問卦");
  expect(an.entities).toEqual([{ name: "FGO", type: "遊戲" }]); // empty name filtered
  expect(an.ad_likelihood).toBe("高度");
  expect(an.factuality).toBe("未證實");
  expect(an.ai_generated).toBe("疑似AI");
  expect(an.push_stance).toEqual({ pro: 100, con: 0, neutral: 0 }); // clamped
  expect(an.push_facts).toBe("推文有人貼出官網公告");
  expect(an.qa_summary).toBe("推文說要等 7 月");
});

test("parseAnalysis v1-only output gets v2 defaults", () => {
  const an = parseAnalysis('{"tldr":"摘要","community_take":"c","top_comments":[],"sentiment":"中立","controversy":"低","tags":[]}');
  expect(an.article_type).toBe("其他");
  expect(an.entities).toEqual([]);
  expect(an.ad_likelihood).toBe("無");
  expect(an.factuality).toBe("觀點");
  expect(an.ai_generated).toBe("不確定");
  expect(an.push_stance).toEqual({ pro: 0, con: 0, neutral: 0 });
  expect(an.push_facts).toBe("");
  expect(an.qa_summary).toBe("");
});

test("entities capped at 8", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `e${i}`, type: "其他" }));
  const an = parseAnalysis(JSON.stringify({ tldr: "t", entities: many }));
  expect(an.entities.length).toBe(8);
});

test("schema_ver<2 rows re-enter the pending queue", async () => {
  const db = openMemoryDB();
  migrate(db);
  db.prepare(`INSERT INTO boards (id, name) VALUES (1, 'Test')`).run();
  db.prepare(`INSERT INTO articles (board_id, url_id, content, net_count) VALUES (1, ?, ?, 50)`).run("M.9.A.X", "y".repeat(30));

  const client = new LLMClient(`http://localhost:${stubLLM.port}`, "", "stub-model");
  const result = await analyze(client, (claimPendingArticles(db, 5, 20))[0]!, "stub-model");
  storeInsight(db, result);
  expect(claimPendingArticles(db, 5, 20)).toEqual([]); // v2 → not pending

  db.prepare(`UPDATE article_insights SET schema_ver = 1`).run(); // simulate legacy row
  expect(claimPendingArticles(db, 5, 20).length).toBe(1); // flows back

  const v2row = db.prepare(`SELECT schema_ver, article_type, push_stance FROM article_insights`).get() as { schema_ver: number; article_type: string | null; push_stance: string | null };
  storeInsight(db, { ...result });
  expect(v2row.schema_ver).toBe(1); // captured before re-store; re-store below flips it
  const after = db.prepare(`SELECT schema_ver FROM article_insights`).get() as { schema_ver: number };
  expect(after.schema_ver).toBe(2);
});
