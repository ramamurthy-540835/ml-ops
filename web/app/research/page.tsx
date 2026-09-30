"use client";
// web/app/research/page.tsx — Research workbench: the MANILA24 agenda as five working panels.
import { useState } from "react";
import styles from "./research.module.css";
import ScreeningQueue from "@/components/research/ScreeningQueue";
import EvidenceMap from "@/components/research/EvidenceMap";
import CoverageGaps from "@/components/research/CoverageGaps";
import LivingEvidence from "@/components/research/LivingEvidence";
import SynthesisPanel from "@/components/research/SynthesisPanel";

const SECTIONS = [
  { id: "screening", name: "Screening queue", lede: "Documents ranked by a transparent logistic model on embeddings. A second opinion from Gemini appears only in the uncertain band; the decision is yours." },
  { id: "map", name: "Evidence map", lede: "Where evidence exists and where it is thin: topic clusters from KMEANS crossed with WGII regions." },
  { id: "gaps", name: "Coverage gaps", lede: "Observed share of evidence per region against an editable expected share, plus grey-literature, language and adaptation-outcome coverage." },
  { id: "living", name: "Living evidence", lede: "Publication volume per cluster since the AR6 literature cut-off, with a three-year ARIMA forecast. Clusters flagged for update are the ones to re-read first." },
  { id: "synthesis", name: "Grounded synthesis", lede: "Draft a synthesis paragraph from retrieved passages only. Every sentence cites a document and page; confidence follows the AR6 calibrated language." },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

export default function ResearchPage() {
  const [active, setActive] = useState<SectionId>("screening");
  const [reviewer, setReviewer] = useState("");
  const section = SECTIONS.find((s) => s.id === active)!;

  return (
    <div className={styles.page}>
      <aside className={styles.rail}>
        <p className={styles.railTitle}>ClimateReview AI</p>
        <p className={styles.railSub}>Research workbench for WGII evidence synthesis</p>
        <nav className={styles.nav} aria-label="Sections">
          {SECTIONS.map((s) => (
            <button key={s.id} onClick={() => setActive(s.id)} aria-current={s.id === active ? "page" : undefined}>
              {s.name}
            </button>
          ))}
        </nav>
        <div className={styles.railNote}>
          <label>
            Reviewer name (saved with your decisions)
            <input className={styles.input} style={{ minWidth: 0, width: "100%", marginTop: 6 }} value={reviewer}
                   onChange={(e) => setReviewer(e.target.value)} placeholder="e.g. R. Valavandan" />
          </label>
          <p style={{ marginTop: 14 }}>Models rank, cluster and draft. Nothing is accepted without a reviewer, and every generated claim carries a document citation.</p>
        </div>
      </aside>

      <main className={styles.main}>
        <h1 className={styles.h1}>{section.name}</h1>
        <p className={styles.lede}>{section.lede}</p>
        {active === "screening" && <ScreeningQueue reviewer={reviewer} />}
        {active === "map" && <EvidenceMap reviewer={reviewer} />}
        {active === "gaps" && <CoverageGaps />}
        {active === "living" && <LivingEvidence />}
        {active === "synthesis" && <SynthesisPanel reviewer={reviewer} />}
      </main>
    </div>
  );
}
