-- 03_evidence_map_kmeans.sql — §5.2 evidence maps + topic discovery.
-- KMEANS over embeddings of docs predicted relevant; clusters are named by Gemini from
-- their top titles; the evidence map crosses cluster × WGII region.

CREATE OR REPLACE MODEL `ai-ippc.climate_ai.evidence_kmeans`
OPTIONS (model_type = 'KMEANS', num_clusters = 14, kmeans_init_method = 'KMEANS++',
         standardize_features = FALSE, distance_type = 'COSINE') AS
SELECT e.embedding
FROM `ai-ippc.climate_ai.corpus_embeddings` e
JOIN `ai-ippc.climate_ai.screening_predictions` s USING (doc_id)
WHERE s.p_relevant >= 0.5;

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.cluster_quality` AS
SELECT CURRENT_TIMESTAMP() AS evaluated_at, * FROM ML.EVALUATE(MODEL `ai-ippc.climate_ai.evidence_kmeans`);

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.doc_clusters` AS
SELECT p.doc_id, p.CENTROID_ID AS cluster_id,
       (SELECT MIN(d.DISTANCE) FROM UNNEST(p.NEAREST_CENTROIDS_DISTANCE) d) AS dist_to_centroid
FROM ML.PREDICT(MODEL `ai-ippc.climate_ai.evidence_kmeans`,
  (SELECT e.doc_id, e.embedding FROM `ai-ippc.climate_ai.corpus_embeddings` e
   JOIN `ai-ippc.climate_ai.screening_predictions` s USING (doc_id) WHERE s.p_relevant >= 0.5)) p;

-- Name each cluster from its 12 most central titles. Output is strict JSON (see prompts/).
CREATE OR REPLACE TABLE `ai-ippc.climate_ai.cluster_labels` AS
WITH top_titles AS (
  SELECT cluster_id, STRING_AGG(title, '\n' ORDER BY dist_to_centroid LIMIT 12) AS titles, COUNT(*) AS n_docs
  FROM `ai-ippc.climate_ai.doc_clusters` JOIN `ai-ippc.climate_ai.corpus` USING (doc_id)
  GROUP BY cluster_id
),
gen AS (
  SELECT cluster_id, n_docs, ml_generate_text_llm_result AS raw
  FROM ML.GENERATE_TEXT(MODEL `ai-ippc.climate_ai.gemini_text`,
    (SELECT cluster_id, n_docs, CONCAT(
      'You label topic clusters for an IPCC Working Group II evidence map. ',
      'Given representative paper titles, return ONLY JSON: ',
      '{"label": "<max 6 words>", "sector": "<one WGII sector>", "evidence_focus": "impact|vulnerability|adaptation|maladaptation|mixed", ',
      '"coherence_guess": "high|medium|low"}. Do not invent topics not present in the titles.\n\nTitles:\n', titles) AS prompt
     FROM top_titles),
    STRUCT(0.1 AS temperature, 256 AS max_output_tokens, TRUE AS flatten_json_output))
)
SELECT cluster_id, n_docs,
  JSON_VALUE(SAFE.PARSE_JSON(REGEXP_REPLACE(raw, r'```json|```', '')), '$.label') AS label,
  JSON_VALUE(SAFE.PARSE_JSON(REGEXP_REPLACE(raw, r'```json|```', '')), '$.sector') AS sector,
  JSON_VALUE(SAFE.PARSE_JSON(REGEXP_REPLACE(raw, r'```json|```', '')), '$.evidence_focus') AS evidence_focus,
  JSON_VALUE(SAFE.PARSE_JSON(REGEXP_REPLACE(raw, r'```json|```', '')), '$.coherence_guess') AS coherence_guess,
  raw AS model_raw, CURRENT_TIMESTAMP() AS labelled_at
FROM gen;

-- The evidence map itself: cluster × region with counts, grey-literature share, outcome share
CREATE OR REPLACE VIEW `ai-ippc.climate_ai.evidence_map` AS
SELECT
  dc.cluster_id, cl.label, cl.sector, cl.evidence_focus,
  COALESCE(c.region, m.region, 'Unknown') AS region,
  COUNT(*) AS n_docs,
  COUNTIF(c.source_type != 'peer_reviewed') / COUNT(*) AS grey_share,
  COUNTIF(COALESCE(c.outcome_reported, m.outcome_reported)) / COUNT(*) AS outcome_share,
  MIN(c.year) AS first_year, MAX(c.year) AS last_year,
  APPROX_TOP_COUNT(c.hazard, 3) AS top_hazards
FROM `ai-ippc.climate_ai.doc_clusters` dc
JOIN `ai-ippc.climate_ai.corpus` c USING (doc_id)
LEFT JOIN `ai-ippc.climate_ai.cluster_labels` cl USING (cluster_id)
LEFT JOIN `ai-ippc.climate_ai.doc_metadata_llm` m USING (doc_id)
GROUP BY 1, 2, 3, 4, 5;
