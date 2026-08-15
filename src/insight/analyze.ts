import type { LLMClient } from "../llm/client.ts";
import type { InsightResult, PendingArticle } from "../repo/insights.ts";

const SYSTEM_PROMPT =
  "你是 PTT 文章與推文討論分析助手。PTT 是台灣最大的 BBS（類似 Reddit）。" +
  "你會收到一篇文章及其所有推文（留言）。請綜合分析「文章本身」和「社群討論」，用繁體中文回傳 JSON。\n\n" +
  "JSON 格式：\n" +
  "{\n" +
  '  "tldr": "文章在說什麼（1-2句，60字內）",\n' +
  '  "community_take": "推文區的社群怎麼看：主流觀點、共識或分歧、氣氛（2-3句，100字內）",\n' +
  '  "top_comments": ["最有價值的推文1", "推文2", "推文3"],\n' +
  '  "sentiment": "正面|中立|負面",\n' +
  '  "controversy": "低|中|高",\n' +
  '  "tags": ["關鍵字1", "關鍵字2"]\n' +
  "}\n\n" +
  "分析重點：\n" +
  "- tldr 摘要文章本身的核心\n" +
  '- community_take 著重在「推文區的人怎麼想」：大家一致推爆、正反意見對立、推文在吵架等\n' +
  "- top_comments 挑 0-3 則最有代表性的推文（搞笑、一針見血、爭議性高），可轉述\n" +
  "- controversy 根據推/噓是否對立來判斷：推噓各半=高，明顯一面倒=低\n" +
  "- 只回傳 JSON 物件本身，不要用 markdown code block 包裹";

const MAX_CONTENT_LEN = 3000;
const MAX_PUSHES = 500;
// GLM-5.2 reasons before answering; 4096 occasionally left zero budget for
// the answer itself ("empty content" errors) — 8192 gives reasoning headroom.
const MAX_TOKENS = 8192;

interface Analysis {
  tldr: string;
  community_take: string;
  top_comments: string[];
  sentiment: string;
  controversy: string;
  tags: string[];
}

export function buildPrompt(a: PendingArticle): string {
  const b: string[] = [];
  const title = a.title && a.title !== "" ? a.title : "(無標題)";
  b.push(`標題：${title}`);
  if (a.author && a.author !== "") b.push(`作者：${a.author}`);

  b.push("\n--- 文章內容 ---");
  let content = a.content ?? "";
  if (content.length > MAX_CONTENT_LEN) {
    content = content.slice(0, MAX_CONTENT_LEN) + "\n...(內容過長已截斷)";
  }
  b.push(content);

  if (a.pushes.length > 0) {
    let pushes = a.pushes;
    let note = "";
    if (pushes.length > MAX_PUSHES) {
      pushes = pushes.slice(0, MAX_PUSHES);
      note = `，僅顯示前 ${MAX_PUSHES} 則`;
    }
    b.push(`\n--- 推文（共 ${a.pushes.length} 則${note}）---`);
    for (const p of pushes) {
      b.push(`${p.tag} ${p.userId}: ${p.content ?? ""}`);
    }
  } else {
    b.push("\n--- 推文：（無）---");
  }
  return b.join("\n");
}

export async function analyze(
  client: LLMClient,
  a: PendingArticle,
  model: string,
  signal?: AbortSignal,
): Promise<InsightResult> {
  const prompt = buildPrompt(a);

  // GLM occasionally emits slightly malformed JSON (e.g. missing opening
  // quote). One retry with the same prompt usually fixes it.
  let res;
  let an: Analysis | null = null;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await client.complete(SYSTEM_PROMPT, prompt, MAX_TOKENS, signal);
    try {
      an = parseAnalysis(res.content);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr !== null || !an || !res) {
    throw new Error(`parse llm output: ${String(lastErr)} (raw: ${res?.content.slice(0, 200) ?? ""})`);
  }

  return {
    articleId: a.id,
    tldr: an.tldr,
    communityTake: an.community_take,
    topComments: an.top_comments.join("\n"),
    sentiment: an.sentiment,
    controversy: an.controversy,
    tags: an.tags,
    model,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
  };
}

export function parseAnalysis(raw: string): Analysis {
  const cleaned = extractJSON(raw);
  const an = JSON.parse(cleaned) as Partial<Analysis>;

  const tldr = (an.tldr ?? "").trim();
  if (tldr === "") throw new Error("empty tldr");

  return {
    tldr,
    community_take: an.community_take ?? "",
    top_comments: an.top_comments ?? [],
    sentiment: normalizeSentiment(an.sentiment ?? ""),
    controversy: normalizeControversy(an.controversy ?? ""),
    tags: an.tags ?? [],
  };
}

function normalizeSentiment(s: string): string {
  if (s.includes("正")) return "正面";
  if (s.includes("負")) return "負面";
  return "中立";
}

function normalizeControversy(s: string): string {
  if (s.includes("高")) return "高";
  if (s.includes("中")) return "中";
  return "低";
}

export function extractJSON(s: string): string {
  s = s.trim();
  if (s.startsWith("```json")) s = s.slice(7);
  else if (s.startsWith("```")) s = s.slice(3);
  if (s.endsWith("```")) s = s.slice(0, -3);
  s = s.trim();
  const start = s.indexOf("{");
  if (start >= 0) {
    const end = s.lastIndexOf("}");
    if (end > start) return s.slice(start, end + 1);
  }
  return s;
}
