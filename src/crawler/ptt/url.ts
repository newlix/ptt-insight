// articleURLRe captures board name and url_id from a PTT article URL.
// Matches: /bbs/Gossiping/M.1786545600.A.D1C.html
const articleURLRe = /\/bbs\/([^/]+)\/(M\.(\d+)\.A\.([^.]+))\.html/;

// timestampRe extracts the Unix timestamp from a url_id.
const timestampRe = /M\.(\d+)\./;

export interface ArticleURLInfo {
  board: string;
  urlId: string; // "M.1786545600.A.D1C"
  timestamp: number; // Unix epoch seconds
}

// urlIdTimestamp extracts the Unix timestamp from a url_id ("M.1786545600.A.D1C").
// Returns null for url_ids without a parseable timestamp.
export function urlIdTimestamp(urlId: string): number | null {
  const m = timestampRe.exec(urlId);
  if (!m) return null;
  const ts = Number(m[1]);
  return Number.isFinite(ts) ? ts : null;
}

// parseArticleURL extracts metadata from a PTT article URL path.
//
// Example: "/bbs/Gossiping/M.1786545600.A.D1C.html"
// → { board: "Gossiping", urlId: "M.1786545600.A.D1C", timestamp: 1786545600 }
//
// Returns null if the URL does not match the expected PTT article format.
export function parseArticleURL(path: string): ArticleURLInfo | null {
  const m = articleURLRe.exec(path);
  if (!m) return null;
  const timestamp = Number(m[3]);
  if (!Number.isFinite(timestamp)) return null;
  return { board: m[1]!, urlId: m[2]!, timestamp };
}
