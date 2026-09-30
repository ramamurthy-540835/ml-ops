-- 01_remote_models.sql — Vertex AI remote models used by ML.GENERATE_TEXT / ML.GENERATE_EMBEDDING.
-- Prereq (once): a BigQuery→Vertex AI connection with the Vertex AI User role.
--   bq mk --connection --location=US --project_id=ai-ippc --connection_type=CLOUD_RESOURCE vertex-ai
-- Then grant roles/aiplatform.user to the connection's service account.
-- Verify which Gemini endpoint names your project can use before running; adjust ENDPOINT.

CREATE OR REPLACE MODEL `ai-ippc.climate_ai.gemini_text`
  REMOTE WITH CONNECTION `ai-ippc.us.vertex-ai`
  OPTIONS (ENDPOINT = 'gemini-2.5-flash');

CREATE OR REPLACE MODEL `ai-ippc.climate_ai.text_embedding`
  REMOTE WITH CONNECTION `ai-ippc.us.vertex-ai`
  OPTIONS (ENDPOINT = 'text-embedding-005');

-- (Optional) re-embed synthetic docs with the real model so real + synthetic share a space.
-- CREATE OR REPLACE TABLE `ai-ippc.climate_ai.embeddings_synthetic` AS
-- SELECT doc_id, 'text-embedding-005' AS model, ml_generate_embedding_result AS embedding
-- FROM ML.GENERATE_EMBEDDING(
--   MODEL `ai-ippc.climate_ai.text_embedding`,
--   (SELECT doc_id, CONCAT(title, '. ', abstract) AS content FROM `ai-ippc.climate_ai.documents_synthetic`),
--   STRUCT(TRUE AS flatten_json_output, 'RETRIEVAL_DOCUMENT' AS task_type));
