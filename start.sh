#!/usr/bin/env bash
set -euo pipefail

GRAFANA_HOME=/usr/share/grafana
DATA_DIR="$HOME/grafana"
PID_FILE="$DATA_DIR/grafana.pid"
PORT=3001

mkdir -p "$DATA_DIR"/{data,plugins,logs}

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Grafana already running (pid $(cat "$PID_FILE")) at http://127.0.0.1:$PORT"
  exit 0
fi

nohup "$GRAFANA_HOME/bin/grafana" server \
  --homepath "$GRAFANA_HOME" \
  cfg:default.paths.data="$DATA_DIR/data" \
  cfg:default.paths.plugins="$DATA_DIR/plugins" \
  cfg:default.paths.logs="$DATA_DIR/logs" \
  cfg:default.server.http_addr=127.0.0.1 \
  cfg:default.server.http_port=$PORT \
  > "$DATA_DIR/logs/launch.out" 2>&1 &

echo $! > "$PID_FILE"

until curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health"; do
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Grafana failed to start; see $DATA_DIR/logs/launch.out"
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 1
done

echo "Grafana started (pid $(cat "$PID_FILE")) at http://127.0.0.1:$PORT"
