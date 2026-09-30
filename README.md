# ClimateReview AI — Research/ML extension (MANILA24 agenda)

This folder extends `climate-review-ai` from a *passage reviewer* into an
*evidence-synthesis research workbench* that operationalises the research agenda in
"Information Retrieval for Climate Impact — Report on the MANILA24 Workshop"
(SIGIR Forum 59(1), 2025). Everything runs on the existing stack:
BigQuery (`ai-ippc.climate_ai`), BQML, Vertex AI remote models, FastAPI, Next.js.

## 1. Reasoning: from the paper to concrete ML use cases

The paper follows the systematic-review chain **querying → screening → aggregating**
and adds IPCC-specific guardrails (no black boxes, provenance, bias, carbon cost).
Each section of the paper yields a use case that is implementable with BQML today.

| Paper section / challenge | Use case in the app | BQML model / SQL | Why this model |
|---|---|---|---|
| §3.2 *The labeling bottleneck* — screening 34k+ papers | **Screening prioritisation**: rank unlabelled docs by P(relevant to WGII), estimate a stopping point | `LOGISTIC_REG` on `embeddings` (768-d) trained on `screening_labels`; `ML.PREDICT`, `ML.EVALUATE` | Transparent, calibrated probabilities, cheap to retrain; TAR literature (CLEF-TAR, Stevenson & Bin-Hezam 2023) uses the same active-screening framing |
| §5.2 *Synthesis and evidence maps*, *Topic discovery* | **Evidence map**: cluster the corpus, name clusters, cross them with region × sector to show where evidence exists and where it is thin | `KMEANS` on embeddings → `ML.GENERATE_TEXT` labels each cluster from its top titles | Clusters are inspectable (centroids, member docs) → satisfies "zero tolerance for black boxes" |
| §2.1 *Fairness / geographic & cultural bias*, §2.2 *Data quality (grey literature)* | **Coverage-gap analysis**: observed vs expected evidence per WGII region, language share, grey-literature share, "outcome reported" share | Pure SQL views over `documents` (+ cluster ids) | Bias is a *distributional* question; no model needed, just honest counts |
| §2.2 *Climate adaptation*, *maladaptation* | **Adaptation classifier**: tag impact / adaptation / vulnerability / maladaptation, adaptation type (technological, institutional, behavioural, nature-based), and whether an outcome is measured | `ML.GENERATE_TEXT` with a strict JSON prompt; fallback `LOGISTIC_REG` multi-class on embeddings | Berrang-Ford et al. 2021 show adaptation outcomes are under-tracked; JSON output goes straight into `adaptation_outcomes` |
| §2.2 / §3.2 *Timeliness*, *Living evidence* | **Living-evidence monitor**: forecast publication volume per cluster and flag clusters whose growth outpaces the last assessment | `ARIMA_PLUS` on yearly counts per cluster | Answers "when should a review be updated?" with a number, not a feeling |
| §3.2 *Trustworthy synthesis*, §5 *provenance tracking* | **Grounded synthesis with calibrated language**: summarise a cluster/region using only retrieved chunks, cite `doc_id:page`, and emit IPCC calibrated confidence (very high / high / medium / low) with an evidence-agreement rationale | `ML.GENERATE_TEXT` grounded prompt; `VECTOR_SEARCH` for retrieval | Reuses the repo's existing "bounded evidence" principle; confidence language mirrors the IPCC AR6 uncertainty guidance |
| §2.1 *carbon cost of IR approaches* | **Cost ledger**: every BQML job logs bytes billed and model type so the team can compare "embedding + logistic regression" vs "LLM per document" | `INFORMATION_SCHEMA.JOBS` view | Makes the paper's carbon question measurable |

Design constraints carried over from the paper:

* **Human in the loop** — models rank, cluster and draft; the reviewer decides. The
  Next.js UI never auto-accepts a label.
* **Provenance** — every generated sentence must cite `doc_id` (and page where known);
  the prompts refuse to answer without evidence.
* **Bias visibility** — the synthetic corpus is *deliberately skewed* (English, Europe /
  North America, peer-reviewed) so the gap dashboard shows the problem the paper
  describes, not a flattering picture.
* **Transparency over accuracy** — where a linear model on embeddings is nearly as good
  as an LLM, the linear model is the default.

## 2. Folder layout

```
ml-extension/
  synthetic/generate_synthetic_corpus.py   synthetic WGII-style corpus (JSONL)
  synthetic/load_to_bigquery.py            loads JSONL into ai-ippc.climate_ai
  bqml/00_schema.sql ... 07_cost_ledger.sql BQML pipeline, run in order
  prompts/*.txt                            prompts used inside ML.GENERATE_TEXT
  services/ml_service.py                   Python wrapper around the BQML tables
  api_ml.py                                FastAPI router: /ml/*
  web/lib/mlApi.ts                         typed client for /ml/*
  web/app/research/page.tsx                Research workbench page
  web/components/research/*.tsx            EvidenceMap, ScreeningQueue, CoverageGaps,
                                           LivingEvidence, SynthesisPanel
```

## 3. Run order

```bash
# 1. synthetic corpus (default 6,000 docs, 768-d embeddings)
python synthetic/generate_synthetic_corpus.py --n 6000 --out data/synthetic
python synthetic/load_to_bigquery.py --project ai-ippc --dataset climate_ai --src data/synthetic

# 2. BQML (BigQuery console or bq CLI). Set the connection name first:
for f in bqml/0*.sql; do bq query --use_legacy_sql=false < "$f"; done

# 3. API — mount the router in api.py
#    from api_ml import router as ml_router; app.include_router(ml_router)

# 4. Web — copy web/* into the repo's web/ folder, then
cd web && npm run dev   # open /research
```

Environment variables (add to `.env.example`):

```
BQ_PROJECT=ai-ippc
BQ_DATASET=climate_ai
BQ_LOCATION=US
BQ_CONNECTION=us.vertex-ai            # BigQuery → Vertex AI connection
BQML_TEXT_MODEL=gemini-2.5-flash       # check the endpoint list available to your project
BQML_EMBED_MODEL=text-embedding-005
```

## 4. Evaluation the way the paper asks for it

* Screening: recall@k and work-saved-over-sampling (WSS@95) from `07_evaluate.sql`.
* Evidence map: silhouette proxy (`ML.EVALUATE` Davies–Bouldin) plus a human
  "is this cluster coherent?" check surfaced in the UI.
* Gap analysis: Gini coefficient of documents per region, before and after adding
  grey literature.
* Synthesis: citation-precision (fraction of cited `doc_id`s that exist and support
  the sentence) — spot-checked by the reviewer in the UI.
