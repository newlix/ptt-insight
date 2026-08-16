-- ============================================================================
-- ptt-insight — read-path indexes (task 9.15).
-- bun:sqlite queries are synchronous: one full-scan request blocks the whole
-- event loop, so hot read paths must be index-backed.
--   idx_articles_author          /u/:author (was ~670ms full scan)
--   idx_articles_recent_pushed   /rising + velocity calibration (was ~680ms)
--   idx_articles_posted          board-page fresh ordering / time ranges
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_articles_author ON articles (author, posted_at DESC);

-- partial: only rising candidates (push_count > 5) — small, always relevant
CREATE INDEX IF NOT EXISTS idx_articles_recent_pushed ON articles (posted_at)
    WHERE push_count > 5 AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_articles_posted ON articles (posted_at DESC);
