import type { ArticleCard, Board } from "../repo/articles.ts";

// HTML-escape for all interpolated text (the templ auto-escaping analogue).
export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// PTT's display timezone (UTC+8), pinned so dates don't shift by server zone.
const TAIPEI_OFFSET_SEC = 8 * 3600;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function taipei(t: number): Date {
  return new Date((t + TAIPEI_OFFSET_SEC) * 1000);
}

// M/D like PTT's board list: no zero padding, month < 10 gets a leading space.
export function pttDate(t: number | null): string {
  if (t === null) return "";
  const d = taipei(t);
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return m < 10 ? ` ${m}/${day}` : `${m}/${day}`;
}

// PTT's article time format: "Mon Jan _2 15:04:05 2006" (_2 = space-padded day).
export function articleTime(t: number | null): string {
  if (t === null) return "";
  const d = taipei(t);
  const day = String(d.getUTCDate()).padStart(2, " ");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${day} ${hh}:${mm}:${ss} ${d.getUTCFullYear()}`;
}

export function relativeTime(t: number | null): string {
  if (t === null) return "";
  const d = Date.now() / 1000 - t;
  if (d < 60) return "剛剛";
  if (d < 3600) return `${Math.floor(d / 60)} 分鐘前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小時前`;
  if (d < 172800) return "昨天";
  if (d < 604800) return `${Math.floor(d / 86400)} 天前`;
  const dt = taipei(t);
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${m}/${day}`;
}

// PTT-shape URL for page p (1 = newest) of a board with totalPages T:
// page 1 is index.html, page p is index{T-p+1}.html.
export function boardPageHref(board: string, totalPages: number, p: number): string {
  if (p <= 1) return `/bbs/${board}/index.html`;
  const n = Math.max(1, totalPages - p + 1);
  return `/bbs/${board}/index${n}.html`;
}

export function parseIndexSlug(slug: string): number | null {
  if (!slug.startsWith("index") || !slug.endsWith(".html")) return null;
  const n = Number(slug.slice(5, -5));
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export function totalPages(count: number, pageSize: number): number {
  if (count < 1) return 1;
  return Math.max(1, Math.ceil(count / pageSize));
}

export function topBoards(boards: Board[], n: number): Board[] {
  return boards.slice(0, n);
}

// Moves [公告] (pinned) entries to the end, matching PTT's bottom-pinned rows.
export function splitPinned(articles: ArticleCard[]): { pinned: ArticleCard[]; normal: ArticleCard[] } {
  const pinned: ArticleCard[] = [];
  const normal: ArticleCard[] = [];
  for (const a of articles) {
    (a.title.startsWith("[公告]") ? pinned : normal).push(a);
  }
  return { pinned, normal };
}

export function splitLines(s: string | null): string[] {
  if (!s) return [];
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

// --- badge data (semantic class names; colors live in app.css) ---

export interface Badge {
  text: string;
  cls: string;
}

export function netBadge(n: number | null): Badge {
  if (n === null) return { text: "—", cls: "net-nil" };
  if (n >= 100) return { text: "爆", cls: "net-boom" };
  if (n > 0) return { text: String(n), cls: "net-pos" };
  if (n < 0) return { text: String(n), cls: "net-neg" };
  return { text: "0", cls: "net-nil" };
}

export function sentimentBadge(s: string): Badge {
  let cls = "badge-neutral";
  if (s === "正面") cls = "badge-pos";
  else if (s === "負面") cls = "badge-neg";
  return { text: s, cls };
}

export function controversyBadge(c: string): Badge {
  switch (c) {
    case "高":
      return { text: "🔥 爭議", cls: "badge-neg" };
    case "中":
      return { text: "⚡ 有討論", cls: "badge-warn" };
    default:
      return { text: "・一面倒", cls: "badge-neutral" };
  }
}

// nrec color from the crawler's nrec_raw (PTT display value):
// 爆/X* → red, 1-9 → green, 10-99 → yellow (PTT terminal convention).
export function nrecClass(raw: string | null): string {
  if (!raw) return "";
  if (raw === "爆" || raw.startsWith("X")) return "c-f1";
  const n = Number(raw);
  if (Number.isInteger(n)) {
    if (n >= 10) return "c-f3";
    if (n >= 1) return "c-f2";
  }
  return "";
}

// sentiment label color for the AI block: 正面 green, 負面 red, else white.
export function sentimentClass(s: string): string {
  if (s === "正面") return "c-f2";
  if (s === "負面") return "c-f1";
  return "c-white";
}

// controversy label color: 高 red, 中 yellow, else white.
export function controversyClass(s: string): string {
  if (s === "高") return "c-f1";
  if (s === "中") return "c-f3";
  return "c-white";
}

// Hotboards online-user color from the upstream span class.
export function nuserColor(cls: string): string {
  if (cls.includes("f1")) return "c-f1";
  if (cls.includes("f3")) return "c-f3";
  return "c-white";
}
