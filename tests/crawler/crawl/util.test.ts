import { test, expect } from "bun:test";
import { mapLimit } from "../../../src/crawler/crawl/util.ts";

test("mapLimit caps concurrency and processes every item", async () => {
  let active = 0;
  let peak = 0;
  let done = 0;
  await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10 + n * 3));
    active--;
    done++;
  });
  expect(done).toBe(7);
  expect(peak).toBe(3); // 7 items / limit 3 → the cap is actually reached
});

test("mapLimit with limit larger than items still completes", async () => {
  const seen: number[] = [];
  await mapLimit([1, 2], 10, async (n) => {
    seen.push(n);
  });
  expect(seen.sort()).toEqual([1, 2]);
});

test("mapLimit stops dispatching after abort", async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 25);
  let started = 0;
  await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 1, async () => {
    started++;
    await new Promise((r) => setTimeout(r, 15));
  }, ctrl.signal);
  expect(started).toBeGreaterThanOrEqual(1);
  expect(started).toBeLessThan(8);
});
