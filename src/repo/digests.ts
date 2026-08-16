import type { DB } from "../db/sqlite.ts";
import type { LLMClient } from "../llm/client.ts";

// Board digests: one LLM call per hot board per day over the insights the
// worker generated in the trailing 24h (pre-launch those are 7d-old articles;
// post-launch they approximate today's discussion).

export interface DigestInput {
  boardId: number;
  boardName: string;
  day: string; // YYYY-MM-DD UTC+8
  digest: string;
  articleCount: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

const SYSTEM_PROMPT =
  "你是 PTT 看板日報助手。你會收到某看板近 24 小時新完成分析的文章清單" +
  "（標題、推數、情緒、爭議度、摘要）。請用繁體中文寫 3-5 句看板日報，涵蓋：" +
  "① 主要話題（合併同主題）② 最大爭議或有趣現象 ③ 整體氣氛一句話。" +
  "直接輸出純文字段落，不要標題、不要 markdown、不要條列符號。";

export interface DigestArticleRow {
  id: number;
  title: string;
  net_count: number;
  sentiment: string | null;
  controversy: string | null;
  tldr: string;
}

export function digestCandidates(db: DB, boardId: number, sinceSecs: number, limit = 15): DigestArticleRow[] {
  return db
    .prepare(
      `SELECT a.id, a.title, a.net_count, ai.sentiment, ai.controversy, ai.tldr
       FROM articles a
       JOIN article_insights ai ON ai.article_id = a.id AND ai.error IS NULL
       WHERE a.board_id = ? AND a.deleted_at IS NULL AND ai.generated_at > ?
       ORDER BY a.net_count DESC
       LIMIT ?`,
    )
    .all(boardId, sinceSecs, limit) as DigestArticleRow[];
}

export function buildDigestPrompt(boardName: string, articles: DigestArticleRow[]): string {
  const lines = articles.map(
    (a) =>
      `- ${a.title}（推 ${a.net_count}｜情緒 ${a.sentiment ?? "?"}｜爭議 ${a.controversy ?? "?"}）：${a.tldr}`,
  );
  return `看板：${boardName}\n近 24 小時新分析文章（${articles.length} 篇）：\n${lines.join("\n")}`;
}

export async function generateDigest(
  db: DB,
  client: LLMClient,
  model: string,
  boardId: number,
  boardName: string,
  day: string,
  sinceSecs: number,
): Promise<DigestInput | null> {
  const articles = digestCandidates(db, boardId, sinceSecs);
  if (articles.length < 3) return null; // not enough fuel for a meaningful digest
  const res = await client.complete(SYSTEM_PROMPT, buildDigestPrompt(boardName, articles), 1024);
  const digest = res.content.trim();
  if (digest === "") return null;
  return {
    boardId,
    boardName,
    day,
    digest,
    articleCount: articles.length,
    model,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
  };
}

export function storeDigest(db: DB, d: DigestInput): void {
  db.prepare(
    `INSERT INTO board_digests (board_id, day, digest, article_count, model, prompt_tokens, completion_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (board_id, day) DO UPDATE SET
       digest = excluded.digest, article_count = excluded.article_count,
       model = excluded.model, prompt_tokens = excluded.prompt_tokens,
       completion_tokens = excluded.completion_tokens, generated_at = unixepoch()`,
  ).run(d.boardId, d.day, d.digest, d.articleCount, d.model, d.promptTokens, d.completionTokens);
}

export function hasDigest(db: DB, boardId: number, day: string): boolean {
  return db.prepare(`SELECT 1 FROM board_digests WHERE board_id = ? AND day = ?`).get(boardId, day) != null;
}

export interface BoardWithDigest {
  boardId: number;
  boardName: string;
  digest: string | null;
  day: string | null;
  articleCount: number;
  generatedAt: number | null;
}

// Hot boards with their latest digest (any day), board name order.
export function listDigests(db: DB): BoardWithDigest[] {
  const boards = db
    .prepare(`SELECT id, name FROM boards WHERE is_hot = 1 ORDER BY name`)
    .all() as { id: number; name: string }[];
  const get = db.prepare(
    `SELECT day, digest, article_count, generated_at FROM board_digests
     WHERE board_id = ? ORDER BY day DESC LIMIT 1`,
  );
  return boards.map((b) => {
    const d = get.get(b.id) as { day: string; digest: string; article_count: number; generated_at: number } | undefined;
    return {
      boardId: b.id,
      boardName: b.name,
      digest: d?.digest ?? null,
      day: d?.day ?? null,
      articleCount: d?.article_count ?? 0,
      generatedAt: d?.generated_at ?? null,
    };
  });
}
