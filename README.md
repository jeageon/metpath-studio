MetPath Studio
==============

Phase 1 + 2 + 3 MVP scaffold for KEGG-based metabolic map visualization:
FastAPI backend translates KEGG KGML to a metabolite-centered JSON model,
React + Cytoscape front-end renders editable canvas and exports SVG/PNG/TIFF.

## Quick start

### 원클릭(권장) 실행: 스크립트 한 번으로 바로 시작

```bash
cd "/Users/jg/Documents/MetPath Studio"
bash scripts/run-local.sh
```

Stop:

```bash
bash scripts/stop-local.sh
```

Smoke test:

```bash
bash scripts/check-local.sh
```

### 포트 기본값

- Backend: `8000` (`METPATH_BACKEND_PORT`)
- Frontend: `5173` (`METPATH_FRONTEND_PORT`)

예시:

```bash
METPATH_BACKEND_PORT=8001 METPATH_FRONTEND_PORT=4173 bash scripts/run-local.sh
```

### 수동 실행(설치만 분리)

Backend
```bash
cd "/Users/jg/Documents/MetPath Studio/backend"
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Frontend
```bash
cd "/Users/jg/Documents/MetPath Studio/frontend"
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Visit:
- Frontend: `http://127.0.0.1:5173`
- Backend health: `http://127.0.0.1:8000/health`
- Sample API: `http://127.0.0.1:8000/api/pathway/eco00670`

또는 바로 체크 스크립트 실행:

```bash
bash scripts/check-local.sh
```

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
9) SVG/PNG/TIFF export helper
10) edge routing preset (Bezier / Orthogonal) with segment offsets
11) template-alignment actions for selected nodes (TCA Ring, Glycolysis vertical flow)

## Planned follow-up

- Phase 3 정밀화: 라우팅 충돌 감소 및 선택 기반 템플릿 정렬 UX 개선
- Phase 4: omics overlays and SBML import
