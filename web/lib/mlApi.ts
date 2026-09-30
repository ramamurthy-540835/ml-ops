// web/lib/mlApi.ts — typed client for the research/ML endpoints in api_ml.py
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

export type ScreeningItem = {
  doc_id: string; title: string; year: number | null; region: string | null; source_type: string;
  language: string; provenance: "synthetic" | "ingested"; p_relevant: number; priority_rank: number;
  llm_decision: "include" | "exclude" | "needs_full_text" | null; criterion: string | null;
  agrees_with_model: boolean | null; llm_reason: string | null;
  human_decision: "screen_include" | "screen_exclude" | null;
};
export type ScreeningResponse = {
  items: ScreeningItem[];
  stopping: { suggested_stop_rank: number; expected_total_relevant: number; corpus_size: number } | null;
  eval: { precision: number; recall: number; roc_auc: number; f1_score: number } | null;
  wss_at_95: number | null;
};

export type Cluster = {
  cluster_id: number; label: string | null; sector: string | null; evidence_focus: string | null;
  coherence_guess: string | null; n_docs: number; votes_coherent: number | null; votes_incoherent: number | null;
};
export type MapCell = {
  cluster_id: number; label: string | null; region: string; n_docs: number; grey_share: number;
  outcome_share: number; first_year: number; last_year: number; top_hazards: { value: string; count: number }[];
};
export type EvidenceMapResponse = { clusters: Cluster[]; cells: MapCell[]; regions: string[] };
export type ClusterDoc = { doc_id: string; title: string; year: number; region: string; source_type: string; evidence_type: string; dist_to_centroid: number };

export type RegionGap = {
  region: string; n_docs: number; observed_share: number; expected_share: number; coverage_ratio: number | null;
  grey_share: number | null; non_english_share: number | null; adaptation_share: number | null; adaptation_with_outcome_share: number | null;
};
export type GapsResponse = {
  by_region: RegionGap[];
  region_sector: { region: string; sector: string; n_docs: number; n_adaptation: number; n_maladaptation: number; n_with_outcome: number }[];
  gini_region: number | null;
  adaptation_outcomes: { context_similarity_key: string; adaptation_type: string; n_studies: number; n_positive: number; n_negative: number; n_mixed: number; mean_effect: number; sd_effect: number | null }[];
};

export type LivingAlert = {
  cluster_id: number; label: string | null; sector: string | null; n_before_ar6: number | null; n_since_ar6: number | null;
  n_forecast_3y: number | null; growth_since_ar6: number | null; update_status: "update_now" | "watch" | "stable";
};
export type LivingResponse = {
  alerts: LivingAlert[];
  history: { cluster_id: number; year: number; n_docs: number }[];
  forecast: { cluster_id: number; year: number; forecast: number; lo: number; hi: number }[];
};

export type SynthesisResult = {
  synthesis: string | null; confidence: "very high" | "high" | "medium" | "low" | null;
  confidence_rationale: string; gaps: string[]; citations_used: string[];
};
export type SynthesisResponse = {
  topic: string; region: string | null; result: SynthesisResult | null;
  cited_documents: { doc_id: string; title: string; year: number; region: string; source_type: string }[];
};

export type DecisionType = "screen_include" | "screen_exclude" | "cluster_coherent" | "cluster_incoherent" | "citation_ok" | "citation_bad";

export const mlApi = {
  screening: (p: { limit?: number; offset?: number; only_unlabelled?: boolean; region?: string } = {}) => {
    const q = new URLSearchParams();
    if (p.limit) q.set("limit", String(p.limit));
    if (p.offset) q.set("offset", String(p.offset));
    if (p.only_unlabelled !== undefined) q.set("only_unlabelled", String(p.only_unlabelled));
    if (p.region) q.set("region", p.region);
    return get<ScreeningResponse>(`/ml/screening?${q}`);
  },
  decide: (b: { doc_id?: string; cluster_id?: number; decision_type: DecisionType; reviewer: string; note?: string }) =>
    post<{ decision_id: string }>("/ml/decisions", b),
  evidenceMap: () => get<EvidenceMapResponse>("/ml/evidence-map"),
  clusterDocs: (id: number) => get<ClusterDoc[]>(`/ml/clusters/${id}/documents`),
  gaps: () => get<GapsResponse>("/ml/gaps"),
  living: () => get<LivingResponse>("/ml/living-evidence"),
  synthesis: (b: { topic: string; region?: string | null; k?: number }) => post<SynthesisResponse>("/ml/synthesis", b),
  cost: () => get<{ day: string; job_kind: string; n_jobs: number; gb_billed: number; slot_hours: number }[]>("/ml/cost"),
};
