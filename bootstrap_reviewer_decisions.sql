CREATE TABLE IF NOT EXISTS `ai-ippc.climate_ai.reviewer_decisions` (
  decision_id STRING NOT NULL,
  doc_id STRING,
  cluster_id INT64,
  decision_type STRING,
  reviewer STRING,
  note STRING,
  decided_at TIMESTAMP
);
