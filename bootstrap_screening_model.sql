-- Bootstrap screening model for the deployed document/embedding schema.
-- Labels are weak, transparent keyword labels (not reviewer decisions). Replace
-- screening_labels with reviewer-created labels and rerun bqml/02_screening_model.sql
-- when an adjudicated label set is available.

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.corpus` AS
SELECT
  id AS doc_id,
  document_name AS title,
  CAST(NULL AS INT64) AS year,
  CAST(NULL AS STRING) AS region,
  'ingested' AS source_type,
  'en' AS language,
  'ingested' AS provenance
FROM `ai-ippc.climate_ai.documents`;

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.corpus_embeddings` AS
SELECT id AS doc_id, embedding
FROM `ai-ippc.climate_ai.embeddings`;

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.screening_labels` AS
SELECT
  id AS doc_id,
  IF(MOD(ABS(FARM_FINGERPRINT(id)), 5) = 0, 'test', 'train') AS split,
  CAST(REGEXP_CONTAINS(
    LOWER(CONCAT(document_name, ' ', content)),
    r'\b(adaptation|maladaptation|vulnerab\w*|climate impact\w*|resilien\w*|climate risk\w*|exposure|hazard\w*)\b'
  ) AS INT64) AS label,
  'bootstrap_keyword_v1' AS label_origin,
  CURRENT_TIMESTAMP() AS created_at
FROM `ai-ippc.climate_ai.documents`;

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.screening_train` AS
SELECT e.doc_id, e.embedding, labels.label, labels.split
FROM `ai-ippc.climate_ai.screening_labels` labels
JOIN `ai-ippc.climate_ai.corpus_embeddings` e USING (doc_id);

CREATE OR REPLACE MODEL `ai-ippc.climate_ai.screening_lr`
OPTIONS (
  model_type = 'LOGISTIC_REG',
  input_label_cols = ['label'],
  auto_class_weights = TRUE,
  l2_reg = 0.5,
  enable_global_explain = TRUE,
  data_split_method = 'NO_SPLIT'
) AS
SELECT embedding, label
FROM `ai-ippc.climate_ai.screening_train`
WHERE split = 'train';

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.screening_eval` AS
SELECT CURRENT_TIMESTAMP() AS evaluated_at, *
FROM ML.EVALUATE(MODEL `ai-ippc.climate_ai.screening_lr`,
  (SELECT embedding, label FROM `ai-ippc.climate_ai.screening_train` WHERE split = 'test'));

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.screening_predictions` AS
WITH pred AS (
  SELECT doc_id,
         (SELECT prob FROM UNNEST(predicted_label_probs) WHERE label = 1) AS p_relevant
  FROM ML.PREDICT(MODEL `ai-ippc.climate_ai.screening_lr`,
                 (SELECT doc_id, embedding FROM `ai-ippc.climate_ai.corpus_embeddings`))
)
SELECT p.doc_id, c.title, c.year, c.region, c.source_type, c.language, c.provenance,
       p.p_relevant, FALSE AS already_labelled,
       RANK() OVER (ORDER BY p.p_relevant DESC) AS priority_rank,
       SUM(p.p_relevant) OVER (ORDER BY p.p_relevant DESC ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)
         - p.p_relevant AS expected_relevant_remaining,
       CURRENT_TIMESTAMP() AS scored_at
FROM pred p
JOIN `ai-ippc.climate_ai.corpus` c USING (doc_id);

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.screening_stopping` AS
WITH total AS (SELECT SUM(p_relevant) AS expected_total FROM `ai-ippc.climate_ai.screening_predictions`)
SELECT MIN(priority_rank) AS suggested_stop_rank,
       total.expected_total AS expected_total_relevant,
       (SELECT COUNT(*) FROM `ai-ippc.climate_ai.screening_predictions`) AS corpus_size
FROM `ai-ippc.climate_ai.screening_predictions`, total
WHERE expected_relevant_remaining < 0.05 * total.expected_total
GROUP BY total.expected_total;
