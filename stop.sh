#!/usr/bin/env bash
set -euo pipefail

PID_FILE="$HOME/grafana/grafana.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No PID file ($PID_FILE); Grafana not running via start.sh"
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  for _ in $(seq 1 10); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "Grafana (pid $PID) didn't stop; sending SIGKILL"
    kill -9 "$PID" 2>/dev/null || true
  fi
  echo "Grafana stopped (pid $PID)"
else
  echo "Grafana not running (stale pid $PID)"
fi

rm -f "$PID_FILE"
