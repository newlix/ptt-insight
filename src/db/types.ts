// Raw DB row shapes (snake_case, 0/1 booleans) and domain types (camelCase).
// Query modules convert at the boundary so the rest of the codebase
// never touches SQLite encoding details.

export interface BoardRow {
  id: number;
  name: string;
  category_path: string | null;
  title: string | null;
  user_count: number | null;
  latest_page_index: number | null;
  last_backfill_page: number;
  backfill_complete: number;
  next_check_at: number | null;
  check_interval_secs: number;
  last_check_at: number | null;
  backfill_claimed_at: number | null;
  backfill_recent_complete: number;
  is_hot: number;
  window_floor: number | null;
  created_at: number;
  updated_at: number;
}

export interface Board {
  id: number;
  name: string;
  categoryPath: string | null;
  title: string | null;
  userCount: number | null;
  latestPageIndex: number | null;
  lastBackfillPage: number;
  backfillComplete: boolean;
  nextCheckAt: number | null;
  checkIntervalSecs: number;
  lastCheckAt: number | null;
  backfillClaimedAt: number | null;
  backfillRecentComplete: boolean;
  isHot: boolean;
  windowFloor: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ArticleRow {
  id: number;
  board_id: number;
  url_id: string;
  url_timestamp: number | null;
  posted_at: number | null;
  title: string | null;
  author: string | null;
  content: string | null;
  ip: string | null;
  mark: string | null;
  nrec_raw: string | null;
  push_count: number | null;
  boo_count: number | null;
  neutral_count: number | null;
  net_count: number | null;
  first_seen_at: number;
  last_fetched_at: number | null;
  deleted_at: number | null;
}

export interface Article {
  id: number;
  boardId: number;
  urlId: string;
  urlTimestamp: number | null;
  postedAt: number | null;
  title: string | null;
  author: string | null;
  content: string | null;
  ip: string | null;
  mark: string | null;
  nrecRaw: string | null;
  pushCount: number | null;
  booCount: number | null;
  neutralCount: number | null;
  netCount: number | null;
  firstSeenAt: number;
  lastFetchedAt: number | null;
  deletedAt: number | null;
}

export interface CrawlRunRow {
  id: number;
  board_id: number | null;
  run_type: string;
  status: string;
  pages_crawled: number;
  articles_new: number;
  articles_updated: number;
  pushes_updated: number;
  errors: number;
  error_detail: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface CrawlRun {
  id: number;
  boardId: number | null;
  runType: string;
  status: string;
  pagesCrawled: number;
  articlesNew: number;
  articlesUpdated: number;
  pushesUpdated: number;
  errors: number;
  errorDetail: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export function toBoard(r: BoardRow): Board {
  return {
    id: r.id,
    name: r.name,
    categoryPath: r.category_path,
    title: r.title,
    userCount: r.user_count,
    latestPageIndex: r.latest_page_index,
    lastBackfillPage: r.last_backfill_page,
    backfillComplete: r.backfill_complete === 1,
    nextCheckAt: r.next_check_at,
    checkIntervalSecs: r.check_interval_secs,
    lastCheckAt: r.last_check_at,
    backfillClaimedAt: r.backfill_claimed_at,
    backfillRecentComplete: r.backfill_recent_complete === 1,
    isHot: r.is_hot === 1,
    windowFloor: r.window_floor,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toArticle(r: ArticleRow): Article {
  return {
    id: r.id,
    boardId: r.board_id,
    urlId: r.url_id,
    urlTimestamp: r.url_timestamp,
    postedAt: r.posted_at,
    title: r.title,
    author: r.author,
    content: r.content,
    ip: r.ip,
    mark: r.mark,
    nrecRaw: r.nrec_raw,
    pushCount: r.push_count,
    booCount: r.boo_count,
    neutralCount: r.neutral_count,
    netCount: r.net_count,
    firstSeenAt: r.first_seen_at,
    lastFetchedAt: r.last_fetched_at,
    deletedAt: r.deleted_at,
  };
}

export function toCrawlRun(r: CrawlRunRow): CrawlRun {
  return {
    id: r.id,
    boardId: r.board_id,
    runType: r.run_type,
    status: r.status,
    pagesCrawled: r.pages_crawled,
    articlesNew: r.articles_new,
    articlesUpdated: r.articles_updated,
    pushesUpdated: r.pushes_updated,
    errors: r.errors,
    errorDetail: r.error_detail,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

// "" → null (mirrors Go's strPtr: empty strings are stored as NULL)
export function emptyToNull(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}

export function placeholders(n: number): string {
  return Array<string>(n).fill("?").join(", ");
}
