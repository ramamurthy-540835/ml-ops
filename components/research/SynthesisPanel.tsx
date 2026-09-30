"use client";
import { useState } from "react";
import styles from "@/app/research/research.module.css";
import { mlApi, type SynthesisResponse } from "@/lib/mlApi";

const REGIONS = ["All", "Africa", "Asia", "Australasia", "Central and South America", "Europe", "North America", "Small Islands", "Polar Regions"];
const CITE = /\[([^\s\]]+) p\.(\d+)\]/g;

export default function SynthesisPanel({ reviewer }: { reviewer: string }) {
  const [topic, setTopic] = useState("");
  const [region, setRegion] = useState("All");
  const [k, setK] = useState(8);
  const [resp, setResp] = useState<SynthesisResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [audit, setAudit] = useState<Record<string, "citation_ok" | "citation_bad">>({});

  async function run() {
    if (topic.trim().length < 3) return;
    setBusy(true); setErr(null); setResp(null); setAudit({});
    try { setResp(await mlApi.synthesis({ topic, region: region === "All" ? null : region, k })); }
    catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  async function mark(docId: string, ok: boolean) {
    if (!reviewer.trim()) { setErr("Enter a reviewer name in the left panel to record citation checks."); return; }
    const t = ok ? "citation_ok" : "citation_bad";
    setAudit((a) => ({ ...a, [docId]: t }));
    try { await mlApi.decide({ doc_id: docId, decision_type: t, reviewer, note: `topic: ${topic}` }); } catch (e) { setErr(String(e)); }
  }

  const r = resp?.result;
  const known = new Set(resp?.cited_documents.map((d) => d.doc_id) ?? []);

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.toolbar}>
          <input className={styles.input} value={topic} onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()}
                 placeholder="Topic, e.g. heat-related mortality among outdoor workers" aria-label="Synthesis topic" />
          <select className={styles.select} value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region filter">
            {REGIONS.map((x) => <option key={x}>{x}</option>)}
          </select>
          <select className={styles.select} value={k} onChange={(e) => setK(Number(e.target.value))} aria-label="Passages to retrieve">
            {[4, 6, 8, 12, 16].map((x) => <option key={x} value={x}>{x} passages</option>)}
          </select>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={run} disabled={busy || topic.trim().length < 3}>{busy ? "Retrieving and drafting…" : "Draft synthesis"}</button>
        </div>
        {err && <div className={styles.error}>{err}</div>}
        {!resp && !busy && !err && <div className={styles.empty}>Enter a topic. Retrieval uses vector search over page-level chunks; the draft may only use what it retrieved.</div>}

        {resp && !r?.synthesis && (
          <div className={styles.empty}>Not enough relevant passages to draft anything defensible ({r?.confidence_rationale ?? "no result"}).
            {r?.gaps?.length ? <ul className={styles.gaps} style={{ textAlign: "left" }}>{r.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul> : null}
          </div>
        )}

        {r?.synthesis && (
          <>
            <p className={styles.synth}>{renderWithCitations(r.synthesis, known)}</p>
            <div className={styles.confidence}>
              <b>{r.confidence} confidence</b>
              <span className={styles.meta}>{r.confidence_rationale}</span>
            </div>
            {r.gaps?.length > 0 && (<>
              <p className={styles.meta} style={{ margin: "10px 0 0" }}>What a WGII author would still need</p>
              <ul className={styles.gaps}>{r.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
            </>)}
          </>
        )}
      </div>

      {resp && resp.cited_documents.length > 0 && (
        <div className={styles.panel}>
          <div className={styles.panelHead}><h2>Cited documents</h2><p>Check each citation against the source before reusing a sentence.</p></div>
          <table className={styles.table}>
            <thead><tr><th>doc_id</th><th>Document</th><th>Supports the text?</th></tr></thead>
            <tbody>
              {resp.cited_documents.map((d) => (
                <tr key={d.doc_id}>
                  <td className={`${styles.mono} ${styles.meta}`}>{d.doc_id}</td>
                  <td><span className={styles.title}>{d.title}</span><div className={styles.meta}>{d.year}, {d.region}, {d.source_type.replace("_", " ")}</div></td>
                  <td>
                    {audit[d.doc_id] ? <span className={`${styles.tag} ${audit[d.doc_id] === "citation_ok" ? styles.tagLichen : styles.tagCoral}`}>{audit[d.doc_id] === "citation_ok" ? "Verified" : "Flagged"}</span> : (
                      <div className={styles.btnRow}>
                        <button className={styles.btn} onClick={() => mark(d.doc_id, true)}>Yes</button>
                        <button className={styles.btn} onClick={() => mark(d.doc_id, false)}>No</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {r?.citations_used.filter((c) => !known.has(c)).map((c) => (
                <tr key={c}><td className={`${styles.mono} ${styles.meta}`}>{c}</td><td colSpan={2}><span className={`${styles.tag} ${styles.tagCoral}`}>Cited id not found in corpus: treat the sentence as unsupported</span></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function renderWithCitations(text: string, known: Set<string>) {
  const out: React.ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, i = 0;
  CITE.lastIndex = 0;
  while ((m = CITE.exec(text))) {
    out.push(text.slice(last, m.index));
    const bad = !known.has(m[1]);
    out.push(<span key={i++} className={styles.cite} style={bad ? { background: "#f3dcd6", color: "#b3412a" } : undefined} title={bad ? "doc_id not in corpus" : `${m[1]}, page ${m[2]}`}>{m[1]} p.{m[2]}</span>);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
