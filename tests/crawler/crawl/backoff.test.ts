import { test, expect } from "bun:test";
import { nextInterval, MIN_INTERVAL_SECS, MAX_INTERVAL_SECS } from "../../../src/crawler/crawl/backoff.ts";

test("nextInterval table", () => {
  const cases: [string, number, boolean, number][] = [
    ["new articles resets to min", 3600, true, MIN_INTERVAL_SECS],
    ["new articles resets even from max", MAX_INTERVAL_SECS, true, MIN_INTERVAL_SECS],
    ["no new articles doubles", 600, false, 1200],
    ["no new articles doubles large", 3600, false, 7200],
    ["doubling caps at max", 400000, false, MAX_INTERVAL_SECS],
    ["already at max stays at max", MAX_INTERVAL_SECS, false, MAX_INTERVAL_SECS],
    ["min doubled to 1200", MIN_INTERVAL_SECS, false, 1200],
  ];
  for (const [name, current, newArticles, want] of cases) {
    expect(nextInterval(current, newArticles)).toBe(want);
  }
});
