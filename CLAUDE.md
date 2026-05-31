## Project knowledge

This repository contains a **Grafana plugin**. You must Read @./.config/AGENTS/instructions.md before doing changes.

## Dev environment

### Starting/stopping Grafana

- `./start.sh` — starts Grafana on http://127.0.0.1:3000 (runs as a background process, PID stored in `.var/grafana.pid`)
- `./stop.sh` — stops Grafana
- Grafana binary: `/usr/share/grafana/bin/grafana`
- Runtime data (db, logs, plugins, provisioning): `.var/` (gitignored)
- Default credentials: `admin:admin`

### Datasource provisioning

- `provisioning/datasources/datasources.yml` — git-tracked, intentionally empty (no datasources)
- `datasources.yml` (project root, gitignored) — private override with real upstream datasource configs
- On startup, `start.sh` checks for the root-level `datasources.yml`. If present, it copies it into `.var/provisioning/datasources/` and points Grafana there instead of the repo's `provisioning/` directory.
- `.var/` is gitignored and used for runtime-generated files.

### Building the plugin

- Frontend: `npm run dev` (webpack watch) or `npm run build`
- The plugin dist is at `dist/` and symlinked into `.var/plugins/`
