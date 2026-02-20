#!/usr/bin/env bash
set -euo pipefail

BACKEND_PORT="${METPATH_BACKEND_PORT:-8000}"
FRONTEND_PORT="${METPATH_FRONTEND_PORT:-5173}"

BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
FRONTEND_URL="http://127.0.0.1:${FRONTEND_PORT}"

status=0

check_backend() {
  if ! curl -fsS "$BACKEND_URL/health" >/dev/null; then
    echo "[FAIL] backend healthcheck failed: $BACKEND_URL/health"
    status=1
    return
  fi

  local health_body
  health_body="$(curl -fsS "$BACKEND_URL/health")"

  if ! python3 - "$health_body" <<'PY'
import json
import sys
body = json.loads(sys.argv[1])
if body.get('status') != 'ok':
    raise SystemExit(1)
PY
  then
    echo "[FAIL] backend health response is invalid: $health_body"
    status=1
    return
  fi

  echo "[OK] backend health: $health_body"
}

check_frontend() {
  if ! curl -fsS "$FRONTEND_URL" >/dev/null; then
    echo "[FAIL] frontend is not reachable: $FRONTEND_URL"
    status=1
    return
  fi
  echo "[OK] frontend reachable: $FRONTEND_URL"
}

check_sample_api() {
  local api_tmp="/tmp/metpath-sample-api.json"
  local summary_tmp="/tmp/metpath-sample-api-summary.txt"

  if ! curl -fsS "$BACKEND_URL/api/pathway/eco00670" >"$api_tmp"; then
    echo "[FAIL] sample API failed: $BACKEND_URL/api/pathway/eco00670"
    status=1
    return
  fi

  if ! python3 - "$api_tmp" >"$summary_tmp" <<'PY'
import json
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    body = json.load(fh)
if not body.get('nodes') or not body.get('edges'):
    raise SystemExit(1)
if len(body['nodes']) == 0 or len(body['edges']) == 0:
    raise SystemExit(1)
print(body.get('pathway_id', '-'))
print(len(body['nodes']))
print(len(body['edges']))
PY
  then
    echo "[FAIL] sample API response format is invalid:"
    cat "$api_tmp"
    status=1
    rm -f "$api_tmp" "$summary_tmp"
    return
  fi

  local pathway_id
  local node_count
  local edge_count
  pathway_id="$(sed -n '1p' "$summary_tmp")"
  node_count="$(sed -n '2p' "$summary_tmp")"
  edge_count="$(sed -n '3p' "$summary_tmp")"

  echo "[OK] sample API: pathway=$pathway_id, nodes=$node_count, edges=$edge_count"
  rm -f "$api_tmp" "$summary_tmp"
}

check_backend
check_frontend
check_sample_api

if [[ "$status" -eq 0 ]]; then
  echo "[PASS] local smoke test successful"
  exit 0
fi

echo "[FAIL] local smoke test found issues"
exit 1
