import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArticlePage } from "../../../src/crawler/ptt/article_parser.ts";

const FIXTURE = join(import.meta.dir, "../../../testdata/gossiping_article_with_pushes.html");

test("parseArticlePage on real fixture", () => {
  const html = readFileSync(FIXTURE, "utf-8");
  const art = parseArticlePage(html, "/bbs/Gossiping/M.1786179614.A.51C.html");

  // Board and urlId from URL
  expect(art.board).toBe("Gossiping");
  expect(art.urlId).toBe("M.1786179614.A.51C");

  // Title from metaline
  expect(art.title).toBe("[公告] PTT 8/8維修後多數更新整合宣導(發錢)");

  // Author ID extracted from "ubcs (nickname)"
  expect(art.author).toBe("ubcs");

  // Posted time: 2026-08-08 17:00:12 Asia/Taipei (metaline differs from the
  // URL timestamp 17:00:14 by 2s — PTT's own rounding, both are stored)
  expect(art.postedAt).toBe(1786179612);

  // IP from ※ 發信站: line
  expect(art.ip).toBe("59.120.192.119");

  // Push counts: 792 推, 42 →, 8 噓
  expect(art.pushCount).toBe(792);
  expect(art.booCount).toBe(8);
  expect(art.neutralCount).toBe(42);
  expect(art.pushes.length).toBe(842);

  // First push spot-check
  const first = art.pushes[0]!;
  expect(first.tag).toBe("推");
  expect(first.userId).toBe("k385476916");
  expect(first.content).toBe("錢");
  expect(first.ipDateTime).not.toBe("");

  // Content should be non-empty and not contain ※ lines
  expect(art.content).not.toBe("");
  expect(art.content.includes("※")).toBe(false);
});

test("parseArticlePage minimal (no pushes)", () => {
  const html = `<html><body>
	<div id="main-content">
		<div class="article-metaline"><span class="article-meta-tag">作者</span><span class="article-meta-value">testuser (test)</span></div>
		<div class="article-metaline-right"><span class="article-meta-tag">看板</span><span class="article-meta-value">Test</span></div>
		<div class="article-metaline"><span class="article-meta-tag">標題</span><span class="article-meta-value">Hello World</span></div>
		<div class="article-metaline"><span class="article-meta-tag">時間</span><span class="article-meta-value">Mon Jan  1 12:00:00 2024</span></div>
		This is the article content.
		<span class="f2">※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4 (臺灣)
		</span>
	</div></body></html>`;

  const art = parseArticlePage(html, "/bbs/Test/M.100.A.AAA.html");

  expect(art.author).toBe("testuser");
  expect(art.title).toBe("Hello World");
  expect(art.ip).toBe("1.2.3.4");
  expect(art.pushes.length).toBe(0);
  // Mon Jan 1 12:00:00 2024 Asia/Taipei
  expect(art.postedAt).toBe(Date.UTC(2024, 0, 1, 12, 0, 0) / 1000 - 8 * 3600);
  expect(art.content.includes("This is the article content")).toBe(true);
});
