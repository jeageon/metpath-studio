#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
BACKEND_PID_FILE="$RUNTIME_DIR/metpath-backend.pid"
FRONTEND_PID_FILE="$RUNTIME_DIR/metpath-frontend.pid"

stop_pid() {
  local file="$1"
  local name="$2"

  if [[ ! -f "$file" ]]; then
    echo "[WARN] no pid file for $name"
    return
  fi

  local pid
  pid="$(cat "$file")"
  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "[INFO] stopping $name (pid: $pid)"
    kill "$pid"
    for _ in {1..20}; do
      if kill -0 "$pid" >/dev/null 2>&1; then
        sleep 0.25
      else
        break
      fi
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid"
      echo "[WARN] forced stop $name (pid: $pid)"
    fi
  else
    echo "[WARN] $name already stopped (pid: $pid)"
  fi

  rm -f "$file"
}

stop_pid "$BACKEND_PID_FILE" "backend"
stop_pid "$FRONTEND_PID_FILE" "frontend"
echo "[OK] all processes stopped."
