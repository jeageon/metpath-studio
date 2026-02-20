MetPath Studio
==============

Phase 1 + 2 + 3 MVP scaffold for KEGG-based metabolic map visualization:
FastAPI backend translates KEGG KGML to a metabolite-centered JSON model,
React + Cytoscape front-end renders editable canvas and exports SVG.

## Quick start

Backend
```bash
cd "/Users/jg/Documents/MetPath Studio/backend"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Frontend
```bash
cd "/Users/jg/Documents/MetPath Studio/frontend"
npm install
npm run dev
```

Visit:
- Frontend: `http://localhost:5173`
- Backend health: `http://localhost:8000/health`
- Sample API: `http://localhost:8000/api/pathway/eco00670`

## Current phase

This repository currently implements Phase 1 + Phase 2 core + Phase 3 routing/alignment scaffolding:
1) KEGG ID fetch and KGML parsing
2) metabolite node + reaction edge translation
3) baseline editing UX (select/move/delete)
4) cofactor hide/show filter
5) edge state presets (up/down/removed)
6) KO center X marker
7) cassette text attachment as snapped decorator nodes near reaction
8) automatic legend by canvas-visible style usage
9) SVG export helper
10) edge routing preset (Bezier / Orthogonal) with segment offsets
11) template-alignment actions for selected nodes (TCA Ring, Glycolysis vertical flow)

## Planned follow-up

- Phase 3 정밀화: 라우팅 충돌 감소 및 선택 기반 템플릿 정렬 UX 개선
- Phase 4: omics overlays and SBML import
