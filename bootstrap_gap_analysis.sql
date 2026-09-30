-- Coverage-gap dashboard bootstrap for installations that have the screening
-- tables but have not yet run the complete BQML corpus/enrichment pipeline.
-- The full bqml/04_gap_analysis.sql migration replaces these views when the
-- corpus and adaptation_outcomes tables are available.

CREATE TABLE IF NOT EXISTS `ai-ippc.climate_ai.region_expected_share` (
  region STRING NOT NULL,
  expected_share FLOAT64 NOT NULL
);

MERGE `ai-ippc.climate_ai.region_expected_share` target
USING (
  SELECT * FROM UNNEST([
    STRUCT('Africa' AS region, 0.18 AS expected_share),
    ('Asia', 0.40), ('Australasia', 0.01), ('Central and South America', 0.09),
    ('Europe', 0.09), ('North America', 0.07), ('Small Islands', 0.01), ('Polar Regions', 0.01)
  ])
) source
ON target.region = source.region
WHEN NOT MATCHED THEN INSERT (region, expected_share) VALUES (source.region, source.expected_share);

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.gap_by_region` AS
WITH relevant AS (
  SELECT region, source_type, language
  FROM `ai-ippc.climate_ai.screening_predictions`
  WHERE p_relevant >= 0.5
), total AS (SELECT COUNT(*) AS n FROM relevant)
SELECT
  expected.region,
  COUNT(relevant.region) AS n_docs,
  SAFE_DIVIDE(COUNT(relevant.region), total.n) AS observed_share,
  expected.expected_share,
  SAFE_DIVIDE(SAFE_DIVIDE(COUNT(relevant.region), total.n), expected.expected_share) AS coverage_ratio,
  SAFE_DIVIDE(COUNTIF(relevant.source_type != 'peer_reviewed'), COUNT(relevant.region)) AS grey_share,
  SAFE_DIVIDE(COUNTIF(relevant.language != 'en'), COUNT(relevant.region)) AS non_english_share,
  CAST(NULL AS FLOAT64) AS adaptation_share,
  CAST(NULL AS FLOAT64) AS adaptation_with_outcome_share
FROM `ai-ippc.climate_ai.region_expected_share` expected
LEFT JOIN relevant ON relevant.region = expected.region
CROSS JOIN total
GROUP BY expected.region, expected.expected_share, total.n;

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.gap_region_sector` AS
SELECT region, 'Not enriched' AS sector, COUNT(*) AS n_docs,
       0 AS n_adaptation, 0 AS n_maladaptation, 0 AS n_with_outcome
FROM `ai-ippc.climate_ai.screening_predictions`
WHERE p_relevant >= 0.5
GROUP BY region;

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.gap_gini` AS
WITH x AS (SELECT n_docs AS v FROM `ai-ippc.climate_ai.gap_by_region`),
ranked AS (SELECT v, ROW_NUMBER() OVER (ORDER BY v) AS i, COUNT(*) OVER () AS n, SUM(v) OVER () AS s FROM x)
SELECT ROUND(SAFE_DIVIDE(SUM((2 * i - n - 1) * v), n * s), 4) AS gini_region,
       CURRENT_TIMESTAMP() AS computed_at
FROM ranked GROUP BY n, s;

CREATE OR REPLACE VIEW `ai-ippc.climate_ai.adaptation_outcome_summary` AS
SELECT CAST(NULL AS STRING) AS context_similarity_key,
       CAST(NULL AS STRING) AS adaptation_type,
       CAST(NULL AS INT64) AS n_studies,
       CAST(NULL AS INT64) AS n_positive,
       CAST(NULL AS INT64) AS n_negative,
       CAST(NULL AS INT64) AS n_mixed,
       CAST(NULL AS FLOAT64) AS mean_effect,
       CAST(NULL AS FLOAT64) AS sd_effect
FROM UNNEST([1])
WHERE FALSE;
