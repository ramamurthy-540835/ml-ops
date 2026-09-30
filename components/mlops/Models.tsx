"use client";
import { useEffect, useState } from "react";
import styles from "@/app/research/research.module.css";
import { mlopsApi, type Model } from "@/lib/mlopsApi";

const STAGE_CLS: Record<string, string> = { production: styles.tagLichen, staging: styles.tagOcean, candidate: styles.tagAmber, retired: "" };
const KEY_METRICS = ["precision", "recall", "roc_auc", "f1_score", "r2_score", "mean_absolute_error", "davies_bouldin_index", "mean_squared_distance", "total_explained_variance_ratio"];

export default function Models({ actor }: { actor: string }) {
  const [list, setList] = useState<Model[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [promo, setPromo] = useState<{ m: Model; to: string; reason: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => mlopsApi.models().then(setList).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, []);

  function metrics(m: Model) {
    try { const j = JSON.parse(m.metrics_json ?? "{}"); const ev = j.evaluate && !Array.isArray(j.evaluate) ? j.evaluate : {}; return { ev, raw: j }; } catch { return { ev: {}, raw: {} }; }
  }
  async function doPromote() {
    if (!promo) return;
    if (!actor.trim()) { setErr("Enter your name in the left panel; promotions are attributed."); return; }
    try { await mlopsApi.promote(promo.m.model_id, { to_stage: promo.to, actor, reason: promo.reason }); setPromo(null); setErr(null); await load(); } catch (e) { setErr(String(e)); }
  }

  if (err && !list) return <div className={styles.error}>{err}</div>;
  if (!list) return <p className={styles.loading}>Loading registry…</p>;

  return (
    <>
      {err && <div className={styles.error} style={{ marginBottom: 12 }}>{err}</div>}
      <div className={styles.panel}>
        <div className={styles.panelHead}><h2>{list.length} models</h2><p>One production model per task. The app reads the alias view prod_&lt;task&gt;.</p></div>
        {list.length === 0 ? <div className={styles.empty}>No models yet. Start a run under Training.</div> : (
          <table className={styles.table}><thead><tr><th>Model</th><th>Task</th><th>Learning</th><th>Key metrics</th><th>Stage</th><th /></tr></thead>
            <tbody>{list.map((m) => { const { ev, raw } = metrics(m); return (
              <>
                <tr key={m.model_id}>
                  <td><div className={styles.title}>{m.name}</div><div className={`${styles.meta} ${styles.mono}`}>{m.model_id}</div></td>
                  <td>{m.task}</td><td className={styles.meta}>{m.learning_type}</td>
                  <td className={`${styles.meta} ${styles.mono}`}>{KEY_METRICS.filter((k) => ev[k] != null).map((k) => `${k} ${Number(ev[k]).toFixed(3)}`).join(", ") || (raw.endpoint ? `tuned endpoint` : "no metrics")}</td>
                  <td><span className={`${styles.tag} ${STAGE_CLS[m.stage]}`}>{m.stage}</span></td>
                  <td><div className={styles.btnRow}>
                    <button className={styles.btn} onClick={() => setOpen(open === m.model_id ? null : m.model_id)}>Details</button>
                    {m.stage === "candidate" && <button className={styles.btn} onClick={() => setPromo({ m, to: "staging", reason: "" })}>To staging</button>}
                    {m.stage !== "production" && m.stage !== "retired" && <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setPromo({ m, to: "production", reason: "" })}>Promote to production</button>}
                    {m.stage !== "retired" && <button className={styles.btn} onClick={() => setPromo({ m, to: "retired", reason: "" })}>Retire</button>}
                  </div></td>
                </tr>
                {open === m.model_id && (
                  <tr key={m.model_id + "-d"}><td colSpan={6}>
                    <div className={styles.meta} style={{ marginBottom: 6 }}>Artifact: <span className={styles.mono}>{m.artifact}</span>{m.bytes_billed != null ? `, ${(m.bytes_billed / 1e9).toFixed(2)} GB billed` : ""}</div>
                    <details><summary className={styles.meta}>Configuration</summary><pre style={{ fontSize: 12, overflowX: "auto" }}>{JSON.stringify(JSON.parse(m.config_json ?? "{}"), null, 2)}</pre></details>
                    <details><summary className={styles.meta}>Evaluation output</summary><pre style={{ fontSize: 12, overflowX: "auto", maxHeight: 320 }}>{JSON.stringify(raw, null, 2)}</pre></details>
                  </td></tr>
                )}
              </>); })}</tbody></table>
        )}
      </div>

      {promo && (
        <div className={styles.panel} role="dialog" aria-label="Promotion">
          <div className={styles.panelHead}><h2>Move {promo.m.name} to {promo.to}</h2><p>{promo.to === "production" ? `The current production model for ${promo.m.task} moves back to staging.` : ""}</p></div>
          <input className={styles.input} style={{ width: "100%" }} value={promo.reason} onChange={(e) => setPromo({ ...promo, reason: e.target.value })} placeholder="Reason (required): e.g. recall 0.93 on v3 test split; cluster labels reviewed by two authors" />
          <div className={styles.btnRow} style={{ marginTop: 10 }}>
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={doPromote} disabled={promo.reason.trim().length < 3}>Confirm</button>
            <button className={styles.btn} onClick={() => setPromo(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
