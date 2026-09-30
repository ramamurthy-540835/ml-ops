CREATE TABLE IF NOT EXISTS `ai-ippc.climate_ai.cluster_labels` (
  cluster_id INT64, n_docs INT64, label STRING, sector STRING,
  evidence_focus STRING, coherence_guess STRING, model_raw STRING, labelled_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS `ai-ippc.climate_ai.cluster_coherence` (
  cluster_id INT64, label STRING, coherence_guess STRING,
  votes_coherent INT64, votes_incoherent INT64, davies_bouldin FLOAT64
);
CREATE TABLE IF NOT EXISTS `ai-ippc.climate_ai.evidence_map` (
  cluster_id INT64, label STRING, sector STRING, evidence_focus STRING,
  region STRING, n_docs INT64, grey_share FLOAT64, outcome_share FLOAT64,
  first_year INT64, last_year INT64,
  top_hazards ARRAY<STRUCT<value STRING, count INT64>>
);
