-- ============================================================================
-- ptt-insight — Entity index: derived table over article_insights.entities.
-- Backfillable from insights alone (json_each); maintained on storeInsight.
-- entity_aliases maps spelling variants to a canonical normalized name
-- (e.g. GTA6 → 俠盜獵車手vi); queries expand the alias set. Seeded empty.
-- ============================================================================

CREATE TABLE IF NOT EXISTS entity_refs (
    name_norm   TEXT    NOT NULL,             -- NFKC + strip spaces + lowercase
    name        TEXT    NOT NULL,             -- display form (first raw seen)
    kind        TEXT    NOT NULL DEFAULT '其他',
    article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    PRIMARY KEY (name_norm, article_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_refs_name ON entity_refs (name_norm);

CREATE TABLE IF NOT EXISTS entity_aliases (
    alias      TEXT PRIMARY KEY,   -- normalized alias
    canonical  TEXT NOT NULL       -- normalized canonical name
);
