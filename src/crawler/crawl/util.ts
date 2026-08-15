import { abortableSleep } from "../ptt/rate_limiter.ts";
import { isAbortError } from "../ptt/fetcher.ts";

// Sleeps for the given duration, returning false if the signal aborted first.
export async function sleepSecs(seconds: number, signal?: AbortSignal): Promise<boolean> {
  await abortableSleep(seconds * 1000, signal);
  return !signal?.aborted;
}

// True when the error is (or coincides with) an intentional shutdown —
// callers should return quietly instead of logging an error.
export function isAborted(e: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || isAbortError(e);
}

// Runs fn over items with at most `limit` concurrent invocations. Aborts
// dispatching new items (in-flight ones still settle) once the signal fires.
// Safe for shared counters: single-threaded event loop, no await between
// claim and increment.
export async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        if (signal?.aborted) return;
        const idx = i++;
        if (idx >= items.length) return;
        await fn(items[idx]!);
      }
    }),
  );
}
