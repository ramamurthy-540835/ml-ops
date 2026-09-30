"""
mlops/training.py — stage 4: one config schema, many learning types.

TrainConfig is shared by the Next.js form, the API and this module. `to_sql()` renders BQML
DDL; `run()` executes it (or launches a Vertex tuning job), evaluates, and writes registry rows.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from typing import Any, Literal

from .common import (BUCKET, MLOPS_DS, PROJECT, VERTEX_LOCATION, CONNECTION, bq, dumps, gcs, insert,
                     new_id, now, rows, tbl)
from .dataset import get_dataset
from .labeling import gold_sql, get_task

LearningType = Literal["classification", "regression", "clustering", "dimensionality_reduction",
                       "anomaly_detection", "time_series", "fine_tune"]

MODEL_TYPES: dict[str, list[str]] = {
    "classification": ["LOGISTIC_REG", "BOOSTED_TREE_CLASSIFIER", "DNN_CLASSIFIER", "RANDOM_FOREST_CLASSIFIER", "AUTOML_CLASSIFIER"],
    "regression": ["LINEAR_REG", "BOOSTED_TREE_REGRESSOR", "DNN_REGRESSOR", "RANDOM_FOREST_REGRESSOR", "AUTOML_REGRESSOR"],
    "clustering": ["KMEANS"],
    "dimensionality_reduction": ["PCA"],
    "anomaly_detection": ["AUTOENCODER", "KMEANS"],
    "time_series": ["ARIMA_PLUS", "ARIMA_PLUS_XREG"],
    "fine_tune": ["gemini-2.5-flash", "gemini-2.5-pro"],
}

# Which hyperparameters each model type accepts (exposed as form fields in the UI)
HPARAMS: dict[str, dict[str, Any]] = {
    "LOGISTIC_REG": {"l1_reg": 0.0, "l2_reg": 0.5, "max_iterations": 20, "auto_class_weights": True},
    "LINEAR_REG": {"l1_reg": 0.0, "l2_reg": 0.1, "max_iterations": 20},
    "BOOSTED_TREE_CLASSIFIER": {"max_iterations": 50, "learn_rate": 0.1, "max_tree_depth": 6, "subsample": 0.85, "auto_class_weights": True},
    "BOOSTED_TREE_REGRESSOR": {"max_iterations": 50, "learn_rate": 0.1, "max_tree_depth": 6, "subsample": 0.85},
    "RANDOM_FOREST_CLASSIFIER": {"num_parallel_tree": 100, "max_tree_depth": 10, "subsample": 0.8},
    "RANDOM_FOREST_REGRESSOR": {"num_parallel_tree": 100, "max_tree_depth": 10, "subsample": 0.8},
    "DNN_CLASSIFIER": {"hidden_units": [256, 64], "dropout": 0.2, "learn_rate": 0.001, "max_iterations": 30, "batch_size": 64},
    "DNN_REGRESSOR": {"hidden_units": [256, 64], "dropout": 0.2, "learn_rate": 0.001, "max_iterations": 30, "batch_size": 64},
    "AUTOML_CLASSIFIER": {"budget_hours": 1.0},
    "AUTOML_REGRESSOR": {"budget_hours": 1.0},
    "KMEANS": {"num_clusters": 12, "distance_type": "COSINE", "kmeans_init_method": "KMEANS++", "standardize_features": False},
    "PCA": {"num_principal_components": 32, "scale_features": False},
    "AUTOENCODER": {"hidden_units": [128, 32, 128], "learn_rate": 0.001, "max_iterations": 30, "dropout": 0.1},
    "ARIMA_PLUS": {"data_frequency": "YEARLY", "auto_arima": True, "holiday_region": "NONE", "horizon": 3},
    "ARIMA_PLUS_XREG": {"data_frequency": "YEARLY", "auto_arima": True, "horizon": 3},
    "gemini-2.5-flash": {"epochs": 3, "learning_rate_multiplier": 1.0, "adapter_size": 4},
    "gemini-2.5-pro": {"epochs": 2, "learning_rate_multiplier": 1.0, "adapter_size": 4},
}

# Hyperparameter search space keys allowed per model (BQML HPARAM_RANGE / HPARAM_CANDIDATES)
TUNABLE = {"l1_reg", "l2_reg", "learn_rate", "max_tree_depth", "subsample", "dropout", "num_clusters",
           "batch_size", "hidden_units", "num_parallel_tree", "min_split_loss"}

QUALITY_GATES: dict[str, dict[str, float]] = {  # default thresholds per learning type (editable per run)
    "classification": {"recall": 0.85, "roc_auc": 0.85},
    "regression": {"r2_score": 0.5},
    "clustering": {"davies_bouldin_index_max": 1.5},
    "time_series": {},
    "fine_tune": {},
    "anomaly_detection": {},
    "dimensionality_reduction": {"total_explained_variance_ratio": 0.7},
}


@dataclass
class TrainConfig:
    name: str
    task: str                              # e.g. "screening", "evidence_type", "evidence_map"
    learning_type: LearningType
    model_type: str
    dataset_id: str
    label_task_id: str | None = None       # if set, labels come from labeling gold view instead of a column
    label_col: str | None = "label"
    feature_cols: list[str] = field(default_factory=lambda: ["embedding"])
    exclude_cols: list[str] = field(default_factory=lambda: ["row_id", "split"])
    split_col: str | None = "split"        # uses train rows for fitting, test rows for evaluation
    hparams: dict[str, Any] = field(default_factory=dict)
    search: dict[str, list[Any]] = field(default_factory=dict)   # {"l2_reg": [0.01, 1.0]} → HPARAM_RANGE
    num_trials: int = 0
    time_series: dict[str, str] = field(default_factory=dict)    # {"timestamp_col": "yr", "data_col": "n_docs", "id_col": "cluster_id"}
    gates: dict[str, float] = field(default_factory=dict)
    created_by: str = "ui"
    notes: str = ""

    def validate(self) -> None:
        if self.model_type not in MODEL_TYPES[self.learning_type]:
            raise ValueError(f"{self.model_type} is not a {self.learning_type} model")
        for k in self.search:
            if k not in TUNABLE:
                raise ValueError(f"{k} is not tunable")
        if self.learning_type in ("classification", "regression") and not (self.label_col or self.label_task_id):
            raise ValueError("supervised learning needs label_col or label_task_id")
        if self.learning_type == "time_series" and not self.time_series:
            raise ValueError("time_series needs timestamp_col/data_col")


# ---------------------------------------------------------------------------- SQL rendering
def _lit(v: Any) -> str:
    if isinstance(v, bool): return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)): return str(v)
    if isinstance(v, list): return "[" + ", ".join(_lit(x) for x in v) + "]"
    return f"'{v}'"


def training_data_sql(cfg: TrainConfig, for_eval: bool = False) -> str:
    d = get_dataset(cfg.dataset_id)
    if not d:
        raise ValueError("unknown dataset")
    split_pred = ""
    if cfg.split_col:
        split_pred = f"WHERE d.{cfg.split_col} = '{'test' if for_eval else 'train'}'"
    feats = ", ".join(f"d.{c}" for c in cfg.feature_cols) if cfg.feature_cols else \
        f"d.* EXCEPT({', '.join(cfg.exclude_cols + ([cfg.label_col] if cfg.label_col else []))})"
    if cfg.learning_type in ("classification", "regression"):
        if cfg.label_task_id:
            return f"WITH gold AS ({gold_sql(cfg.label_task_id)}) SELECT {feats}, gold.label AS label FROM `{d['bq_table']}` d JOIN gold USING (row_id) {split_pred}"
        return f"SELECT {feats}, d.{cfg.label_col} AS label FROM `{d['bq_table']}` d {split_pred} AND d.{cfg.label_col} IS NOT NULL".replace("d  AND", "d WHERE") \
            if split_pred else f"SELECT {feats}, d.{cfg.label_col} AS label FROM `{d['bq_table']}` d WHERE d.{cfg.label_col} IS NOT NULL"
    if cfg.learning_type == "time_series":
        ts = cfg.time_series
        cols = [ts["timestamp_col"], ts["data_col"]] + ([ts["id_col"]] if ts.get("id_col") else [])
        return f"SELECT {', '.join('d.' + c for c in cols)} FROM `{d['bq_table']}` d"
    return f"SELECT {feats} FROM `{d['bq_table']}` d"


def to_sql(cfg: TrainConfig, model_fqn: str) -> str:
    cfg.validate()
    opts: dict[str, Any] = {"model_type": cfg.model_type, **HPARAMS.get(cfg.model_type, {}), **cfg.hparams}
    opts.pop("horizon", None)
    if cfg.learning_type in ("classification", "regression"):
        opts["input_label_cols"] = ["label"]
        opts["data_split_method"] = "NO_SPLIT" if cfg.split_col else "AUTO_SPLIT"
        if cfg.model_type.startswith(("LOGISTIC", "LINEAR", "BOOSTED", "DNN", "RANDOM")):
            opts["enable_global_explain"] = True
    if cfg.learning_type == "time_series":
        ts = cfg.time_series
        opts.update(time_series_timestamp_col=ts["timestamp_col"], time_series_data_col=ts["data_col"])
        if ts.get("id_col"): opts["time_series_id_col"] = ts["id_col"]
    if cfg.num_trials and cfg.search:
        opts["num_trials"] = cfg.num_trials
        opts["hparam_tuning_objectives"] = ["roc_auc"] if cfg.learning_type == "classification" else ["r2_score"] if cfg.learning_type == "regression" else ["davies_bouldin_index"]
        for k, rng in cfg.search.items():
            opts.pop(k, None)
            if k == "hidden_units" or isinstance(rng[0], str) or len(rng) != 2:
                opts[k] = f"HPARAM_CANDIDATES([{', '.join(_lit(x) for x in rng)}])"
            else:
                opts[k] = f"HPARAM_RANGE({rng[0]}, {rng[1]})"

    def fmt(k, v):
        return f"  {k} = {v}" if isinstance(v, str) and v.startswith("HPARAM_") else f"  {k} = {_lit(v)}"

    return f"CREATE OR REPLACE MODEL `{model_fqn}`\nOPTIONS (\n" + ",\n".join(fmt(k, v) for k, v in opts.items()) + \
           f"\n) AS\n{training_data_sql(cfg)};"


def eval_sql(cfg: TrainConfig, model_fqn: str) -> str:
    if cfg.learning_type in ("classification", "regression") and cfg.split_col:
        return f"SELECT * FROM ML.EVALUATE(MODEL `{model_fqn}`, ({training_data_sql(cfg, for_eval=True)}))"
    if cfg.learning_type == "time_series":
        return f"SELECT * FROM ML.ARIMA_EVALUATE(MODEL `{model_fqn}`)"
    return f"SELECT * FROM ML.EVALUATE(MODEL `{model_fqn}`)"


# ---------------------------------------------------------------------------- execution
def run(cfg: TrainConfig) -> dict[str, Any]:
    cfg.validate()
    run_id = new_id("run")
    insert("training_runs", {"run_id": run_id, "dataset_id": cfg.dataset_id, "task_id": cfg.label_task_id,
                             "learning_type": cfg.learning_type, "config_json": dumps(asdict(cfg)),
                             "status": "running", "started_at": now(), "created_by": cfg.created_by})
    try:
        if cfg.learning_type == "fine_tune":
            artifact, metrics, sql_text, billed, slot = _run_fine_tune(cfg, run_id)
        else:
            model_fqn = f"{PROJECT}.{MLOPS_DS}.m_{cfg.task}_{run_id}"
            sql_text = to_sql(cfg, model_fqn)
            job = bq().query(sql_text); job.result()
            billed, slot = job.total_bytes_billed or 0, job.slot_millis or 0
            metrics = _collect_metrics(cfg, model_fqn)
            artifact = model_fqn
        _update_run(run_id, status="succeeded", artifact=artifact, sql_text=sql_text, bytes_billed=billed, slot_ms=slot)
        model_id = new_id("mdl")
        insert("models", {"model_id": model_id, "run_id": run_id, "name": cfg.name, "task": cfg.task,
                          "learning_type": cfg.learning_type, "artifact": artifact, "stage": "candidate", "created_at": now()})
        insert("evaluations", {"eval_id": new_id("ev"), "model_id": model_id, "metrics_json": dumps(metrics), "evaluated_at": now()})
        gates = {**QUALITY_GATES.get(cfg.learning_type, {}), **cfg.gates}
        return {"run_id": run_id, "model_id": model_id, "artifact": artifact, "metrics": metrics,
                "gate": check_gates(metrics, gates), "gates": gates}
    except Exception as e:  # record the failure; never leave a run 'running'
        _update_run(run_id, status="failed", error=str(e)[:4000])
        raise


def _collect_metrics(cfg: TrainConfig, model_fqn: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    try:
        ev = rows(eval_sql(cfg, model_fqn))
        out["evaluate"] = ev[0] if len(ev) == 1 else ev
    except Exception as e:
        out["evaluate_error"] = str(e)[:500]
    if cfg.num_trials:
        try: out["trials"] = rows(f"SELECT trial_id, hyperparameters, hparam_tuning_evaluation_metrics, status FROM ML.TRIAL_INFO(MODEL `{model_fqn}`)")
        except Exception as e: out["trials_error"] = str(e)[:500]
    if cfg.learning_type in ("classification", "regression") and cfg.model_type.startswith(("LOGISTIC", "LINEAR", "BOOSTED", "DNN", "RANDOM")):
        try: out["global_explain"] = rows(f"SELECT * FROM ML.GLOBAL_EXPLAIN(MODEL `{model_fqn}`) LIMIT 20")
        except Exception: pass
    if cfg.learning_type == "time_series":
        try: out["forecast"] = rows(f"SELECT * FROM ML.FORECAST(MODEL `{model_fqn}`, STRUCT({cfg.hparams.get('horizon', 3)} AS horizon, 0.8 AS confidence_level))")
        except Exception as e: out["forecast_error"] = str(e)[:500]
    return out


def _run_fine_tune(cfg: TrainConfig, run_id: str):
    """Vertex AI supervised tuning of Gemini from labelled JSONL. Output: tuned endpoint + remote BQML model."""
    import vertexai
    from vertexai.tuning import sft
    d = get_dataset(cfg.dataset_id)
    text_cols = cfg.feature_cols
    if cfg.label_task_id:
        t = get_task(cfg.label_task_id)
        text_cols = json.loads(t["text_fields"])
        src = f"WITH gold AS ({gold_sql(cfg.label_task_id)}) SELECT d.split, {', '.join('d.' + c for c in text_cols)}, gold.label AS target FROM gold JOIN `{d['bq_table']}` d USING (row_id)"
        system = f"Assign `{t['label_field']}` one of: {', '.join(json.loads(t['label_space']))}. Answer with the label only."
    else:
        src = f"SELECT d.split, {', '.join('d.' + c for c in text_cols)}, d.{cfg.label_col} AS target FROM `{d['bq_table']}` d WHERE d.{cfg.label_col} IS NOT NULL"
        system = cfg.notes or "Return the target for the given text."
    recs = rows(src)

    def to_example(r):  # Gemini SFT JSONL format
        text = "\n".join(f"{c}: {r.get(c, '')}" for c in text_cols)
        return dumps({"systemInstruction": {"role": "system", "parts": [{"text": system}]},
                      "contents": [{"role": "user", "parts": [{"text": text}]},
                                   {"role": "model", "parts": [{"text": str(r["target"])}]}]})
    train = "\n".join(to_example(r) for r in recs if r.get("split") != "test") + "\n"
    val = "\n".join(to_example(r) for r in recs if r.get("split") == "test") + "\n"
    b = gcs().bucket(BUCKET)
    b.blob(f"tuning/{run_id}/train.jsonl").upload_from_string(train)
    b.blob(f"tuning/{run_id}/validation.jsonl").upload_from_string(val)

    vertexai.init(project=PROJECT, location=VERTEX_LOCATION)
    hp = {**HPARAMS.get(cfg.model_type, {}), **cfg.hparams}
    job = sft.train(source_model=cfg.model_type, train_dataset=f"gs://{BUCKET}/tuning/{run_id}/train.jsonl",
                    validation_dataset=f"gs://{BUCKET}/tuning/{run_id}/validation.jsonl" if val.strip() else None,
                    epochs=int(hp["epochs"]), learning_rate_multiplier=float(hp["learning_rate_multiplier"]),
                    adapter_size=int(hp["adapter_size"]), tuned_model_display_name=f"{cfg.name}-{run_id}")
    while not job.has_ended:
        import time; time.sleep(30); job.refresh()
    endpoint = job.tuned_model_endpoint_name
    # expose the tuned endpoint to BQML so ML.GENERATE_TEXT can call it like any other model
    remote = f"{PROJECT}.{MLOPS_DS}.m_{cfg.task}_{run_id}"
    sql_text = f"CREATE OR REPLACE MODEL `{remote}` REMOTE WITH CONNECTION `{PROJECT}.{CONNECTION}` OPTIONS (ENDPOINT = '{endpoint}');"
    bq().query(sql_text).result()
    metrics = {"tuning_job": job.resource_name, "endpoint": endpoint, "n_train": train.count("\n"), "n_val": val.count("\n"),
               "state": str(job.state)}
    return remote, metrics, sql_text, 0, 0


def check_gates(metrics: dict[str, Any], gates: dict[str, float]) -> dict[str, Any]:
    ev = metrics.get("evaluate") if isinstance(metrics.get("evaluate"), dict) else {}
    results = {}
    for k, thr in gates.items():
        if k.endswith("_max"):
            v = ev.get(k[:-4]); results[k] = None if v is None else v <= thr
        else:
            v = ev.get(k); results[k] = None if v is None else v >= thr
    return {"passed": all(v for v in results.values() if v is not None) and any(v is not None for v in results.values()) if gates else None, "checks": results}


def _update_run(run_id: str, **fields) -> None:
    sets = ", ".join(f"{k} = @{k}" for k in fields)
    params = dict(fields)
    bq().query(f"UPDATE {tbl('training_runs')} SET {sets}, finished_at = CURRENT_TIMESTAMP() WHERE run_id = @run_id",
               job_config=_cfg({**params, "run_id": run_id})).result()


def _cfg(params):
    from google.cloud import bigquery
    qp = [bigquery.ScalarQueryParameter(k, "INT64" if isinstance(v, int) else "STRING", v) for k, v in params.items()]
    return bigquery.QueryJobConfig(query_parameters=qp)


def catalog() -> dict[str, Any]:
    """Everything the training form needs to render itself."""
    return {"learning_types": list(MODEL_TYPES), "model_types": MODEL_TYPES, "hparams": HPARAMS,
            "tunable": sorted(TUNABLE), "gates": QUALITY_GATES}
