// web/lib/mlopsApi.ts — typed client for api_mlops.py
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { cache: "no-store", headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
const get = <T,>(p: string) => req<T>(p);
const post = <T,>(p: string, body?: unknown) => req<T>(p, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export type Dataset = { dataset_id: string; name: string; version: number; gcs_uri: string; bq_table: string; schema_json: string; n_rows: number; content_hash: string; source_sql: string | null; created_by: string; created_at: string; notes: string };
export type LabelTask = { task_id: string; dataset_id: string; dataset_name: string; dataset_version: number; label_field: string; label_space: string; text_fields: string; instructions: string; status: string; created_at: string };
export type QueueRow = { row_id: string; llm_label: string | null; llm_conf: number | null; llm_rationale: string | null; n_human_labels: number } & Record<string, unknown>;
export type Progress = { n_rows: number; n_human_rows: number; n_llm_rows: number; n_annotators: number; distribution: { label: string; source: string; n: number }[]; agreement: { human_human_agreement: number | null; n_double_labelled: number; human_llm_agreement: number | null } };
export type Catalog = { learning_types: string[]; model_types: Record<string, string[]>; hparams: Record<string, Record<string, unknown>>; tunable: string[]; gates: Record<string, Record<string, number>> };
export type TrainIn = { name: string; task: string; learning_type: string; model_type: string; dataset_id: string; label_task_id?: string | null; label_col?: string | null; feature_cols: string[]; exclude_cols: string[]; split_col?: string | null; hparams: Record<string, unknown>; search: Record<string, unknown[]>; num_trials: number; time_series: Record<string, string>; gates: Record<string, number>; created_by: string; notes: string };
export type Run = { run_id: string; dataset_id: string; task_id: string | null; learning_type: string; config_json: string; status: "running" | "succeeded" | "failed"; artifact: string | null; bytes_billed: number | null; slot_ms: number | null; started_at: string; finished_at: string | null; error: string | null; created_by: string };
export type Model = { model_id: string; run_id: string; name: string; task: string; learning_type: string; artifact: string; stage: "candidate" | "staging" | "production" | "retired"; created_at: string; dataset_id: string; config_json: string; metrics_json: string | null; bytes_billed: number | null };
export type PipelineRun = { pipeline_run_id: string; spec_json: string; stage: string; status: string; log: string; started_at: string; finished_at: string | null };
export type Monitoring = { task: string; override_rate?: { override_rate: number; n_decisions: number }; score_histogram?: { bucket: number; n: number }[]; llm_agreement?: { llm_model_agreement: number; n_band: number }; cost: { learning_type: string; n_runs: number; gb: number; slot_hours: number }[] };

export const mlopsApi = {
  init: () => post<{ ok: boolean }>("/mlops/init"),
  datasets: () => get<Dataset[]>("/mlops/datasets"),
  recipes: () => get<{ recipes: Record<string, string> }>("/mlops/datasets/recipes"),
  createDataset: (b: { name: string; recipe?: string; sql?: string; split: boolean; notes: string; created_by: string }) => post<Dataset>("/mlops/datasets", b),
  preview: (id: string) => get<Record<string, unknown>[]>(`/mlops/datasets/${id}/preview`),
  tasks: () => get<LabelTask[]>("/mlops/labels/tasks"),
  createTask: (b: { dataset_id: string; label_field: string; label_space: string[]; text_fields: string[]; instructions: string }) => post<LabelTask>("/mlops/labels/tasks", b),
  prelabel: (id: string, limit = 300) => post<{ prelabelled: number }>(`/mlops/labels/tasks/${id}/prelabel?limit=${limit}`),
  queue: (id: string, annotator: string) => get<QueueRow[]>(`/mlops/labels/tasks/${id}/queue?annotator=${encodeURIComponent(annotator)}`),
  submitLabel: (id: string, b: { row_id: string; label: string; annotator: string; rationale?: string }) => post(`/mlops/labels/tasks/${id}/labels`, b),
  progress: (id: string) => get<Progress>(`/mlops/labels/tasks/${id}/progress`),
  exportLabels: (id: string) => post<{ gcs_uri: string }>(`/mlops/labels/tasks/${id}/export`),
  catalog: () => get<Catalog>("/mlops/catalog"),
  previewSql: (b: TrainIn) => post<{ sql: string }>("/mlops/train/preview-sql", b),
  train: (b: TrainIn) => post<{ queued: boolean; run: Run | null }>("/mlops/train", b),
  runs: () => get<Run[]>("/mlops/runs"),
  run: (id: string) => get<Run>(`/mlops/runs/${id}`),
  models: (task?: string) => get<Model[]>(`/mlops/models${task ? `?task=${task}` : ""}`),
  promote: (id: string, b: { to_stage: string; actor: string; reason: string }) => post(`/mlops/models/${id}/promote`, b),
  monitoring: (task = "screening") => get<Monitoring>(`/mlops/monitoring?task=${task}`),
  pipeline: (b: unknown) => post<{ queued: boolean }>("/mlops/pipeline", b),
  pipelineRuns: () => get<PipelineRun[]>("/mlops/pipeline/runs"),
};
