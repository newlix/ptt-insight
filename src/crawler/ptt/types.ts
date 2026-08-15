// Index entry from a PTT board index page.
export interface IndexEntry {
  urlId: string; // "M.1786545600.A.D1C" — empty when article is deleted
  title: string;
  author: string; // "-" when deleted
  date: string; // "MM/DD" from index page (no year)
  nrecRaw: string; // raw display: "5", "爆", "X1", ""
  mark: string; // "M", "!", ""
  deleted: boolean; // true when .title has no <a> (article removed)
}

// Fully parsed article page.
export interface ParsedArticle {
  board: string;
  urlId: string;
  title: string;
  author: string;
  postedAt: number | null; // epoch secs, from metaline '時間' (Asia/Taipei)
  content: string;
  ip: string;
  pushes: ParsedPush[];
  pushCount: number;
  booCount: number;
  neutralCount: number;
}

// One push/comment from an article page.
export interface ParsedPush {
  tag: string; // "推", "噓", "→"
  userId: string;
  content: string;
  ipDateTime: string; // raw "IP MM/DD HH:MM" or "MM/DD HH:MM"
}

// One entry from a PTT /cls/ category page (sub-category or board).
export interface ClsEntry {
  href: string; // "/cls/2870" or "/bbs/Gossiping/index.html"
  name: string; // "Gossiping" or "H_Group"
  userCount: number; // online users (0 for categories)
  class: string; // category class: "綜合", "硬體", etc.
  title: string; // "◎[八卦] ..."
  isBoard: boolean; // true = actual board, false = sub-category
}

// Board discovered from /cls/ tree or hotboards.html.
export interface ParsedBoard {
  name: string; // URL segment: "Gossiping"
  title: string; // "◎[八卦] ..."
  userCount: number;
  categoryPath: string; // "H_Group > 戰略高手"
}
