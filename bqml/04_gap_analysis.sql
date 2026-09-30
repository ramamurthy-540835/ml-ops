-- 04_gap_analysis.sql — §2.1 fairness / §2.2 data quality: where is evidence thin?
-- Pure SQL. "Expected share" is a transparent, editable prior (here: rough share of
-- global population exposed to climate hazards per WGII region). Replace with your own.

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.region_expected_share` AS
SELECT * FROM UNNEST([
  STRUCT('Africa' AS region, 0.18 AS expected_share),
  ('Asia', 0.40), ('Australasia', 0.01), ('Central and South America', 0.09),
  ('Europe', 0.09), ('North America', 0.07), ('Small Islands', 0.01), ('Polar Regions', 0.01)
]);

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.gap_by_region` AS
WITH rel AS (
  SELECT c.*, COALESCE(c.region, m.region) AS region_f
  FROM `ai-ippc.climate_ai.corpus` c
  JOIN `ai-ippc.climate_ai.screening_predictions` s USING (doc_id)
  LEFT JOIN `ai-ippc.climate_ai.doc_metadata_llm` m USING (doc_id)
  WHERE s.p_relevant >= 0.5
),
tot AS (SELECT COUNT(*) AS n FROM rel)
SELECT
  e.region,
  COUNT(r.doc_id) AS n_docs,
  COUNT(r.doc_id) / (SELECT n FROM tot) AS observed_share,
  e.expected_share,
  SAFE_DIVIDE(COUNT(r.doc_id) / (SELECT n FROM tot), e.expected_share) AS coverage_ratio,  -- <1 = under-covered
  COUNTIF(r.source_type != 'peer_reviewed') / NULLIF(COUNT(r.doc_id), 0) AS grey_share,
  COUNTIF(r.language != 'en') / NULLIF(COUNT(r.doc_id), 0) AS non_english_share,
  COUNTIF(r.evidence_type IN ('adaptation', 'maladaptation')) / NULLIF(COUNT(r.doc_id), 0) AS adaptation_share,
  COUNTIF(r.outcome_reported) / NULLIF(COUNTIF(r.evidence_type IN ('adaptation', 'maladaptation')), 0) AS adaptation_with_outcome_share
FROM `ai-ippc.climate_ai.region_expected_share` e
LEFT JOIN rel r ON r.region_f = e.region
GROUP BY e.region, e.expected_share;

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.gap_region_sector` AS
SELECT COALESCE(c.region, m.region, 'Unknown') AS region, COALESCE(c.sector, m.sector, 'Unknown') AS sector,
       COUNT(*) AS n_docs,
       COUNTIF(c.evidence_type = 'adaptation') AS n_adaptation,
       COUNTIF(c.evidence_type = 'maladaptation') AS n_maladaptation,
       COUNTIF(c.outcome_reported) AS n_with_outcome
FROM `ai-ippc.climate_ai.corpus` c
JOIN `ai-ippc.climate_ai.screening_predictions` s USING (doc_id)
LEFT JOIN `ai-ippc.climate_ai.doc_metadata_llm` m USING (doc_id)
WHERE s.p_relevant >= 0.5
GROUP BY 1, 2;

-- Gini coefficient of documents per region (0 = perfectly even, 1 = all in one region)
CREATE OR REPLACE VIEW `ai-ippc.climate_ai.gap_gini` AS
WITH x AS (SELECT n_docs AS v FROM `ai-ippc.climate_ai.gap_by_region`),
ranked AS (SELECT v, ROW_NUMBER() OVER (ORDER BY v) AS i, COUNT(*) OVER () AS n, SUM(v) OVER () AS s FROM x)
SELECT ROUND(SUM((2 * i - n - 1) * v) / (n * s), 4) AS gini_region,
       CURRENT_TIMESTAMP() AS computed_at
FROM ranked GROUP BY n, s;

-- Adaptation outcome aggregation by "similar context" (region|sector|hazard) — §2.2 "aggregate
-- outcomes based on similarity of contexts"
CREATE OR REPLACE VIEW `ai-ippc.climate_ai.adaptation_outcome_summary` AS
SELECT context_similarity_key, adaptation_type,
       COUNT(*) AS n_studies,
       COUNTIF(outcome_direction = 'positive') AS n_positive,
       COUNTIF(outcome_direction = 'negative') AS n_negative,
       COUNTIF(outcome_direction = 'mixed') AS n_mixed,
       AVG(effect_size) AS mean_effect, STDDEV(effect_size) AS sd_effect
FROM `ai-ippc.climate_ai.adaptation_outcomes`
GROUP BY 1, 2;
