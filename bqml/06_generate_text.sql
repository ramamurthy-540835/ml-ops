-- 06_generate_text.sql — LLM steps, all with strict JSON prompts (see ../prompts/*.txt).
-- Cost note (§2.1 carbon question): these are the only per-document LLM calls. Run them on
-- the subset the logistic model already ranks as likely-relevant, not on the whole corpus.

DECLARE p_threshold FLOAT64 DEFAULT 0.5;

-- Helper: strip ```json fences and parse safely
CREATE TEMP FUNCTION clean_json(s STRING) AS (SAFE.PARSE_JSON(REGEXP_REPLACE(s, r'```json|```', '')));

-- ---------------------------------------------------------------------------------------
-- A. Metadata extraction for INGESTED docs (synthetic docs already carry metadata)
-- ---------------------------------------------------------------------------------------
INSERT INTO `ai-ippc.climate_ai.doc_metadata_llm`
WITH todo AS (
  SELECT c.doc_id, c.title, c.abstract
  FROM `ai-ippc.climate_ai.corpus` c
  JOIN `ai-ippc.climate_ai.screening_predictions` s USING (doc_id)
  LEFT JOIN `ai-ippc.climate_ai.doc_metadata_llm` m USING (doc_id)
  WHERE c.provenance = 'ingested' AND s.p_relevant >= p_threshold AND m.doc_id IS NULL
    AND LENGTH(c.abstract) > 30
),
gen AS (
  SELECT doc_id, clean_json(ml_generate_text_llm_result) AS j
  FROM ML.GENERATE_TEXT(MODEL `ai-ippc.climate_ai.gemini_text`,
    (SELECT doc_id, CONCAT(
      -- inline copy of prompts/bqml_metadata_extraction_prompt.txt (keep in sync)
      'You are extracting structured metadata for the IPCC Working Group II evidence base. Record only what the text states. ',
      'region ∈ {Africa, Asia, Australasia, Central and South America, Europe, North America, Small Islands, Polar Regions, Global, null}. ',
      'sector ∈ the seven WGII sectoral chapters or null. evidence_type ∈ {impact, vulnerability, adaptation, maladaptation, off_topic}; ',
      'maladaptation only if adaptation increased vulnerability, lock-in or inequity. adaptation_type ∈ {technological, institutional, behavioural, nature-based, null}. ',
      'outcome_reported true only if a measured outcome (metric + direction) is reported. confidence_language = IPCC calibrated term if present else null. ',
      'rationale: one sentence quoting ≤12 words. Return ONLY JSON with keys region,country,sector,hazard,evidence_type,adaptation_type,outcome_reported,confidence_language,rationale.',
      '\n\nTitle: ', title, '\nAbstract: ', abstract) AS prompt
     FROM todo),
    STRUCT(0.0 AS temperature, 400 AS max_output_tokens, TRUE AS flatten_json_output))
)
SELECT doc_id,
  JSON_VALUE(j, '$.region'), JSON_VALUE(j, '$.country'), JSON_VALUE(j, '$.sector'), JSON_VALUE(j, '$.hazard'),
  JSON_VALUE(j, '$.evidence_type'), JSON_VALUE(j, '$.adaptation_type'),
  SAFE_CAST(JSON_VALUE(j, '$.outcome_reported') AS BOOL), JSON_VALUE(j, '$.confidence_language'),
  JSON_VALUE(j, '$.rationale'), 'gemini_text', CURRENT_TIMESTAMP()
FROM gen WHERE j IS NOT NULL;

-- ---------------------------------------------------------------------------------------
-- B. LLM second-opinion screening on the uncertain band only (0.3 ≤ p < 0.7)
--    Disagreements are what the human should look at first.
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE TABLE `ai-ippc.climate_ai.screening_llm_second_opinion` AS
WITH band AS (
  SELECT s.doc_id, s.p_relevant, c.title, c.abstract
  FROM `ai-ippc.climate_ai.screening_predictions` s JOIN `ai-ippc.climate_ai.corpus` c USING (doc_id)
  WHERE s.p_relevant BETWEEN 0.3 AND 0.7 AND NOT s.already_labelled
),
gen AS (
  SELECT doc_id, p_relevant, clean_json(ml_generate_text_llm_result) AS j
  FROM ML.GENERATE_TEXT(MODEL `ai-ippc.climate_ai.gemini_text`,
    (SELECT doc_id, p_relevant, CONCAT(
      'Second-opinion screener for an IPCC WGII assessment. Include if the text reports (1) climate impacts, (2) vulnerability/exposure, or (3) adaptation responses/outcomes/maladaptation. ',
      'Exclude mitigation-only, pure climate physics, methods without impact application. Decide from the text only; report agreement with the model score separately. ',
      'If abstract < 30 words return needs_full_text. Never exclude for language or grey-literature status. ',
      'Return ONLY JSON {"decision":"include|exclude|needs_full_text","criterion":"1|2|3|none","agrees_with_model":true|false,"reason":"<≤30 words>"}',
      '\n\nModel P(relevant): ', CAST(ROUND(p_relevant, 2) AS STRING), '\nTitle: ', title, '\nAbstract: ', abstract) AS prompt
     FROM band),
    STRUCT(0.0 AS temperature, 200 AS max_output_tokens, TRUE AS flatten_json_output))
)
SELECT doc_id, p_relevant,
  JSON_VALUE(j, '$.decision') AS llm_decision, JSON_VALUE(j, '$.criterion') AS criterion,
  SAFE_CAST(JSON_VALUE(j, '$.agrees_with_model') AS BOOL) AS agrees_with_model,
  JSON_VALUE(j, '$.reason') AS reason, CURRENT_TIMESTAMP() AS generated_at
FROM gen;

-- ---------------------------------------------------------------------------------------
-- C. Adaptation outcome extraction for adaptation/maladaptation docs lacking outcome rows
-- ---------------------------------------------------------------------------------------
INSERT INTO `ai-ippc.climate_ai.adaptation_outcomes`
WITH todo AS (
  SELECT c.doc_id, c.title, c.abstract, c.region, c.sector, c.hazard
  FROM `ai-ippc.climate_ai.corpus` c
  LEFT JOIN `ai-ippc.climate_ai.doc_metadata_llm` m USING (doc_id)
  LEFT JOIN `ai-ippc.climate_ai.adaptation_outcomes` o USING (doc_id)
  WHERE COALESCE(c.evidence_type, m.evidence_type) IN ('adaptation', 'maladaptation')
    AND c.provenance = 'ingested' AND o.doc_id IS NULL
),
gen AS (
  SELECT doc_id, region, sector, hazard, clean_json(ml_generate_text_llm_result) AS j
  FROM ML.GENERATE_TEXT(MODEL `ai-ippc.climate_ai.gemini_text`,
    (SELECT doc_id, region, sector, hazard, CONCAT(
      'Extract adaptation outcome records (Berrang-Ford et al. 2021 structure). Only measured outcomes; proposals are not outcomes. ',
      'Return ONLY a JSON array of {"action","adaptation_type":"technological|institutional|behavioural|nature-based","outcome_direction":"positive|negative|mixed",',
      '"metric","effect_size":number|null,"effect_units","population","maladaptation_flag":bool,"evidence_quote":"≤15 words"}. Empty array if none.',
      '\n\nTitle: ', title, '\nText: ', abstract) AS prompt
     FROM todo),
    STRUCT(0.0 AS temperature, 600 AS max_output_tokens, TRUE AS flatten_json_output))
)
SELECT doc_id,
  JSON_VALUE(rec, '$.adaptation_type'), JSON_VALUE(rec, '$.action'), JSON_VALUE(rec, '$.outcome_direction'),
  JSON_VALUE(rec, '$.metric'), SAFE_CAST(JSON_VALUE(rec, '$.effect_size') AS FLOAT64),
  CONCAT(COALESCE(region, '?'), '|', COALESCE(sector, '?'), '|', COALESCE(hazard, '?'))
FROM gen, UNNEST(JSON_QUERY_ARRAY(j)) AS rec
WHERE j IS NOT NULL;

-- ---------------------------------------------------------------------------------------
-- D. Grounded synthesis: a table-valued procedure the API calls with (topic, region, k).
--    Retrieval = VECTOR_SEARCH over chunk embeddings; generation cites doc_id + page.
-- ---------------------------------------------------------------------------------------
-- One-off: embed chunks (needs the real embedding model; skip if you only use synthetic vectors)
-- CREATE OR REPLACE TABLE `ai-ippc.climate_ai.chunk_embeddings` AS
-- SELECT chunk_id, doc_id, page, text AS content, ml_generate_embedding_result AS embedding
-- FROM ML.GENERATE_EMBEDDING(MODEL `ai-ippc.climate_ai.text_embedding`,
--   (SELECT chunk_id, doc_id, page, text, text AS content FROM `ai-ippc.climate_ai.chunks`),
--   STRUCT(TRUE AS flatten_json_output, 'RETRIEVAL_DOCUMENT' AS task_type));
-- CREATE VECTOR INDEX IF NOT EXISTS chunk_idx ON `ai-ippc.climate_ai.chunk_embeddings`(embedding)
--   OPTIONS (index_type = 'IVF', distance_type = 'COSINE');

CREATE OR REPLACE PROCEDURE `ai-ippc.climate_ai.grounded_synthesis`(
  topic STRING, region_filter STRING, k INT64, OUT result JSON)
BEGIN
  DECLARE passages STRING;

  SET passages = (
    WITH q AS (
      SELECT ml_generate_embedding_result AS qe
      FROM ML.GENERATE_EMBEDDING(MODEL `ai-ippc.climate_ai.text_embedding`,
        (SELECT topic AS content), STRUCT(TRUE AS flatten_json_output, 'RETRIEVAL_QUERY' AS task_type))
    ),
    hits AS (
      SELECT base.doc_id, base.page, base.content, distance
      FROM VECTOR_SEARCH(TABLE `ai-ippc.climate_ai.chunk_embeddings`, 'embedding',
                         (SELECT qe FROM q), top_k => k * 3, distance_type => 'COSINE')
    ),
    filtered AS (
      SELECT h.* FROM hits h JOIN `ai-ippc.climate_ai.corpus` c USING (doc_id)
      WHERE region_filter IS NULL OR region_filter = 'All' OR c.region = region_filter
      ORDER BY distance LIMIT k
    )
    SELECT STRING_AGG(FORMAT('[%s p.%d] %s', doc_id, page, content), '\n' ORDER BY distance) FROM filtered
  );

  SET result = (
    SELECT SAFE.PARSE_JSON(REGEXP_REPLACE(ml_generate_text_llm_result, r'```json|```', ''))
    FROM ML.GENERATE_TEXT(MODEL `ai-ippc.climate_ai.gemini_text`,
      (SELECT CONCAT(
        -- inline copy of prompts/bqml_grounded_synthesis_prompt.txt (keep in sync)
        'Draft an evidence synthesis paragraph for IPCC WGII authors using ONLY the retrieved passages. Every factual sentence ends with citations [doc_id p.N] copied exactly. ',
        'No outside knowledge. Where passages disagree, say so and cite both. Return ONLY JSON with keys: synthesis (3–6 sentences), confidence (very high|high|medium|low, per AR6 guidance combining amount of evidence and agreement; few or conflicting passages cannot exceed medium), ',
        'confidence_rationale ("<amount> evidence, <agreement> agreement: <why>"), gaps (1–3 items a WGII author would want but is missing), citations_used (array of doc_id). ',
        'If fewer than 2 relevant passages: synthesis null, confidence null, confidence_rationale "insufficient evidence retrieved".',
        '\n\nTopic: ', topic, '\nRegion filter: ', COALESCE(region_filter, 'All'),
        '\n\nRetrieved passages\n', COALESCE(passages, '(none)')) AS prompt),
      STRUCT(0.1 AS temperature, 900 AS max_output_tokens, TRUE AS flatten_json_output))
  );
END;
