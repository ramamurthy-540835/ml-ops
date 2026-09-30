-- Evidence-map bootstrap for the deployed documents/embeddings schema.
-- Uses KMEANS on ranked chunk embeddings. Labels are deterministic representative
-- filenames; replace with bqml/03 after metadata extraction and Gemini setup.

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.corpus` AS
SELECT id AS doc_id, document_name AS title,
       CAST(NULL AS INT64) AS year, CAST(NULL AS STRING) AS region,
       'ingested' AS source_type, 'en' AS language, 'ingested' AS provenance,
       CAST(NULL AS STRING) AS sector, CAST(NULL AS STRING) AS hazard,
       CAST(NULL AS STRING) AS evidence_type, CAST(NULL AS BOOL) AS outcome_reported
FROM `ai-ippc.climate_ai.documents`;

CREATE OR REPLACE MODEL `ai-ippc.climate_ai.evidence_kmeans`
OPTIONS (model_type = 'KMEANS', num_clusters = 14, kmeans_init_method = 'KMEANS++',
         standardize_features = FALSE, distance_type = 'COSINE') AS
SELECT e.embedding
FROM `ai-ippc.climate_ai.corpus_embeddings` e
JOIN `ai-ippc.climate_ai.screening_predictions` s USING (doc_id)
WHERE s.p_relevant >= 0.5;

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.cluster_quality` AS
SELECT CURRENT_TIMESTAMP() AS evaluated_at, *
FROM ML.EVALUATE(MODEL `ai-ippc.climate_ai.evidence_kmeans`);

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.doc_clusters` AS
SELECT p.doc_id, p.CENTROID_ID AS cluster_id,
       (SELECT MIN(d.DISTANCE) FROM UNNEST(p.NEAREST_CENTROIDS_DISTANCE) d) AS dist_to_centroid
FROM ML.PREDICT(MODEL `ai-ippc.climate_ai.evidence_kmeans`,
  (SELECT e.doc_id, e.embedding
   FROM `ai-ippc.climate_ai.corpus_embeddings` e
   JOIN `ai-ippc.climate_ai.screening_predictions` s USING (doc_id)
   WHERE s.p_relevant >= 0.5)) p;

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.cluster_labels` AS
SELECT dc.cluster_id, COUNT(*) AS n_docs,
       CONCAT('Topic cluster ', CAST(dc.cluster_id AS STRING)) AS label,
       'Unknown' AS sector, 'mixed' AS evidence_focus, 'unreviewed' AS coherence_guess,
       STRING_AGG(c.title, '\n' ORDER BY dc.dist_to_centroid LIMIT 12) AS model_raw,
       CURRENT_TIMESTAMP() AS labelled_at
FROM `ai-ippc.climate_ai.doc_clusters` dc
JOIN `ai-ippc.climate_ai.corpus` c USING (doc_id)
GROUP BY dc.cluster_id;

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.evidence_map` AS
SELECT dc.cluster_id, labels.label, labels.sector, labels.evidence_focus,
       COALESCE(c.region, 'Unknown') AS region, COUNT(*) AS n_docs,
       SAFE_DIVIDE(COUNTIF(c.source_type != 'peer_reviewed'), COUNT(*)) AS grey_share,
       SAFE_DIVIDE(COUNTIF(c.outcome_reported), COUNT(*)) AS outcome_share,
       MIN(c.year) AS first_year, MAX(c.year) AS last_year,
       [STRUCT('Not enriched' AS value, COUNT(*) AS count)] AS top_hazards
FROM `ai-ippc.climate_ai.doc_clusters` dc
JOIN `ai-ippc.climate_ai.corpus` c USING (doc_id)
JOIN `ai-ippc.climate_ai.cluster_labels` labels USING (cluster_id)
GROUP BY dc.cluster_id, labels.label, labels.sector, labels.evidence_focus, COALESCE(c.region, 'Unknown');
