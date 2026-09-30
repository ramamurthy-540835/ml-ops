"use client";
import { useEffect, useState } from "react";
import styles from "@/app/research/research.module.css";
import { mlApi, type GapsResponse } from "@/lib/mlApi";

const pct = (x: number | null | undefined) => (x == null ? "–" : `${Math.round(x * 100)}%`);

export default function CoverageGaps() {
  const [data, setData] = useState<GapsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { mlApi.gaps().then(setData).catch((e) => setErr(String(e))); }, []);

  if (err) return <div className={styles.error}>{err}</div>;
  if (!data) return <p className={styles.loading}>Computing coverage…</p>;

  const maxShare = Math.max(...data.by_region.map((r) => Math.max(r.observed_share, r.expected_share)), 0.01);
  const under = data.by_region.filter((r) => (r.coverage_ratio ?? 1) < 0.6);

  return (
    <>
      <div className={styles.stats}>
        <div className={styles.stat}><b className={styles.mono}>{data.gini_region?.toFixed(2) ?? "–"}</b><span>Gini of documents across regions (0 even, 1 concentrated)</span></div>
        <div className={styles.stat}><b className={styles.mono}>{under.length}</b><span>regions below 60% of expected coverage</span></div>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHead}><h2>Evidence share by WGII region</h2><p>Blue bar is observed share; the black tick is the expected share from climate_ai.region_expected_share.</p></div>
        {data.by_region.map((r) => (
          <div key={r.region} className={styles.gapRow}>
            <div><div className={styles.title}>{r.region}</div><div className={styles.meta}>{r.n_docs.toLocaleString()} docs, {pct(r.grey_share)} grey, {pct(r.non_english_share)} non-English</div></div>
            <div className={styles.gapTrack}>
              <div className={styles.gapObs} style={{ width: `${(r.observed_share / maxShare) * 100}%` }} />
              <div className={styles.gapExp} style={{ left: `${(r.expected_share / maxShare) * 100}%` }} title={`expected ${pct(r.expected_share)}`} />
            </div>
            <span className={`${styles.tag} ${styles.mono} ${(r.coverage_ratio ?? 1) < 0.6 ? styles.tagCoral : (r.coverage_ratio ?? 1) < 1 ? styles.tagAmber : styles.tagLichen}`}>
              {r.coverage_ratio == null ? "–" : `${r.coverage_ratio.toFixed(2)}×`}
            </span>
          </div>
        ))}
        <p className={styles.gapNote}>
          The expected share is a stated prior, not a fact: edit the table to reflect exposed population, hazard incidence, or any other basis your author team agrees on. The ratio shows how far the literature departs from it.
        </p>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHead}><h2>Adaptation evidence with measured outcomes</h2><p>Share of adaptation papers that report a metric and a direction.</p></div>
        <table className={styles.table}>
          <thead><tr><th>Region</th><th>Adaptation papers</th><th>With measured outcome</th></tr></thead>
          <tbody>
            {data.by_region.map((r) => (
              <tr key={r.region}><td>{r.region}</td><td className={styles.mono}>{pct(r.adaptation_share)} of docs</td><td className={styles.mono}>{pct(r.adaptation_with_outcome_share)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHead}><h2>Adaptation outcomes aggregated by similar context</h2><p>Region, sector and hazard combined; counts of positive, negative and mixed results.</p></div>
        {data.adaptation_outcomes.length === 0 ? <div className={styles.empty}>No outcome records yet. They come from the synthetic corpus or from bqml/06 step C.</div> : (
          <table className={styles.table}>
            <thead><tr><th>Context</th><th>Type</th><th>Studies</th><th>Positive</th><th>Negative</th><th>Mixed</th><th>Mean effect</th></tr></thead>
            <tbody>
              {data.adaptation_outcomes.map((o) => (
                <tr key={o.context_similarity_key + o.adaptation_type}>
                  <td>{o.context_similarity_key.split("|").join(", ")}</td>
                  <td><span className={`${styles.tag} ${o.adaptation_type === "nature-based" ? styles.tagLichen : ""}`}>{o.adaptation_type}</span></td>
                  <td className={styles.mono}>{o.n_studies}</td>
                  <td className={styles.mono}>{o.n_positive}</td>
                  <td className={styles.mono} style={{ color: o.n_negative > o.n_positive ? "#b3412a" : undefined }}>{o.n_negative}</td>
                  <td className={styles.mono}>{o.n_mixed}</td>
                  <td className={styles.mono}>{o.mean_effect.toFixed(2)}{o.sd_effect != null ? ` ± ${o.sd_effect.toFixed(2)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
