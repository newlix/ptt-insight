-- ============================================================================
-- ptt-insight — Insight schema (added to the crawler's ptt.db)
-- ============================================================================
-- Reads articles/pushes/boards (owned by crawler). Writes only this table.
-- Combined from PG migrations 001_insights + 002_discussion + 003_reply_count.
-- (article_insights is rebuildable AI output — not migrated from PG.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS article_insights (
    id                INTEGER     PRIMARY KEY AUTOINCREMENT,
    article_id        INTEGER     NOT NULL UNIQUE REFERENCES articles(id) ON DELETE CASCADE,
    tldr              TEXT        NOT NULL,
    key_points        TEXT        NOT NULL DEFAULT '',
    community_take    TEXT,
    top_comments      TEXT,
    controversy       TEXT,
    reply_count       INTEGER     NOT NULL DEFAULT 0,
    sentiment         TEXT,
    tags              TEXT        NOT NULL DEFAULT '[]',  -- JSON array of strings
    model             TEXT        NOT NULL,
    prompt_tokens     INTEGER     NOT NULL DEFAULT 0,
    completion_tokens INTEGER     NOT NULL DEFAULT 0,
    generated_at      INTEGER     NOT NULL DEFAULT (unixepoch()),
    error             TEXT
);

CREATE INDEX IF NOT EXISTS idx_article_insights_article
    ON article_insights (article_id);

-- list articles lacking a (fresh) insight, hottest first
CREATE INDEX IF NOT EXISTS idx_insights_missing
    ON articles (net_count DESC)
    WHERE deleted_at IS NULL;
