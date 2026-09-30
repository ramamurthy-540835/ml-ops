-- 07_evaluate_and_cost.sql — evaluation the way the MANILA24 report frames it, plus the
-- carbon/cost ledger (§2.1: "do benefits outweigh the carbon costs?").

-- 1. Screening: recall@k and WSS@95 (work saved over sampling at 95% recall) on the test split
CREATE OR REPLACE VIEW `ai-ippc.climate_ai.screening_recall_curve` AS
WITH gold AS (
  SELECT doc_id, CAST(AVG(label) >= 0.5 AS INT64) AS label
  FROM `ai-ippc.climate_ai.screening_labels` WHERE split = 'test' GROUP BY doc_id
),
ranked AS (
  SELECT g.doc_id, g.label, s.p_relevant,
         ROW_NUMBER() OVER (ORDER BY s.p_relevant DESC) AS k,
         COUNT(*) OVER () AS n, SUM(g.label) OVER () AS n_rel
  FROM gold g JOIN `ai-ippc.climate_ai.screening_predictions` s USING (doc_id)
)
SELECT k, n, n_rel,
       SUM(label) OVER (ORDER BY k) / n_rel AS recall_at_k,
       k / n AS fraction_screened
FROM ranked;

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.screening_wss95` AS
SELECT 1 - MIN(fraction_screened) AS wss_at_95, ANY_VALUE(n) AS test_size
FROM `ai-ippc.climate_ai.screening_recall_curve` WHERE recall_at_k >= 0.95;

-- 2. Human ↔ model ↔ LLM agreement on the uncertain band
CREATE OR REPLACE VIEW `ai-ippc.climate_ai.screening_agreement` AS
SELECT
  COUNT(*) AS n_band,
  COUNTIF(agrees_with_model) / COUNT(*) AS llm_model_agreement,
  COUNTIF(llm_decision = 'needs_full_text') / COUNT(*) AS needs_full_text_share
FROM `ai-ippc.climate_ai.screening_llm_second_opinion`;

-- 3. Cluster coherence: model metric + human votes from the UI
CREATE OR REPLACE VIEW `ai-ippc.climate_ai.cluster_coherence` AS
SELECT cl.cluster_id, cl.label, cl.coherence_guess,
       COUNTIF(r.decision_type = 'cluster_coherent') AS votes_coherent,
       COUNTIF(r.decision_type = 'cluster_incoherent') AS votes_incoherent,
       (SELECT davies_bouldin_index FROM `ai-ippc.climate_ai.cluster_quality` ORDER BY evaluated_at DESC LIMIT 1) AS davies_bouldin
FROM `ai-ippc.climate_ai.cluster_labels` cl
LEFT JOIN `ai-ippc.climate_ai.reviewer_decisions` r USING (cluster_id)
GROUP BY 1, 2, 3;

-- 4. Cost/carbon ledger: bytes and slot time per BQML job type over the last 30 days.
--    Multiply slot_ms by your region's grid intensity assumption in the UI if you want gCO2e.
CREATE OR REPLACE VIEW `ai-ippc.climate_ai.ml_cost_ledger` AS
SELECT
  DATE(creation_time) AS day,
  CASE
    WHEN REGEXP_CONTAINS(query, r'ML\.GENERATE_TEXT') THEN 'llm_generate_text'
    WHEN REGEXP_CONTAINS(query, r'ML\.GENERATE_EMBEDDING') THEN 'embedding'
    WHEN REGEXP_CONTAINS(query, r'CREATE (OR REPLACE )?MODEL') THEN 'train_model'
    WHEN REGEXP_CONTAINS(query, r'ML\.(PREDICT|FORECAST|EVALUATE)') THEN 'predict'
    WHEN REGEXP_CONTAINS(query, r'VECTOR_SEARCH') THEN 'vector_search'
    ELSE 'other'
  END AS job_kind,
  COUNT(*) AS n_jobs,
  SUM(total_bytes_billed) / POW(1024, 3) AS gb_billed,
  SUM(total_slot_ms) / 3.6e6 AS slot_hours
FROM `ai-ippc.region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND REGEXP_CONTAINS(query, r'climate_ai')
GROUP BY 1, 2;
