"""
mlops/registry.py — stage 5: models, evaluations, promotion, monitoring.
mlops.pipeline (bottom of file) — runs the stages end to end from a PipelineSpec.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

from .common import MLOPS_DS, PROJECT, bq, dumps, insert, new_id, now, rows, tbl, ensure_registry
from . import dataset as ds, labeling as lb, training as tr

STAGES = ["candidate", "staging", "production", "retired"]


def list_models(task: str | None = None) -> list[dict[str, Any]]:
    where = "WHERE m.task = @task" if task else ""
    return rows(f"""
      SELECT m.*, r.dataset_id, r.config_json, r.bytes_billed, r.slot_ms,
             (SELECT metrics_json FROM {tbl('evaluations')} e WHERE e.model_id = m.model_id ORDER BY evaluated_at DESC LIMIT 1) AS metrics_json
      FROM {tbl('models')} m LEFT JOIN {tbl('training_runs')} r USING (run_id) {where}
      ORDER BY m.created_at DESC""", {"task": task} if task else {})


def list_runs(limit: int = 50) -> list[dict[str, Any]]:
    return rows(f"SELECT * EXCEPT(sql_text) FROM {tbl('training_runs')} ORDER BY started_at DESC LIMIT @n", {"n": limit})


def get_run(run_id: str) -> dict[str, Any] | None:
    r = rows(f"SELECT * FROM {tbl('training_runs')} WHERE run_id = @id", {"id": run_id})
    return r[0] if r else None


def promote(model_id: str, to_stage: str, actor: str, reason: str) -> dict[str, Any]:
    if to_stage not in STAGES:
        raise ValueError("bad stage")
    m = rows(f"SELECT * FROM {tbl('models')} WHERE model_id = @id", {"id": model_id})
    if not m:
        raise ValueError("unknown model")
    m = m[0]
    if to_stage in ("staging", "production"):
        ev = rows(f"SELECT 1 FROM {tbl('evaluations')} WHERE model_id = @id LIMIT 1", {"id": model_id})
        if not ev:
            raise ValueError("a model needs an evaluation before staging/production")
    if not reason.strip():
        raise ValueError("a promotion needs a written reason")

    if to_stage == "production":
        # demote current production for the same task, then repoint the alias view
        bq().query(f"UPDATE {tbl('models')} SET stage = 'staging' WHERE task = @task AND stage = 'production' AND model_id != @id",
                   job_config=_p({"task": m["task"], "id": model_id})).result()
        alias = f"{PROJECT}.{MLOPS_DS}.prod_{m['task']}"
        bq().query(f"""CREATE OR REPLACE VIEW `{alias}` AS
                       SELECT '{m['artifact']}' AS model_fqn, '{model_id}' AS model_id, '{m['learning_type']}' AS learning_type,
                              CURRENT_TIMESTAMP() AS resolved_at""").result()
    bq().query(f"UPDATE {tbl('models')} SET stage = @stage WHERE model_id = @id", job_config=_p({"stage": to_stage, "id": model_id})).result()
    rec = {"promotion_id": new_id("pr"), "model_id": model_id, "from_stage": m["stage"], "to_stage": to_stage,
           "reason": reason, "actor": actor, "promoted_at": now()}
    insert("promotions", rec)
    return rec


def production(task: str) -> dict[str, Any] | None:
    try:
        r = rows(f"SELECT * FROM `{PROJECT}.{MLOPS_DS}.prod_{task}`")
        return r[0] if r else None
    except Exception:
        return None


def predict_sql(task: str, input_sql: str) -> str:
    """Application code calls this: prediction against whatever is in production for the task."""
    p = production(task)
    if not p:
        raise ValueError(f"no production model for task {task}")
    return f"SELECT * FROM ML.PREDICT(MODEL `{p['model_fqn']}`, ({input_sql}))"


def monitoring(task: str = "screening") -> dict[str, Any]:
    """Drift (PSI of P(relevant) vs training-time), human override rate, LLM agreement, cost."""
    out: dict[str, Any] = {"task": task}
    try:
        out["override_rate"] = rows(f"""
          SELECT COUNTIF((d.decision_type = 'screen_include' AND s.p_relevant < 0.5) OR (d.decision_type = 'screen_exclude' AND s.p_relevant >= 0.5)) / COUNT(*) AS override_rate,
                 COUNT(*) AS n_decisions
          FROM `{PROJECT}.climate_ai.reviewer_decisions` d JOIN `{PROJECT}.climate_ai.screening_predictions` s USING (doc_id)
          WHERE d.decision_type LIKE 'screen_%'""")[0]
    except Exception as e:
        out["override_rate_error"] = str(e)[:300]
    try:
        out["score_histogram"] = rows(f"""
          SELECT FLOOR(p_relevant * 10) / 10 AS bucket, COUNT(*) AS n
          FROM `{PROJECT}.climate_ai.screening_predictions` GROUP BY 1 ORDER BY 1""")
    except Exception as e:
        out["score_histogram_error"] = str(e)[:300]
    try:
        out["llm_agreement"] = rows(f"SELECT * FROM `{PROJECT}.climate_ai.screening_agreement`")[0]
    except Exception:
        pass
    out["cost"] = rows(f"SELECT learning_type, COUNT(*) AS n_runs, SUM(bytes_billed)/POW(1024,3) AS gb, SUM(slot_ms)/3.6e6 AS slot_hours FROM {tbl('training_runs')} GROUP BY 1")
    return out


def _p(params):
    from google.cloud import bigquery
    return bigquery.QueryJobConfig(query_parameters=[bigquery.ScalarQueryParameter(k, "STRING", v) for k, v in params.items()])


# =============================================================================== pipeline
@dataclass
class PipelineSpec:
    """A whole loop, declarative. Any stage can be skipped by leaving its block None."""
    name: str
    dataset: dict[str, Any] | None = None       # {"name": "screening", "recipe": "screening"} or {"sql": ...}
    dataset_id: str | None = None               # reuse an existing dataset instead
    label: dict[str, Any] | None = None         # {"label_field": "label", "label_space": ["0","1"], "text_fields": ["title","abstract"], "prelabel_limit": 500}
    train: dict[str, Any] | None = None         # TrainConfig fields minus dataset_id/label_task_id
    promote_to: str | None = None               # "staging" | "production" if gates pass
    actor: str = "pipeline"


def run_pipeline(spec: PipelineSpec) -> dict[str, Any]:
    ensure_registry()
    prid = new_id("pipe"); log: list[str] = []
    insert("pipeline_runs", {"pipeline_run_id": prid, "spec_json": dumps(asdict(spec)), "stage": "start", "status": "running", "log": "", "started_at": now()})
    result: dict[str, Any] = {"pipeline_run_id": prid}

    def step(stage: str, fn):
        _stage(prid, stage, "running", log)
        try:
            out = fn(); log.append(f"{stage}: ok"); _stage(prid, stage, "running", log); return out
        except Exception as e:
            log.append(f"{stage}: FAILED {e}"); _stage(prid, stage, "failed", log, done=True); raise

    dataset_id = spec.dataset_id
    if spec.dataset:
        d = step("dataset", lambda: ds.build_dataset(created_by=spec.actor, **spec.dataset)); dataset_id = d["dataset_id"]; result["dataset"] = d
    task_id = None
    if spec.label:
        L = dict(spec.label); n_pre = L.pop("prelabel_limit", 300)
        t = step("label.create", lambda: lb.create_task(dataset_id, **L)); task_id = t["task_id"]; result["label_task"] = t
        result["prelabelled"] = step("label.prelabel", lambda: lb.prelabel(task_id, n_pre))
    if spec.train:
        cfg = tr.TrainConfig(dataset_id=dataset_id, label_task_id=task_id, created_by=spec.actor, **spec.train)
        result["train"] = step("train", lambda: tr.run(cfg))
        if spec.promote_to and result["train"]["gate"]["passed"]:
            result["promotion"] = step("promote", lambda: promote(result["train"]["model_id"], spec.promote_to, spec.actor,
                                                                   f"auto: gates passed {result['train']['gate']['checks']}"))
        elif spec.promote_to:
            log.append("promote: skipped, quality gate not passed")
    _stage(prid, "done", "succeeded", log, done=True)
    result["log"] = log
    return result


def _stage(prid: str, stage: str, status: str, log: list[str], done: bool = False) -> None:
    fin = ", finished_at = CURRENT_TIMESTAMP()" if done else ""
    bq().query(f"UPDATE {tbl('pipeline_runs')} SET stage = @stage, status = @status, log = @log {fin} WHERE pipeline_run_id = @id",
               job_config=_p({"stage": stage, "status": status, "log": "\n".join(log), "id": prid})).result()


def list_pipeline_runs(limit: int = 20) -> list[dict[str, Any]]:
    return rows(f"SELECT * FROM {tbl('pipeline_runs')} ORDER BY started_at DESC LIMIT @n", {"n": limit})
