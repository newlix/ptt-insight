-- ============================================================================
-- ptt-insight — push footprint by user (task 9.16).
-- /u/:author shows latest pushes; without this index that's a 9M-row scan.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_pushes_user ON pushes (user_id, article_id, seq);
