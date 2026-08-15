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
