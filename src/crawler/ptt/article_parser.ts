import * as cheerio from "cheerio";
import type { ParsedArticle, ParsedPush } from "./types.ts";
import { parseArticleURL } from "./url.ts";

const ipRe = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

// PTT metaline time format: "Sat Aug  8 17:00:12 2026" (Asia/Taipei, UTC+8).
// Go's time.Parse validated the weekday; we accept it unvalidated (more lenient,
// keeps the date when PTT's weekday is inconsistent).
const timeRe = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// parsePostedAt converts a metaline 時間 value to epoch seconds (Taipei time).
function parsePostedAt(val: string): number | null {
  const m = timeRe.exec(val);
  if (!m) return null;
  const month = MONTHS[m[1]!];
  if (month === undefined) return null;
  return Math.floor(Date.UTC(+m[6]!, month, +m[2]!, +m[3]!, +m[4]!, +m[5]!) / 1000) - 8 * 3600;
}

// parseArticlePage parses a PTT article page. articleURL is the full or
// relative URL (e.g. "/bbs/Gossiping/M.xxx.A.xxx.html") used to extract
// board name and url_id.
export function parseArticlePage(html: string, articleURL: string): ParsedArticle {
  const info = parseArticleURL(articleURL);
  if (!info) {
    throw new Error(`parse article URL: invalid article URL: ${articleURL}`);
  }

  const $ = cheerio.load(html);
  const main = $("#main-content");
  if (main.length === 0) {
    throw new Error("#main-content not found");
  }

  const art: ParsedArticle = {
    board: info.board,
    urlId: info.urlId,
    title: "",
    author: "",
    postedAt: null,
    content: "",
    ip: "",
    pushes: [],
    pushCount: 0,
    booCount: 0,
    neutralCount: 0,
  };

  // Extract metadata from metalines
  main.find(".article-metaline").each((_i, el) => {
    const s = $(el);
    const tag = s.find(".article-meta-tag").text().trim();
    const val = s.find(".article-meta-value").text().trim();
    switch (tag) {
      case "作者":
        // "ubcs (nickname)" → "ubcs"
        art.author = val.split(" ")[0]!;
        break;
      case "標題":
        art.title = val;
        break;
      case "時間":
        art.postedAt = parsePostedAt(val);
        break;
    }
  });

  // Extract pushes before removing them
  main.find(".push").each((_i, el) => {
    const s = $(el);
    const push: ParsedPush = {
      tag: s.find(".push-tag").text().trim(),
      userId: s.find(".push-userid").text().trim(),
      ipDateTime: s.find(".push-ipdatetime").text().trim(),
      content: "",
    };
    // Skip empty/deleted pushes (rendering artifacts with no tag)
    if (push.tag === "") return;
    // Push content has leading ": " — strip it
    const content = s.find(".push-content").text().trim();
    push.content = content.replace(/^:/, "").trim();

    art.pushes.push(push);

    switch (push.tag) {
      case "推":
        art.pushCount++;
        break;
      case "噓":
        art.booCount++;
        break;
      case "→":
        art.neutralCount++;
        break;
    }
  });

  // Remove structural elements to isolate content text
  main.find(".article-metaline").remove();
  main.find(".article-metaline-right").remove();
  main.find(".push").remove();

  // Extract IP from ※ 發信站: line, then filter ※/◆ lines from content
  const lines: string[] = [];
  for (const line of main.text()!.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (t.startsWith("※")) {
      if (art.ip === "" && t.includes("發信站")) {
        const m = ipRe.exec(t);
        if (m) art.ip = m[0];
      }
      continue;
    }
    if (t.startsWith("◆")) continue;
    lines.push(t);
  }
  art.content = lines.join("\n");

  return art;
}
