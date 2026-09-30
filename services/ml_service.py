"""
services/ml_service.py — thin, typed wrapper over the BQML tables and procedures created by
bqml/0*.sql. Every method returns plain dicts/lists so the FastAPI router can pass them straight
to the Next.js client. No model logic lives here: BigQuery is the model runtime.

Env:
  BQ_PROJECT (ai-ippc), BQ_DATASET (climate_ai), BQ_LOCATION (US)
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

from google.cloud import bigquery

PROJECT = os.getenv("BQ_PROJECT", "ai-ippc")
DATASET = os.getenv("BQ_DATASET", "climate_ai")
LOCATION = os.getenv("BQ_LOCATION", "US")
T = f"`{PROJECT}.{DATASET}"  # table prefix; close the backtick after the table name


@lru_cache(maxsize=1)
def client() -> bigquery.Client:
    return bigquery.Client(project=PROJECT, location=LOCATION)


def _rows(sql: str, params: list[bigquery.ScalarQueryParameter] | None = None) -> list[dict[str, Any]]:
    job = client().query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params or []))
    return [dict(r) for r in job.result()]


def _p(name: str, typ: str, val: Any) -> bigquery.ScalarQueryParameter:
    return bigquery.ScalarQueryParameter(name, typ, val)


# --------------------------------------------------------------------------- screening
def screening_queue(limit: int = 50, offset: int = 0, only_unlabelled: bool = True,
                    region: str | None = None) -> dict[str, Any]:
    """Docs ranked by P(relevant) with LLM second opinion where present (uncertain band)."""
    where = ["TRUE"]
    params = [_p("limit", "INT64", limit), _p("offset", "INT64", offset)]
    if only_unlabelled:
        where.append("NOT s.already_labelled")
    if region:
        where.append("s.region = @region"); params.append(_p("region", "STRING", region))
    rows = _rows(f"""
      SELECT s.doc_id, s.title, s.year, s.region, s.source_type, s.language, s.provenance,
             ROUND(s.p_relevant, 3) AS p_relevant, s.priority_rank,
             o.llm_decision, o.criterion, o.agrees_with_model, o.reason AS llm_reason,
             d.decision_type AS human_decision
      FROM {T}.screening_predictions` s
      LEFT JOIN {T}.screening_llm_second_opinion` o USING (doc_id)
      LEFT JOIN (SELECT doc_id, ARRAY_AGG(decision_type ORDER BY decided_at DESC LIMIT 1)[OFFSET(0)] AS decision_type
                 FROM {T}.reviewer_decisions` WHERE decision_type LIKE 'screen_%' GROUP BY doc_id) d USING (doc_id)
      WHERE {' AND '.join(where)}
      ORDER BY s.priority_rank
      LIMIT @limit OFFSET @offset""", params)
    stop = _rows(f"SELECT * FROM {T}.screening_stopping`")
    ev = _rows(f"SELECT precision, recall, roc_auc, f1_score FROM {T}.screening_eval` ORDER BY evaluated_at DESC LIMIT 1")
    wss = _rows(f"SELECT wss_at_95 FROM {T}.screening_wss95`")
    return {"items": rows, "stopping": stop[0] if stop else None,
            "eval": ev[0] if ev else None, "wss_at_95": wss[0]["wss_at_95"] if wss else None}


def record_decision(doc_id: str | None, cluster_id: int | None, decision_type: str,
                    reviewer: str, note: str | None = None) -> dict[str, Any]:
    row = {"decision_id": str(uuid.uuid4()), "doc_id": doc_id, "cluster_id": cluster_id,
           "decision_type": decision_type, "reviewer": reviewer, "note": note,
           "decided_at": datetime.now(timezone.utc).isoformat()}
    errors = client().insert_rows_json(f"{PROJECT}.{DATASET}.reviewer_decisions", [row])
    if errors:
        raise RuntimeError(f"BigQuery insert failed: {errors}")
    return row


# --------------------------------------------------------------------------- evidence map
def evidence_map() -> dict[str, Any]:
    cells = _rows(f"""
      SELECT cluster_id, label, sector, evidence_focus, region, n_docs,
             ROUND(grey_share, 3) AS grey_share, ROUND(outcome_share, 3) AS outcome_share,
             first_year, last_year,
             ARRAY(SELECT AS STRUCT value, count FROM UNNEST(top_hazards)) AS top_hazards
      FROM {T}.evidence_map` ORDER BY cluster_id, region""")
    clusters = _rows(f"""
      SELECT c.cluster_id, c.label, c.sector, c.evidence_focus, c.coherence_guess, c.n_docs,
             q.votes_coherent, q.votes_incoherent
      FROM {T}.cluster_labels` c LEFT JOIN {T}.cluster_coherence` q USING (cluster_id)
      ORDER BY c.n_docs DESC""")
    regions = sorted({c["region"] for c in cells})
    return {"clusters": clusters, "cells": cells, "regions": regions}


def cluster_documents(cluster_id: int, limit: int = 30) -> list[dict[str, Any]]:
    return _rows(f"""
      SELECT dc.doc_id, c.title, c.year, c.region, c.source_type, c.evidence_type,
             ROUND(dc.dist_to_centroid, 4) AS dist_to_centroid
      FROM {T}.doc_clusters` dc JOIN {T}.corpus` c USING (doc_id)
      WHERE dc.cluster_id = @cid ORDER BY dc.dist_to_centroid LIMIT @limit""",
      [_p("cid", "INT64", cluster_id), _p("limit", "INT64", limit)])


# --------------------------------------------------------------------------- gaps
def coverage_gaps() -> dict[str, Any]:
    by_region = _rows(f"SELECT * FROM {T}.gap_by_region` ORDER BY coverage_ratio")
    grid = _rows(f"SELECT * FROM {T}.gap_region_sector`")
    gini = _rows(f"SELECT gini_region FROM {T}.gap_gini`")
    outcomes = _rows(f"SELECT * FROM {T}.adaptation_outcome_summary` ORDER BY n_studies DESC LIMIT 40")
    return {"by_region": by_region, "region_sector": grid,
            "gini_region": gini[0]["gini_region"] if gini else None, "adaptation_outcomes": outcomes}


# --------------------------------------------------------------------------- living evidence
def living_evidence() -> dict[str, Any]:
    alerts = _rows(f"SELECT * FROM {T}.living_evidence_alerts` ORDER BY growth_since_ar6 DESC NULLS LAST")
    history = _rows(f"SELECT cluster_id, EXTRACT(YEAR FROM yr) AS year, n_docs FROM {T}.cluster_yearly` ORDER BY 1, 2")
    forecast = _rows(f"""SELECT cluster_id, EXTRACT(YEAR FROM forecast_timestamp) AS year,
                                ROUND(forecast_value, 1) AS forecast,
                                ROUND(prediction_interval_lower_bound, 1) AS lo,
                                ROUND(prediction_interval_upper_bound, 1) AS hi
                         FROM {T}.cluster_forecast` ORDER BY 1, 2""")
    return {"alerts": alerts, "history": history, "forecast": forecast}


# --------------------------------------------------------------------------- synthesis
def grounded_synthesis(topic: str, region: str | None = None, k: int = 8) -> dict[str, Any]:
    """Calls the BQML stored procedure; returns parsed JSON + the passages used for audit."""
    sql = f"""
      DECLARE result JSON;
      CALL {T}.grounded_synthesis`(@topic, @region, @k, result);
      SELECT TO_JSON_STRING(result) AS result;"""
    rows = _rows(sql, [_p("topic", "STRING", topic), _p("region", "STRING", region), _p("k", "INT64", k)])
    raw = rows[0]["result"] if rows else None
    parsed = json.loads(raw) if raw and raw != "null" else None
    # resolve cited docs so the UI can show titles for provenance checks
    cited = (parsed or {}).get("citations_used") or []
    docs = _rows(f"SELECT doc_id, title, year, region, source_type FROM {T}.corpus` WHERE doc_id IN UNNEST(@ids)",
                 [bigquery.ArrayQueryParameter("ids", "STRING", cited)]) if cited else []
    return {"topic": topic, "region": region, "result": parsed, "cited_documents": docs}


# --------------------------------------------------------------------------- cost
def cost_ledger() -> list[dict[str, Any]]:
    return _rows(f"SELECT * FROM {T}.ml_cost_ledger` ORDER BY day DESC, job_kind")
