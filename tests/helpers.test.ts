import { test, expect } from "bun:test";
import {
  nrecClass,
  pttDate,
  articleTime,
  boardPageHref,
  splitPinned,
  parseIndexSlug,
  totalPages,
  nuserColor,
  esc,
} from "../src/views/helpers.ts";
import type { ArticleCard } from "../src/repo/articles.ts";

test("nrecClass table", () => {
  const cases: [string, string][] = [
    ["爆", "c-f1"],
    ["X1", "c-f1"],
    ["XX", "c-f1"],
    ["1", "c-f2"],
    ["9", "c-f2"],
    ["10", "c-f3"],
    ["99", "c-f3"],
    ["", ""],
  ];
  for (const [inV, want] of cases) {
    expect(nrecClass(inV)).toBe(want);
  }
  expect(nrecClass(null)).toBe("");
});

test("pttDate (Taipei UTC+8, space-padded month)", () => {
  expect(pttDate(Date.UTC(2026, 7, 14, 16, 0, 0) / 1000)).toBe(" 8/15"); // 16:00Z = 8/15 00:00 Taipei
  expect(pttDate(Date.UTC(2026, 7, 14, 10, 0, 0) / 1000)).toBe(" 8/14");
  expect(pttDate(Date.UTC(2026, 11, 25, 1, 0, 0) / 1000)).toBe("12/25");
  expect(pttDate(null)).toBe("");
});

test("articleTime (Taipei, Go 'Mon Jan _2 15:04:05 2006' format)", () => {
  expect(articleTime(Date.UTC(2026, 7, 14, 14, 39, 44) / 1000)).toBe("Fri Aug 14 22:39:44 2026");
  expect(articleTime(Date.UTC(2026, 0, 5, 3, 4, 5) / 1000)).toBe("Mon Jan  5 11:04:05 2026");
  expect(articleTime(null)).toBe("");
});

test("boardPageHref", () => {
  const cases: [string, number, number, string][] = [
    ["Gossiping", 85, 1, "/bbs/Gossiping/index.html"],
    ["Gossiping", 85, 2, "/bbs/Gossiping/index84.html"],
    ["Gossiping", 85, 85, "/bbs/Gossiping/index1.html"],
    ["Gossiping", 85, 0, "/bbs/Gossiping/index.html"],
    ["Gossiping", 85, 99, "/bbs/Gossiping/index1.html"],
  ];
  for (const [board, total, p, want] of cases) {
    expect(boardPageHref(board, total, p)).toBe(want);
  }
});

test("splitPinned", () => {
  const mk = (title: string): ArticleCard => ({
    id: 0, boardId: 0, boardName: "", urlId: "", title, author: null, postedAt: null,
    netCount: null, pushCount: null, booCount: null, nrecRaw: null, mark: null, contentLen: 0,
    hasInsight: false, tldr: null, communityTake: null, sentiment: null, controversy: null, tags: [],
  });
  const { pinned, normal } = splitPinned([
    mk("[問卦] a"),
    mk("[公告] b"),
    mk("Re: [公告] c"), // not pinned: prefix rule
    mk("[公告] d"),
  ]);
  expect(pinned.map((p) => p.title)).toEqual(["[公告] b", "[公告] d"]);
  expect(normal.map((p) => p.title)).toEqual(["[問卦] a", "Re: [公告] c"]);
});

test("parseIndexSlug", () => {
  const cases: [string, number | null][] = [
    ["index.html", null],
    ["index1.html", 1],
    ["index84.html", 84],
    ["index39187.html", 39187],
    ["index0.html", null],
    ["index-1.html", null],
    ["indexX.html", null],
    ["M.123.A.B.html", null],
    ["index", null],
    ["index.html.bak", null],
  ];
  for (const [inV, want] of cases) {
    expect(parseIndexSlug(inV)).toBe(want);
  }
});

test("totalPages", () => {
  const cases: [number, number, number][] = [
    [0, 30, 1],
    [1, 30, 1],
    [30, 30, 1],
    [31, 30, 2],
    [90, 30, 3],
    [91, 30, 4],
    [10484, 30, 350],
  ];
  for (const [count, pageSize, want] of cases) {
    expect(totalPages(count, pageSize)).toBe(want);
  }
});

test("nuserColor from upstream class", () => {
  expect(nuserColor("hl f1")).toBe("c-f1");
  expect(nuserColor("hl f3")).toBe("c-f3");
  expect(nuserColor("hl")).toBe("c-white");
});

test("esc escapes HTML", () => {
  expect(esc(`<script>"a" & 'b'</script>`)).toBe(
    "&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;",
  );
});
