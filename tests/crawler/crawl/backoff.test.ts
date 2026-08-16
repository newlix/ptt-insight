import { test, expect } from "bun:test";
import { nextInterval, MIN_INTERVAL_SECS, MAX_INTERVAL_SECS } from "../../../src/crawler/crawl/backoff.ts";

test("nextInterval table (defaults)", () => {
  const cases: [string, number, boolean, number][] = [
    ["new articles resets to min", 3600, true, MIN_INTERVAL_SECS],
    ["new articles resets even from max", MAX_INTERVAL_SECS, true, MIN_INTERVAL_SECS],
    ["no new articles doubles", 600, false, 1200],
    ["no new articles doubles large", 3600, false, 7200],
    ["doubling caps at max", 400000, false, MAX_INTERVAL_SECS],
    ["already at max stays at max", MAX_INTERVAL_SECS, false, MAX_INTERVAL_SECS],
    ["min doubled to 240", MIN_INTERVAL_SECS, false, 240],
  ];
  for (const [name, current, newArticles, want] of cases) {
    expect(nextInterval(current, newArticles)).toBe(want);
  }
});

test("nextInterval custom bounds", () => {
  // Tighter floor configured via INCREMENTAL_MIN_SECS
  expect(nextInterval(3600, true, 60, 86400)).toBe(60);
  expect(nextInterval(60, false, 60, 86400)).toBe(120);
  expect(nextInterval(50000, false, 60, 86400)).toBe(86400);
  expect(nextInterval(86400, true, 60, 86400)).toBe(60);
  // Custom ceiling shortens the quiet-board tail
  expect(nextInterval(50000, false, 600, 7200)).toBe(7200);
});
