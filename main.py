from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from api_ml import router as ml_router
from api_mlops import router as mlops_router

ROOT = Path(__file__).parent
WEB_OUT = ROOT / "out"

app = FastAPI(title="ClimateReview AI", version="1.0.0")
app.include_router(ml_router)
app.include_router(mlops_router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "climatereview-ai"}


@app.get("/api")
def api_index() -> dict[str, object]:
    return {"service": "ClimateReview AI", "research": "/ml", "mlops": "/mlops"}


if WEB_OUT.exists():
    app.mount("/_next", StaticFiles(directory=WEB_OUT / "_next"), name="next-assets")
    app.mount("/assets", StaticFiles(directory=WEB_OUT / "assets"), name="assets") if (WEB_OUT / "assets").exists() else None


def _page(name: str) -> FileResponse:
    return FileResponse(WEB_OUT / name / "index.html")


@app.get("/")
def home():
    return RedirectResponse("/research")


@app.get("/research")
def research():
    return _page("research")


@app.get("/mlops")
def mlops():
    return _page("mlops")
