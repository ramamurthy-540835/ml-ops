"""
mlops/dataset.py — stage 1 + 3: build a JSONL dataset, store it in GCS, load it into BigQuery,
register it. A dataset is `name@vN`; versions are immutable.

CLI:
  python -m mlops.dataset build --name screening --sql "SELECT ... " --split
  python -m mlops.dataset build --name screening --from-jsonl data/synthetic/documents.jsonl
  python -m mlops.dataset list
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import tempfile
from pathlib import Path
from typing import Any, Iterable

from google.cloud import bigquery

from .common import BUCKET, MLOPS_DS, PROJECT, bq, dumps, gcs, insert, new_id, now, rows, tbl

# Built-in dataset recipes: the SQL that produces training rows from the application tables.
RECIPES: dict[str, str] = {
    "screening": f"""
        SELECT c.doc_id AS row_id, c.title, c.abstract, c.year, c.region, c.language, c.source_type,
               e.embedding, CAST(AVG(l.label) >= 0.5 AS INT64) AS label
        FROM `{PROJECT}.climate_ai.corpus` c
        JOIN `{PROJECT}.climate_ai.corpus_embeddings` e USING (doc_id)
        LEFT JOIN `{PROJECT}.climate_ai.screening_labels` l USING (doc_id)
        GROUP BY 1,2,3,4,5,6,7,8""",
    "evidence_type": f"""
        SELECT doc_id AS row_id, title, abstract, region, sector, hazard, e.embedding, evidence_type AS label
        FROM `{PROJECT}.climate_ai.corpus` JOIN `{PROJECT}.climate_ai.corpus_embeddings` e USING (doc_id)
        WHERE evidence_type IS NOT NULL""",
    "credibility_regression": f"""
        SELECT doc_id AS row_id, source_type, language, year, n_pages, e.embedding, credibility_score AS label
        FROM `{PROJECT}.climate_ai.corpus` JOIN `{PROJECT}.climate_ai.corpus_embeddings` e USING (doc_id)
        WHERE credibility_score IS NOT NULL""",
    "embeddings_unsupervised": f"""
        SELECT doc_id AS row_id, e.embedding
        FROM `{PROJECT}.climate_ai.corpus_embeddings` e""",
    "cluster_volume_ts": f"""
        SELECT CONCAT(cluster_id, '-', yr) AS row_id, cluster_id, yr, n_docs
        FROM `{PROJECT}.climate_ai.cluster_yearly`""",
    "metadata_extraction_tuning": f"""
        SELECT doc_id AS row_id, title, abstract,
               TO_JSON_STRING(STRUCT(region, country, sector, hazard, evidence_type, adaptation_type,
                                     outcome_reported, confidence_language)) AS target_json
        FROM `{PROJECT}.climate_ai.corpus` WHERE provenance = 'synthetic' AND evidence_type != 'off_topic'""",
}


def _hash(lines: Iterable[str]) -> str:
    h = hashlib.sha256()
    for ln in lines:
        h.update(ln.encode("utf-8"))
    return h.hexdigest()[:16]


def _infer_schema(sample: dict[str, Any]) -> list[dict[str, str]]:
    def t(v):
        if isinstance(v, bool): return "BOOL"
        if isinstance(v, int): return "INT64"
        if isinstance(v, float): return "FLOAT64"
        if isinstance(v, list): return "FLOAT64[]" if v and isinstance(v[0], (int, float)) else "STRING[]"
        return "STRING"
    return [{"name": k, "type": t(v)} for k, v in sample.items()]


def _bq_schema(schema: list[dict[str, str]]) -> list[bigquery.SchemaField]:
    out = []
    for c in schema:
        if c["type"].endswith("[]"):
            out.append(bigquery.SchemaField(c["name"], c["type"][:-2], mode="REPEATED"))
        else:
            out.append(bigquery.SchemaField(c["name"], c["type"], mode="NULLABLE"))
    return out


def next_version(name: str) -> int:
    r = rows(f"SELECT COALESCE(MAX(version), 0) + 1 AS v FROM {tbl('datasets')} WHERE name = @name", {"name": name})
    return int(r[0]["v"]) if r else 1


def build_dataset(name: str, *, sql: str | None = None, from_jsonl: str | None = None, recipe: str | None = None,
                  split: bool = True, split_fracs=(0.7, 0.15, 0.15), seed: int = 7, created_by: str = "cli",
                  notes: str = "") -> dict[str, Any]:
    """Materialise rows → JSONL (+ optional split column) → GCS → BigQuery → registry row."""
    if recipe:
        sql = RECIPES[recipe]
    if not sql and not from_jsonl:
        raise ValueError("provide sql, recipe or from_jsonl")

    if sql:
        records = [dict(r) for r in bq().query(sql).result()]
    else:
        records = [json.loads(l) for l in Path(from_jsonl).read_text(encoding="utf-8").splitlines() if l.strip()]
    if not records:
        raise ValueError("dataset is empty")

    rng = random.Random(seed)
    for i, r in enumerate(records):
        r.setdefault("row_id", str(i))
        if split:
            r["split"] = rng.choices(["train", "val", "test"], split_fracs)[0]

    version = next_version(name)
    schema = _infer_schema(records[0])
    lines = [dumps(r) for r in records]
    content_hash = _hash(lines)

    manifest = {"name": name, "version": version, "n_rows": len(records), "schema": schema,
                "content_hash": content_hash, "source_sql": sql, "source_file": from_jsonl,
                "split": split, "split_fracs": split_fracs, "seed": seed, "created_by": created_by,
                "created_at": now(), "notes": notes}

    # --- GCS (immutable path; bucket versioning is on) ------------------------------------
    prefix = f"datasets/{name}/v{version}"
    bucket = gcs().bucket(BUCKET)
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n"); tmp = f.name
    bucket.blob(f"{prefix}/data-00000.jsonl").upload_from_filename(tmp, content_type="application/jsonl")
    bucket.blob(f"{prefix}/manifest.json").upload_from_string(dumps(manifest), content_type="application/json")
    gcs_uri = f"gs://{BUCKET}/{prefix}/data-*.jsonl"

    # --- BigQuery load --------------------------------------------------------------------
    table_id = f"{PROJECT}.{MLOPS_DS}.ds_{name}_v{version}"
    cfg = bigquery.LoadJobConfig(source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
                                 schema=_bq_schema(schema), write_disposition="WRITE_EMPTY")
    bq().load_table_from_uri(gcs_uri, table_id, job_config=cfg).result()

    dataset_id = new_id("ds")
    insert("datasets", {"dataset_id": dataset_id, "name": name, "version": version, "gcs_uri": gcs_uri,
                        "bq_table": table_id, "schema_json": dumps(schema), "n_rows": len(records),
                        "content_hash": content_hash, "source_sql": sql, "created_by": created_by,
                        "created_at": now(), "notes": notes})
    return {"dataset_id": dataset_id, **manifest, "gcs_uri": gcs_uri, "bq_table": table_id}


def list_datasets() -> list[dict[str, Any]]:
    return rows(f"SELECT * FROM {tbl('datasets')} ORDER BY created_at DESC")


def get_dataset(dataset_id: str) -> dict[str, Any] | None:
    r = rows(f"SELECT * FROM {tbl('datasets')} WHERE dataset_id = @id", {"id": dataset_id})
    return r[0] if r else None


def preview(dataset_id: str, n: int = 20) -> list[dict[str, Any]]:
    d = get_dataset(dataset_id)
    if not d:
        return []
    return rows(f"SELECT * EXCEPT(embedding) FROM `{d['bq_table']}` LIMIT @n", {"n": n}) if '"embedding"' in d["schema_json"] \
        else rows(f"SELECT * FROM `{d['bq_table']}` LIMIT @n", {"n": n})


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build"); b.add_argument("--name", required=True); b.add_argument("--sql"); b.add_argument("--recipe", choices=RECIPES)
    b.add_argument("--from-jsonl"); b.add_argument("--no-split", action="store_true"); b.add_argument("--notes", default="")
    sub.add_parser("list")
    a = ap.parse_args()
    if a.cmd == "build":
        print(dumps(build_dataset(a.name, sql=a.sql, recipe=a.recipe, from_jsonl=a.from_jsonl, split=not a.no_split, notes=a.notes)))
    else:
        for d in list_datasets():
            print(d["dataset_id"], f"{d['name']}@v{d['version']}", d["n_rows"], d["bq_table"])
