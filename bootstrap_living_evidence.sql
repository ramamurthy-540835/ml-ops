-- Living Evidence bootstrap with provenance-safe year extraction.
-- A year is accepted only when the source text explicitly labels it as a
-- publication year. Citation years and arbitrary years in prose are ignored.

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.publication_years` AS
SELECT id AS doc_id,
       SAFE_CAST(REGEXP_EXTRACT(LOWER(content), r'(?:publication year|year of publication|published)[^0-9]{0,30}(19[5-9][0-9]|20[0-2][0-9])') AS INT64) AS publication_year,
       'explicit_publication_label' AS extraction_method,
       CURRENT_TIMESTAMP() AS extracted_at
FROM `ai-ippc.climate_ai.documents`
WHERE REGEXP_CONTAINS(LOWER(content), r'(?:publication year|year of publication|published)[^0-9]{0,30}(19[5-9][0-9]|20[0-2][0-9])');

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.cluster_yearly` AS
SELECT dc.cluster_id, DATE(py.publication_year, 1, 1) AS yr,
       COUNT(DISTINCT dc.doc_id) AS n_docs
FROM `ai-ippc.climate_ai.doc_clusters` dc
JOIN `ai-ippc.climate_ai.publication_years` py USING (doc_id)
GROUP BY dc.cluster_id, yr;

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.cluster_forecast` AS
SELECT CAST(NULL AS INT64) AS cluster_id,
       CAST(NULL AS TIMESTAMP) AS forecast_timestamp,
       CAST(NULL AS FLOAT64) AS forecast_value,
       CAST(NULL AS FLOAT64) AS prediction_interval_lower_bound,
       CAST(NULL AS FLOAT64) AS prediction_interval_upper_bound
FROM UNNEST([1])
WHERE FALSE;

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.living_evidence_alerts` AS
WITH by_cluster AS (
  SELECT cluster_id, COUNT(DISTINCT EXTRACT(YEAR FROM yr)) AS observed_years,
         SUM(IF(EXTRACT(YEAR FROM yr) < 2021, n_docs, 0)) AS n_before_ar6,
         SUM(IF(EXTRACT(YEAR FROM yr) >= 2021, n_docs, 0)) AS n_since_ar6
  FROM `ai-ippc.climate_ai.cluster_yearly`
  GROUP BY cluster_id
)
SELECT b.cluster_id, c.label, c.sector, b.n_before_ar6, b.n_since_ar6,
       CAST(NULL AS FLOAT64) AS n_forecast_3y,
       SAFE_DIVIDE(b.n_since_ar6, NULLIF(b.n_before_ar6, 0)) - 1 AS growth_since_ar6,
       CASE WHEN b.observed_years < 3 THEN 'insufficient_data'
            WHEN SAFE_DIVIDE(b.n_since_ar6, NULLIF(b.n_before_ar6, 0)) - 1 >= 0.5 THEN 'update_now'
            WHEN SAFE_DIVIDE(b.n_since_ar6, NULLIF(b.n_before_ar6, 0)) - 1 >= 0.25 THEN 'watch'
            ELSE 'stable' END AS update_status
FROM by_cluster b LEFT JOIN `ai-ippc.climate_ai.cluster_labels` c USING (cluster_id);
