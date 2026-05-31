#!/usr/bin/env bash
set -euo pipefail

GRAFANA_HOME=/usr/share/grafana
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/.var"
PID_FILE="$DATA_DIR/grafana.pid"
PORT=3000

mkdir -p "$DATA_DIR"/{data,plugins,logs}

# Ensure `az` (~/bin/az -> cmdproxy shim) is reachable by the plugin subprocess.
export PATH="$HOME/bin:$PATH"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Grafana already running (pid $(cat "$PID_FILE")) at http://127.0.0.1:$PORT"
  exit 0
fi

# Use private datasources override if present
PROVISIONING_DIR="$SCRIPT_DIR/provisioning"
if [[ -f "$SCRIPT_DIR/datasources.yml" ]]; then
  PROVISIONING_DIR="$SCRIPT_DIR/.var/provisioning"
  mkdir -p "$PROVISIONING_DIR/datasources"
  cp "$SCRIPT_DIR/datasources.yml" "$PROVISIONING_DIR/datasources/datasources.yml"
fi

nohup "$GRAFANA_HOME/bin/grafana" server \
  --homepath "$GRAFANA_HOME" \
  cfg:default.paths.data="$DATA_DIR/data" \
  cfg:default.paths.plugins="$DATA_DIR/plugins" \
  cfg:default.paths.logs="$DATA_DIR/logs" \
  cfg:default.paths.provisioning="$PROVISIONING_DIR" \
  cfg:default.server.http_addr=127.0.0.1 \
  cfg:default.server.http_port=$PORT \
  cfg:default.plugins.allow_loading_unsigned_plugins=mmazur-grafana-datasource \
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
