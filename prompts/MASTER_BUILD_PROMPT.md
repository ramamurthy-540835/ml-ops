# Master build prompt — ClimateReview AI research + MLOps layer

Use this prompt with a coding model (Claude / Gemini) to regenerate or extend the system consistently.

---
You are extending `climate-review-ai` (FastAPI + Next.js/TypeScript + BigQuery + BQML + Vertex AI on Cloud Run, project `ai-ippc`, dataset `climate_ai` with tables `documents`, `embeddings`). The product is an evidence-synthesis workbench for IPCC Working Group II that implements the research agenda of the MANILA24 workshop report (SIGIR Forum 59(1), 2025).

Non-negotiable design rules
1. Human in the loop: models rank, cluster, pre-label and draft; a named reviewer decides. Every decision is written to BigQuery with actor, time and reason.
2. Provenance: every generated claim cites `doc_id` and page; every dataset is `name@vN`, immutable, content-hashed, stored in GCS and loaded into BigQuery; every model links to its run, dataset, config and evaluation.
3. Transparency first: prefer BQML linear/tree models on embeddings; use Gemini only for pre-labeling, cluster naming, metadata extraction, grounded synthesis and fine-tuning; always request strict JSON and parse with SAFE.PARSE_JSON.
4. Bias visible: dashboards show observed vs expected coverage by WGII region, language and grey literature; active learning prioritises under-represented rows.
5. Cost visible: record bytes billed and slot ms for every job.
6. Nothing is auto-promoted to production without passing quality gates AND a human click with a written reason.

Architecture (keep these names)
- Python packages: `services/ml_service.py`, `api_ml.py` (research), `mlops/{common,dataset,labeling,training,registry}.py`, `api_mlops.py` (control plane).
- BigQuery: `climate_ai.*` (application + BQML models from bqml/0*.sql), `climate_ai_mlops.*` (registry: datasets, label_tasks, labels, training_runs, models, evaluations, promotions, pipeline_runs, ds_<name>_v<N>, prod_<task> alias views).
- GCS: `gs://ai-ippc-climate-mlops/{datasets,labels,tuning,models}/…`, bucket versioning on.
- Next.js: `/research` (screening, evidence map, gaps, living evidence, synthesis) and `/mlops` (overview, datasets, labeling, training, models, runs). Typed clients in `web/lib/{mlApi,mlopsApi}.ts`. CSS modules, one type family, no all-caps labels, no decorative gradients.
- Learning types in `TrainConfig`: classification, regression, clustering, dimensionality_reduction, anomaly_detection, time_series, fine_tune; each maps to BQML model_type or Vertex `sft.train`. Hyperparameter search via NUM_TRIALS + HPARAM_RANGE/HPARAM_CANDIDATES.

When asked for a new capability: (a) say which MANILA24 section it serves, (b) add the BigQuery table/view or model first, (c) add the Python function, (d) add the API route, (e) add the UI panel, (f) add a quality gate or monitoring view if it changes a decision the reviewer relies on. Return complete files, not snippets.
---
