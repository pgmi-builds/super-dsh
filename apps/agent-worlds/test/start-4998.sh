#!/usr/bin/env bash
# start-4998.sh — AW-A acceptance instance (adapted from multi-agent-ctx template).
# One process: CTX0 web face on 127.0.0.1:4998 + ctx-omp world (plugin-spawned,
# loopback-ephemeral listener). SUPERD_KEEP: left running; stop via systemctl.
set -euo pipefail
PORT=4998
UNIT="aw-4998-test"
REPO="$HOME/workspaces/superd"
LOG="$REPO/.scratch/aw-4998.log"
NODE_BIN="/usr/bin/node"

if ss -tln | grep -q ":${PORT} "; then
  echo "refusing to start: port ${PORT} already listening:" >&2
  ss -tlnp | grep ":${PORT} " >&2 || true
  exit 1
fi
systemctl --user reset-failed "$UNIT" 2>/dev/null || true
WATERMARK=$(wc -l < "$LOG" 2>/dev/null || echo 0)

systemd-run --user --unit="$UNIT" \
  --property=WorkingDirectory="$REPO/apps/agent-worlds/test" \
  --property=Environment="DSH_HOME=$REPO/.superd-test/aw" \
  --property=Environment="SUPERD_DSH_ANCHOR=$REPO/upstream/deepseek-harness/package.json" \
  --property=Environment="AW_BARE_BASE=$REPO/.superd-test/aw/profiles/node_modules/" \
  --property=Environment="OMP_HOME=$REPO/.superd-test/aw/agents/omp" \
  --property=Environment="SUPERD_KEEP=1" \
  --property=StandardOutput=append:"$LOG" \
  --property=StandardError=append:"$LOG" \
  "$NODE_BIN" "$REPO/apps/agent-worlds/test/smoke.mjs"

ok=""
for _ in $(seq 1 90); do
  sleep 2
  if ss -tln | grep -q ":${PORT} "; then ok=1; break; fi
  systemctl --user is-active --quiet "$UNIT" || { journalctl --user -u "$UNIT" --no-pager | tail -30; exit 1; }
done
[ -n "$ok" ] || { echo "timeout waiting for ${PORT}" >&2; exit 1; }
echo "--- listening on ${PORT}; token URL (this boot):"
tail -n +$((WATERMARK + 1)) "$LOG" | grep 'token=' | tail -1 || true
echo "SUPERD_KEEP=1 — left running for acceptance; stop: systemctl --user stop $UNIT"
