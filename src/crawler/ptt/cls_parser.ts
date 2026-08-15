import * as cheerio from "cheerio";
import type { ClsEntry } from "./types.ts";

// parseClsPage parses a PTT category listing page (/cls/{id} or hotboards.html).
// Returns both sub-categories and boards found on the page.
export function parseClsPage(html: string): ClsEntry[] {
  const $ = cheerio.load(html);

  const entries: ClsEntry[] = [];
  $(".b-ent").each((_i, el) => {
    const s = $(el);
    const a = s.find("a.board");
    const href = a.attr("href");
    if (!href) return;

    const nuserText = s.find(".board-nuser").text().trim();
    const userCount = Number(nuserText);

    entries.push({
      href,
      name: s.find(".board-name").text().trim(),
      userCount: Number.isInteger(userCount) ? userCount : 0,
      class: s.find(".board-class").text().trim(),
      title: s.find(".board-title").text().trim(),
      isBoard: href.includes("/bbs/"),
    });
  });

  return entries;
}
