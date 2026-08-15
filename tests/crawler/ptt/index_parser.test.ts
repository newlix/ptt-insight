import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIndexPage } from "../../../src/crawler/ptt/index_parser.ts";

const FIXTURE = join(import.meta.dir, "../../../testdata/gossiping_index.html");

test("parseIndexPage on real fixture", () => {
  const html = readFileSync(FIXTURE, "utf-8");
  const { entries, maxPageIndex } = parseIndexPage(html);

  // Fixture has 22 .r-ent entries
  expect(entries.length).toBe(22);
  // Max page index should be in the right ballpark (>39000)
  expect(maxPageIndex).toBeGreaterThan(39000);

  // First entry should have a urlId (not deleted)
  const first = entries[0]!;
  expect(first.deleted).toBe(false);
  expect(first.urlId).not.toBe("");
  expect(first.title).not.toBe("");
  expect(first.date).not.toBe("");

  // Should have entries with various nrec values
  expect(entries.some((e) => e.nrecRaw === "")).toBe(true);
  expect(entries.some((e) => e.nrecRaw !== "")).toBe(true);

  // Should have entries with marks (! and M)
  expect(entries.some((e) => e.mark === "!" || e.mark === "M")).toBe(true);
});

test("parseIndexPage with deleted article", () => {
  const html = `<html><body>
	<div class="r-list-container">
		<div class="r-ent">
			<div class="nrec"></div>
			<div class="title">(本文已被刪除) [someuser]</div>
			<div class="meta">
				<div class="author">-</div>
				<div class="date"> 8/12</div>
				<div class="mark"></div>
			</div>
		</div>
		<div class="r-ent">
			<div class="nrec"><span class="hl f2">5</span></div>
			<div class="title"><a href="/bbs/Test/M.100.A.AAA.html">Normal article</a></div>
			<div class="meta">
				<div class="author">someone</div>
				<div class="date"> 8/12</div>
				<div class="mark"></div>
			</div>
		</div>
	</div></body></html>`;

  const { entries } = parseIndexPage(html);
  expect(entries.length).toBe(2);

  const deleted = entries[0]!;
  expect(deleted.deleted).toBe(true);
  expect(deleted.urlId).toBe("");
  expect(deleted.author).toBe("-");

  const normal = entries[1]!;
  expect(normal.deleted).toBe(false);
  expect(normal.urlId).toBe("M.100.A.AAA");
});
