import { test, expect } from "bun:test";
import { RateLimiter, CombinedLimiter } from "../../../src/crawler/ptt/rate_limiter.ts";

// Refill rate 0.0001/s ≈ frozen for test purposes — buckets behave as fixed
// burst counters, making take() success/failure fully deterministic.
const FROZEN = 0.0001;

// How many consecutive take()s resolve without waiting (microtask-drained).
async function immediateTakes(l: { take(): Promise<void> }, max: number): Promise<number> {
  let n = 0;
  for (let i = 0; i < max; i++) {
    let settled = false;
    const p = l.take().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 5)); // let microtasks run
    if (!settled) return n;
    await p;
    n++;
  }
  return n;
}

test("CombinedLimiter: effective burst = min of buckets", async () => {
  const sub = new RateLimiter(FROZEN, 3); // backfill cap burst 3
  const global = new RateLimiter(FROZEN, 5); // global burst 5
  const combined = new CombinedLimiter([sub, global]);
  expect(await immediateTakes(combined, 8)).toBe(3); // sub bucket binds
});

test("CombinedLimiter: global bucket can serve incremental while backfill holds sub tokens", async () => {
  const sub = new RateLimiter(FROZEN, 3);
  const global = new RateLimiter(FROZEN, 5);
  const backfill = new CombinedLimiter([sub, global]);

  // Backfill consumes its full sub-bucket share.
  expect(await immediateTakes(backfill, 8)).toBe(3);

  // Incremental (global-only) still has 2 tokens: guaranteed-share semantics.
  expect(await immediateTakes(global, 5)).toBe(2);
});

test("single RateLimiter: burst floor and token spend", async () => {
  const l = new RateLimiter(FROZEN, 4);
  expect(await immediateTakes(l, 8)).toBe(4);
});
