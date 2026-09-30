"""mlops/common.py — settings, registry table schemas and small BigQuery helpers."""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

from google.cloud import bigquery, storage

PROJECT = os.getenv("BQ_PROJECT", "ai-ippc")
LOCATION = os.getenv("BQ_LOCATION", "US")
DATA_DS = os.getenv("BQ_DATASET", "climate_ai")           # application data (corpus etc.)
MLOPS_DS = os.getenv("BQ_MLOPS_DATASET", "climate_ai_mlops")
BUCKET = os.getenv("MLOPS_BUCKET", "ai-ippc-climate-mlops")
CONNECTION = os.getenv("BQ_CONNECTION", "us.vertex-ai")
TEXT_MODEL = f"`{PROJECT}.{DATA_DS}.gemini_text`"
VERTEX_LOCATION = os.getenv("VERTEX_LOCATION", "us-central1")

REGISTRY_SCHEMAS: dict[str, list[tuple]] = {
    "datasets": [("dataset_id", "STRING", "REQUIRED"), ("name", "STRING"), ("version", "INT64"), ("gcs_uri", "STRING"),
                 ("bq_table", "STRING"), ("schema_json", "STRING"), ("n_rows", "INT64"), ("content_hash", "STRING"),
                 ("source_sql", "STRING"), ("created_by", "STRING"), ("created_at", "TIMESTAMP"), ("notes", "STRING")],
    "label_tasks": [("task_id", "STRING", "REQUIRED"), ("dataset_id", "STRING"), ("label_field", "STRING"),
                    ("label_space", "STRING"), ("text_fields", "STRING"), ("instructions", "STRING"),
                    ("status", "STRING"), ("created_at", "TIMESTAMP")],
    "labels": [("label_id", "STRING", "REQUIRED"), ("task_id", "STRING"), ("row_id", "STRING"), ("label", "STRING"),
               ("source", "STRING"), ("annotator", "STRING"), ("confidence", "FLOAT64"), ("rationale", "STRING"),
               ("labeled_at", "TIMESTAMP")],
    "training_runs": [("run_id", "STRING", "REQUIRED"), ("dataset_id", "STRING"), ("task_id", "STRING"),
                      ("learning_type", "STRING"), ("config_json", "STRING"), ("status", "STRING"),
                      ("artifact", "STRING"), ("sql_text", "STRING"), ("bytes_billed", "INT64"), ("slot_ms", "INT64"),
                      ("started_at", "TIMESTAMP"), ("finished_at", "TIMESTAMP"), ("error", "STRING"), ("created_by", "STRING")],
    "models": [("model_id", "STRING", "REQUIRED"), ("run_id", "STRING"), ("name", "STRING"), ("task", "STRING"),
               ("learning_type", "STRING"), ("artifact", "STRING"), ("stage", "STRING"), ("created_at", "TIMESTAMP")],
    "evaluations": [("eval_id", "STRING", "REQUIRED"), ("model_id", "STRING"), ("metrics_json", "STRING"),
                    ("evaluated_at", "TIMESTAMP")],
    "promotions": [("promotion_id", "STRING", "REQUIRED"), ("model_id", "STRING"), ("from_stage", "STRING"),
                   ("to_stage", "STRING"), ("reason", "STRING"), ("actor", "STRING"), ("promoted_at", "TIMESTAMP")],
    "pipeline_runs": [("pipeline_run_id", "STRING", "REQUIRED"), ("spec_json", "STRING"), ("stage", "STRING"),
                      ("status", "STRING"), ("log", "STRING"), ("started_at", "TIMESTAMP"), ("finished_at", "TIMESTAMP")],
}


@lru_cache(maxsize=1)
def bq() -> bigquery.Client:
    return bigquery.Client(project=PROJECT, location=LOCATION)


@lru_cache(maxsize=1)
def gcs() -> storage.Client:
    return storage.Client(project=PROJECT)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def tbl(name: str) -> str:
    return f"`{PROJECT}.{MLOPS_DS}.{name}`"


def rows(sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    qp = []
    for k, v in (params or {}).items():
        if isinstance(v, list):
            qp.append(bigquery.ArrayQueryParameter(k, "STRING", v))
        else:
            t = "INT64" if isinstance(v, int) and not isinstance(v, bool) else "FLOAT64" if isinstance(v, float) else "BOOL" if isinstance(v, bool) else "STRING"
            qp.append(bigquery.ScalarQueryParameter(k, t, v))
    job = bq().query(sql, job_config=bigquery.QueryJobConfig(query_parameters=qp))
    return [dict(r) for r in job.result()]


def insert(table: str, row: dict[str, Any]) -> None:
    errs = bq().insert_rows_json(f"{PROJECT}.{MLOPS_DS}.{table}", [row])
    if errs:
        raise RuntimeError(f"insert into {table} failed: {errs}")


def ensure_registry() -> None:
    """Idempotent: create MLOps dataset + registry tables."""
    bq().create_dataset(bigquery.Dataset(f"{PROJECT}.{MLOPS_DS}"), exists_ok=True)
    for name, cols in REGISTRY_SCHEMAS.items():
        schema = [bigquery.SchemaField(c[0], c[1], mode=c[2] if len(c) > 2 else "NULLABLE") for c in cols]
        bq().create_table(bigquery.Table(f"{PROJECT}.{MLOPS_DS}.{name}", schema=schema), exists_ok=True)
    gcs().create_bucket(BUCKET, location=LOCATION) if not gcs().lookup_bucket(BUCKET) else None
    b = gcs().bucket(BUCKET)
    if not b.versioning_enabled:
        b.versioning_enabled = True
        b.patch()


def dumps(o: Any) -> str:
    return json.dumps(o, ensure_ascii=False, default=str)
