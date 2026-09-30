"use client";
import { useEffect, useState } from "react";
import styles from "@/app/research/research.module.css";
import { mlopsApi, type Dataset, type LabelTask, type Model, type Run } from "@/lib/mlopsApi";

export default function Overview({ go }: { go: (tab: string) => void }) {
  const [d, setD] = useState<{ datasets: Dataset[]; tasks: LabelTask[]; runs: Run[]; models: Model[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [initBusy, setInitBusy] = useState(false);

  const load = () => Promise.all([mlopsApi.datasets(), mlopsApi.tasks(), mlopsApi.runs(), mlopsApi.models()])
    .then(([datasets, tasks, runs, models]) => setD({ datasets, tasks, runs, models })).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, []);

  async function init() { setInitBusy(true); try { await mlopsApi.init(); setErr(null); await load(); } catch (e) { setErr(String(e)); } finally { setInitBusy(false); } }

  if (err) return (<div className={styles.error}>{err}<div style={{ marginTop: 8 }}><button className={styles.btn} onClick={init} disabled={initBusy}>Create registry tables and bucket</button></div></div>);
  if (!d) return <p className={styles.loading}>Loading registry…</p>;

  const prod = d.models.filter((m) => m.stage === "production");
  const running = d.runs.filter((r) => r.status === "running");
  const stages = [
    { id: "datasets", title: "1. Dataset", value: d.datasets.length, note: d.datasets[0] ? `latest ${d.datasets[0].name}@v${d.datasets[0].version}, ${d.datasets[0].n_rows.toLocaleString()} rows` : "No dataset yet. Build one from a recipe." },
    { id: "labeling", title: "2. Labeling", value: d.tasks.filter((t) => t.status === "open").length, note: `${d.tasks.length} tasks total; open tasks feed active learning` },
    { id: "training", title: "3. Training", value: running.length, note: running.length ? "runs in progress" : `${d.runs.length} runs recorded` },
    { id: "models", title: "4. Registry", value: d.models.length, note: `${d.models.filter((m) => m.stage === "candidate").length} candidates, ${d.models.filter((m) => m.stage === "staging").length} in staging` },
    { id: "models", title: "5. Production", value: prod.length, note: prod.length ? prod.map((m) => `${m.task}: ${m.name}`).join("; ") : "Nothing promoted yet" },
  ];
  return (
    <>
      <div className={styles.stats}>
        {stages.map((s, i) => (
          <button key={i} className={styles.stat} style={{ background: "none", border: 0, textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit" }} onClick={() => go(s.id)}>
            <b className={styles.mono}>{s.value}</b><span>{s.title}</span><span style={{ maxWidth: 220 }}>{s.note}</span>
          </button>
        ))}
      </div>
      <div className={styles.panel}>
        <div className={styles.panelHead}><h2>Recent training runs</h2><p>Status updates as background jobs finish.</p></div>
        {d.runs.length === 0 ? <div className={styles.empty}>No runs yet. Build a dataset, then start a run from Training.</div> : (
          <table className={styles.table}><thead><tr><th>Run</th><th>Learning</th><th>Status</th><th>Started</th><th>Artifact</th></tr></thead>
            <tbody>{d.runs.slice(0, 8).map((r) => (
              <tr key={r.run_id}><td className={styles.mono}>{r.run_id}</td><td>{r.learning_type}</td>
                <td><span className={`${styles.tag} ${r.status === "succeeded" ? styles.tagLichen : r.status === "failed" ? styles.tagCoral : styles.tagAmber}`}>{r.status}</span></td>
                <td className={styles.meta}>{new Date(r.started_at).toLocaleString()}</td><td className={`${styles.meta} ${styles.mono}`}>{r.artifact ?? r.error?.slice(0, 80) ?? ""}</td></tr>))}</tbody></table>
        )}
      </div>
    </>
  );
}
