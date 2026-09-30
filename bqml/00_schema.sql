-- 00_schema.sql — unified views over the existing tables (documents, embeddings) and the
-- synthetic ones. Everything downstream reads from `corpus` / `corpus_embeddings` so real
-- ingested PDFs and synthetic docs are handled identically.
--
-- Assumptions about the existing tables (adjust the column mapping if yours differ):
--   climate_ai.documents(doc_id STRING, title STRING, abstract/text STRING, year INT64, ...)
--   climate_ai.embeddings(doc_id STRING, embedding ARRAY<FLOAT64>, ...)

DECLARE project STRING DEFAULT 'ai-ippc';

CREATE SCHEMA IF NOT EXISTS `ai-ippc.climate_ai`;

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.corpus` AS
SELECT
  doc_id, title, abstract, year, source_type, language, region, country, sector, hazard,
  evidence_type, adaptation_type, outcome_reported, confidence_language, evidence_agreement,
  credibility_score, doi, n_pages, 'synthetic' AS provenance
FROM `ai-ippc.climate_ai.documents_synthetic`
UNION ALL
SELECT
  CAST(doc_id AS STRING),
  title,
  -- the ingestion pipeline may store `abstract` or `text`; coalesce whichever exists
  COALESCE(SAFE_CAST(abstract AS STRING), '') AS abstract,
  SAFE_CAST(year AS INT64),
  'peer_reviewed' AS source_type,
  'en' AS language,
  CAST(NULL AS STRING) AS region,      -- filled later by 06_generate_text (metadata extraction)
  CAST(NULL AS STRING) AS country,
  CAST(NULL AS STRING) AS sector,
  CAST(NULL AS STRING) AS hazard,
  CAST(NULL AS STRING) AS evidence_type,
  CAST(NULL AS STRING) AS adaptation_type,
  CAST(NULL AS BOOL)   AS outcome_reported,
  CAST(NULL AS STRING) AS confidence_language,
  CAST(NULL AS STRING) AS evidence_agreement,
  CAST(NULL AS FLOAT64) AS credibility_score,
  CAST(NULL AS STRING) AS doi,
  CAST(NULL AS INT64)  AS n_pages,
  'ingested' AS provenance
FROM `ai-ippc.climate_ai.documents`;

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.corpus_embeddings` AS
SELECT doc_id, embedding FROM `ai-ippc.climate_ai.embeddings_synthetic`
UNION ALL
SELECT CAST(doc_id AS STRING), embedding FROM `ai-ippc.climate_ai.embeddings`;

-- Metadata extracted by the LLM for ingested docs (populated by 06). Kept separate so
-- model outputs never overwrite human-provided fields.
CREATE TABLE IF NOT EXISTS `ai-ippc.climate_ai.doc_metadata_llm` (
  doc_id STRING NOT NULL,
  region STRING, country STRING, sector STRING, hazard STRING,
  evidence_type STRING, adaptation_type STRING, outcome_reported BOOL,
  confidence_language STRING, rationale STRING,
  model STRING, generated_at TIMESTAMP
);

-- Human decisions from the reviewer UI (screening accept/reject, cluster coherence votes)
CREATE TABLE IF NOT EXISTS `ai-ippc.climate_ai.reviewer_decisions` (
  decision_id STRING NOT NULL,
  doc_id STRING, cluster_id INT64,
  decision_type STRING,   -- 'screen_include' | 'screen_exclude' | 'cluster_coherent' | 'cluster_incoherent' | 'citation_ok' | 'citation_bad'
  reviewer STRING, note STRING, decided_at TIMESTAMP
);
