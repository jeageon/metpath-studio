#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

BACKEND_PORT="${METPATH_BACKEND_PORT:-8000}"
FRONTEND_PORT="${METPATH_FRONTEND_PORT:-5173}"

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
BACKEND_PID_FILE="$RUNTIME_DIR/metpath-backend.pid"
FRONTEND_PID_FILE="$RUNTIME_DIR/metpath-frontend.pid"
BACKEND_LOG_FILE="$RUNTIME_DIR/metpath-backend.log"
FRONTEND_LOG_FILE="$RUNTIME_DIR/metpath-frontend.log"
NPM_INSTALL_LOG_FILE="/tmp/metpath-frontend-npm-install.log"

require_cmds() {
  local missing=0
  for cmd in python3 pip3 curl npm; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "[ERROR] required command not found: $cmd" >&2
      missing=1
    fi
  done
  if ((missing)); then
    echo "[ERROR] install missing dependencies first." >&2
    exit 1
  fi
}

is_running() {
  local pid_file="$1"
  local service_name="$2"

  if [[ ! -f "$pid_file" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "[WARN] $service_name already running (pid: $pid)" >&2
    return 0
  fi

  rm -f "$pid_file"
  return 1
}

wait_for_http() {
  local url=$1
  local max_attempts=$2
  local attempt=0

  while ((attempt < max_attempts)); do
    if curl -fs "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
    attempt=$((attempt + 1))
  done

  return 1
}

show_log_tail() {
  local file=$1
  local label=$2

  echo "[TRACE] ${label} log tail (last 30 lines):"
  if [[ -f "$file" ]]; then
    tail -n 30 "$file"
  else
    echo "  (not found)"
  fi
}

start_backend() {
  if is_running "$BACKEND_PID_FILE" "backend"; then
    return
  fi

  echo "[INFO] setup backend"
  if [[ ! -d "$BACKEND_DIR/.venv" ]]; then
    python3 -m venv "$BACKEND_DIR/.venv"
  fi

  # shellcheck source=/dev/null
  source "$BACKEND_DIR/.venv/bin/activate"
  python3 -m pip install --quiet -r "$BACKEND_DIR/requirements.txt"

  echo "[INFO] starting backend : http://127.0.0.1:$BACKEND_PORT"
  (
    cd "$BACKEND_DIR" && \
    python3 -m uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" \
      > "$BACKEND_LOG_FILE" 2>&1
  ) &
  local backend_pid=$!
  echo "$backend_pid" > "$BACKEND_PID_FILE"

  if wait_for_http "http://127.0.0.1:$BACKEND_PORT/health" 30; then
    echo "[OK] backend ready"
    return
  fi

  echo "[ERROR] backend did not become ready. logs: $BACKEND_LOG_FILE" >&2
  show_log_tail "$BACKEND_LOG_FILE" "backend"
  exit 1
}

start_frontend() {
  if is_running "$FRONTEND_PID_FILE" "frontend"; then
    return
  fi

  echo "[INFO] setup frontend"
  (cd "$FRONTEND_DIR" && npm install) >"$NPM_INSTALL_LOG_FILE" 2>&1

  echo "[INFO] starting frontend : http://127.0.0.1:$FRONTEND_PORT"
  (
    cd "$FRONTEND_DIR" && \
    npm run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT" \
      > "$FRONTEND_LOG_FILE" 2>&1
  ) &
  local frontend_pid=$!
  echo "$frontend_pid" > "$FRONTEND_PID_FILE"

  if wait_for_http "http://127.0.0.1:$FRONTEND_PORT" 30; then
    echo "[OK] frontend ready"
    return
  fi

  echo "[ERROR] frontend did not become ready. logs: $FRONTEND_LOG_FILE" >&2
  echo "[TRACE] npm install log (last 30 lines):"
  tail -n 30 "$NPM_INSTALL_LOG_FILE"
  show_log_tail "$FRONTEND_LOG_FILE" "frontend"
  exit 1
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: bash scripts/run-local.sh"
  echo "Set METPATH_BACKEND_PORT / METPATH_FRONTEND_PORT to override default ports."
  exit 0
fi

require_cmds
start_backend
start_frontend

echo ""
echo "=================================================="
echo "MetPath Studio is running"
echo "Backend : http://127.0.0.1:$BACKEND_PORT"
echo "Frontend: http://127.0.0.1:$FRONTEND_PORT"
echo "Backend log : $BACKEND_LOG_FILE"
echo "Frontend log: $FRONTEND_LOG_FILE"
echo ""
echo "Stop all: bash scripts/stop-local.sh"
echo "=================================================="
