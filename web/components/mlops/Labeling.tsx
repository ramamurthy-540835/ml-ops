"use client";
import { useEffect, useState } from "react";
import styles from "@/app/research/research.module.css";
import { mlopsApi, type Dataset, type LabelTask, type Progress, type QueueRow } from "@/lib/mlopsApi";

export default function Labeling({ actor }: { actor: string }) {
  const [tasks, setTasks] = useState<LabelTask[] | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [sel, setSel] = useState<LabelTask | null>(null);
  const [queue, setQueue] = useState<QueueRow[] | null>(null);
  const [prog, setProg] = useState<Progress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // new-task form
  const [f, setF] = useState({ dataset_id: "", label_field: "label", label_space: "0, 1", text_fields: "title, abstract", instructions: "Include (1) if the paper reports climate impacts, vulnerability or adaptation; else 0." });

  const loadTasks = () => mlopsApi.tasks().then(setTasks).catch((e) => setErr(String(e)));
  useEffect(() => { loadTasks(); mlopsApi.datasets().then((d) => { setDatasets(d); if (d[0]) setF((x) => ({ ...x, dataset_id: x.dataset_id || d[0].dataset_id })); }).catch(() => {}); }, []);
  useEffect(() => { if (!sel) return; refresh(sel); }, [sel, actor]);

  async function refresh(t: LabelTask) {
    setQueue(null);
    try { setProg(await mlopsApi.progress(t.task_id)); if (actor.trim()) setQueue(await mlopsApi.queue(t.task_id, actor)); else setQueue([]); }
    catch (e) { setErr(String(e)); }
  }
  async function createTask() {
    setBusy("create"); setErr(null);
    try {
      const t = await mlopsApi.createTask({ dataset_id: f.dataset_id, label_field: f.label_field, label_space: f.label_space.split(",").map((s) => s.trim()).filter(Boolean),
        text_fields: f.text_fields.split(",").map((s) => s.trim()).filter(Boolean), instructions: f.instructions });
      await loadTasks(); setSel(t);
    } catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }
  async function prelabel() { if (!sel) return; setBusy("prelabel"); try { const r = await mlopsApi.prelabel(sel.task_id, 300); setErr(null); await refresh(sel); alert(`Pre-labelled ${r.prelabelled} rows`); } catch (e) { setErr(String(e)); } finally { setBusy(null); } }
  async function label(row: QueueRow, lab: string) {
    if (!sel || !actor.trim()) { setErr("Enter your name in the left panel to label."); return; }
    setBusy(row.row_id);
    try { await mlopsApi.submitLabel(sel.task_id, { row_id: row.row_id, label: lab, annotator: actor }); setQueue((q) => q && q.filter((x) => x.row_id !== row.row_id)); }
    catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }
  async function exportLabels() { if (!sel) return; try { const r = await mlopsApi.exportLabels(sel.task_id); alert(`Exported to ${r.gcs_uri}`); } catch (e) { setErr(String(e)); } }

  const space = sel ? (JSON.parse(sel.label_space) as string[]) : [];
  const textFields = sel ? (JSON.parse(sel.text_fields) as string[]) : [];
  const pct = (x: number | null | undefined) => x == null ? "–" : `${Math.round(x * 100)}%`;

  return (
    <>
      {err && <div className={styles.error} style={{ marginBottom: 12 }}>{err}</div>}
      <div className={styles.panel}>
        <div className={styles.panelHead}><h2>Label tasks</h2><p>A task fixes the field, the label space and the text the annotator sees.</p></div>
        <div className={styles.toolbar}>
          <select className={styles.select} value={f.dataset_id} onChange={(e) => setF({ ...f, dataset_id: e.target.value })}>{datasets.map((d) => <option key={d.dataset_id} value={d.dataset_id}>{d.name}@v{d.version}</option>)}</select>
          <input className={styles.input} style={{ minWidth: 120, flex: 0, width: 140 }} value={f.label_field} onChange={(e) => setF({ ...f, label_field: e.target.value })} aria-label="Label field" />
          <input className={styles.input} style={{ minWidth: 160, flex: 0, width: 220 }} value={f.label_space} onChange={(e) => setF({ ...f, label_space: e.target.value })} aria-label="Label space, comma separated" placeholder="labels, comma separated" />
          <input className={styles.input} style={{ minWidth: 160, flex: 0, width: 200 }} value={f.text_fields} onChange={(e) => setF({ ...f, text_fields: e.target.value })} aria-label="Text fields" placeholder="text fields" />
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={createTask} disabled={busy === "create" || !f.dataset_id}>Create task</button>
        </div>
        <textarea className={styles.input} rows={2} style={{ width: "100%" }} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} aria-label="Annotator instructions" />
        {tasks && tasks.length > 0 && (
          <table className={styles.table} style={{ marginTop: 12 }}><thead><tr><th>Task</th><th>Dataset</th><th>Field</th><th>Labels</th><th /></tr></thead>
            <tbody>{tasks.map((t) => (
              <tr key={t.task_id}><td className={`${styles.mono} ${styles.meta}`}>{t.task_id}</td><td>{t.dataset_name}@v{t.dataset_version}</td><td>{t.label_field}</td><td className={styles.meta}>{(JSON.parse(t.label_space) as string[]).join(", ")}</td>
                <td><button className={styles.btn} onClick={() => setSel(t)} aria-pressed={sel?.task_id === t.task_id}>Open</button></td></tr>))}</tbody></table>
        )}
      </div>

      {sel && (
        <div className={styles.panel}>
          <div className={styles.panelHead}><h2>Labeling {sel.label_field}: {sel.dataset_name}@v{sel.dataset_version}</h2>
            <div className={styles.btnRow}><button className={styles.btn} onClick={prelabel} disabled={busy === "prelabel"}>{busy === "prelabel" ? "Pre-labelling…" : "Pre-label 300 with Gemini"}</button><button className={styles.btn} onClick={exportLabels}>Export gold labels</button></div></div>
          {prog && (
            <div className={styles.stats}>
              <div className={styles.stat}><b className={styles.mono}>{prog.n_human_rows}/{prog.n_rows}</b><span>rows with a human label</span></div>
              <div className={styles.stat}><b className={styles.mono}>{prog.n_llm_rows}</b><span>rows pre-labelled</span></div>
              <div className={styles.stat}><b className={styles.mono}>{pct(prog.agreement.human_human_agreement)}</b><span>human agreement ({prog.agreement.n_double_labelled} double-labelled)</span></div>
              <div className={styles.stat}><b className={styles.mono}>{pct(prog.agreement.human_llm_agreement)}</b><span>human ↔ Gemini agreement</span></div>
            </div>
          )}
          {!queue ? <p className={styles.loading}>Loading queue…</p> : queue.length === 0 ? <div className={styles.empty}>{actor.trim() ? "Nothing left in your queue for this task." : "Enter your name in the left panel to get a queue."}</div> : (
            <table className={styles.table}><thead><tr><th>Text</th><th>Gemini suggests</th><th>Your label</th></tr></thead>
              <tbody>{queue.map((r) => (
                <tr key={r.row_id}>
                  <td style={{ maxWidth: 520 }}>{textFields.map((tf) => <div key={tf}><span className={styles.meta}>{tf}: </span>{String(r[tf] ?? "")}</div>)}<div className={`${styles.meta} ${styles.mono}`}>{r.row_id}, {r.n_human_labels} human label(s)</div></td>
                  <td style={{ maxWidth: 220 }}>{r.llm_label ? <><span className={`${styles.tag} ${(r.llm_conf ?? 0) < 0.6 ? styles.tagAmber : styles.tagOcean}`}>{r.llm_label}, {Math.round((r.llm_conf ?? 0) * 100)}%</span><div className={styles.meta}>{r.llm_rationale}</div></> : <span className={styles.meta}>no pre-label</span>}</td>
                  <td><div className={styles.btnRow}>{space.map((s) => <button key={s} className={`${styles.btn} ${s === r.llm_label ? styles.btnPrimary : ""}`} disabled={busy === r.row_id} onClick={() => label(r, s)}>{s}</button>)}</div></td>
                </tr>))}</tbody></table>
          )}
        </div>
      )}
    </>
  );
}
