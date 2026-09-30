CREATE TABLE IF NOT EXISTS `ai-ippc.climate_ai.screening_predictions` (
  doc_id STRING, title STRING, year INT64, region STRING, source_type STRING,
  language STRING, provenance STRING, p_relevant FLOAT64, already_labelled BOOL,
  priority_rank INT64, expected_relevant_remaining FLOAT64, scored_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS `ai-ippc.climate_ai.screening_llm_second_opinion` (
  doc_id STRING, p_relevant FLOAT64, llm_decision STRING, criterion STRING,
  agrees_with_model BOOL, reason STRING, generated_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS `ai-ippc.climate_ai.screening_stopping` (
  suggested_stop_rank INT64, expected_total_relevant FLOAT64, corpus_size INT64
);
CREATE TABLE IF NOT EXISTS `ai-ippc.climate_ai.screening_eval` (
  evaluated_at TIMESTAMP, precision FLOAT64, recall FLOAT64, roc_auc FLOAT64, f1_score FLOAT64
);
CREATE TABLE IF NOT EXISTS `ai-ippc.climate_ai.screening_wss95` (
  wss_at_95 FLOAT64, test_size INT64
);
