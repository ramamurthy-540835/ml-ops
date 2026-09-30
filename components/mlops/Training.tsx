"use client";
import { useEffect, useMemo, useState } from "react";
import styles from "@/app/research/research.module.css";
import { mlopsApi, type Catalog, type Dataset, type LabelTask, type TrainIn } from "@/lib/mlopsApi";

const LT_LABEL: Record<string, string> = {
  classification: "Supervised: classification", regression: "Supervised: regression", clustering: "Unsupervised: clustering",
  dimensionality_reduction: "Unsupervised: dimensionality reduction", anomaly_detection: "Unsupervised: anomaly detection",
  time_series: "Time series forecasting", fine_tune: "Fine-tune Gemini (Vertex AI)",
};

export default function Training({ actor }: { actor: string }) {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [tasks, setTasks] = useState<LabelTask[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sql, setSql] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [cfg, setCfg] = useState<TrainIn>({ name: "screening-lr", task: "screening", learning_type: "classification", model_type: "LOGISTIC_REG", dataset_id: "",
    label_task_id: null, label_col: "label", feature_cols: ["embedding"], exclude_cols: ["row_id", "split"], split_col: "split",
    hparams: {}, search: {}, num_trials: 0, time_series: { timestamp_col: "yr", data_col: "n_docs", id_col: "cluster_id" }, gates: {}, created_by: "ui", notes: "" });

  useEffect(() => {
    Promise.all([mlopsApi.catalog(), mlopsApi.datasets(), mlopsApi.tasks()]).then(([c, d, t]) => { setCat(c); setDatasets(d); setTasks(t); if (d[0]) setCfg((x) => ({ ...x, dataset_id: d[0].dataset_id })); }).catch((e) => setErr(String(e)));
  }, []);

  const defaults = useMemo(() => cat?.hparams[cfg.model_type] ?? {}, [cat, cfg.model_type]);
  const gates = useMemo(() => cat?.gates[cfg.learning_type] ?? {}, [cat, cfg.learning_type]);

  function setLT(lt: string) { const mt = cat!.model_types[lt][0]; setCfg({ ...cfg, learning_type: lt, model_type: mt, hparams: {}, search: {}, num_trials: 0 }); setSql(null); }
  function setHp(k: string, v: string) {
    const d = defaults[k]; let val: unknown = v;
    if (typeof d === "number") val = Number(v); else if (typeof d === "boolean") val = v === "true"; else if (Array.isArray(d)) val = v.split(",").map((s) => Number(s.trim())).filter((n) => !isNaN(n));
    setCfg({ ...cfg, hparams: { ...cfg.hparams, [k]: val } }); setSql(null);
  }
  function setSearch(k: string, v: string) {
    const s = { ...cfg.search }; if (!v.trim()) delete s[k]; else s[k] = v.split(",").map((x) => x.trim()).map((x) => (isNaN(Number(x)) ? x : Number(x)));
    setCfg({ ...cfg, search: s }); setSql(null);
  }
  async function preview() { try { setErr(null); setSql((await mlopsApi.previewSql({ ...cfg, created_by: actor || "ui" })).sql); } catch (e) { setErr(String(e)); } }
  async function run() {
    if (!actor.trim()) { setErr("Enter your name in the left panel before starting a run."); return; }
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await mlopsApi.train({ ...cfg, created_by: actor, gates: { ...gates, ...cfg.gates } }); setMsg(`Run queued${r.run ? `: ${r.run.run_id}` : ""}. Follow it under Runs & monitoring.`); }
    catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  if (err && !cat) return <div className={styles.error}>{err}</div>;
  if (!cat) return <p className={styles.loading}>Loading catalog…</p>;
  const supervised = cfg.learning_type === "classification" || cfg.learning_type === "regression" || cfg.learning_type === "fine_tune";

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.panelHead}><h2>Configure a run</h2><p>The same configuration object is what the API and the SQL generator use.</p></div>
        <div className={styles.toolbar}>
          <input className={styles.input} style={{ minWidth: 160, flex: 0, width: 180 }} value={cfg.name} onChange={(e) => setCfg({ ...cfg, name: e.target.value })} aria-label="Run name" />
          <input className={styles.input} style={{ minWidth: 120, flex: 0, width: 150 }} value={cfg.task} onChange={(e) => setCfg({ ...cfg, task: e.target.value.replace(/[^a-z0-9_]/g, "_") })} aria-label="Task (production alias name)" title="Task name: production alias is prod_<task>" />
          <select className={styles.select} value={cfg.learning_type} onChange={(e) => setLT(e.target.value)} aria-label="Learning type">{cat.learning_types.map((lt) => <option key={lt} value={lt}>{LT_LABEL[lt] ?? lt}</option>)}</select>
          <select className={styles.select} value={cfg.model_type} onChange={(e) => { setCfg({ ...cfg, model_type: e.target.value, hparams: {}, search: {} }); setSql(null); }} aria-label="Model type">{cat.model_types[cfg.learning_type].map((m) => <option key={m}>{m}</option>)}</select>
          <select className={styles.select} value={cfg.dataset_id} onChange={(e) => setCfg({ ...cfg, dataset_id: e.target.value })} aria-label="Dataset">{datasets.map((d) => <option key={d.dataset_id} value={d.dataset_id}>{d.name}@v{d.version}</option>)}</select>
        </div>

        {supervised && (
          <div className={styles.toolbar}>
            <span className={styles.meta}>Labels from</span>
            <select className={styles.select} value={cfg.label_task_id ?? ""} onChange={(e) => setCfg({ ...cfg, label_task_id: e.target.value || null })} aria-label="Label source">
              <option value="">column in dataset</option>{tasks.filter((t) => t.dataset_id === cfg.dataset_id).map((t) => <option key={t.task_id} value={t.task_id}>label task {t.task_id} ({t.label_field})</option>)}
            </select>
            {!cfg.label_task_id && <input className={styles.input} style={{ minWidth: 100, flex: 0, width: 120 }} value={cfg.label_col ?? ""} onChange={(e) => setCfg({ ...cfg, label_col: e.target.value })} aria-label="Label column" />}
            <span className={styles.meta}>Features</span>
            <input className={styles.input} style={{ minWidth: 160, flex: 0, width: 220 }} value={cfg.feature_cols.join(", ")} onChange={(e) => setCfg({ ...cfg, feature_cols: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} aria-label="Feature columns" />
          </div>
        )}
        {cfg.learning_type === "time_series" && (
          <div className={styles.toolbar}>{(["timestamp_col", "data_col", "id_col"] as const).map((k) => (
            <label key={k} className={styles.meta}>{k} <input className={styles.input} style={{ minWidth: 100, flex: 0, width: 130 }} value={cfg.time_series[k] ?? ""} onChange={(e) => setCfg({ ...cfg, time_series: { ...cfg.time_series, [k]: e.target.value } })} /></label>))}</div>
        )}

        <div className={styles.drawer}>
          <h3>Parameters for {cfg.model_type}</h3>
          <table className={styles.table}><thead><tr><th>Parameter</th><th>Default</th><th>Value</th><th>Search range or candidates (comma separated)</th></tr></thead>
            <tbody>{Object.entries(defaults).map(([k, d]) => (
              <tr key={k}><td className={styles.mono}>{k}</td><td className={`${styles.meta} ${styles.mono}`}>{JSON.stringify(d)}</td>
                <td><input className={styles.input} style={{ minWidth: 100, width: 160 }} defaultValue={Array.isArray(d) ? (d as number[]).join(", ") : String(d)} onBlur={(e) => setHp(k, e.target.value)} aria-label={`value for ${k}`} /></td>
                <td>{cat.tunable.includes(k) && cfg.learning_type !== "fine_tune" ? <input className={styles.input} style={{ minWidth: 100, width: 200 }} placeholder="e.g. 0.01, 1.0" onBlur={(e) => setSearch(k, e.target.value)} aria-label={`search for ${k}`} /> : <span className={styles.meta}>not tunable</span>}</td></tr>))}</tbody></table>
          {Object.keys(cfg.search).length > 0 && (
            <div className={styles.toolbar} style={{ marginTop: 10 }}><span className={styles.meta}>Number of trials</span><input className={styles.input} type="number" min={2} max={100} style={{ minWidth: 80, flex: 0, width: 100 }} value={cfg.num_trials || 10} onChange={(e) => setCfg({ ...cfg, num_trials: Number(e.target.value) })} /></div>
          )}
        </div>

        <div className={styles.drawer}>
          <h3>Quality gates</h3>
          <p className={styles.meta}>{Object.keys(gates).length ? Object.entries(gates).map(([k, v]) => `${k} ${k.endsWith("_max") ? "≤" : "≥"} ${v}`).join(", ") : "No default gates for this learning type; add your own in the notes for the reviewer."} A model that fails a gate stays a candidate and cannot be promoted automatically.</p>
          <input className={styles.input} style={{ width: "100%" }} value={cfg.notes} onChange={(e) => setCfg({ ...cfg, notes: e.target.value })} placeholder={cfg.learning_type === "fine_tune" ? "System instruction for the tuned model (used when labels come from a column)" : "Why this run? (recorded with the model)"} />
        </div>

        <div className={styles.btnRow} style={{ marginTop: 14 }}>
          <button className={styles.btn} onClick={preview}>Preview SQL</button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={run} disabled={busy || !cfg.dataset_id}>{busy ? "Starting…" : "Start training run"}</button>
        </div>
        {err && <div className={styles.error} style={{ marginTop: 10 }}>{err}</div>}
        {msg && <p className={styles.meta} style={{ marginTop: 10 }}>{msg}</p>}
        {sql && <pre style={{ fontSize: 12.5, background: "#f4f7f8", padding: 12, borderRadius: 6, overflowX: "auto", marginTop: 12 }}>{sql}</pre>}
      </div>
    </>
  );
}
