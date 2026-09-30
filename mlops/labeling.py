"""
mlops/labeling.py — stage 2: labeling with a human in the loop.

  create_task()   define what to label (field, label space, text fields, instructions)
  prelabel()      Gemini via ML.GENERATE_TEXT proposes a label + confidence + rationale (source='llm')
  queue()         rows to label next, ordered by uncertainty (active learning) — human labels first
  submit()        record a human label (source='human'); a row may have several annotators
  gold_view()     majority-vote human labels (fallback: llm label above a confidence floor)
  export()        gold labels → gs://…/labels/<task_id>/labels.jsonl (input to fine-tuning)
  agreement()     inter-annotator + human↔llm agreement
"""
from __future__ import annotations

import json
import tempfile
from typing import Any

from .common import BUCKET, MLOPS_DS, PROJECT, TEXT_MODEL, bq, dumps, gcs, insert, new_id, now, rows, tbl
from .dataset import get_dataset

PRELABEL_PROMPT = (
    "You are pre-labelling rows for a human annotator working on an IPCC WGII evidence-synthesis dataset. "
    "Task: assign the field `{label_field}` one value from this label space: {label_space}. "
    "Instructions from the task owner: {instructions} "
    "Use only the text given. If the text does not support any label, choose the label the owner designated as fallback "
    "or, if none, the most conservative label. Return ONLY JSON: "
    '{{"label": "<one value from the label space>", "confidence": <0.0-1.0>, '
    '"rationale": "<one sentence quoting at most 12 words from the text>"}}\n\nText:\n'
)


def create_task(dataset_id: str, label_field: str, label_space: list[str], text_fields: list[str],
                instructions: str = "") -> dict[str, Any]:
    if not get_dataset(dataset_id):
        raise ValueError("unknown dataset")
    task = {"task_id": new_id("lt"), "dataset_id": dataset_id, "label_field": label_field,
            "label_space": dumps(label_space), "text_fields": dumps(text_fields),
            "instructions": instructions, "status": "open", "created_at": now()}
    insert("label_tasks", task)
    return task


def get_task(task_id: str) -> dict[str, Any]:
    r = rows(f"SELECT * FROM {tbl('label_tasks')} WHERE task_id = @id", {"id": task_id})
    if not r:
        raise ValueError("unknown task")
    return r[0]


def prelabel(task_id: str, limit: int = 500) -> int:
    """Gemini pre-labels rows that have no label yet. Runs entirely inside BigQuery."""
    t = get_task(task_id); d = get_dataset(t["dataset_id"])
    text_fields = json.loads(t["text_fields"]); label_space = json.loads(t["label_space"])
    text_expr = " || '\\n' || ".join(f"COALESCE(CAST({f} AS STRING), '')" for f in text_fields)
    prompt = PRELABEL_PROMPT.format(label_field=t["label_field"], label_space=", ".join(label_space),
                                    instructions=t["instructions"] or "none").replace("'", "\\'")
    sql = f"""
      INSERT INTO {tbl('labels')} (label_id, task_id, row_id, label, source, annotator, confidence, rationale, labeled_at)
      WITH todo AS (
        SELECT d.row_id, {text_expr} AS text
        FROM `{d['bq_table']}` d
        LEFT JOIN (SELECT DISTINCT row_id FROM {tbl('labels')} WHERE task_id = @task) l USING (row_id)
        WHERE l.row_id IS NULL LIMIT @limit),
      gen AS (
        SELECT row_id, SAFE.PARSE_JSON(REGEXP_REPLACE(ml_generate_text_llm_result, r'```json|```', '')) AS j
        FROM ML.GENERATE_TEXT({TEXT_MODEL},
          (SELECT row_id, CONCAT('{prompt}', text) AS prompt FROM todo),
          STRUCT(0.0 AS temperature, 200 AS max_output_tokens, TRUE AS flatten_json_output)))
      SELECT GENERATE_UUID(), @task, row_id, JSON_VALUE(j, '$.label'), 'llm', 'gemini_text',
             SAFE_CAST(JSON_VALUE(j, '$.confidence') AS FLOAT64), JSON_VALUE(j, '$.rationale'), CURRENT_TIMESTAMP()
      FROM gen WHERE JSON_VALUE(j, '$.label') IN UNNEST(@space)"""
    job = bq().query(sql, job_config=_cfg({"task": task_id, "limit": limit, "space": label_space}))
    job.result()
    return job.num_dml_affected_rows or 0


def queue(task_id: str, annotator: str, limit: int = 25) -> list[dict[str, Any]]:
    """Rows the annotator has not labelled, most uncertain LLM pre-label first (active learning)."""
    t = get_task(task_id); d = get_dataset(t["dataset_id"])
    text_fields = json.loads(t["text_fields"])
    cols = ", ".join(f"d.{f}" for f in text_fields)
    return rows(f"""
      WITH mine AS (SELECT row_id FROM {tbl('labels')} WHERE task_id = @task AND source = 'human' AND annotator = @ann),
      llm AS (SELECT row_id, ANY_VALUE(label) AS llm_label, ANY_VALUE(confidence) AS llm_conf, ANY_VALUE(rationale) AS llm_rationale
              FROM {tbl('labels')} WHERE task_id = @task AND source = 'llm' GROUP BY row_id),
      n_human AS (SELECT row_id, COUNT(*) AS n FROM {tbl('labels')} WHERE task_id = @task AND source = 'human' GROUP BY row_id)
      SELECT d.row_id, {cols}, llm.llm_label, llm.llm_conf, llm.llm_rationale, COALESCE(n_human.n, 0) AS n_human_labels
      FROM `{d['bq_table']}` d
      LEFT JOIN mine USING (row_id) LEFT JOIN llm USING (row_id) LEFT JOIN n_human USING (row_id)
      WHERE mine.row_id IS NULL
      ORDER BY COALESCE(n_human.n, 0), ABS(COALESCE(llm.llm_conf, 0.5) - 0.5), RAND()
      LIMIT @limit""", {"task": task_id, "ann": annotator, "limit": limit})


def submit(task_id: str, row_id: str, label: str, annotator: str, rationale: str | None = None) -> dict[str, Any]:
    t = get_task(task_id)
    if label not in json.loads(t["label_space"]):
        raise ValueError(f"label {label!r} not in label space")
    row = {"label_id": new_id("lb"), "task_id": task_id, "row_id": row_id, "label": label, "source": "human",
           "annotator": annotator, "confidence": 1.0, "rationale": rationale, "labeled_at": now()}
    insert("labels", row)
    return row


def gold_sql(task_id: str, llm_floor: float = 0.9) -> str:
    """Majority vote of human labels; falls back to confident LLM labels so training can start early."""
    return f"""
      WITH h AS (
        SELECT row_id, label, COUNT(*) AS n FROM {tbl('labels')}
        WHERE task_id = '{task_id}' AND source = 'human' GROUP BY 1, 2),
      hv AS (SELECT row_id, ARRAY_AGG(label ORDER BY n DESC LIMIT 1)[OFFSET(0)] AS label, 'human' AS gold_source FROM h GROUP BY row_id),
      l AS (SELECT row_id, ANY_VALUE(label) AS label, 'llm' AS gold_source FROM {tbl('labels')}
            WHERE task_id = '{task_id}' AND source = 'llm' AND confidence >= {llm_floor} GROUP BY row_id)
      SELECT * FROM hv UNION ALL SELECT * FROM l WHERE row_id NOT IN (SELECT row_id FROM hv)"""


def progress(task_id: str) -> dict[str, Any]:
    t = get_task(task_id); d = get_dataset(t["dataset_id"])
    r = rows(f"""
      SELECT (SELECT COUNT(*) FROM `{d['bq_table']}`) AS n_rows,
             COUNT(DISTINCT IF(source = 'human', row_id, NULL)) AS n_human_rows,
             COUNT(DISTINCT IF(source = 'llm', row_id, NULL)) AS n_llm_rows,
             COUNT(DISTINCT IF(source = 'human', annotator, NULL)) AS n_annotators
      FROM {tbl('labels')} WHERE task_id = @task""", {"task": task_id})
    dist = rows(f"SELECT label, source, COUNT(*) AS n FROM {tbl('labels')} WHERE task_id = @task GROUP BY 1, 2", {"task": task_id})
    return {**(r[0] if r else {}), "distribution": dist}


def agreement(task_id: str) -> dict[str, Any]:
    r = rows(f"""
      WITH gold AS ({gold_sql(task_id, 2.0)}),   -- humans only
      llm AS (SELECT row_id, ANY_VALUE(label) AS label FROM {tbl('labels')} WHERE task_id = @task AND source = 'llm' GROUP BY row_id),
      pairs AS (
        SELECT a.row_id, a.label = b.label AS agree
        FROM {tbl('labels')} a JOIN {tbl('labels')} b USING (task_id, row_id)
        WHERE a.task_id = @task AND a.source = 'human' AND b.source = 'human' AND a.annotator < b.annotator)
      SELECT (SELECT AVG(CAST(agree AS INT64)) FROM pairs) AS human_human_agreement,
             (SELECT COUNT(*) FROM pairs) AS n_double_labelled,
             (SELECT AVG(CAST(g.label = l.label AS INT64)) FROM gold g JOIN llm l USING (row_id)) AS human_llm_agreement""",
      {"task": task_id})
    return r[0] if r else {}


def export(task_id: str) -> str:
    """Gold labels + text → JSONL in GCS (used by fine-tuning and as an audit artefact)."""
    t = get_task(task_id); d = get_dataset(t["dataset_id"])
    text_fields = json.loads(t["text_fields"]); cols = ", ".join(f"d.{f}" for f in text_fields)
    recs = rows(f"WITH gold AS ({gold_sql(task_id)}) SELECT d.row_id, {cols}, gold.label, gold.gold_source FROM gold JOIN `{d['bq_table']}` d USING (row_id)")
    uri = f"labels/{task_id}/labels.jsonl"
    gcs().bucket(BUCKET).blob(uri).upload_from_string("\n".join(dumps(r) for r in recs) + "\n", content_type="application/jsonl")
    return f"gs://{BUCKET}/{uri}"


def list_tasks() -> list[dict[str, Any]]:
    return rows(f"""SELECT t.*, ds.name AS dataset_name, ds.version AS dataset_version
                    FROM {tbl('label_tasks')} t JOIN {tbl('datasets')} ds USING (dataset_id) ORDER BY t.created_at DESC""")


def _cfg(params: dict[str, Any]):
    from google.cloud import bigquery
    qp = []
    for k, v in params.items():
        if isinstance(v, list): qp.append(bigquery.ArrayQueryParameter(k, "STRING", v))
        elif isinstance(v, int): qp.append(bigquery.ScalarQueryParameter(k, "INT64", v))
        else: qp.append(bigquery.ScalarQueryParameter(k, "STRING", v))
    return bigquery.QueryJobConfig(query_parameters=qp)
