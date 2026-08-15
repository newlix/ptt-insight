-- ============================================================================
-- PTT Crawler — Initial Schema (SQLite)
-- ============================================================================
-- Design principles (inherited from the PostgreSQL version):
--   - Surrogate INTEGER PKs for efficient FK joins (millions of rows)
--   - Natural UNIQUE constraints for data integrity + lookup indexes
--   - Crawl state inlined on boards (always read/written together)
--   - Soft delete (deleted_at) preserves mirror fidelity
--
-- SQLite specifics:
--   - Timestamps are Unix epoch SECONDS stored as INTEGER — same unit as
--     url_timestamp (PTT URLs), window_floor, and backfill_meta.value.
--     One unit everywhere: no seconds/ms split-brain, integer comparison,
--     compact storage (~4-8 bytes vs ~24 for ISO text), fully D1-portable.
--     Human-readable debugging: datetime(col, 'unixepoch').
--   - Booleans are INTEGER 0/1; the query layer converts.
--   - DESC ordering puts NULLs last by default (matches PG's NULLS LAST usage).
-- ============================================================================

-- ============================================================================
-- boards: 看板 (~20,000 rows)
-- ============================================================================
CREATE TABLE boards (
    id                  INTEGER     PRIMARY KEY AUTOINCREMENT,
    name                TEXT        NOT NULL UNIQUE,    -- URL segment: 'Gossiping'
    category_path       TEXT,                           -- e.g. 'H_Group > 戰略高手'
    title               TEXT,                           -- e.g. '◎[八卦] ...'
    user_count          INTEGER,                        -- online users (from index page)

    -- backfill state (one-time historical crawl, newest → oldest page)
    latest_page_index   INTEGER,                        -- PTT's current max index page number
    last_backfill_page  INTEGER     NOT NULL DEFAULT 1, -- oldest page crawled so far
    backfill_complete   INTEGER     NOT NULL DEFAULT 0,

    -- incremental scheduling (adaptive backoff per board)
    next_check_at       INTEGER,                        -- epoch secs: priority-queue key, next time to fetch index.html
    check_interval_secs INTEGER     NOT NULL DEFAULT 600,-- current interval (600s = 10 min floor)
    last_check_at       INTEGER,                        -- epoch secs

    -- dedicated backfill claim exclusion (independent of incremental scheduling)
    backfill_claimed_at INTEGER,                        -- epoch secs

    -- window sweep state
    backfill_recent_complete INTEGER NOT NULL DEFAULT 0,
    is_hot              INTEGER     NOT NULL DEFAULT 0,
    window_floor        INTEGER,                        -- epoch secs of oldest contiguous coverage; NULL = never backfilled

    created_at          INTEGER     NOT NULL DEFAULT (unixepoch()),
    updated_at          INTEGER     NOT NULL DEFAULT (unixepoch())
);

-- ============================================================================
-- articles: 文章 (millions of rows)
-- ============================================================================
CREATE TABLE articles (
    id                INTEGER     PRIMARY KEY AUTOINCREMENT,
    board_id          INTEGER     NOT NULL REFERENCES boards(id),
    url_id            TEXT        NOT NULL,             -- 'M.1786545600.A.D1C' (from URL path)

    -- temporal data (two sources, both valuable)
    url_timestamp     INTEGER,                          -- Unix epoch parsed from URL (pre-fetch available)
    posted_at         INTEGER,                          -- epoch secs, from metaline '時間' (Asia/Taipei)

    -- content
    title             TEXT,
    author            TEXT,
    content           TEXT,                             -- extracted plain text (pushes & metalines removed)
    ip                TEXT,                             -- from '※ 發信站:' line
    mark              TEXT,                             -- index page .mark: 'M' / '!' / NULL

    -- push summary (denormalized counters from full article page fetch)
    nrec_raw          TEXT,                             -- raw index display for comparison: '5'/'爆'/'X1'/''
    push_count        INTEGER,                          -- 推
    boo_count         INTEGER,                          -- 噓
    neutral_count     INTEGER,                          -- →
    net_count         INTEGER,                          -- push_count - boo_count

    -- crawl metadata
    first_seen_at     INTEGER     NOT NULL DEFAULT (unixepoch()),
    last_fetched_at   INTEGER,                          -- epoch secs: last full article-page fetch
    deleted_at        INTEGER,                          -- epoch secs: soft delete, article removed from PTT

    UNIQUE(board_id, url_id)
);

-- ============================================================================
-- pushes: 推文/留言 (tens of millions of rows)
-- ============================================================================
-- Push re-fetch strategy: DELETE WHERE article_id = ?, then batch re-INSERT.
-- Pushes have no stable ID in PTT HTML; positional seq is the only ordering.
CREATE TABLE pushes (
    id          INTEGER     PRIMARY KEY AUTOINCREMENT,
    article_id  INTEGER     NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    seq         INTEGER     NOT NULL,                   -- position within article (0-based, top→bottom)
    tag         TEXT        NOT NULL,                   -- 推/噓/→ (display from PTT, no constraint — edge cases exist)
    user_id     TEXT        NOT NULL,
    content     TEXT,
    ipdatetime  TEXT,                                   -- raw 'IP MM/DD HH:MM' or 'MM/DD HH:MM' (no year)

    UNIQUE(article_id, seq)
);

-- ============================================================================
-- crawl_runs: backfill / discovery progress log
-- ============================================================================
-- Incremental checks are too frequent to log individually (20K boards × hourly).
-- Use for: board discovery sessions, per-board backfill batches.
CREATE TABLE crawl_runs (
    id                INTEGER     PRIMARY KEY AUTOINCREMENT,
    board_id          INTEGER     REFERENCES boards(id),
    run_type          TEXT        NOT NULL CHECK (run_type IN ('discovery', 'backfill', 'incremental')),
    status            TEXT        NOT NULL DEFAULT 'running'
                                  CHECK (status IN ('running', 'completed', 'failed')),
    pages_crawled     INTEGER     NOT NULL DEFAULT 0,
    articles_new      INTEGER     NOT NULL DEFAULT 0,
    articles_updated  INTEGER     NOT NULL DEFAULT 0,
    pushes_updated    INTEGER     NOT NULL DEFAULT 0,
    errors            INTEGER     NOT NULL DEFAULT 0,
    error_detail      TEXT,
    started_at        INTEGER     NOT NULL DEFAULT (unixepoch()),
    finished_at       INTEGER
);

-- ============================================================================
-- backfill_meta: window sweep watermark
-- ============================================================================
CREATE TABLE backfill_meta (
    key   TEXT   PRIMARY KEY,
    value INTEGER NOT NULL
);

-- Backfill window watermark: current sweep boundary, starts 90 days back
-- (7776000 = BACKFILL_RECENT_DAYS default). Without this row no board is
-- claimable — window_floor > NULL is never true.
INSERT INTO backfill_meta (key, value)
VALUES ('window_bottom', unixepoch() - 7776000)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Indexes
-- ============================================================================

-- boards: priority queue — "which board to check next?"
CREATE INDEX idx_boards_next_check ON boards (next_check_at)
    WHERE next_check_at IS NOT NULL;

-- boards: find boards still needing backfill
CREATE INDEX idx_boards_backfill ON boards (backfill_complete)
    WHERE backfill_complete = 0;

-- boards: backfill claim — highest-user_count unclaimed board
CREATE INDEX idx_boards_backfill_claim ON boards (user_count DESC, id)
    WHERE backfill_complete = 0;

-- articles: UNIQUE(board_id, url_id) already indexes lookup by board + url_id.
-- articles: list articles in a board, newest first
CREATE INDEX idx_articles_board_posted ON articles (board_id, posted_at DESC);

-- articles: find soft-deleted articles
CREATE INDEX idx_articles_deleted ON articles (deleted_at)
    WHERE deleted_at IS NOT NULL;

-- pushes: UNIQUE(article_id, seq) already indexes lookup by article_id (leftmost prefix).

-- ============================================================================
-- Trigger: auto-update boards.updated_at on every UPDATE
-- ============================================================================
-- (Recursive triggers are OFF by default in SQLite, so the nested UPDATE
-- inside this trigger does not re-trigger it.)
CREATE TRIGGER trg_boards_set_updated_at
    AFTER UPDATE ON boards
BEGIN
    UPDATE boards SET updated_at = unixepoch() WHERE id = NEW.id;
END;
