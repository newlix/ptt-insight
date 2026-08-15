import * as cheerio from "cheerio";
import type { IndexEntry } from "./types.ts";
import { parseArticleURL } from "./url.ts";

const pageIndexRe = /index(\d+)\.html/;

export interface ParseIndexResult {
  entries: IndexEntry[];
  // Max page index from the ‹ 上頁 link. On the latest page (index.html) this
  // is the current highest page number; on older pages it's that page + 1.
  maxPageIndex: number;
}

// parseIndexPage parses a PTT board index page.
export function parseIndexPage(html: string): ParseIndexResult {
  const $ = cheerio.load(html);

  // Extract max page index from ‹ 上頁 link
  let maxPageIndex = 0;
  for (const a of $(".btn-group-paging a").toArray()) {
    const text = $(a).text();
    if (!text.includes("上頁")) continue;
    const href = $(a).attr("href");
    if (href) {
      const m = pageIndexRe.exec(href);
      if (m) maxPageIndex = Number(m[1]) + 1;
    }
    break;
  }

  // Parse article entries
  const entries: IndexEntry[] = [];
  $(".r-ent").each((_i, el) => {
    const s = $(el);
    const entry: IndexEntry = {
      urlId: "",
      title: "",
      author: (s.find(".author").text() ?? "").trim(),
      date: (s.find(".date").text() ?? "").trim(),
      nrecRaw: (s.find(".nrec span").text() ?? "").trim(),
      mark: (s.find(".mark").text() ?? "").trim(),
      deleted: false,
    };

    const a = s.find(".title a");
    if (a.length === 0) {
      entry.deleted = true;
      entry.title = s.find(".title").text().trim();
    } else {
      const href = a.attr("href") ?? "";
      const info = parseArticleURL(href);
      if (info) entry.urlId = info.urlId;
      entry.title = a.text().trim();
    }

    entries.push(entry);
  });

  return { entries, maxPageIndex };
}
