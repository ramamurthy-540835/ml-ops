"""
api_ml.py — FastAPI router for the research/ML layer. Mount in api.py:

    from api_ml import router as ml_router
    app.include_router(ml_router)

Endpoints (all JSON):
  GET  /ml/screening?limit=&offset=&only_unlabelled=&region=
  POST /ml/decisions           {doc_id|cluster_id, decision_type, reviewer, note}
  GET  /ml/evidence-map
  GET  /ml/clusters/{cluster_id}/documents
  GET  /ml/gaps
  GET  /ml/living-evidence
  POST /ml/synthesis           {topic, region?, k?}
  GET  /ml/cost
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from services import ml_service as ml

router = APIRouter(prefix="/ml", tags=["research-ml"])

DecisionType = Literal["screen_include", "screen_exclude", "cluster_coherent",
                       "cluster_incoherent", "citation_ok", "citation_bad"]


class DecisionIn(BaseModel):
    doc_id: str | None = None
    cluster_id: int | None = None
    decision_type: DecisionType
    reviewer: str = Field(min_length=1, max_length=120)
    note: str | None = Field(default=None, max_length=1000)


class SynthesisIn(BaseModel):
    topic: str = Field(min_length=3, max_length=400)
    region: str | None = None
    k: int = Field(default=8, ge=2, le=20)


def _guard(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except Exception as e:  # surface BigQuery errors plainly; never fabricate results
        raise HTTPException(status_code=502, detail=f"BigQuery: {e}") from e


@router.get("/screening")
def screening(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
              only_unlabelled: bool = True, region: str | None = None):
    return _guard(ml.screening_queue, limit, offset, only_unlabelled, region)


@router.post("/decisions")
def decisions(body: DecisionIn):
    if body.doc_id is None and body.cluster_id is None:
        raise HTTPException(400, "doc_id or cluster_id required")
    return _guard(ml.record_decision, body.doc_id, body.cluster_id, body.decision_type, body.reviewer, body.note)


@router.get("/evidence-map")
def evidence_map():
    return _guard(ml.evidence_map)


@router.get("/clusters/{cluster_id}/documents")
def cluster_docs(cluster_id: int, limit: int = Query(30, ge=1, le=200)):
    return _guard(ml.cluster_documents, cluster_id, limit)


@router.get("/gaps")
def gaps():
    return _guard(ml.coverage_gaps)


@router.get("/living-evidence")
def living():
    return _guard(ml.living_evidence)


@router.post("/synthesis")
def synthesis(body: SynthesisIn):
    return _guard(ml.grounded_synthesis, body.topic, body.region, body.k)


@router.get("/cost")
def cost():
    return _guard(ml.cost_ledger)
