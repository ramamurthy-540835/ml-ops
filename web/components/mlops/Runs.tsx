"use client";
import { useEffect, useState } from "react";
import styles from "@/app/research/research.module.css";
import { mlopsApi, type Monitoring, type PipelineRun, type Run } from "@/lib/mlopsApi";

const DEFAULT_SPEC = JSON.stringify({
  name: "screening-loop",
  dataset: { name: "screening", recipe: "screening" },
  label: { label_field: "label", label_space: ["0", "1"], text_fields: ["title", "abstract"], instructions: "1 if the paper reports climate impacts, vulnerability or adaptation; else 0.", prelabel_limit: 300 },
  train: { name: "screening-lr", task: "screening", learning_type: "classification", model_type: "LOGISTIC_REG", feature_cols: ["embedding"], hparams: { l2_reg: 0.5 } },
  promote_to: "staging",
}, null, 2);

export default function Runs() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [pruns, setPruns] = useState<PipelineRun[]>([]);
  const [mon, setMon] = useState<Monitoring | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [spec, setSpec] = useState(DEFAULT_SPEC);
  const [busy, setBusy] = useState(false);

  const load = () => Promise.all([mlopsApi.runs(), mlopsApi.pipelineRuns(), mlopsApi.monitoring()])
    .then(([r, p, m]) => { setRuns(r); setPruns(p); setMon(m); }).catch((e) => setErr(String(e)));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  async function launch() {
    setBusy(true); setErr(null);
    try { await mlopsApi.pipeline({ ...JSON.parse(spec), actor: "ui" }); setTimeout(load, 2000); } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  if (err && !runs) return <div className={styles.error}>{err}</div>;
  if (!runs) return <p className={styles.loading}>Loading runs…</p>;
  const hist = mon?.score_histogram ?? []; const maxN = Math.max(1, ...hist.map((h) => h.n));

  return (
    <>
      {err && <div className={styles.error} style={{ marginBottom: 12 }}>{err}</div>}
      {mon && (
        <div className={styles.stats}>
          {mon.override_rate && <div className={styles.stat}><b className={styles.mono}>{Math.round(mon.override_rate.override_rate * 100)}%</b><span>reviewer overrides of the production model ({mon.override_rate.n_decisions} decisions)</span></div>}
          {mon.llm_agreement && <div className={styles.stat}><b className={styles.mono}>{Math.round(mon.llm_agreement.llm_model_agreement * 100)}%</b><span>Gemini agrees with model in the uncertain band</span></div>}
          {mon.cost.map((c) => <div key={c.learning_type} className={styles.stat}><b className={styles.mono}>{c.gb.toFixed(2)} GB</b><span>{c.learning_type}: {c.n_runs} runs, {c.slot_hours.toFixed(2)} slot-hours</span></div>)}
        </div>
      )}

      {hist.length > 0 && (
        <div className={styles.panel}>
          <div className={styles.panelHead}><h2>Score distribution of the production screening model</h2><p>A shift of mass toward the middle means the model is unsure about new literature: time to label more.</p></div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${hist.length}, 1fr)`, gap: 4, alignItems: "end", height: 90 }}>
            {hist.map((h) => <div key={h.bucket} title={`${h.bucket.toFixed(1)}: ${h.n}`} style={{ background: "#0b5f7a", height: `${(h.n / maxN) * 100}%`, borderRadius: 3 }} />)}
          </div>
          <div className={styles.meta} style={{ display: "flex", justifyContent: "space-between" }}><span>P = 0</span><span>P = 1</span></div>
        </div>
      )}

      <div className={styles.panel}>
        <div className={styles.panelHead}><h2>Training runs</h2><p>Refreshes every 15 seconds.</p></div>
        <table className={styles.table}><thead><tr><th>Run</th><th>Learning</th><th>Status</th><th>Cost</th><th>Started</th><th>Result</th></tr></thead>
          <tbody>{runs.map((r) => (
            <tr key={r.run_id}><td className={`${styles.mono} ${styles.meta}`}>{r.run_id}<br />{r.created_by}</td><td>{r.learning_type}</td>
              <td><span className={`${styles.tag} ${r.status === "succeeded" ? styles.tagLichen : r.status === "failed" ? styles.tagCoral : styles.tagAmber}`}>{r.status}</span></td>
              <td className={`${styles.meta} ${styles.mono}`}>{r.bytes_billed != null ? `${(r.bytes_billed / 1e9).toFixed(2)} GB` : ""}</td>
              <td className={styles.meta}>{new Date(r.started_at).toLocaleString()}</td>
              <td className={styles.meta} style={{ maxWidth: 320, wordBreak: "break-all" }}>{r.artifact ?? r.error ?? ""}</td></tr>))}</tbody></table>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHead}><h2>Pipeline runs</h2><p>A pipeline spec runs dataset → labeling → training → promotion in one go. Edit the JSON and launch.</p></div>
        <textarea className={styles.input} rows={12} style={{ width: "100%", fontFamily: "monospace", fontSize: 12.5 }} value={spec} onChange={(e) => setSpec(e.target.value)} aria-label="Pipeline spec" />
        <div className={styles.btnRow} style={{ margin: "10px 0 14px" }}><button className={`${styles.btn} ${styles.btnPrimary}`} onClick={launch} disabled={busy}>{busy ? "Launching…" : "Launch pipeline"}</button></div>
        {pruns.length > 0 && (
          <table className={styles.table}><thead><tr><th>Pipeline run</th><th>Stage</th><th>Status</th><th>Log</th></tr></thead>
            <tbody>{pruns.map((p) => (
              <tr key={p.pipeline_run_id}><td className={`${styles.mono} ${styles.meta}`}>{p.pipeline_run_id}</td><td>{p.stage}</td>
                <td><span className={`${styles.tag} ${p.status === "succeeded" ? styles.tagLichen : p.status === "failed" ? styles.tagCoral : styles.tagAmber}`}>{p.status}</span></td>
                <td><pre className={styles.meta} style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{p.log}</pre></td></tr>))}</tbody></table>
        )}
      </div>
    </>
  );
}
