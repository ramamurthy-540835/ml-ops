-- 05_living_evidence_arima.sql — §2.2/§3.2 timeliness & living evidence.
-- Forecast yearly publication volume per cluster; flag clusters whose forecast growth since
-- the last assessment cut-off (AR6 WGII literature cut-off ≈ 2021) exceeds a threshold.

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.cluster_yearly` AS
SELECT cluster_id, DATE(c.year, 1, 1) AS yr, COUNT(*) AS n_docs
FROM `ai-ippc.climate_ai.doc_clusters` JOIN `ai-ippc.climate_ai.corpus` c USING (doc_id)
WHERE c.year IS NOT NULL AND c.year BETWEEN 2005 AND EXTRACT(YEAR FROM CURRENT_DATE())
GROUP BY 1, 2;

CREATE OR REPLACE MODEL `ai-ippc.climate_ai.cluster_volume_arima`
OPTIONS (model_type = 'ARIMA_PLUS', time_series_timestamp_col = 'yr',
         time_series_data_col = 'n_docs', time_series_id_col = 'cluster_id',
         data_frequency = 'YEARLY', auto_arima = TRUE, holiday_region = 'NONE') AS
SELECT * FROM `ai-ippc.climate_ai.cluster_yearly`;

CREATE OR REPLACE TABLE `ai-ippc.climate_ai.cluster_forecast` AS
SELECT cluster_id, forecast_timestamp, forecast_value,
       prediction_interval_lower_bound, prediction_interval_upper_bound
FROM ML.FORECAST(MODEL `ai-ippc.climate_ai.cluster_volume_arima`,
                 STRUCT(3 AS horizon, 0.8 AS confidence_level));

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.living_evidence_alerts` AS
WITH since_cutoff AS (
  SELECT cluster_id, SUM(n_docs) AS n_since_ar6
  FROM `ai-ippc.climate_ai.cluster_yearly` WHERE yr > DATE(2021, 1, 1) GROUP BY 1
),
before_cutoff AS (
  SELECT cluster_id, SUM(n_docs) AS n_before_ar6
  FROM `ai-ippc.climate_ai.cluster_yearly` WHERE yr <= DATE(2021, 1, 1) GROUP BY 1
),
fc AS (SELECT cluster_id, SUM(forecast_value) AS n_forecast_3y FROM `ai-ippc.climate_ai.cluster_forecast` GROUP BY 1)
SELECT
  cl.cluster_id, cl.label, cl.sector,
  b.n_before_ar6, s.n_since_ar6, fc.n_forecast_3y,
  SAFE_DIVIDE(s.n_since_ar6, b.n_before_ar6) AS growth_since_ar6,
  CASE
    WHEN SAFE_DIVIDE(s.n_since_ar6, b.n_before_ar6) >= 0.5 THEN 'update_now'
    WHEN SAFE_DIVIDE(s.n_since_ar6, b.n_before_ar6) >= 0.25 THEN 'watch'
    ELSE 'stable'
  END AS update_status
FROM `ai-ippc.climate_ai.cluster_labels` cl
LEFT JOIN since_cutoff s USING (cluster_id)
LEFT JOIN before_cutoff b USING (cluster_id)
LEFT JOIN fc USING (cluster_id);
