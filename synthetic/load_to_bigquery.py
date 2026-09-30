"""
Load the synthetic corpus into BigQuery (ai-ippc.climate_ai).

Creates/replaces: documents_synthetic, embeddings_synthetic, screening_labels,
adaptation_outcomes, chunks. The existing `documents` / `embeddings` tables are left
untouched; bqml/00_schema.sql builds a UNION view (`corpus`) over real + synthetic rows.

Usage:
  python load_to_bigquery.py --project ai-ippc --dataset climate_ai --src data/synthetic
"""
from __future__ import annotations

import argparse
from pathlib import Path

from google.cloud import bigquery

SCHEMAS = {
    "documents_synthetic": [
        ("doc_id", "STRING", "REQUIRED"), ("title", "STRING"), ("abstract", "STRING"), ("year", "INT64"),
        ("source_type", "STRING"), ("language", "STRING"), ("region", "STRING"), ("country", "STRING"),
        ("sector", "STRING"), ("hazard", "STRING"), ("evidence_type", "STRING"), ("adaptation_type", "STRING"),
        ("outcome_reported", "BOOL"), ("confidence_language", "STRING"), ("evidence_agreement", "STRING"),
        ("credibility_score", "FLOAT64"), ("doi", "STRING"), ("n_pages", "INT64"), ("ingested_at", "DATE"),
    ],
    "embeddings_synthetic": [
        ("doc_id", "STRING", "REQUIRED"), ("model", "STRING"), ("embedding", "FLOAT64", "REPEATED"),
    ],
    "screening_labels": [
        ("doc_id", "STRING", "REQUIRED"), ("label", "INT64"), ("annotator", "STRING"), ("split", "STRING"),
    ],
    "adaptation_outcomes": [
        ("doc_id", "STRING", "REQUIRED"), ("adaptation_type", "STRING"), ("action", "STRING"),
        ("outcome_direction", "STRING"), ("metric", "STRING"), ("effect_size", "FLOAT64"),
        ("context_similarity_key", "STRING"),
    ],
    "chunks": [
        ("chunk_id", "STRING", "REQUIRED"), ("doc_id", "STRING"), ("page", "INT64"), ("chunk_index", "INT64"),
        ("text", "STRING"), ("char_start", "INT64"), ("char_end", "INT64"),
    ],
}

FILES = {  # table -> jsonl
    "documents_synthetic": "documents.jsonl", "embeddings_synthetic": "embeddings.jsonl",
    "screening_labels": "screening_labels.jsonl", "adaptation_outcomes": "adaptation_outcomes.jsonl",
    "chunks": "chunks.jsonl",
}


def schema(cols):
    return [bigquery.SchemaField(c[0], c[1], mode=(c[2] if len(c) > 2 else "NULLABLE")) for c in cols]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default="ai-ippc")
    ap.add_argument("--dataset", default="climate_ai")
    ap.add_argument("--location", default="US")
    ap.add_argument("--src", default="data/synthetic")
    a = ap.parse_args()

    client = bigquery.Client(project=a.project, location=a.location)
    client.create_dataset(bigquery.Dataset(f"{a.project}.{a.dataset}"), exists_ok=True)

    for table, fname in FILES.items():
        path = Path(a.src) / fname
        if not path.exists():
            print(f"skip {table}: {path} missing")
            continue
        table_id = f"{a.project}.{a.dataset}.{table}"
        cfg = bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
            schema=schema(SCHEMAS[table]),
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        )
        with path.open("rb") as f:
            job = client.load_table_from_file(f, table_id, job_config=cfg)
        job.result()
        print(f"loaded {job.output_rows:>7} rows -> {table_id}")


if __name__ == "__main__":
    main()
