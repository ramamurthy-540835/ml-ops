"""
Generate a synthetic IPCC-WGII-style evidence corpus for ClimateReview AI.

Outputs (JSONL, one file per BigQuery table):
  documents.jsonl          – metadata + abstract, aligned with climate_ai.documents
  embeddings.jsonl         – 768-d vectors; topic-structured so KMEANS/LOGISTIC_REG work
  screening_labels.jsonl   – human-style relevance labels with train/val/test split
  adaptation_outcomes.jsonl – outcome records for adaptation papers (tracks §2.2)
  chunks.jsonl             – page-aware text chunks for grounded synthesis / VECTOR_SEARCH

The corpus is DELIBERATELY skewed (English, Europe/North America, peer-reviewed) to
reproduce the coverage imbalance the MANILA24 report describes. Use --balanced to
generate a counterfactual corpus for comparison.

Usage:
  python generate_synthetic_corpus.py --n 6000 --out data/synthetic [--seed 7] [--balanced]
  python generate_synthetic_corpus.py --n 6000 --out data/synthetic --real-embeddings
      (uses Vertex AI text-embedding-005; needs GOOGLE_CLOUD_PROJECT + ADC)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
from dataclasses import dataclass, asdict
from datetime import date
from pathlib import Path

import numpy as np

# ----------------------------------------------------------------------------
# Controlled vocabularies (WGII AR6 structure)
# ----------------------------------------------------------------------------
REGIONS = {
    # region: (weight_skewed, weight_balanced, example countries)
    "Africa": (0.09, 0.16, ["Kenya", "Nigeria", "Ethiopia", "Mozambique", "Senegal", "Benin"]),
    "Asia": (0.16, 0.20, ["India", "Bangladesh", "Viet Nam", "Indonesia", "Pakistan", "Nepal"]),
    "Australasia": (0.07, 0.06, ["Australia", "New Zealand", "Papua New Guinea"]),
    "Central and South America": (0.07, 0.12, ["Brazil", "Peru", "Colombia", "Bolivia", "Chile"]),
    "Europe": (0.24, 0.14, ["Netherlands", "Germany", "Italy", "Spain", "United Kingdom", "Finland"]),
    "North America": (0.26, 0.14, ["United States", "Canada", "Mexico"]),
    "Small Islands": (0.05, 0.10, ["Fiji", "Maldives", "Vanuatu", "Barbados", "Tuvalu"]),
    "Polar Regions": (0.06, 0.08, ["Greenland", "Svalbard", "Antarctica", "Alaska"]),
}

SECTORS = [
    "Terrestrial and freshwater ecosystems",
    "Ocean and coastal ecosystems",
    "Water",
    "Food, fibre and other ecosystem products",
    "Cities, settlements and key infrastructure",
    "Health, wellbeing and communities",
    "Poverty, livelihoods and sustainable development",
]

HAZARDS = [
    "heatwaves", "drought", "riverine flooding", "coastal flooding", "sea-level rise",
    "tropical cyclones", "wildfire", "ocean acidification", "glacier retreat",
    "permafrost thaw", "extreme precipitation", "marine heatwaves", "saltwater intrusion",
]

EVIDENCE_TYPES = {  # (weight)
    "impact": 0.46, "vulnerability": 0.20, "adaptation": 0.28, "maladaptation": 0.06,
}
ADAPTATION_TYPES = ["technological", "institutional", "behavioural", "nature-based"]

SOURCE_TYPES = {  # skewed weight, balanced weight
    "peer_reviewed": (0.78, 0.55),
    "preprint": (0.07, 0.08),
    "policy_report": (0.06, 0.12),
    "ngo_report": (0.04, 0.10),
    "indigenous_knowledge": (0.01, 0.06),
    "news": (0.03, 0.05),
    "social_media": (0.01, 0.04),
}

LANGUAGES = {  # skewed, balanced
    "en": (0.88, 0.55), "es": (0.04, 0.12), "fr": (0.03, 0.08), "pt": (0.02, 0.07),
    "zh": (0.01, 0.06), "hi": (0.005, 0.04), "sw": (0.005, 0.04), "ar": (0.01, 0.04),
}

CONFIDENCE = ["very high", "high", "medium", "low"]
AGREEMENT = ["robust evidence, high agreement", "medium evidence, medium agreement",
             "limited evidence, low agreement"]

METRICS = ["crop yield (t/ha)", "heat-related mortality (per 100k)", "households displaced",
           "coral cover (%)", "water stress index", "economic loss (USD m)", "species range shift (km)"]

# ----------------------------------------------------------------------------
# Text templates (kept modest; the point is structure and labels, not prose)
# ----------------------------------------------------------------------------
TITLE_TPL = {
    "impact": [
        "Observed impacts of {hazard} on {sector_short} in {country}",
        "Attribution of {hazard}-driven losses in {country}, {y0}-{y1}",
        "{Hazard} and {sector_short}: evidence from {country}",
    ],
    "vulnerability": [
        "Differential vulnerability to {hazard} among {group} in {country}",
        "Mapping exposure and vulnerability to {hazard} in {country}",
    ],
    "adaptation": [
        "{Adapt} adaptation to {hazard}: outcomes from {country}",
        "Evaluating {adapt} responses to {hazard} in {sector_short}, {country}",
        "Does {adapt} adaptation reduce {hazard} risk? A {country} case",
    ],
    "maladaptation": [
        "Lock-in and unequal outcomes of {adapt} responses to {hazard} in {country}",
        "When adaptation backfires: {adapt} measures and {hazard} in {country}",
    ],
}

ABSTRACT_TPL = (
    "We assess {etype_phrase} associated with {hazard} affecting {sector_lower} in {country} "
    "({region}) over {y0}-{y1}. Using {method}, we find {finding}. "
    "{adapt_sentence}Evidence is characterised as {agreement}; we assign {confidence} confidence. "
    "{outcome_sentence}Findings are relevant to IPCC WGII assessment of {sector_lower}."
)

METHODS = ["a multi-model ensemble and observational records", "household surveys and remote sensing",
           "a systematic review of 140 studies", "panel regression on district data",
           "participatory mapping with local knowledge holders", "process-based crop modelling",
           "hydrological simulation under SSP scenarios"]

FINDINGS = ["losses concentrated among low-income households", "a doubling of exposure since 2000",
            "a 12-18% decline in the primary indicator", "non-linear increases beyond 1.5 C",
            "substantial spatial heterogeneity in risk", "early-warning systems reduced mortality by a third"]

GROUPS = ["smallholder farmers", "informal urban settlements", "coastal fishing communities",
          "pastoralists", "outdoor workers", "Indigenous communities", "older adults"]

# Off-topic "distractor" documents for screening (label = 0)
DISTRACTOR_TITLES = [
    "A survey of transformer architectures for retrieval",
    "Corporate ESG disclosure quality and stock returns",
    "Photovoltaic inverter efficiency under partial shading",
    "Historical climatology of the Little Ice Age in Europe",
    "Carbon pricing pass-through in electricity markets",
    "Battery recycling supply chains: a techno-economic review",
]


@dataclass
class Doc:
    doc_id: str
    title: str
    abstract: str
    year: int
    source_type: str
    language: str
    region: str
    country: str
    sector: str
    hazard: str
    evidence_type: str
    adaptation_type: str | None
    outcome_reported: bool
    confidence_language: str
    evidence_agreement: str
    credibility_score: float
    doi: str | None
    n_pages: int
    ingested_at: str


def wchoice(rng: random.Random, table: dict, idx: int | None = None):
    keys = list(table.keys())
    if idx is None:
        weights = list(table.values())
    else:
        weights = [v[idx] for v in table.values()]
    return rng.choices(keys, weights=weights, k=1)[0]


def make_doc(i: int, rng: random.Random, balanced: bool) -> Doc:
    wi = 1 if balanced else 0
    region = wchoice(rng, REGIONS, wi)
    country = rng.choice(REGIONS[region][2])
    sector = rng.choice(SECTORS)
    hazard = rng.choice(HAZARDS)
    etype = wchoice(rng, EVIDENCE_TYPES)
    adapt = rng.choice(ADAPTATION_TYPES) if etype in ("adaptation", "maladaptation") else None
    source = wchoice(rng, SOURCE_TYPES, wi)
    lang = wchoice(rng, LANGUAGES, wi)
    # literature grows exponentially: skew years towards recent
    year = int(np.clip(2026 - rng.expovariate(1 / 5.5), 2005, 2026))
    y0, y1 = max(1980, year - rng.randint(10, 40)), year - 1
    outcome = (etype == "adaptation" and rng.random() < 0.38) or (etype == "maladaptation" and rng.random() < 0.6)
    conf = rng.choices(CONFIDENCE, weights=[0.15, 0.4, 0.33, 0.12])[0]
    agreement = AGREEMENT[CONFIDENCE.index(conf) // 2 if conf != "medium" else 1]
    sector_short = sector.split(",")[0].split(" and ")[0].lower()

    ctx = dict(hazard=hazard, Hazard=hazard.capitalize(), sector_short=sector_short,
               sector_lower=sector.lower(), country=country, region=region, y0=y0, y1=y1,
               adapt=adapt or "", Adapt=(adapt or "").capitalize(), group=rng.choice(GROUPS))
    title = rng.choice(TITLE_TPL[etype]).format(**ctx)
    adapt_sentence = (f"The {adapt} adaptation studied is {rng.choice(['community-led', 'state-funded', 'privately financed'])}. "
                      if adapt else "")
    outcome_sentence = (f"Outcome was measured as {rng.choice(METRICS)} with a "
                        f"{rng.choice(['positive', 'negative', 'mixed'])} effect. " if outcome else "")
    etype_phrase = {"impact": "observed impacts", "vulnerability": "vulnerability and exposure",
                    "adaptation": "adaptation responses", "maladaptation": "maladaptive outcomes"}[etype]
    abstract = ABSTRACT_TPL.format(etype_phrase=etype_phrase, method=rng.choice(METHODS),
                                   finding=rng.choice(FINDINGS), adapt_sentence=adapt_sentence,
                                   agreement=agreement, confidence=conf,
                                   outcome_sentence=outcome_sentence, **ctx)
    cred_base = {"peer_reviewed": 0.85, "preprint": 0.65, "policy_report": 0.7, "ngo_report": 0.6,
                 "indigenous_knowledge": 0.7, "news": 0.4, "social_media": 0.25}[source]
    doc_id = f"syn-{hashlib.sha1(f'{i}-{title}'.encode()).hexdigest()[:12]}"
    return Doc(doc_id, title, abstract, year, source, lang, region, country, sector, hazard, etype,
               adapt, outcome, conf, agreement, round(min(1, max(0, rng.gauss(cred_base, 0.08))), 3),
               f"10.5555/syn.{year}.{i}" if source in ("peer_reviewed", "preprint") else None,
               rng.randint(6, 28), date.today().isoformat())


def make_distractor(i: int, rng: random.Random) -> Doc:
    title = rng.choice(DISTRACTOR_TITLES) + f" ({rng.randint(1, 99)})"
    abstract = ("This paper does not address climate impacts, adaptation or vulnerability. "
                "It concerns " + title.lower() + ".")
    year = rng.randint(2010, 2026)
    return Doc(f"syn-x{hashlib.sha1(f'{i}{title}'.encode()).hexdigest()[:11]}", title, abstract, year,
               "peer_reviewed", "en", "Europe", "Germany", "n/a", "n/a", "off_topic", None, False,
               "low", "n/a", 0.8, f"10.5555/off.{i}", rng.randint(4, 15), date.today().isoformat())


# ----------------------------------------------------------------------------
# Embeddings: topic-structured pseudo-embeddings (or real Vertex embeddings)
# ----------------------------------------------------------------------------
def pseudo_embeddings(docs: list[Doc], dim: int, rng: np.random.Generator) -> np.ndarray:
    """Centroid(sector×evidence_type) + region offset + hazard offset + noise, L2-normalised.
    KMEANS recovers ~sector×evidence_type clusters; LOGISTIC_REG separates off_topic."""
    def unit(key: str) -> np.ndarray:
        g = np.random.default_rng(int(hashlib.md5(key.encode()).hexdigest(), 16) % 2**32)
        v = g.normal(size=dim)
        return v / np.linalg.norm(v)

    out = np.zeros((len(docs), dim), dtype=np.float32)
    for k, d in enumerate(docs):
        v = 1.0 * unit(f"topic|{d.sector}|{d.evidence_type}") \
            + 0.45 * unit(f"region|{d.region}") \
            + 0.35 * unit(f"hazard|{d.hazard}") \
            + 0.55 * rng.normal(size=dim) / np.sqrt(dim) * np.sqrt(dim) * 0.15
        out[k] = v / np.linalg.norm(v)
    return out


def real_embeddings(docs: list[Doc], model: str = "text-embedding-005") -> np.ndarray:
    from vertexai.language_models import TextEmbeddingModel, TextEmbeddingInput  # lazy import
    import vertexai
    vertexai.init(project=os.environ["GOOGLE_CLOUD_PROJECT"], location=os.getenv("VERTEX_LOCATION", "us-central1"))
    m = TextEmbeddingModel.from_pretrained(model)
    vecs = []
    for s in range(0, len(docs), 100):
        batch = [TextEmbeddingInput(f"{d.title}. {d.abstract}", "RETRIEVAL_DOCUMENT") for d in docs[s:s + 100]]
        vecs.extend([e.values for e in m.get_embeddings(batch)])
    return np.asarray(vecs, dtype=np.float32)


# ----------------------------------------------------------------------------
def chunks_for(d: Doc, rng: random.Random) -> list[dict]:
    """Page-aware chunks compatible with the repo's bounded-evidence retrieval."""
    sents = d.abstract.split(". ")
    out, page = [], 1
    for j, s in enumerate(sents):
        if not s.strip():
            continue
        out.append({"chunk_id": f"{d.doc_id}-c{j}", "doc_id": d.doc_id, "page": page,
                    "chunk_index": j, "text": s.strip().rstrip(".") + ".",
                    "char_start": j * 220, "char_end": j * 220 + len(s)})
        if rng.random() < 0.35:
            page = min(d.n_pages, page + 1)
    return out


def write_jsonl(path: Path, rows) -> int:
    n = 0
    with path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=6000)
    ap.add_argument("--distractor-frac", type=float, default=0.15)
    ap.add_argument("--dim", type=int, default=768)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="data/synthetic")
    ap.add_argument("--balanced", action="store_true", help="counterfactual, coverage-balanced corpus")
    ap.add_argument("--real-embeddings", action="store_true")
    a = ap.parse_args()

    rng, nrng = random.Random(a.seed), np.random.default_rng(a.seed)
    n_dis = int(a.n * a.distractor_frac)
    docs = [make_doc(i, rng, a.balanced) for i in range(a.n - n_dis)] + [make_distractor(i, rng) for i in range(n_dis)]
    rng.shuffle(docs)

    emb = real_embeddings(docs) if a.real_embeddings else pseudo_embeddings(docs, a.dim, nrng)

    # labels: ~25% "annotated" by two synthetic annotators with 6% disagreement noise
    labels = []
    for d in docs:
        if rng.random() > 0.25:
            continue
        gold = 0 if d.evidence_type == "off_topic" else 1
        noisy = gold if rng.random() > 0.06 else 1 - gold
        split = rng.choices(["train", "val", "test"], [0.7, 0.15, 0.15])[0]
        labels.append({"doc_id": d.doc_id, "label": gold, "annotator": "A1", "split": split})
        if rng.random() < 0.5:
            labels.append({"doc_id": d.doc_id, "label": noisy, "annotator": "A2", "split": split})

    outcomes = [{
        "doc_id": d.doc_id, "adaptation_type": d.adaptation_type,
        "action": f"{d.adaptation_type} response to {d.hazard}",
        "outcome_direction": rng.choice(["positive", "negative", "mixed"]) if d.evidence_type == "adaptation" else "negative",
        "metric": rng.choice(METRICS), "effect_size": round(rng.gauss(0.0, 0.25), 3),
        "context_similarity_key": f"{d.region}|{d.sector}|{d.hazard}",
    } for d in docs if d.outcome_reported]

    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    n_docs = write_jsonl(out / "documents.jsonl", (asdict(d) for d in docs))
    write_jsonl(out / "embeddings.jsonl", ({"doc_id": d.doc_id, "model": "synthetic-768" if not a.real_embeddings else "text-embedding-005",
                                            "embedding": [round(float(x), 6) for x in emb[i]]} for i, d in enumerate(docs)))
    n_lab = write_jsonl(out / "screening_labels.jsonl", labels)
    n_out = write_jsonl(out / "adaptation_outcomes.jsonl", outcomes)
    n_chk = write_jsonl(out / "chunks.jsonl", (c for d in docs for c in chunks_for(d, rng)))

    # quick bias report so the skew is visible immediately
    from collections import Counter
    reg = Counter(d.region for d in docs if d.evidence_type != "off_topic")
    lang = Counter(d.language for d in docs)
    print(f"docs={n_docs} labels={n_lab} outcomes={n_out} chunks={n_chk} balanced={a.balanced}")
    print("region share:", {k: round(v / sum(reg.values()), 3) for k, v in reg.most_common()})
    print("language share:", {k: round(v / n_docs, 3) for k, v in lang.most_common()})


if __name__ == "__main__":
    main()
