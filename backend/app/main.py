from __future__ import annotations

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .models import PathwayResponse
from .translator import build_metabolic_graph, build_metabolic_graph_from_sbml

app = FastAPI(title="MetPath Studio API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/pathway/{pathway_id}", response_model=PathwayResponse)
def get_pathway(
    pathway_id: str,
    hide_cofactors: bool = Query(default=False, description="Hide common cofactor compounds"),
):
    try:
        return build_metabolic_graph(pathway_id, hide_cofactors=hide_cofactors)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/api/import/sbml", response_model=PathwayResponse)
async def import_sbml(file: UploadFile = File(...)) -> PathwayResponse:
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    try:
        return build_metabolic_graph_from_sbml(content)
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to import SBML: {exc}")
