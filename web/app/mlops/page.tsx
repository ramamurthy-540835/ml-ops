"use client";
// web/app/mlops/page.tsx — MLOps console: dataset → labeling → training → registry → runs, all controlled here.
import { useState } from "react";
import styles from "@/app/research/research.module.css";
import Overview from "@/components/mlops/Overview";
import Datasets from "@/components/mlops/Datasets";
import Labeling from "@/components/mlops/Labeling";
import Training from "@/components/mlops/Training";
import Models from "@/components/mlops/Models";
import Runs from "@/components/mlops/Runs";

const TABS = [
  { id: "overview", name: "Pipeline", lede: "The whole loop at a glance: what data exists, what is being labelled, what is training, and what is in production." },
  { id: "datasets", name: "Datasets", lede: "Build a versioned JSONL dataset from a recipe or your own SQL. Each version is stored in Cloud Storage and loaded into BigQuery; versions never change." },
  { id: "labeling", name: "Labeling", lede: "Gemini pre-labels rows; you confirm or correct them. The queue shows the most uncertain rows first so each label teaches the model the most." },
  { id: "training", name: "Training", lede: "Choose a learning type, a model and its parameters, or let BigQuery search a range. Preview the exact SQL before you run it." },
  { id: "models", name: "Models", lede: "Every trained model with its evaluation and quality-gate result. Promotion to production repoints the alias the app reads from; it needs a reason." },
  { id: "runs", name: "Runs & monitoring", lede: "Training and pipeline runs, cost per learning type, score drift and how often reviewers override the production model." },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function MlopsPage() {
  const [tab, setTab] = useState<TabId>("overview");
  const [actor, setActor] = useState("");
  const t = TABS.find((x) => x.id === tab)!;
  return (
    <div className={styles.page}>
      <aside className={styles.rail}>
        <p className={styles.railTitle}>ClimateReview AI</p>
        <p className={styles.railSub}>MLOps console</p>
        <nav className={styles.nav} aria-label="MLOps sections">
          {TABS.map((x) => <button key={x.id} onClick={() => setTab(x.id)} aria-current={x.id === tab ? "page" : undefined}>{x.name}</button>)}
        </nav>
        <div className={styles.railNote}>
          <label>Your name (recorded on datasets, labels and promotions)
            <input className={styles.input} style={{ minWidth: 0, width: "100%", marginTop: 6 }} value={actor} onChange={(e) => setActor(e.target.value)} placeholder="e.g. R. Valavandan" />
          </label>
        </div>
      </aside>
      <main className={styles.main}>
        <h1 className={styles.h1}>{t.name}</h1>
        <p className={styles.lede}>{t.lede}</p>
        {tab === "overview" && <Overview go={(id) => setTab(id as TabId)} />}
        {tab === "datasets" && <Datasets actor={actor} />}
        {tab === "labeling" && <Labeling actor={actor} />}
        {tab === "training" && <Training actor={actor} />}
        {tab === "models" && <Models actor={actor} />}
        {tab === "runs" && <Runs />}
      </main>
    </div>
  );
}
