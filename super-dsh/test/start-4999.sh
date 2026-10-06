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
PORT="${SUPERD_PORT:-4999}"
UNIT="superd-${PORT}-test"
# The line's repo root = wherever THIS script lives (main checkout or a dev
# worktree — pack.mjs anchors itself the same way via import.meta.url), never a
# hardcoded path: a worktree checkout must pack and boot its OWN branch state.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LINE="$REPO/super-dsh"
# Components reuse the checkout compiler when a component has no local bin.
export PATH="$LINE/superd-hub/node_modules/.bin:$PATH"
DSH_HOME_DIR="${SUPERD_HOME_DIR:-$REPO/.tests/superd}"
PROFILE="${SUPERD_PROFILE:-superd-pub}"
LOG="$REPO/.scratch/superd-${PORT}.log"
NODE_BIN="/usr/bin/node"
if command -v corepack >/dev/null 2>&1; then
  PNPM="corepack pnpm@10.33.2"
else
  PNPM="pnpm --config.strict-dep-builds=false"  # Keep dependency builds disabled without pnpm 12 aborting.
fi
PNPM_STORE="$REPO/.npm-cache/pnpm-store-v10"
ANCHOR="${SUPERD_TEST_DSH_ANCHOR:-$REPO/upstream/deepseek-harness/apps/cli/package.json}"
CLI="$(dirname "$ANCHOR")/lib/bin.js"
[ -f "$ANCHOR" ] && [ -f "$CLI" ] || { echo "DSH installation missing: $ANCHOR" >&2; exit 1; }

# ---- ONE credential seed for every test rig on this machine (2026-10-04 user
# ruling). The browser cookie is HMAC-signed with the constant secret inside
# `$DSH_HOME/.credentials.yaml`, and its name is derived from the AUTHORITY —
# so for a fixed URL (test.pc.internal.test) a rig whose home carries a
# DIFFERENT secret invalidates the cookie the user just minted. Ports are
# shared test ground (499x has no owner), so the seed must not be per-home:
# every rig points the `credentials` row at this one file and the cookie the
# user minted once survives every takeover. Seeded on first use from the home's
# own document (which the repo's main homes already share), so no existing
# cookie is invalidated by adopting it. Other repos' launchers adopt the same
# convention by pointing their `credentials` row at the same path.
SHARED_CREDENTIALS="${DSH_TEST_CREDENTIALS:-$(dirname "$REPO")/.dsh-test-credentials.yaml}"

# ---- red line: home must be this repo's test tree ----
case "$DSH_HOME_DIR" in
  "$REPO/.tests"*) ;;
  *) echo "refusing: DSH home $DSH_HOME_DIR is outside $REPO/.tests (repo red line)" >&2; exit 1 ;;
esac

RELAY="superd-lan-${PORT}-relay"
SOCAT_BIN="${SUPERD_SOCAT_BIN:-$(command -v socat || true)}"
if [ -z "$SOCAT_BIN" ] && [ -x "$REPO/.scratch/socat-runtime/usr/bin/socat" ]; then
  SOCAT_BIN="$REPO/.scratch/socat-runtime/usr/bin/socat"
fi
[ -x "$SOCAT_BIN" ] || { echo "socat missing: install it or set SUPERD_SOCAT_BIN" >&2; exit 1; }
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
  # Match on the bare unit name: transient unit names end in `.service`, so
  # suffix patterns written as `*-test`/`*-relay` never match (found 2026-10-04
  # when the dashr rig's `test123-lan-4999-relay.service` blocked takeover).
  case "${unit%.service}" in
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

# ---- 1. build + pack the delivery artifact ----
if [ -n "${SUPERD_TEST_TARBALL:-}" ]; then
  TARBALL="$(realpath "$SUPERD_TEST_TARBALL")"
  [ -f "$TARBALL" ] || { echo "delivery tarball missing: $TARBALL" >&2; exit 1; }
else
  "$NODE_BIN" "$LINE/scripts/pack.mjs"
  TARBALL="$REPO/.scratch/superd-pack/super-dsh-$("$NODE_BIN" -p "require('$LINE/package.json').version").tgz"
fi

# ---- 2. fresh profile consuming the tarball (consumer manifest shape) ----
# Plus the dev-only WebMCP injection bundle (super-dsh/dev-webmcp): built from
# this checkout each boot and installed as a SECOND `file:` dep, so ANY browser
# on the line URL gets the page-mcp tools server-side with zero manual steps.
# It is NOT part of the pack (absent from the pack files whitelist and pack.mjs)
# and must never reach a published artifact or a prod profile.
if [ ! -d "$LINE/dev-webmcp/node_modules" ]; then
  (cd "$LINE/dev-webmcp" && npm install --cache "$REPO/.npm-cache" --no-audit --no-fund --silent)
fi
if [ "${SUPERD_TEST_DEV_WEBMCP_PREBUILT:-0}" = "1" ]; then
  [ -f "$LINE/dev-webmcp/dist/index.js" ] || { echo "prebuilt dev WebMCP bundle missing" >&2; exit 1; }
else
  (cd "$LINE/dev-webmcp" && npm run build --silent)
fi
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
rm -rf "$PROFILE_DIR"
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "superd-pub-profile",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "super-dsh", "@pgmi-builds/superd-dev-webmcp"] } },
  "dependencies": { "super-dsh": "file:$TARBALL", "@pgmi-builds/superd-dev-webmcp": "file:$LINE/dev-webmcp" }
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
# One seed for every rig on this machine (see SHARED_CREDENTIALS above): the
# upstream row defaults to the credentials document under the harness home,
# which makes the
# browser cookie die every time a rig with another home takes the port. The
# profile patch composes AFTER the bundle patch, so restating the id with an
# explicit absolute path wins.
- id: credentials
  config:
    path: ${SHARED_CREDENTIALS}
EOF
echo "--- pnpm install (first run downloads the runtime SDKs into the store; later runs reuse it)"
(cd "$PROFILE_DIR" && $PNPM add "file:$TARBALL" "file:$LINE/dev-webmcp" --config.store-dir="$PNPM_STORE" --prefer-offline)

# ---- 3. boot via the repo build's dsh CLI (no custom boot code) ----
# ---- test preparation (2026-09-24 user ruling; spec: docs/07 §7) — the line
# must see the world production sees, or the test tests the wrong thing:
#   1. provider keys: copy the prod home's .env into the line home (the
#      launcher's env layering is inherited > invoking-dir > HOME .env; an
#      inherited EMPTY value would BLOCK the file layer, so we deliberately
#      do NOT pass DEEPSEEK_API_KEY through the unit env);
#   2. web-trust: the shipped bundle owns authentication-only admission
#      for both the ctx0 server gate and browser; no launcher override.
if [ ! -f "$HOME/.dsh/.env" ]; then
  echo "refusing: $HOME/.dsh/.env missing — test preparation cannot provide provider keys" >&2
  exit 1
fi
cp -f "$HOME/.dsh/.env" "$DSH_HOME_DIR/.env"
chmod 600 "$DSH_HOME_DIR/.env"

# Auth seed awareness (2026-09-27 user ruling; shared file since 2026-10-04):
# the browser-session signing secret persists in the SHARED document (the row
# override above). When it already exists, cookies minted before this restart —
# and cookies minted by any other rig on this machine — remain valid; the
# boot's launch token only serves first mint / new clients. A home that has its
# own document and no shared one yet seeds the shared file from it, so adopting
# the convention never invalidates a cookie the user already holds.
if [ ! -f "$SHARED_CREDENTIALS" ] && [ -f "$DSH_HOME_DIR/.credentials.yaml" ]; then
  install -m 600 "$DSH_HOME_DIR/.credentials.yaml" "$SHARED_CREDENTIALS"
fi
SEED_EXISTED=""
[ -f "$SHARED_CREDENTIALS" ] && SEED_EXISTED=1

# ---- claude world-home provider seed (task 12) ------------------------------
# Acceptance rigging: the pack line's claude world reads its provider list from
# `<lineHome>/agents/claude/claude-providers.json`. provisionWorldProfile builds
# that home IN-PROCESS at world boot (and never touches this file), so seeding
# here — after the line .env exists, before the server starts — lands the store
# the world reads on its first boot. Keys come from the line's own .env copy
# (a key the file omits still falls through to the inherited environment).
# NON-FATAL by design: missing keys skip inside the seeder, and any failure here
# must not keep the line from booting.
SEED_ENV=()
for _seed_key in DEEPSEEK_API_KEY ZAI_PLAN_API_KEY; do
  _seed_val=$(sed -n "s/^${_seed_key}=//p" "$DSH_HOME_DIR/.env" | head -n 1)
  if [ -n "$_seed_val" ]; then SEED_ENV+=("${_seed_key}=${_seed_val}"); fi
done
env ${SEED_ENV[@]+"${SEED_ENV[@]}"} \
  "$NODE_BIN" "$LINE/test/seed-claude-providers.mjs" "$DSH_HOME_DIR/agents/claude" || true

# Codex's third-party acceptance route uses the adapter store, without writing
# native config/auth or passing provider-key env to the systemd business unit.
env ${SEED_ENV[@]+"${SEED_ENV[@]}"} \
  "$NODE_BIN" "$LINE/test/seed-codex-providers.mjs" "$DSH_HOME_DIR/agents/codex" || true

# Explicit test-only proxy; adapter/business code knows no proxy endpoint.
# Local UI/RPC stays direct. Native Codex children inherit these standard vars.
PROXY_ARGS=()
if [ -n "${SUPERD_TEST_HTTP_PROXY:-}" ]; then
  PROXY_ARGS+=(--property="Environment=HTTP_PROXY=$SUPERD_TEST_HTTP_PROXY")
  PROXY_ARGS+=(--property="Environment=HTTPS_PROXY=$SUPERD_TEST_HTTP_PROXY")
  PROXY_ARGS+=(--property="Environment=ALL_PROXY=$SUPERD_TEST_HTTP_PROXY")
  PROXY_ARGS+=(--property="Environment=NO_PROXY=localhost,127.0.0.1,::1")
fi
systemd-run --user --unit="$UNIT" "${PROXY_ARGS[@]}" \
  --property=WorkingDirectory="$REPO" \
  --property=Environment="DSH_HOME=$DSH_HOME_DIR" \
  --property=Environment="SUPERD_DSH_ANCHOR=$ANCHOR" \
  --property=Environment="SUPERD_KEEP=1" \
  --property=Environment="SUPERD_TRACE=${SUPERD_TRACE:-0}" \
  --property='UnsetEnvironment=DISPLAY WAYLAND_DISPLAY' \
  --property=Environment="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  --property=StandardOutput=append:"$LOG" \
  --property=StandardError=append:"$LOG" \
  "$NODE_BIN" "$CLI" \
    --profile "$PROFILE" --no-open

ok=""
for _ in $(seq 1 90); do
  sleep 2
  if ss -tln | grep -q ":${PORT} "; then ok=1; break; fi
  systemctl --user is-active --quiet "$UNIT" || { tail -30 "$LOG"; exit 1; }
done
[ -n "$ok" ] || { echo "timeout waiting for ${PORT}" >&2; exit 1; }

# LAN relay on every test port, including the Caddy-backed 4999.
# The web server stays on loopback; web-trust retains authentication and
# removes address fences, so neither host nor trusted-host CLI flags are needed.
if [ -n "$LAN_IP" ]; then
  systemd-run --user --unit="$RELAY" \
    --property=StandardOutput=append:"$LOG" \
    --property=StandardError=append:"$LOG" \
    "$SOCAT_BIN" TCP-LISTEN:"${PORT}",fork,reuseaddr,bind="${LAN_IP}" TCP:127.0.0.1:"${PORT}"
  lan_ok=""
  for _ in $(seq 1 10); do
    ss -tln | grep -q "${LAN_IP}:${PORT} " && { lan_ok=1; break; }
    sleep 1
  done
  [ -n "$lan_ok" ] || echo "WARN: socat relay $RELAY not listening on ${LAN_IP}:${PORT}" >&2
fi
if [ -n "$SEED_EXISTED" ]; then
  echo "--- listening on ${PORT}; SHARED auth seed persisted (${SHARED_CREDENTIALS}) — cookies stay"
  echo "    valid across rigs and restarts (≤30d per authority); the token URL is for first mint / new"
  echo "    clients only:"
else
  echo "--- listening on ${PORT}; NEW shared seed — mint your cookie once via the token URL (valid 30d per authority):"
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
  fi
  echo "  lan:   http://${LAN_IP}:${PORT}/?token=$found   (LAN relay: $RELAY)"
else
  echo "  WARN: no token authenticated against the index — inspect $LOG" >&2
fi
rm -f "$JAR"
echo "--- SUPERD_KEEP=1: unit $UNIT left running (stop: systemctl --user stop $UNIT $RELAY)"
