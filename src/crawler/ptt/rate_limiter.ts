// Token-bucket rate limiter (the golang.org/x/time/rate analogue).
// Burst capacity = floor(rate), refilled continuously.
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  // take waits until one token is available. Rejects immediately if the
  // signal is already aborted; an in-progress wait ends early on abort.
  async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error("aborted");
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.rate);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = ((1 - this.tokens) / this.rate) * 1000;
      await abortableSleep(waitMs, signal);
    }
  }
}

// A limiter is anything with take() — RateLimiter satisfies it structurally.
export interface Limiter {
  take(signal?: AbortSignal): Promise<void>;
}

// CombinedLimiter gates one request on multiple buckets: a token must be
// taken from each. Used to cap backfill below the global politeness budget
// while the global bucket itself is shared with incremental — incremental
// keeps a guaranteed share when backfill is busy and borrows the unused
// backfill share when backfill idles.
export class CombinedLimiter implements Limiter {
  constructor(private readonly limiters: Limiter[]) {}

  async take(signal?: AbortSignal): Promise<void> {
    for (const l of this.limiters) {
      await l.take(signal);
    }
  }
}

// Resolves after `ms`, or early when the signal aborts.
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
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
