import { test, expect } from "bun:test";
import { buildArticleParams, buildPushParams, articleURL } from "../../../src/crawler/crawl/store.ts";
import type { IndexEntry, ParsedArticle, ParsedPush } from "../../../src/crawler/ptt/types.ts";

function fakeArticle(overrides: Partial<ParsedArticle> = {}): ParsedArticle {
  return {
    board: "TestBoard",
    urlId: "M.1000000000.A.AAA",
    title: "Test Title",
    author: "user1",
    postedAt: Date.UTC(2024, 0, 1, 12, 0, 0) / 1000,
    content: "Article body",
    ip: "1.2.3.4",
    pushes: [],
    pushCount: 3,
    booCount: 1,
    neutralCount: 1,
    ...overrides,
  };
}

test("buildArticleParams", () => {
  const entry: IndexEntry = { urlId: "M.1000000000.A.AAA", title: "T", author: "user1", date: "1/01", nrecRaw: "5", mark: "M", deleted: false };
  const article = fakeArticle();

  const params = buildArticleParams(42, entry, article);

  expect(params.boardId).toBe(42);
  expect(params.urlId).toBe("M.1000000000.A.AAA");
  expect(params.urlTimestamp).toBe(1000000000);
  expect(params.postedAt).toBe(article.postedAt);
  expect(params.title).toBe("Test Title");
  expect(params.nrecRaw).toBe("5");
  expect(params.mark).toBe("M");
  expect(params.pushCount).toBe(3);
  expect(params.netCount).toBe(2);
});

test("buildArticleParams with null postedAt", () => {
  const entry: IndexEntry = { urlId: "M.100.A.AAA", title: "T", author: "a", date: "1/01", nrecRaw: "", mark: "", deleted: false };
  const params = buildArticleParams(1, entry, fakeArticle({ postedAt: null }));

  expect(params.postedAt).toBeNull();
  expect(params.urlTimestamp).toBe(100); // "M.100." still matches M\.(\d+)\. (Go behavior)
  expect(params.nrecRaw).toBeNull(); // "" → NULL
  expect(params.mark).toBeNull();
});

test("buildArticleParams with unparsable url_id", () => {
  const entry: IndexEntry = { urlId: "not-a-urlid", title: "T", author: "a", date: "1/01", nrecRaw: "", mark: "", deleted: false };
  const params = buildArticleParams(1, entry, fakeArticle({ postedAt: null }));
  expect(params.urlTimestamp).toBe(0); // no match → 0 (Go behavior)
});

test("buildPushParams", () => {
  const pushes: ParsedPush[] = [
    { tag: "推", userId: "u1", content: "good", ipDateTime: "1.1.1.1 01/01 12:00" },
    { tag: "噓", userId: "u2", content: "bad", ipDateTime: "2.2.2.2 01/01 12:01" },
    { tag: "→", userId: "u3", content: "meh", ipDateTime: "01/01 12:02" },
  ];

  const rows = buildPushParams(99, pushes);

  expect(rows.length).toBe(3);
  expect(rows[0]!.articleId).toBe(99);
  expect(rows[0]!.seq).toBe(0);
  expect(rows[0]!.tag).toBe("推");
  expect(rows[0]!.userId).toBe("u1");
  expect(rows[1]!.seq).toBe(1);
  expect(rows[1]!.tag).toBe("噓");
  expect(rows[2]!.seq).toBe(2);
  expect(rows[2]!.tag).toBe("→");
  expect(rows[2]!.content).toBe("meh");
});

test("articleURL", () => {
  expect(articleURL("Gossiping", "M.1.A.B")).toBe("/bbs/Gossiping/M.1.A.B.html");
});
