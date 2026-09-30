-- Living-evidence bootstrap for corpora without publication-year metadata.
-- Keeps the API contract available without fabricating a time series or forecast.
-- Replace with bqml/05_living_evidence_arima.sql after corpus.year is populated.

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.cluster_yearly` AS
SELECT CAST(NULL AS INT64) AS cluster_id,
       CAST(NULL AS DATE) AS yr,
       CAST(NULL AS INT64) AS n_docs
FROM UNNEST([1])
WHERE FALSE;

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.cluster_forecast` AS
SELECT CAST(NULL AS INT64) AS cluster_id,
       CAST(NULL AS TIMESTAMP) AS forecast_timestamp,
       CAST(NULL AS FLOAT64) AS forecast_value,
       CAST(NULL AS FLOAT64) AS prediction_interval_lower_bound,
       CAST(NULL AS FLOAT64) AS prediction_interval_upper_bound
FROM UNNEST([1])
WHERE FALSE;

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.living_evidence_alerts` AS
SELECT CAST(NULL AS INT64) AS cluster_id,
       CAST(NULL AS STRING) AS label,
       CAST(NULL AS STRING) AS sector,
       CAST(NULL AS INT64) AS n_before_ar6,
       CAST(NULL AS INT64) AS n_since_ar6,
       CAST(NULL AS FLOAT64) AS n_forecast_3y,
       CAST(NULL AS FLOAT64) AS growth_since_ar6,
       CAST(NULL AS STRING) AS update_status
FROM UNNEST([1])
WHERE FALSE;
