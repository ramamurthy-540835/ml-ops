"use client";
import { useEffect, useState } from "react";
import styles from "@/app/research/research.module.css";
import { mlopsApi, type Dataset } from "@/lib/mlopsApi";

export default function Datasets({ actor }: { actor: string }) {
  const [list, setList] = useState<Dataset[] | null>(null);
  const [recipes, setRecipes] = useState<Record<string, string>>({});
  const [name, setName] = useState("screening");
  const [mode, setMode] = useState<"recipe" | "sql">("recipe");
  const [recipe, setRecipe] = useState("screening");
  const [sql, setSql] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; rows: Record<string, unknown>[] } | null>(null);

  const load = () => mlopsApi.datasets().then(setList).catch((e) => setErr(String(e)));
  useEffect(() => { load(); mlopsApi.recipes().then((r) => setRecipes(r.recipes)).catch(() => {}); }, []);

  async function build() {
    if (!actor.trim()) { setErr("Enter your name in the left panel first."); return; }
    setBusy(true); setErr(null);
    try {
      await mlopsApi.createDataset({ name, recipe: mode === "recipe" ? recipe : undefined, sql: mode === "sql" ? sql : undefined, split: true, notes, created_by: actor });
      await load();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }
  async function showPreview(id: string) { setPreview({ id, rows: [] }); try { setPreview({ id, rows: await mlopsApi.preview(id) }); } catch (e) { setErr(String(e)); } }

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.panelHead}><h2>Build a new version</h2><p>Rows are written as JSONL to Cloud Storage, loaded into BigQuery and registered with a content hash.</p></div>
        <div className={styles.toolbar}>
          <input className={styles.input} style={{ minWidth: 200, flex: 0 }} value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} aria-label="Dataset name" />
          <label style={{ fontSize: 14 }}><input type="radio" checked={mode === "recipe"} onChange={() => setMode("recipe")} /> From recipe</label>
          <label style={{ fontSize: 14 }}><input type="radio" checked={mode === "sql"} onChange={() => setMode("sql")} /> From my SQL</label>
          {mode === "recipe" && <select className={styles.select} value={recipe} onChange={(e) => setRecipe(e.target.value)}>{Object.keys(recipes).map((k) => <option key={k}>{k}</option>)}</select>}
          <input className={styles.input} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes for this version (what changed and why)" />
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={build} disabled={busy || (mode === "sql" && sql.trim().length < 20)}>{busy ? "Building…" : "Build version"}</button>
        </div>
        {mode === "recipe" && recipes[recipe] && <pre className={styles.meta} style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>{recipes[recipe]}</pre>}
        {mode === "sql" && <textarea className={styles.input} rows={6} style={{ width: "100%", fontFamily: "monospace", fontSize: 12.5 }} value={sql} onChange={(e) => setSql(e.target.value)} placeholder="SELECT doc_id AS row_id, ... , label FROM `ai-ippc.climate_ai.corpus` ..." />}
        {err && <div className={styles.error} style={{ marginTop: 10 }}>{err}</div>}
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHead}><h2>Registered datasets</h2><p>Select a row to preview 20 records.</p></div>
        {!list ? <p className={styles.loading}>Loading…</p> : list.length === 0 ? <div className={styles.empty}>No datasets registered yet.</div> : (
          <table className={styles.table}><thead><tr><th>Dataset</th><th>Rows</th><th>Hash</th><th>Storage</th><th>Created</th><th /></tr></thead>
            <tbody>{list.map((d) => (
              <tr key={d.dataset_id}>
                <td><div className={styles.title}>{d.name}@v{d.version}</div><div className={styles.meta}>{d.notes}</div></td>
                <td className={styles.mono}>{d.n_rows.toLocaleString()}</td><td className={`${styles.mono} ${styles.meta}`}>{d.content_hash}</td>
                <td className={styles.meta} style={{ maxWidth: 260, wordBreak: "break-all" }}>{d.gcs_uri}<br />{d.bq_table}</td>
                <td className={styles.meta}>{d.created_by}, {new Date(d.created_at).toLocaleDateString()}</td>
                <td><button className={styles.btn} onClick={() => showPreview(d.dataset_id)}>Preview</button></td>
              </tr>))}</tbody></table>
        )}
        {preview && (
          <div className={styles.drawer}><h3>Preview</h3>
            {preview.rows.length === 0 ? <p className={styles.loading}>Loading rows…</p> : (
              <div style={{ overflowX: "auto" }}><table className={styles.table}><thead><tr>{Object.keys(preview.rows[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead>
                <tbody>{preview.rows.map((r, i) => <tr key={i}>{Object.values(r).map((v, j) => <td key={j} className={styles.meta} style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(v ?? "")}</td>)}</tr>)}</tbody></table></div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
