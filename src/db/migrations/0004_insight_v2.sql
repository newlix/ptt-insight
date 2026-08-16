-- ============================================================================
-- ptt-insight — Insight schema v2: article/discussion analysis depth.
-- Adds article typing, entity extraction, ad/factuality/AI-detection,
-- push stance split, push-surfaced facts, and Q&A summaries.
-- schema_ver=1 rows flow back into the worker for re-analysis.
-- ============================================================================

ALTER TABLE article_insights ADD COLUMN schema_ver    INTEGER NOT NULL DEFAULT 1;
ALTER TABLE article_insights ADD COLUMN article_type  TEXT;                -- 新聞|問卦|心得|爆掛|閒聊|其他
ALTER TABLE article_insights ADD COLUMN entities      TEXT    NOT NULL DEFAULT '[]';  -- JSON [{name,type}]
ALTER TABLE article_insights ADD COLUMN ad_likelihood TEXT;                -- 無|疑似|高度
ALTER TABLE article_insights ADD COLUMN factuality    TEXT;                -- 事實|觀點|未證實
ALTER TABLE article_insights ADD COLUMN ai_generated  TEXT;                -- 人寫|不確定|疑似AI
ALTER TABLE article_insights ADD COLUMN push_stance   TEXT;                -- JSON {pro,con,neutral} 0-100
ALTER TABLE article_insights ADD COLUMN push_facts    TEXT;                -- 推文揭露的增量事實
ALTER TABLE article_insights ADD COLUMN qa_summary    TEXT;                -- 僅問卦類：推文最佳回答摘要
