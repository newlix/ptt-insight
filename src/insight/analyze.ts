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
  '  "tags": ["關鍵字1", "關鍵字2"],\n' +
  '  "article_type": "新聞|問卦|心得|爆掛|閒聊|其他",\n' +
  '  "entities": [{"name": "名稱", "type": "人物|公司|產品|遊戲|地點|事件|其他"}],\n' +
  '  "ad_likelihood": "無|疑似|高度",\n' +
  '  "factuality": "事實|觀點|未證實",\n' +
  '  "ai_generated": "人寫|不確定|疑似AI",\n' +
  '  "push_stance": {"pro": 60, "con": 20, "neutral": 20},\n' +
  '  "push_facts": "推文揭露的新事實、爆料或更正；沒有則空字串（60字內）",\n' +
  '  "qa_summary": "僅當 article_type=問卦：推文中最有價值的回答摘要；其他類型一律空字串（80字內）"\n' +
  "}\n\n" +
  "分析重點：\n" +
  "- tldr 摘要文章本身的核心\n" +
  '- community_take 著重在「推文區的人怎麼想」：大家一致推爆、正反意見對立、推文在吵架等\n' +
  "- top_comments 挑 0-3 則最有代表性的推文（搞笑、一針見血、爭議性高），可轉述\n" +
  "- controversy 根據推/噓是否對立來判斷：推噓各半=高，明顯一面倒=低\n" +
  "- entities 挑文章討論的核心對象，最多 8 個，只留重要的\n" +
  "- ad_likelihood 判斷是否為業配/廣告文（推銷意圖、置入連結、話術）\n" +
  "- factuality：有具體可查證事實=事實；純個人看法=觀點；聳動但無來源=未證實\n" +
  "- ai_generated 根據文風判斷是否疑似 AI 生成（模板化、過度工整、免洗帳號發文）\n" +
  "- push_stance 是推文立場分佈的估計百分比，三者加總應接近 100\n" +
  "- push_facts 只記推文「新增」的資訊，不重複正文\n" +
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
  article_type: string;
  entities: { name: string; type: string }[];
  ad_likelihood: string;
  factuality: string;
  ai_generated: string;
  push_stance: { pro: number; con: number; neutral: number };
  push_facts: string;
  qa_summary: string;
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
    articleType: an.article_type,
    entities: an.entities,
    adLikelihood: an.ad_likelihood,
    factuality: an.factuality,
    aiGenerated: an.ai_generated,
    pushStance: an.push_stance,
    pushFacts: an.push_facts,
    qaSummary: an.qa_summary,
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
    article_type: normalizeEnum(an.article_type ?? "", ["新聞", "問卦", "心得", "爆掛", "閒聊"], "其他"),
    entities: normalizeEntities(an.entities),
    ad_likelihood: normalizeEnum(an.ad_likelihood ?? "", ["高度", "疑似"], "無"),
    factuality: normalizeEnum(an.factuality ?? "", ["事實", "觀點", "未證實"], "觀點"),
    ai_generated: normalizeAI(an.ai_generated ?? ""),
    push_stance: normalizeStance(an.push_stance),
    push_facts: (an.push_facts ?? "").trim(),
    qa_summary: (an.qa_summary ?? "").trim(),
  };
}

function normalizeEnum(s: string, options: string[], fallback: string): string {
  for (const o of options) if (s.includes(o)) return o;
  return fallback;
}

function normalizeEntities(raw: unknown): { name: string; type: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is { name: string; type?: string } => typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string" && (e as { name: string }).name.trim() !== "")
    .slice(0, 8)
    .map((e) => ({ name: e.name.trim().slice(0, 40), type: (e.type ?? "其他").slice(0, 10) }));
}

function normalizeAI(s: string): string {
  if (s.includes("疑似")) return "疑似AI";
  if (s.includes("人寫")) return "人寫";
  return "不確定";
}

function normalizeStance(raw: unknown): { pro: number; con: number; neutral: number } {
  const clamp = (v: unknown): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
    return Math.min(100, Math.max(0, n));
  };
  const o = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  return { pro: clamp(o.pro), con: clamp(o.con), neutral: clamp(o.neutral) };
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
