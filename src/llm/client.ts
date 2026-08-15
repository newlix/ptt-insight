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

// Statuses worth retrying with backoff. 429 = provider rate limit (Z.AI 1302);
// 5xx = transient provider/proxy failures.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface LLMClientOptions {
  maxRetries?: number; // retry attempts for 429/5xx/network errors (default 2)
  retryBackoffMs?: number; // first backoff, doubles per attempt (default 15s)
}

export class LLMClient {
  private readonly chatURL: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;

  constructor(baseURL: string, apiKey: string, model: string, opts: LLMClientOptions = {}) {
    baseURL = baseURL.replace(/\/+$/, "");
    this.chatURL = chatCompletionsURL(baseURL);
    this.apiKey = apiKey;
    this.model = model;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryBackoffMs = opts.retryBackoffMs ?? 15_000;
  }

  async complete(systemPrompt: string, userPrompt: string, maxTokens: number, signal?: AbortSignal): Promise<LLMResult> {
    let waitMs = this.retryBackoffMs;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // ±20% jitter so concurrent slots don't retry in lockstep
        const jitter = 0.8 + Math.random() * 0.4;
        await sleep(waitMs * jitter, signal);
        waitMs *= 2;
      }

      let resp: Response;
      try {
        resp = await fetch(this.chatURL, {
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
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
            : AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        lastErr = e; // network error — retry
        continue;
      }

      const body = await resp.text();

      if (resp.ok) {
        return parseSuccess(body);
      }

      if (isContentFilterError(body)) {
        throw new ContentFilterError(); // never retried with the same provider
      }

      if (RETRYABLE_STATUS.has(resp.status)) {
        lastErr = new Error(`llm status ${resp.status}: ${truncate(body, 500)}`);
        // Honor server-provided Retry-After when larger than our backoff
        const ra = Number(resp.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) {
          waitMs = Math.max(waitMs, ra * 1000);
        }
        continue;
      }

      throw new Error(`llm status ${resp.status}: ${truncate(body, 500)}`);
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

function parseSuccess(body: string): LLMResult {
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

// Resolves after `ms`, or early when the signal aborts.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
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
