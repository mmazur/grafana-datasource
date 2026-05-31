#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.var/grafana.pid"
PORT=3000

stop_pid() {
  local pid=$1
  kill "$pid" 2>/dev/null || return 1
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  echo "Grafana (pid $pid) didn't stop; sending SIGKILL"
  kill -9 "$pid" 2>/dev/null || true
}

stopped=false

# Preferred: PID file written by start.sh
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  PID=$(cat "$PID_FILE")
  stop_pid "$PID" && echo "Grafana stopped (pid $PID)"
  stopped=true
fi

# Fallback: a stale/missing PID file must not leave an orphan holding the port.
# Match our own instance by its command line (homepath + our port).
for pid in $(pgrep -f "grafana server .*http_port=$PORT" 2>/dev/null || true); do
  stop_pid "$pid" && echo "Grafana stopped (orphan pid $pid, not in PID file)"
  stopped=true
done

$stopped || echo "No Grafana on port $PORT to stop"
rm -f "$PID_FILE"
