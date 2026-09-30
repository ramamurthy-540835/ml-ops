"use client";
import { useEffect, useMemo, useState } from "react";
import styles from "@/app/research/research.module.css";
import { mlApi, type ClusterDoc, type EvidenceMapResponse, type MapCell } from "@/lib/mlApi";

function ramp(t: number) { // pale blue → ocean; t in [0,1]
  const a = [0xcf, 0xe3, 0xea], b = [0x0b, 0x5f, 0x7a];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * t));
  return `rgb(${c.join(",")})`;
}

export default function EvidenceMap({ reviewer }: { reviewer: string }) {
  const [data, setData] = useState<EvidenceMapResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<MapCell | null>(null);
  const [docs, setDocs] = useState<ClusterDoc[] | null>(null);
  const [voteBusy, setVoteBusy] = useState(false);

  useEffect(() => { mlApi.evidenceMap().then(setData).catch((e) => setErr(String(e))); }, []);
  useEffect(() => {
    if (!sel) return; setDocs(null);
    mlApi.clusterDocs(sel.cluster_id).then((d) => setDocs(d.filter((x) => x.region === sel.region))).catch((e) => setErr(String(e)));
  }, [sel]);

  const grid = useMemo(() => {
    if (!data) return null;
    const max = Math.max(1, ...data.cells.map((c) => c.n_docs));
    const byKey = new Map(data.cells.map((c) => [`${c.cluster_id}|${c.region}`, c]));
    return { max, byKey };
  }, [data]);

  async function vote(coherent: boolean) {
    if (!sel) return;
    if (!reviewer.trim()) { setErr("Enter a reviewer name in the left panel to vote on cluster coherence."); return; }
    setVoteBusy(true);
    try { await mlApi.decide({ cluster_id: sel.cluster_id, decision_type: coherent ? "cluster_coherent" : "cluster_incoherent", reviewer }); }
    catch (e) { setErr(String(e)); } finally { setVoteBusy(false); }
  }

  if (err) return <div className={styles.error}>{err}</div>;
  if (!data || !grid) return <p className={styles.loading}>Loading clusters…</p>;
  if (data.clusters.length === 0) return <div className={styles.empty}>No clusters yet. Run bqml/03_evidence_map_kmeans.sql after scoring the corpus.</div>;

  const cols = data.regions;
  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <h2>{data.clusters.length} topic clusters across {cols.length} regions</h2>
        <p>Cell colour is document count; select a cell to see its documents.</p>
      </div>

      <div className={styles.heat} style={{ gridTemplateColumns: `240px repeat(${cols.length}, minmax(70px, 1fr))` }}>
        <div />
        {cols.map((r) => <div key={r} className={styles.heatCol}>{r}</div>)}
        {data.clusters.map((cl) => (
          <RowFragment key={cl.cluster_id} cl={cl} cols={cols} grid={grid} sel={sel} onSel={setSel} />
        ))}
      </div>
      <div className={styles.legend}><span>fewer</span><span className={styles.legendRamp} /><span>more documents</span><span style={{ marginLeft: 16 }}>Blank cells are the gaps.</span></div>

      {sel && (
        <div className={styles.drawer}>
          <h3>{sel.label ?? `Cluster ${sel.cluster_id}`} in {sel.region}: {sel.n_docs} documents, {sel.first_year}–{sel.last_year}</h3>
          <p className={styles.meta}>
            Grey literature {Math.round(sel.grey_share * 100)}%, adaptation outcomes measured in {Math.round(sel.outcome_share * 100)}%.
            {sel.top_hazards?.length ? ` Hazards: ${sel.top_hazards.map((h) => h.value).join(", ")}.` : ""}
          </p>
          <div className={styles.btnRow} style={{ margin: "8px 0 12px" }}>
            <span className={styles.meta} style={{ alignSelf: "center" }}>Is this cluster coherent as a topic?</span>
            <button className={styles.btn} disabled={voteBusy} onClick={() => vote(true)}>Yes, coherent</button>
            <button className={styles.btn} disabled={voteBusy} onClick={() => vote(false)}>No, mixed</button>
          </div>
          {!docs ? <p className={styles.loading}>Loading documents…</p> : (
            <ul className={styles.docList}>
              {docs.map((d) => (
                <li key={d.doc_id}>
                  <span><span className={styles.title}>{d.title}</span> <span className={styles.meta}>{d.year}, {d.evidence_type}</span></span>
                  <span className={`${styles.meta} ${styles.mono}`}>{d.doc_id}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function RowFragment({ cl, cols, grid, sel, onSel }: {
  cl: EvidenceMapResponse["clusters"][number]; cols: string[];
  grid: { max: number; byKey: Map<string, MapCell> }; sel: MapCell | null; onSel: (c: MapCell) => void;
}) {
  return (
    <>
      <div className={styles.heatRowLabel}>
        <b>{cl.label ?? `Cluster ${cl.cluster_id}`}</b>
        <span className={styles.meta}>{[cl.sector, cl.evidence_focus, `${cl.n_docs} docs`].filter(Boolean).join(", ")}</span>
      </div>
      {cols.map((r) => {
        const c = grid.byKey.get(`${cl.cluster_id}|${r}`);
        if (!c) return <div key={r} className={`${styles.cell} ${styles.cellEmpty}`} aria-label={`no documents for ${cl.label} in ${r}`}>–</div>;
        const t = Math.log1p(c.n_docs) / Math.log1p(grid.max);
        const selected = sel?.cluster_id === c.cluster_id && sel?.region === c.region;
        return (
          <button key={r} className={`${styles.cell} ${selected ? styles.cellSelected : ""}`}
                  style={{ background: ramp(t), color: t > 0.45 ? "#fff" : "#1b2a33" }}
                  onClick={() => onSel(c)} aria-label={`${c.n_docs} documents for ${cl.label} in ${r}`}>
            {c.n_docs}
          </button>
        );
      })}
    </>
  );
}
