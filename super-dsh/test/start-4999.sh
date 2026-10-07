#!/usr/bin/env bash
# start-4999.sh — joint or standalone consumer in delivery form.
# Default4999 runs Super Dash; Better Dash can be selected on its own test port.
#
#   build BOTH same-repository packages (pack-pair.mjs) → npm pack → pnpm install into a
#   fresh profile  →  boot via the repo build's dsh CLI.
#
# No hand-written compositions, no @pgmi-builds symlink farms, no library boot
# script: the native profile activates Super Dash only. Its pack contains the
# locally built Better Dash package and composes Better Dash YAML before its own.
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
#     The joint line uses Better Dash's password page for new clients;
#     never re-inject cookies between test restarts.
# 2026-10-07 user ruling baked in below:
#   • the webserver binds 0.0.0.0 by default (SUPERD_BIND=127.0.0.1 opts back
#     into the loopback + socat-relay shape): LAN/WAN visitors hit the port
#     directly, no relay unit; admission stays cookie-only via web-trust.
set -euo pipefail
# Rig knobs: the defaults below are the long-lived compat home (session-format
# verification, reused across runs — user data is a test asset). A throwaway
# fresh-home boot (only when first-boot behavior itself is under test):
#   SUPERD_PORT=4997 SUPERD_HOME_DIR=$PWD/.tests/superd-clean \
#     bash super-dsh/test/start-4999.sh
# (delete that home afterwards; see docs/07-cordis-dsh-dev-test-guides.md §3).
PORT="${SUPERD_PORT:-4999}"
UNIT="superd-${PORT}-test"
# Bind face (2026-10-07 user ruling): the server binds ALL interfaces by
# default — LAN/WAN visitors hit the port directly and the socat LAN relay is
# skipped (a relay on the same port would collide with the wide bind).
# SUPERD_BIND=127.0.0.1 restores the old loopback + relay shape. Admission is
# unchanged either way: web-trust keeps cookie authentication and removes only
# the Host/Origin fence, so an unauthenticated LAN request still gets 401.
BIND="${SUPERD_BIND:-0.0.0.0}"
# The line's repo root = wherever THIS script lives (main checkout or a dev
# worktree — pack.mjs anchors itself the same way via import.meta.url), never a
# hardcoded path: a worktree checkout must pack and boot its OWN branch state.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LINE="$REPO/super-dsh"
# Components reuse the checkout compiler when a component has no local bin.
export PATH="$LINE/superd-hub/node_modules/.bin:$PATH"
DSH_HOME_DIR="${SUPERD_HOME_DIR:-$REPO/.tests/superd}"
CONSUMER="${SUPERD_TEST_CONSUMER:-super-dsh}"
case "$CONSUMER" in super-dsh) PRODUCT_KEY=superDash; DEFAULT_PROFILE=superd-pub ;; better-dsh) PRODUCT_KEY=betterDash; DEFAULT_PROFILE=better-pub ;; *) echo "invalid test consumer: $CONSUMER" >&2; exit 1 ;; esac
PROFILE="${SUPERD_PROFILE:-$DEFAULT_PROFILE}"
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
# ---- 1. Build locally, or explicitly consume the SAME received artifact pair ----
[ -z "${SUPERD_TEST_TARBALL:-}" ] || { echo "use a verified dual artifact pair, not a single unverified tarball" >&2; exit 1; }
if [ -n "${SUPERD_TEST_PACK_DIR:-}" ]; then
  PACK_DIR="$SUPERD_TEST_PACK_DIR"
else
  "$NODE_BIN" "$LINE/scripts/pack-pair.mjs"
  PACK_DIR="$REPO/.scratch/superd-pack"
fi
TARBALL="$("$NODE_BIN" "$REPO/scripts/read-pack-pair.mjs" "$PACK_DIR" "$PRODUCT_KEY")"
DEV_WEBMCP="$REPO/dev-webmcp"

# ---- 2. fresh profile consuming the tarball (consumer manifest shape) ----
# Plus the dev-only WebMCP injection bundle (dev-webmcp/): built from
# this checkout each boot and installed as an additional `file:` dep, so ANY browser
# on the line URL gets the page-mcp tools server-side with zero manual steps.
# It is NOT part of the pack (absent from the pack files whitelist and pack.mjs)
# and must never reach a published artifact or a prod profile.
if [ ! -d "$DEV_WEBMCP/node_modules" ]; then
  (cd "$DEV_WEBMCP" && npm install --cache "$REPO/.npm-cache" --no-audit --no-fund --silent)
fi
"$NODE_BIN" "$DEV_WEBMCP/scripts/sync-host-peers.mjs" "$ANCHOR"
if [ "${SUPERD_TEST_DEV_WEBMCP_PREBUILT:-0}" = "1" ]; then
  [ -f "$DEV_WEBMCP/dist/index.js" ] || { echo "prebuilt dev WebMCP bundle missing" >&2; exit 1; }
else
  (cd "$DEV_WEBMCP" && npm run build --silent)
fi
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
rm -rf "$PROFILE_DIR"
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "${CONSUMER}-test-profile",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "$CONSUMER", "@pgmi-builds/better-dsh-dev-webmcp"] } },
  "dependencies": { "$CONSUMER": "file:$TARBALL", "@pgmi-builds/better-dsh-dev-webmcp": "file:$DEV_WEBMCP" }
}
EOF
# The selected product is the only direct package. For Super Dash, Better
# comes from its tarball; no direct dependency or override can mask a missing bundle.
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<EOF
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
EOF
cat > "$PROFILE_DIR/cordis.patch.yml" <<EOF
# Native WebServer defaults belong to Better Dash; the port is a CLI flag.
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
(cd "$PROFILE_DIR" && $PNPM add "file:$TARBALL" "file:$DEV_WEBMCP" --config.store-dir="$PNPM_STORE" --prefer-offline)

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
# password page serves first mint / new clients. A home that has its
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
if [ "$CONSUMER" = "super-dsh" ]; then
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

fi

# Explicit test-only proxy; adapter/business code knows no proxy endpoint.
# Local UI/RPC stays direct. Native Codex children inherit these standard vars.
PROXY_ARGS=()
if [ -n "${SUPERD_TEST_HTTP_PROXY:-}" ]; then
  PROXY_ARGS+=(--property="Environment=HTTP_PROXY=$SUPERD_TEST_HTTP_PROXY")
  PROXY_ARGS+=(--property="Environment=HTTPS_PROXY=$SUPERD_TEST_HTTP_PROXY")
  PROXY_ARGS+=(--property="Environment=ALL_PROXY=$SUPERD_TEST_HTTP_PROXY")
  PROXY_ARGS+=(--property="Environment=NO_PROXY=localhost,127.0.0.1,::1")
fi
HOST_ARGS=()
if [ "$BIND" = "127.0.0.1" ]; then HOST_ARGS+=(--host 127.0.0.1); fi
[ "$BIND" = "0.0.0.0" ] || [ "$BIND" = "127.0.0.1" ] || { echo "unsupported SUPERD_BIND: $BIND" >&2; exit 1; }
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
    --profile "$PROFILE" --no-open --port "$PORT" "${HOST_ARGS[@]}"

ok=""
for _ in $(seq 1 90); do
  sleep 2
  if ss -tln | grep -q ":${PORT} "; then ok=1; break; fi
  systemctl --user is-active --quiet "$UNIT" || { tail -30 "$LOG"; exit 1; }
done
[ -n "$ok" ] || { echo "timeout waiting for ${PORT}" >&2; exit 1; }

# LAN relay on every test port, including the Caddy-backed 4999.
# LAN relay ONLY for a loopback bind (the default 0.0.0.0 already answers on
# every interface, and a relay on the same port would lose the bind race).
# web-trust retains authentication and removes address fences, so neither
# host nor trusted-host CLI flags are needed on either shape.
if [ -n "$LAN_IP" ] && [ "$BIND" = "127.0.0.1" ]; then
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
  echo "    valid across rigs and restarts (≤30d per authority); new clients use the Better Dash password page."
else
  echo "--- listening on ${PORT}; NEW shared seed — sign in through the Better Dash password page."
fi
# Better Dash owns '/', so 200 may be a password form, NOT an authenticated
# app. Readiness requires the expected form AND rejection by a protected API.
# Actual authenticated app/API behavior is verified separately at acceptance.
door_ready=""
for _ in $(seq 1 15); do
  if "$NODE_BIN" "$LINE/test/check-pair-login.mjs" "http://127.0.0.1:${PORT}" > "$REPO/.scratch/pair-login-${PORT}.json" 2>/dev/null; then
    door_ready=1
    break
  fi
  sleep 2
done
[ -n "$door_ready" ] || { echo "password door / protected API readiness failed — inspect $LOG" >&2; exit 1; }
echo "  local: http://127.0.0.1:${PORT}/"
if [ "$PORT" = "4999" ]; then
  echo "  wan:   https://test.pc.internal.test/"
fi
if [ "$BIND" = "127.0.0.1" ]; then
  [ -n "$LAN_IP" ] && echo "  lan:   http://${LAN_IP}:${PORT}/   (LAN relay: $RELAY)"
elif [ -n "$LAN_IP" ]; then
  echo "  lan:   http://${LAN_IP}:${PORT}/   (direct bind ${BIND}; no relay)"
fi
echo "--- SUPERD_KEEP=1: unit $UNIT left running (stop: systemctl --user stop $UNIT $RELAY)"
