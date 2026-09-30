"use client";
import { useEffect, useMemo, useState } from "react";
import styles from "@/app/research/research.module.css";
import { mlApi, type LivingResponse } from "@/lib/mlApi";

const AR6_CUTOFF = 2021;
const STATUS: Record<string, { text: string; cls: string }> = {
  update_now: { text: "Update now", cls: styles.tagCoral },
  watch: { text: "Watch", cls: styles.tagAmber },
  stable: { text: "Stable", cls: styles.tagLichen },
  insufficient_data: { text: "Needs more years", cls: styles.tagAmber },
};

export default function LivingEvidence() {
  const [data, setData] = useState<LivingResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { mlApi.living().then(setData).catch((e) => setErr(String(e))); }, []);

  const series = useMemo(() => {
    if (!data) return new Map<number, { hist: [number, number][]; fc: [number, number][] }>();
    const m = new Map<number, { hist: [number, number][]; fc: [number, number][] }>();
    for (const h of data.history) { if (!m.has(h.cluster_id)) m.set(h.cluster_id, { hist: [], fc: [] }); m.get(h.cluster_id)!.hist.push([h.year, h.n_docs]); }
    for (const f of data.forecast) { if (!m.has(f.cluster_id)) m.set(f.cluster_id, { hist: [], fc: [] }); m.get(f.cluster_id)!.fc.push([f.year, f.forecast]); }
    return m;
  }, [data]);

  if (err) return <div className={styles.error}>{err}</div>;
  if (!data) return <p className={styles.loading}>Loading forecasts…</p>;
  if (data.alerts.length === 0) return <div className={styles.empty}>No explicit publication-year metadata is available for clustered documents yet. Add publication-year metadata before forecasting.</div>;

  const n = { update_now: 0, watch: 0, stable: 0 } as Record<string, number>;
  data.alerts.forEach((a) => (n[a.update_status] = (n[a.update_status] ?? 0) + 1));

  return (
    <>
      <div className={styles.stats}>
        <div className={styles.stat}><b className={styles.mono}>{n.update_now}</b><span>clusters to update now</span></div>
        <div className={styles.stat}><b className={styles.mono}>{n.watch}</b><span>clusters to watch</span></div>
        <div className={styles.stat}><b className={styles.mono}>{n.stable}</b><span>stable clusters</span></div>
      </div>
      <div className={styles.panel}>
        <div className={styles.panelHead}><h2>Growth since the AR6 literature cut-off ({AR6_CUTOFF})</h2><p>Solid line is observed papers per year, dashed is the forecast, amber tick is the cut-off.</p></div>
        <table className={styles.table}>
          <thead><tr><th>Cluster</th><th>Before cut-off</th><th>Since</th><th>Growth</th><th>Next 3 years</th><th>Trend</th><th>Status</th></tr></thead>
          <tbody>
            {data.alerts.map((a) => {
              const s = series.get(a.cluster_id);
              const st = STATUS[a.update_status] ?? STATUS.stable;
              return (
                <tr key={a.cluster_id}>
                  <td><div className={styles.title}>{a.label ?? `Cluster ${a.cluster_id}`}</div><div className={styles.meta}>{a.sector}</div></td>
                  <td className={styles.mono}>{a.n_before_ar6 ?? 0}</td>
                  <td className={styles.mono}>{a.n_since_ar6 ?? 0}</td>
                  <td className={styles.mono}>{a.growth_since_ar6 == null ? "–" : `+${Math.round(a.growth_since_ar6 * 100)}%`}</td>
                  <td className={styles.mono}>{a.n_forecast_3y == null ? "–" : Math.round(a.n_forecast_3y)}</td>
                  <td>{s && <Spark hist={s.hist} fc={s.fc} />}</td>
                  <td><span className={`${styles.tag} ${st.cls}`}>{st.text}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className={styles.gapNote}>Growth is papers since {AR6_CUTOFF} divided by papers before it. Thresholds (50% update, 25% watch) live in bqml/05 and are a policy choice for the author team, not a model output.</p>
      </div>
    </>
  );
}

function Spark({ hist, fc }: { hist: [number, number][]; fc: [number, number][] }) {
  const all = [...hist, ...fc];
  if (all.length < 2) return null;
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y1 = Math.max(...ys, 1);
  const W = 160, H = 36, pad = 3;
  const X = (x: number) => pad + ((x - x0) / Math.max(1, x1 - x0)) * (W - 2 * pad);
  const Y = (y: number) => H - pad - (y / y1) * (H - 2 * pad);
  const path = (pts: [number, number][]) => pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
  const bridge = hist.length && fc.length ? [hist[hist.length - 1], ...fc] : fc;
  return (
    <svg className={styles.spark} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="papers per year with forecast">
      {AR6_CUTOFF >= x0 && AR6_CUTOFF <= x1 && <line className={styles.sparkCut} x1={X(AR6_CUTOFF)} x2={X(AR6_CUTOFF)} y1={0} y2={H} />}
      <path className={styles.sparkHist} d={path(hist)} />
      {bridge.length > 1 && <path className={styles.sparkFc} d={path(bridge)} />}
    </svg>
  );
}
