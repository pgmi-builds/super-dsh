#!/usr/bin/env bash
# start-4999.sh — the super-dsh line in PUBLISH-READY form (2026-09-22
# transformation): the 4999 instance runs THE DELIVERED ARTIFACT.
#
#   build (pack.mjs)  →  npm pack  →  pnpm install of the tarball into a
#   fresh profile  →  boot via the repo build's dsh CLI.
#
# No hand-written compositions, no @pgmi-builds symlink farms, no library boot
# script: the profile shape IS the consumer shape (`dsh plugin add super-dsh`
# produces exactly this manifest). Worlds self-provision from the package.
#
# Red line (repo AGENTS §〇): this script refuses to run against any home that
# is not this repo's .tests tree — the launch step owns the dev/test boundary,
# business code never does.
#
# 2026-09-27 user rulings baked in below:
#   • ports are UNOWNED test ports (4999 included): this rig stops test-owned
#     occupant units and takes the port; only a non-test listener refuses.
#   • the auth seed persists in the home's .credentials.yaml — browser cookies
#     stay valid across restarts (connection.cookieMaxAgeDays, default 30d).
#     The ?token= in each boot's log is a per-process launch token for FIRST
#     mint only — never re-inject cookies between test restarts.
set -euo pipefail
# Rig knobs: the defaults below are the long-lived compat home (session-format
# verification, reused across runs — user data is a test asset). A throwaway
# fresh-home boot (only when first-boot behavior itself is under test):
#   SUPERD_PORT=4997 SUPERD_HOME_DIR=$PWD/.tests/superd-clean \
#     bash super-dsh/test/start-4999.sh
# (delete that home afterwards; see docs/07-cordis-dsh-dev-test-guides.md §3).
#   SUPERD_PORT=4999 SUPERD_PACK_FROM=registry bash super-dsh/test/start-4999.sh
#     → skip the local pack and install the PUBLISHED super-dsh@<version> from
#       npm instead (consumer-channel parity; default is the local tarball).
PORT="${SUPERD_PORT:-4999}"
UNIT="superd-${PORT}-test"
# The line's repo root = wherever THIS script lives (main checkout or a dev
# worktree — pack.mjs anchors itself the same way via import.meta.url), never a
# hardcoded path: a worktree checkout must pack and boot its OWN branch state.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LINE="$REPO/super-dsh"
DSH_HOME_DIR="${SUPERD_HOME_DIR:-$REPO/.tests/superd}"
PROFILE="${SUPERD_PROFILE:-superd-pub}"
LOG="$REPO/.scratch/superd-${PORT}.log"
NODE_BIN="/usr/bin/node"
PNPM="corepack pnpm@10.33.2"   # consumer-parity installer (store v10)
PNPM_STORE="$REPO/.npm-cache/pnpm-store-v10"
ANCHOR="$REPO/upstream/deepseek-harness/apps/cli/package.json"  # repo-line contract: the checkout build IS the installation

# ---- red line: home must be this repo's test tree ----
case "$DSH_HOME_DIR" in
  "$REPO/.tests"*) ;;
  *) echo "refusing: DSH home $DSH_HOME_DIR is outside $REPO/.tests (repo red line)" >&2; exit 1 ;;
esac

RELAY="superd-lan-${PORT}-relay"
LAN_IP=$(hostname -I | awk '{print $1}')

# Idempotent restart of THIS rig's own named units; then, per the 2026-09-27
# port ruling (test ports are unowned, 4999 included), any OTHER test-owned
# unit still holding the port is stopped and the port taken over. Only an
# unknown non-test listener refuses the start.
systemctl --user stop "$UNIT" "$RELAY" 2>/dev/null || true
systemctl --user reset-failed "$UNIT" "$RELAY" 2>/dev/null || true
# Map the port's listener pid to its user unit via /proc/<pid>/cgroup
# (launcher = app.slice/<unit>.service; socat relay = its own unit).
test_unit_on_port() {
  local pid unit
  pid=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  [ -n "$pid" ] || return 1
  unit=$(sed -n 's#^.*/\([^/]*\.service\)$#\1#p' "/proc/${pid}/cgroup" 2>/dev/null | head -1)
  [ -n "$unit" ] || return 1
  case "$unit" in
    superd-*|dsh-*|*-test|*-relay) printf '%s' "$unit" ;;
    *) return 1 ;;
  esac
}
for _ in $(seq 1 15); do ss -tln | grep -q ":${PORT} " || break; sleep 1; done
if ss -tln | grep -q ":${PORT} "; then
  if OCCUPANT=$(test_unit_on_port); then
    echo "--- port ${PORT} held by test unit ${OCCUPANT}: stopping (ports are unowned test infra)"
    systemctl --user stop "$OCCUPANT"
    for _ in $(seq 1 15); do ss -tln | grep -q ":${PORT} " || break; sleep 1; done
  fi
fi
if ss -tln | grep -q ":${PORT} "; then
  echo "refusing to start: port ${PORT} held by a non-test listener:" >&2
  ss -tlnp | grep ":${PORT} " >&2 || true
  echo "  pick another port: SUPERD_PORT=<free> bash super-dsh/test/start-4999.sh" >&2
  exit 1
fi
WATERMARK=$(wc -l < "$LOG" 2>/dev/null || echo 0)

# ---- 1. the delivery artifact: locally packed tarball (default) or the
# registry release (SUPERD_PACK_FROM=registry — consumer-channel parity: the
# exact published version is what the line runs, no local build involved).
VERSION="$("$NODE_BIN" -p "require('$LINE/package.json').version")"
TARBALL="$REPO/.scratch/superd-pack/super-dsh-${VERSION}.tgz"
if [ "${SUPERD_PACK_FROM:-tarball}" = "registry" ]; then
  DEP_VALUE="$VERSION"                 # manifest spec: exact published version
  DEP_ADD="super-dsh@$VERSION"         # pnpm arg: name@version from the registry
  echo "--- source = registry: installing $DEP_ADD (local pack skipped)"
else
  DEP_VALUE="file:$TARBALL"
  DEP_ADD="file:$TARBALL"
  "$NODE_BIN" "$LINE/scripts/pack.mjs"
fi

# ---- 2. fresh profile consuming the artifact (consumer manifest shape) ----
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
rm -rf "$PROFILE_DIR"
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "superd-pub-profile",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "super-dsh"] } },
  "dependencies": { "super-dsh": "$DEP_VALUE" }
}
EOF
cat > "$PROFILE_DIR/cordis.patch.yml" <<EOF
# ctx0 web face on the line port (loopback; LAN/WAN via socat/Caddy per repo
# port discipline). Everything else — hub, world rows, claude join, picker —
# composes from the installed super-dsh bundle's own patch.
- id: webserver
  config:
    host: 127.0.0.1
    port: ${PORT}
EOF
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'YAML'
# super-dsh sanctioned build approval: the omp sidecar needs the bun binary;
# pnpm skips postinstall scripts without this (local + dev3 evidence).
onlyBuiltDependencies:
  - bun
YAML
echo "--- pnpm install (first run downloads the runtime SDKs into the store; later runs reuse it)"
(cd "$PROFILE_DIR" && $PNPM add "$DEP_ADD" --config.store-dir="$PNPM_STORE" --prefer-offline)
# pnpm ordering quirk: bun's postinstall runs before @oven/bun-linux-x64
# links, so bun/bin keeps launcher stubs. Idempotent manual backfill (resolve
# THROUGH the super-dsh package — pnpm isolated layout keeps bun off the top
# level). Fails soft: the omp world reports not-ready without it, the line
# itself must still boot.
BUN_DIR=$(cd "$PROFILE_DIR" && node -e "try{const{createRequire}=require('module');const fs=require('fs');const r=createRequire(process.cwd()+'/package.json');const sd=fs.realpathSync(r.resolve('super-dsh/package.json'));const inner=createRequire(sd);console.log(fs.realpathSync(inner.resolve('bun/package.json')).replace(/\\/package.json$/,''))}catch{}")
if [ -n "$BUN_DIR" ] && [ -d "$BUN_DIR" ]; then
  (cd "$BUN_DIR" && node install.js >/dev/null 2>&1) && echo "--- bun binary ensured"
fi

# ---- 3. boot via the repo build's dsh CLI (no custom boot code) ----
# ---- test preparation (2026-09-24 user ruling; spec: docs/07 §7) — the line
# must see the world production sees, or the test tests the wrong thing:
#   1. provider keys: copy the prod home's .env into the line home (the
#      launcher's env layering is inherited > invoking-dir > HOME .env; an
#      inherited EMPTY value would BLOCK the file layer, so we deliberately
#      do NOT pass DEEPSEEK_API_KEY through the unit env);
#   2. trusted authorities: one SUPERD_TRUSTED_HOSTS declaration feeds the server
#      fence legs (worlds' --trusted-host) AND the page-trust component's
#      default authorities (bare hostnames only — the portful entry below
#      covers the fence, the bare ones cover the pages).
if [ ! -f "$HOME/.dsh/.env" ]; then
  echo "refusing: $HOME/.dsh/.env missing — test preparation cannot provide provider keys" >&2
  exit 1
fi
cp -f "$HOME/.dsh/.env" "$DSH_HOME_DIR/.env"
chmod 600 "$DSH_HOME_DIR/.env"

# Auth seed awareness (2026-09-27 user ruling): the browser-session signing
# secret persists at the home root (.credentials.yaml, owner-only). When it
# already exists, cookies minted before this restart remain valid — the boot's
# launch token only serves first mint / new clients.
SEED_EXISTED=""
[ -f "$DSH_HOME_DIR/.credentials.yaml" ] && SEED_EXISTED=1

# ctx0's native /api + /hub fences read the CONNECTION service's trustedHosts
# (= webRuntime: bind-derived loopback literals + EXPLICIT --trusted-host
# extras). SUPERD_TRUSTED_HOSTS above feeds only the world fence leg and the
# page-trust leg — 2026-09-26 user LAN round: without these extras every
# non-loopback Host 403s (WS stuck on "reconnecting", RPC transport failures).
# Port-less entries match any port (api-request-trust canonicalAuthority).
systemd-run --user --unit="$UNIT" \
  --property=WorkingDirectory="$REPO" \
  --property=Environment="DSH_HOME=$DSH_HOME_DIR" \
  --property=Environment="SUPERD_DSH_ANCHOR=$ANCHOR" \
  --property=Environment="SUPERD_KEEP=1" \
  --property=Environment="SUPERD_TRACE=${SUPERD_TRACE:-0}" \
  --property="Environment=\"SUPERD_TRUSTED_HOSTS=test.pc.internal.test 192.0.2.130 192.0.2.130:${PORT}\"" \
  --property='UnsetEnvironment=DISPLAY WAYLAND_DISPLAY' \
  --property=Environment="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  --property=StandardOutput=append:"$LOG" \
  --property=StandardError=append:"$LOG" \
  "$NODE_BIN" "$REPO/upstream/deepseek-harness/apps/cli/lib/bin.js" \
    --profile "$PROFILE" --no-open \
    --trusted-host "$LAN_IP" \
    --trusted-host test.pc.internal.test

ok=""
for _ in $(seq 1 90); do
  sleep 2
  if ss -tln | grep -q ":${PORT} "; then ok=1; break; fi
  systemctl --user is-active --quiet "$UNIT" || { tail -30 "$LOG"; exit 1; }
done
[ -n "$ok" ] || { echo "timeout waiting for ${PORT}" >&2; exit 1; }

# ---- LAN relay (2026-09-26 user ruling): user visits via LAN; every non-4999
# port MUST carry one (4999 is Caddy-backed). Bind the LAN IP only — never
# 0.0.0.0 (repo port discipline; webserver startup hard-refuses it anyway).
# Fence note: the LAN Host passes the /api fences via the CLI --trusted-host
# extras above (port-less entry matches any port), not via SUPERD_TRUSTED_HOSTS
# (that env only feeds the world fence leg + page-trust authorities).
if [ "$PORT" != "4999" ]; then
  systemd-run --user --unit="$RELAY" \
    --property=StandardOutput=append:"$LOG" \
    --property=StandardError=append:"$LOG" \
    /usr/bin/socat TCP-LISTEN:"${PORT}",fork,reuseaddr,bind="${LAN_IP}" TCP:127.0.0.1:"${PORT}"
  lan_ok=""
  for _ in $(seq 1 10); do
    ss -tln | grep -q "${LAN_IP}:${PORT} " && { lan_ok=1; break; }
    sleep 1
  done
  [ -n "$lan_ok" ] || echo "WARN: socat relay $RELAY not listening on ${LAN_IP}:${PORT}" >&2
fi
if [ -n "$SEED_EXISTED" ]; then
  echo "--- listening on ${PORT}; auth seed persisted — existing browser cookies stay valid (≤30d),"
  echo "    no re-injection needed; the token URL is for first mint / new clients only:"
else
  echo "--- listening on ${PORT}; NEW home seed — mint your cookie once via the token URL (valid 30d per authority):"
fi
JAR=$(mktemp)
# ctx0's token can land a few seconds after the bind (worlds interleave their
# virtual webServer lines around it) — poll until one actually authenticates.
found=""
for _ in $(seq 1 15); do
  for t in $(tail -n +$((WATERMARK + 1)) "$LOG" | grep -o 'token=[^ ]*' | cut -d= -f2 | tac); do
    rm -f "$JAR"
    if curl -s -o /dev/null -c "$JAR" "http://127.0.0.1:${PORT}/?token=$t" && \
       [ "$(curl -s -o /dev/null -b "$JAR" -w '%{http_code}' "http://127.0.0.1:${PORT}/")" = "200" ]; then
      found="$t"; break
    fi
  done
  [ -n "$found" ] && break
  sleep 2
done
if [ -n "$found" ]; then
  echo "  local: http://127.0.0.1:${PORT}/?token=$found"
  if [ "$PORT" = "4999" ]; then
    echo "  wan:   https://test.pc.internal.test/?token=$found"
  else
    echo "  lan:   http://${LAN_IP}:${PORT}/?token=$found   (socat relay: $RELAY)"
  fi
else
  echo "  WARN: no token authenticated against the index — inspect $LOG" >&2
fi
rm -f "$JAR"
echo "--- SUPERD_KEEP=1: unit $UNIT left running (stop: systemctl --user stop $UNIT $RELAY)"
