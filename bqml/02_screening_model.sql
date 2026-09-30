-- 02_screening_model.sql — §3.2 "the labeling bottleneck": screening prioritisation.
-- Transparent logistic regression on document embeddings. Trained on human labels
-- (majority vote across annotators), evaluated on the held-out split, then used to rank
-- every unlabelled document and estimate a stopping point.

-- 1. training view: majority vote per doc, only train split
CREATE OR REPLACE VIEW `ai-ippc.climate_ai.screening_train` AS
WITH votes AS (
  SELECT doc_id, split, AVG(label) AS p FROM `ai-ippc.climate_ai.screening_labels`
  GROUP BY doc_id, split
)
SELECT e.doc_id, e.embedding, CAST(v.p >= 0.5 AS INT64) AS label, v.split
FROM votes v JOIN `ai-ippc.climate_ai.corpus_embeddings` e USING (doc_id);

-- 2. model
CREATE OR REPLACE MODEL `ai-ippc.climate_ai.screening_lr`
OPTIONS (
  model_type = 'LOGISTIC_REG',
  input_label_cols = ['label'],
  auto_class_weights = TRUE,
  l2_reg = 0.5,
  enable_global_explain = TRUE,
  data_split_method = 'NO_SPLIT'
) AS
SELECT embedding, label FROM `ai-ippc.climate_ai.screening_train` WHERE split = 'train';

-- 3. evaluation on the test split (precision/recall/roc_auc)
CREATE OR REPLACE TABLE `ai-ippc.climate_ai.screening_eval` AS
SELECT CURRENT_TIMESTAMP() AS evaluated_at, *
FROM ML.EVALUATE(MODEL `ai-ippc.climate_ai.screening_lr`,
  (SELECT embedding, label FROM `ai-ippc.climate_ai.screening_train` WHERE split = 'test'));

-- 4. rank the whole corpus; reviewers work top-down
CREATE OR REPLACE TABLE `ai-ippc.climate_ai.screening_predictions` AS
WITH pred AS (
  SELECT doc_id, predicted_label,
         (SELECT prob FROM UNNEST(predicted_label_probs) WHERE label = 1) AS p_relevant
  FROM ML.PREDICT(MODEL `ai-ippc.climate_ai.screening_lr`,
                  (SELECT doc_id, embedding FROM `ai-ippc.climate_ai.corpus_embeddings`))
),
labelled AS (SELECT DISTINCT doc_id FROM `ai-ippc.climate_ai.screening_labels`)
SELECT
  p.doc_id, c.title, c.year, c.region, c.source_type, c.language, c.provenance,
  p.p_relevant,
  l.doc_id IS NOT NULL AS already_labelled,
  RANK() OVER (ORDER BY p.p_relevant DESC) AS priority_rank,
  -- expected number of relevant docs remaining below this rank → simple stopping heuristic
  SUM(p.p_relevant) OVER (ORDER BY p.p_relevant DESC ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)
    - p.p_relevant AS expected_relevant_remaining,
  CURRENT_TIMESTAMP() AS scored_at
FROM pred p
JOIN `ai-ippc.climate_ai.corpus` c USING (doc_id)
LEFT JOIN labelled l USING (doc_id);

-- 5. stopping point: first rank where expected remaining relevant < 5% of expected total
CREATE OR REPLACE VIEW `ai-ippc.climate_ai.screening_stopping` AS
WITH t AS (SELECT SUM(p_relevant) AS total FROM `ai-ippc.climate_ai.screening_predictions`)
SELECT MIN(priority_rank) AS suggested_stop_rank,
       (SELECT total FROM t) AS expected_total_relevant,
       (SELECT COUNT(*) FROM `ai-ippc.climate_ai.screening_predictions`) AS corpus_size
FROM `ai-ippc.climate_ai.screening_predictions`, t
WHERE expected_relevant_remaining < 0.05 * t.total;
