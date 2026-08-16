-- ============================================================================
-- ptt-insight — Board daily digests: LLM summary of insights generated per
-- hot board in a trailing 24h window (works pre-launch: those are the
-- articles the worker just analyzed).
-- ============================================================================

CREATE TABLE IF NOT EXISTS board_digests (
    board_id          INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    day               TEXT    NOT NULL,              -- YYYY-MM-DD UTC+8 (digest date)
    digest            TEXT    NOT NULL,
    article_count     INTEGER NOT NULL DEFAULT 0,    -- articles fed into the digest
    model             TEXT    NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    generated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (board_id, day)
);
