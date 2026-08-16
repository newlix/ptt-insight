import { RateLimiter, abortableSleep } from "./rate_limiter.ts";

export const PTT_BASE_URL = "https://www.ptt.cc";
export const USER_AGENT = "ptt-crawler/1.0";

const DEFAULT_RETRY = 3;
const DEFAULT_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

// Consume an error response body so the connection returns to the pool
// instead of waiting on an unread stream (404s are routine: deleted articles).
async function drainBody(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    // best effort — never mask the original error path
  }
}

// Indicates the article was deleted (HTTP 404).
export class NotFoundError extends Error {
  constructor(url: string) {
    super(`ptt: article not found (404): ${url}`);
    this.name = "NotFoundError";
  }
}

// Caller aborted the request (SIGTERM / shutdown). Distinct from network
// errors so crawl loops can shut down quietly without retry noise.
export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

export function isAbortError(e: unknown): boolean {
  return (
    e instanceof AbortedError ||
    (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"))
  );
}

export interface FetcherOptions {
  baseURL?: string; // override for tests
  maxRetries?: number;
  baseBackoffMs?: number;
}

// Fetcher handles HTTP requests to PTT with rate limiting, retry, and the
// over18 cookie.
export class Fetcher {
  readonly baseURL: string;
  readonly maxRetries: number;
  readonly baseBackoffMs: number;
  private readonly limiter: RateLimiter;

  constructor(reqPerSec: number, opts: FetcherOptions = {}) {
    this.baseURL = opts.baseURL ?? PTT_BASE_URL;
    this.maxRetries = opts.maxRetries ?? DEFAULT_RETRY;
    this.baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.limiter = new RateLimiter(reqPerSec, Math.max(1, Math.floor(reqPerSec)));
  }

  // fetch retrieves a URL and returns its body as text.
  // Handles rate limiting, over18 cookie, and exponential backoff retry on
  // 5xx/network errors. 4xx errors are not retried (client errors — article
  // deleted, board removed, etc).
  async fetch(url: string, signal?: AbortSignal): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.limiter.take(signal);
      if (signal?.aborted) throw new AbortedError();

      let resp: Response;
      try {
        const timeoutSignal = AbortSignal.any([
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ...(signal ? [signal] : []),
        ]);
        resp = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            Cookie: "over18=1",
          },
          signal: timeoutSignal,
          redirect: "follow",
        });
      } catch (e) {
        if (signal?.aborted) throw new AbortedError();
        lastErr = e;
        await this.backoff(attempt, signal);
        continue;
      }

      if (resp.status >= 500) {
        lastErr = new Error(`server error: ${resp.status}`);
        await drainBody(resp);
        await this.backoff(attempt, signal);
        continue;
      }

      if (resp.status === 404) {
        await drainBody(resp);
        throw new NotFoundError(url);
      }

      if (resp.status >= 400) {
        await drainBody(resp);
        throw new Error(`client error: ${resp.status} for ${url}`);
      }

      try {
        return await resp.text();
      } catch (e) {
        if (signal?.aborted) throw new AbortedError();
        lastErr = e;
        await this.backoff(attempt, signal);
        continue;
      }
    }
    throw new Error(`after ${this.maxRetries} retries: ${String(lastErr)}`);
  }

  private async backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    await abortableSleep(this.baseBackoffMs * (1 << attempt), signal);
  }
  // fetchIndexPage fetches a board index page.
  // page=0 fetches the latest page (index.html); page=N fetches indexN.html.
  fetchIndexPage(board: string, page: number, signal?: AbortSignal): Promise<string> {
    const url =
      page > 0
        ? `${this.baseURL}/bbs/${board}/index${page}.html`
        : `${this.baseURL}/bbs/${board}/index.html`;
    return this.fetch(url, signal);
  }

  fetchArticlePage(board: string, urlId: string, signal?: AbortSignal): Promise<string> {
    const url = `${this.baseURL}/bbs/${board}/${urlId}.html`;
    return this.fetch(url, signal);
  }
}
