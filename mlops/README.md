# mlops/ — quick start

```bash
pip install -r requirements.ml.txt
export $(grep -v '^#' .env.additions | xargs)

# 0. registry tables + versioned bucket (idempotent)
python -c "from mlops.common import ensure_registry; ensure_registry()"

# 1. dataset (JSONL → GCS → BigQuery → registry)
python -m mlops.dataset build --name screening --recipe screening --notes "first version from synthetic corpus"

# 2. labeling (from API/UI or Python)
python - <<'PY'
from mlops import labeling as lb, dataset as ds
d = ds.list_datasets()[0]
t = lb.create_task(d["dataset_id"], "label", ["0","1"], ["title","abstract"], "1 if impacts/vulnerability/adaptation, else 0")
print("prelabelled", lb.prelabel(t["task_id"], 300))
PY

# 3. training run from a config
python - <<'PY'
from mlops import training as tr, dataset as ds
cfg = tr.TrainConfig(name="screening-lr", task="screening", learning_type="classification", model_type="LOGISTIC_REG",
                     dataset_id=ds.list_datasets()[0]["dataset_id"], search={"l2_reg":[0.01,1.0]}, num_trials=8)
print(tr.to_sql(cfg, "ai-ippc.climate_ai_mlops.m_screening_preview"))   # inspect first
print(tr.run(cfg))
PY

# 4. whole loop
python - <<'PY'
from mlops.registry import PipelineSpec, run_pipeline
print(run_pipeline(PipelineSpec(name="loop", dataset={"name":"screening","recipe":"screening"},
      label={"label_field":"label","label_space":["0","1"],"text_fields":["title","abstract"],"prelabel_limit":200},
      train={"name":"screening-lr","task":"screening","learning_type":"classification","model_type":"LOGISTIC_REG"},
      promote_to="staging")))
PY
```

Mount both routers in `api.py`:
```python
from api_ml import router as ml_router
from api_mlops import router as mlops_router
app.include_router(ml_router); app.include_router(mlops_router)
```
Cloud Run job for nightly retraining: `gcloud run jobs create climate-mlops --image <api image> --command python --args "-m,mlops.registry"` with a small `__main__` that calls `run_pipeline` from a spec in GCS, scheduled by Cloud Scheduler.
