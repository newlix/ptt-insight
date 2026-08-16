-- 0003: deletion audit log — each soft-deleted article is re-verified once,
-- 24h after its deletion mark (fetch the article URL: 200 => resurrect,
-- 404 => confirmed gone). History doubles as a PTT-side anomaly signal:
-- a batch of 'alive' results means PTT served false 404s / had an incident.

CREATE TABLE IF NOT EXISTS deletion_audits (
    board_id    INTEGER NOT NULL REFERENCES boards(id),
    url_id      TEXT    NOT NULL,
    checked_at  INTEGER NOT NULL,
    result      TEXT    NOT NULL,             -- 'gone' | 'alive'
    PRIMARY KEY (board_id, url_id)
);
