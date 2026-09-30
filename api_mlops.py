"""
api_mlops.py — FastAPI control plane for the MLOps layer. Mount in api.py:
    from api_mlops import router as mlops_router; app.include_router(mlops_router)

Long-running steps (train, pipeline) run in a background thread; the UI polls /mlops/runs/{id}.
"""
from __future__ import annotations

import threading
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from mlops import dataset as ds, labeling as lb, training as tr, registry as rg
from mlops.common import ensure_registry

router = APIRouter(prefix="/mlops", tags=["mlops"])


def _guard(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"backend: {e}") from e


@router.post("/init")
def init():
    _guard(ensure_registry); return {"ok": True}


# ---------------------------------------------------------------- datasets
class DatasetIn(BaseModel):
    name: str = Field(min_length=2, max_length=60, pattern=r"^[a-z0-9_]+$")
    recipe: str | None = None
    sql: str | None = None
    split: bool = True
    notes: str = ""
    created_by: str = "ui"


@router.get("/datasets")
def datasets(): return _guard(ds.list_datasets)

@router.get("/datasets/recipes")
def recipes(): return {"recipes": {k: v.strip() for k, v in ds.RECIPES.items()}}

@router.post("/datasets")
def create_dataset(b: DatasetIn):
    return _guard(ds.build_dataset, b.name, sql=b.sql, recipe=b.recipe, split=b.split, notes=b.notes, created_by=b.created_by)

@router.get("/datasets/{dataset_id}/preview")
def preview(dataset_id: str, n: int = Query(20, le=200)): return _guard(ds.preview, dataset_id, n)


# ---------------------------------------------------------------- labeling
class TaskIn(BaseModel):
    dataset_id: str; label_field: str; label_space: list[str] = Field(min_length=2)
    text_fields: list[str] = Field(min_length=1); instructions: str = ""

class LabelIn(BaseModel):
    row_id: str; label: str; annotator: str = Field(min_length=1); rationale: str | None = None


@router.get("/labels/tasks")
def tasks(): return _guard(lb.list_tasks)

@router.post("/labels/tasks")
def create_task(b: TaskIn): return _guard(lb.create_task, b.dataset_id, b.label_field, b.label_space, b.text_fields, b.instructions)

@router.post("/labels/tasks/{task_id}/prelabel")
def prelabel(task_id: str, limit: int = Query(300, le=5000)): return {"prelabelled": _guard(lb.prelabel, task_id, limit)}

@router.get("/labels/tasks/{task_id}/queue")
def queue(task_id: str, annotator: str, limit: int = Query(25, le=100)): return _guard(lb.queue, task_id, annotator, limit)

@router.post("/labels/tasks/{task_id}/labels")
def submit(task_id: str, b: LabelIn): return _guard(lb.submit, task_id, b.row_id, b.label, b.annotator, b.rationale)

@router.get("/labels/tasks/{task_id}/progress")
def progress(task_id: str): return {**_guard(lb.progress, task_id), "agreement": _guard(lb.agreement, task_id)}

@router.post("/labels/tasks/{task_id}/export")
def export(task_id: str): return {"gcs_uri": _guard(lb.export, task_id)}


# ---------------------------------------------------------------- training
class TrainIn(BaseModel):
    name: str; task: str; learning_type: str; model_type: str; dataset_id: str
    label_task_id: str | None = None; label_col: str | None = "label"
    feature_cols: list[str] = ["embedding"]; exclude_cols: list[str] = ["row_id", "split"]; split_col: str | None = "split"
    hparams: dict[str, Any] = {}; search: dict[str, list[Any]] = {}; num_trials: int = 0
    time_series: dict[str, str] = {}; gates: dict[str, float] = {}; created_by: str = "ui"; notes: str = ""


@router.get("/catalog")
def catalog(): return tr.catalog()

@router.post("/train/preview-sql")
def preview_sql(b: TrainIn):
    cfg = tr.TrainConfig(**b.model_dump())
    if cfg.learning_type == "fine_tune":
        return {"sql": "(fine-tuning runs on Vertex AI; a remote BQML model is created from the tuned endpoint)"}
    return {"sql": _guard(tr.to_sql, cfg, f"<project>.<mlops_dataset>.m_{cfg.task}_<run_id>")}

@router.post("/train")
def train(b: TrainIn):
    cfg = tr.TrainConfig(**b.model_dump()); _guard(cfg.validate)
    holder: dict[str, Any] = {}
    # start synchronously enough to get a run_id, then continue in a thread
    def work():
        try: holder["result"] = tr.run(cfg)
        except Exception as e: holder["error"] = str(e)
    threading.Thread(target=work, daemon=True).start()
    import time; time.sleep(1.5)
    runs = rg.list_runs(1)
    return {"queued": True, "run": runs[0] if runs else None}

@router.get("/runs")
def runs(limit: int = Query(50, le=200)): return _guard(rg.list_runs, limit)

@router.get("/runs/{run_id}")
def run(run_id: str):
    r = _guard(rg.get_run, run_id)
    if not r: raise HTTPException(404, "unknown run")
    return r


# ---------------------------------------------------------------- registry
class PromoteIn(BaseModel):
    to_stage: str; actor: str = Field(min_length=1); reason: str = Field(min_length=3)

@router.get("/models")
def models(task: str | None = None): return _guard(rg.list_models, task)

@router.post("/models/{model_id}/promote")
def promote(model_id: str, b: PromoteIn): return _guard(rg.promote, model_id, b.to_stage, b.actor, b.reason)

@router.get("/production/{task}")
def production(task: str): return _guard(rg.production, task) or {}

@router.get("/monitoring")
def monitoring(task: str = "screening"): return _guard(rg.monitoring, task)


# ---------------------------------------------------------------- pipeline
class PipelineIn(BaseModel):
    name: str; dataset: dict[str, Any] | None = None; dataset_id: str | None = None
    label: dict[str, Any] | None = None; train: dict[str, Any] | None = None
    promote_to: str | None = None; actor: str = "ui"

@router.post("/pipeline")
def pipeline(b: PipelineIn):
    spec = rg.PipelineSpec(**b.model_dump())
    threading.Thread(target=lambda: rg.run_pipeline(spec), daemon=True).start()
    return {"queued": True}

@router.get("/pipeline/runs")
def pipeline_runs(limit: int = Query(20, le=100)): return _guard(rg.list_pipeline_runs, limit)
