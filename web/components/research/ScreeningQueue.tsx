"use client";
import { useEffect, useState } from "react";
import styles from "@/app/research/research.module.css";
import { mlApi, type ScreeningItem, type ScreeningResponse } from "@/lib/mlApi";

const PAGE = 40;

export default function ScreeningQueue({ reviewer }: { reviewer: string }) {
  const [data, setData] = useState<ScreeningResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [onlyUnlabelled, setOnlyUnlabelled] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null); setErr(null);
    mlApi.screening({ limit: PAGE, offset, only_unlabelled: onlyUnlabelled }).then(setData).catch((e) => setErr(String(e)));
  }, [offset, onlyUnlabelled]);

  async function decide(item: ScreeningItem, decision: "screen_include" | "screen_exclude") {
    if (!reviewer.trim()) { setErr("Enter a reviewer name in the left panel before recording decisions."); return; }
    setBusy(item.doc_id);
    try {
      await mlApi.decide({ doc_id: item.doc_id, decision_type: decision, reviewer });
      setData((d) => d && { ...d, items: d.items.map((x) => (x.doc_id === item.doc_id ? { ...x, human_decision: decision } : x)) });
    } catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }

  if (err) return <div className={styles.error}>{err}</div>;
  if (!data) return <p className={styles.loading}>Loading ranked documents from BigQuery…</p>;

  const stop = data.stopping;
  return (
    <>
      <div className={styles.stats}>
        {stop && <div className={styles.stat}><b className={styles.mono}>{stop.suggested_stop_rank.toLocaleString()}</b><span>suggested stopping rank of {stop.corpus_size.toLocaleString()} documents</span></div>}
        {stop && <div className={styles.stat}><b className={styles.mono}>{Math.round(stop.expected_total_relevant).toLocaleString()}</b><span>expected relevant documents</span></div>}
        {data.eval && <div className={styles.stat}><b className={styles.mono}>{data.eval.recall.toFixed(2)}</b><span>recall on held-out labels</span></div>}
        {data.eval && <div className={styles.stat}><b className={styles.mono}>{data.eval.roc_auc.toFixed(2)}</b><span>ROC AUC</span></div>}
        {data.wss_at_95 != null && <div className={styles.stat}><b className={styles.mono}>{Math.round(data.wss_at_95 * 100)}%</b><span>work saved at 95% recall</span></div>}
      </div>

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={onlyUnlabelled} onChange={(e) => { setOffset(0); setOnlyUnlabelled(e.target.checked); }} /> Hide documents that already have human labels
          </label>
          <span style={{ flex: 1 }} />
          <button className={styles.btn} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <button className={styles.btn} disabled={data.items.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </div>

        {data.items.length === 0 ? (
          <div className={styles.empty}>No documents match. Run bqml/02_screening_model.sql to score the corpus, or untick the filter.</div>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>Rank</th><th>Document</th><th>P(relevant)</th><th>Second opinion</th><th>Decision</th></tr></thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.doc_id}>
                  <td className={styles.mono}>{it.priority_rank}</td>
                  <td>
                    <div className={styles.title}>{it.title}</div>
                    <div className={styles.meta}>{[it.year, it.region, it.source_type.replace("_", " "), it.language !== "en" ? `lang ${it.language}` : null, it.provenance === "synthetic" ? "synthetic" : null].filter(Boolean).join(", ")}</div>
                  </td>
                  <td style={{ width: 130 }}>
                    <div className={styles.bar}><i style={{ width: `${it.p_relevant * 100}%` }} /></div>
                    <span className={`${styles.meta} ${styles.mono}`}>{it.p_relevant.toFixed(2)}</span>
                  </td>
                  <td style={{ maxWidth: 260 }}>
                    {it.llm_decision ? (
                      <>
                        <span className={`${styles.tag} ${it.agrees_with_model ? styles.tagLichen : styles.tagAmber}`}>
                          {it.llm_decision.replace("_", " ")}{it.agrees_with_model === false ? ", disagrees with model" : ""}
                        </span>
                        <div className={styles.meta} style={{ marginTop: 4 }}>{it.llm_reason}</div>
                      </>
                    ) : <span className={styles.meta}>not in uncertain band</span>}
                  </td>
                  <td>
                    {it.human_decision ? (
                      <span className={`${styles.tag} ${it.human_decision === "screen_include" ? styles.tagLichen : styles.tagCoral}`}>{it.human_decision === "screen_include" ? "Included" : "Excluded"}</span>
                    ) : (
                      <div className={styles.btnRow}>
                        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy === it.doc_id} onClick={() => decide(it, "screen_include")}>Include</button>
                        <button className={styles.btn} disabled={busy === it.doc_id} onClick={() => decide(it, "screen_exclude")}>Exclude</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
