// OpenAI-compatible chat completions client (GLM via Z.AI / opencode proxy).

export interface LLMResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

// The provider refused the request due to content policy (e.g. Z.AI error
// 1301: gambling/politics/adult content). Callers should retry with a
// different provider.
export class ContentFilterError extends Error {
  constructor() {
    super("content filter blocked by provider");
    this.name = "ContentFilterError";
  }
}

const TIMEOUT_MS = 120_000;

export class LLMClient {
  private readonly chatURL: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(baseURL: string, apiKey: string, model: string) {
    baseURL = baseURL.replace(/\/+$/, "");
    this.chatURL = chatCompletionsURL(baseURL);
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(systemPrompt: string, userPrompt: string, maxTokens: number, signal?: AbortSignal): Promise<LLMResult> {
    const resp = await fetch(this.chatURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: maxTokens,
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = await resp.text();
    if (!resp.ok) {
      if (isContentFilterError(body)) throw new ContentFilterError();
      throw new Error(`llm status ${resp.status}: ${truncate(body, 500)}`);
    }

    const cr = JSON.parse(body) as {
      choices?: { message: { content: string; reasoning_content?: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const choice = cr.choices?.[0];
    if (!choice) throw new Error("no choices in response");
    if (choice.message.content === "") {
      throw new Error("empty content (model may have hit max_tokens during reasoning)");
    }

    return {
      content: choice.message.content,
      promptTokens: cr.usage?.prompt_tokens ?? 0,
      completionTokens: cr.usage?.completion_tokens ?? 0,
    };
  }
}

// Resolves the full endpoint from a base URL.
//   "http://localhost:18905"              → +"/v1/chat/completions"
//   "https://api.z.ai/api/coding/paas/v4" → +"/chat/completions" (already versioned)
function chatCompletionsURL(baseURL: string): string {
  if (baseURL.endsWith("/chat/completions")) return baseURL;
  if (/\/v\d+[a-z]*$/.test(baseURL)) return `${baseURL}/chat/completions`;
  return `${baseURL}/v1/chat/completions`;
}

function isContentFilterError(body: string): boolean {
  return (
    body.includes(`"code":"1301"`) ||
    body.includes(`"code": 1301`) ||
    body.includes(`"code":1301`) ||
    body.includes("contentFilter")
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "...";
}
