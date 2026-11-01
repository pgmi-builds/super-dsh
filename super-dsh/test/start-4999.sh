#!/usr/bin/env bash
# start-4999.sh — joint or standalone consumer in delivery form.
# Default4999 runs Super Dash; Better Dash can be selected on its own test port.
#
#   build BOTH same-repository packages (pack-pair.mjs) → npm pack → pnpm install into a
#   fresh profile  →  boot via the repo build's dsh CLI.
#
# No hand-written compositions, no @pgmi-builds symlink farms, no library boot
# script: the native profile activates the selected product only. The two packages
# are installed independently; nothing promotes one from the other.
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
# 2026-10-09: native WebServer stays on loopback; LAN access uses a test relay.
set -euo pipefail
# Rig knobs: the defaults below are the long-lived compat home (session-format
# verification, reused across runs — user data is a test asset). A throwaway
# fresh-home boot (only when first-boot behavior itself is under test):
#   SUPERD_PORT=4997 SUPERD_HOME_DIR=$PWD/.tests/superd-clean \
#     bash super-dsh/test/start-4999.sh
# (delete that home afterwards; see docs/07-cordis-dsh-dev-test-guides.md §3).
PORT="${SUPERD_PORT:-4999}"
UNIT="superd-${PORT}-test"
# Explicit native loopback keeps plugin changes independent of listener ownership.
# The test relay changes reachability only; native cookie authentication remains.
BIND="${SUPERD_BIND:-127.0.0.1}"
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
PNPM="pnpm"  # Same canonical executable and default build policy as native UI.
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
if [ "$BIND" = "127.0.0.1" ] && [ ! -x "$SOCAT_BIN" ]; then
  echo "socat missing for loopback relay: install it or set SUPERD_SOCAT_BIN" >&2
  exit 1
fi
LAN_IP=$(hostname -I | awk '{print $1}')

# ---- 1. Build locally, or explicitly consume the SAME received artifact pair ----
[ -z "${SUPERD_TEST_TARBALL:-}" ] || { echo "use a verified dual artifact pair, not a single unverified tarball" >&2; exit 1; }
if [ -n "${SUPERD_TEST_PACK_DIR:-}" ]; then
  PACK_DIR="$SUPERD_TEST_PACK_DIR"
else
  "$NODE_BIN" "$LINE/scripts/pack-pair.mjs"
  PACK_DIR="$REPO/.scratch/superd-pack"
fi
TARBALL="$("$NODE_BIN" "$REPO/scripts/read-pack-pair.mjs" "$PACK_DIR" "$PRODUCT_KEY")"

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
DEV_WEBMCP="$REPO/dev-webmcp"

# ---- 2. preserved profile consuming the tarball (consumer manifest shape) ----
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
# Stop/restart only this rig's read-only registry endpoint after pair validation.
REGISTRY_UNIT="superd-${PORT}-pair-registry"
REGISTRY_PORT="${SUPERD_TEST_REGISTRY_PORT:-$((PORT + 10000))}"
REGISTRY_UPSTREAM="$(cd "$REPO" && npm config get registry)"
REGISTRY_URL="http://127.0.0.1:${REGISTRY_PORT}/"
systemctl --user stop "$REGISTRY_UNIT" 2>/dev/null || true
systemd-run --user --unit="$REGISTRY_UNIT" \
  --property=WorkingDirectory="$REPO" \
  --property=StandardOutput=append:"$REPO/.scratch/pair-registry-${PORT}.log" \
  --property=StandardError=append:"$REPO/.scratch/pair-registry-${PORT}.log" \
  "$NODE_BIN" "$LINE/test/registry-pair-server.mjs" "$PACK_DIR" "$REGISTRY_PORT" "$REGISTRY_UPSTREAM"
for _ in $(seq 1 30); do
  if curl --noproxy '*' --fail --silent "$REGISTRY_URL$CONSUMER" > /dev/null; then break; fi
  systemctl --user is-active --quiet "$REGISTRY_UNIT" || exit 1
  sleep 1
done
curl --noproxy '*' --fail --silent "$REGISTRY_URL$CONSUMER" > /dev/null || exit 1
mkdir -p "$PROFILE_DIR"
"$NODE_BIN" --input-type=module - "$PROFILE_DIR/package.json" "$CONSUMER" "$TARBALL" "$DEV_WEBMCP" <<'JS'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
const [file, consumer, tarball, webmcp] = process.argv.slice(2)
const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
const bundles = [...new Set([...(previous.dsh?.profile?.bundles ?? []), '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', consumer, '@pgmi-builds/better-dsh-dev-webmcp'])]
const dependencies = { ...previous.dependencies, [consumer]: 'file:' + tarball, '@pgmi-builds/better-dsh-dev-webmcp': 'file:' + webmcp }
writeFileSync(file, JSON.stringify({ ...previous, name: consumer + '-test-profile', private: true,
  dsh: { ...previous.dsh, profile: { ...previous.dsh?.profile, bundles } }, dependencies }, null, 2) + '\n')
JS
# First consumption declares only the selected product; repeat consumption
# preserves whatever the profile already carries (e.g. an independently
# installed Better Dash) — nothing is promoted or removed here.
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<EOF
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
EOF
printf 'registry=%s\n' "$REGISTRY_URL" > "$PROFILE_DIR/.npmrc"
# Initial installation and native Plugin Manager both use pnpm's configured
# default store. Isolation belongs to this test profile, not a custom store.

if [ ! -f "$PROFILE_DIR/cordis.patch.yml" ]; then
cat > "$PROFILE_DIR/cordis.patch.yml" <<EOF
# Native WebServer bind and port are explicit deployment CLI flags.
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
fi
echo "--- pnpm install (complete local pack, native default script policy)"
(cd "$PROFILE_DIR" && $PNPM add "file:$TARBALL" "file:$DEV_WEBMCP" --prefer-offline)

# ---- 3. boot via the repo build's dsh CLI (no custom boot code) ----
# ---- test preparation (2026-10-10 test-only isolation; docs/07 §7) ----
# Keep retained test credentials. An explicit test-only source can seed a new
# home; production homes are never read. Do not pass empty provider keys through
# the unit environment: they would shadow the home .env layer.
if [ ! -f "$DSH_HOME_DIR/.env" ]; then
  if [ -z "${SUPERD_TEST_ENV_FILE:-}" ] || [ ! -f "$SUPERD_TEST_ENV_FILE" ]; then
    echo "refusing: test home .env missing; provide SUPERD_TEST_ENV_FILE with a test-only env file" >&2
    exit 1
  fi
  cp -- "$SUPERD_TEST_ENV_FILE" "$DSH_HOME_DIR/.env"
fi
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
# Operator access configuration remains valid when Better's permissive fence
# is disabled. These are official CLI authorities, not plugin policy overrides.
HOST_ARGS=()
# Declare the direct machine entrance on every test port. Only 4999 owns the
# Caddy-backed test.pc entrance; extra deployment authorities remain additive.
if [ -n "$LAN_IP" ]; then HOST_ARGS+=(--trusted-host "${LAN_IP}:${PORT}"); fi
if [ "$PORT" = "4999" ]; then HOST_ARGS+=(--trusted-host test.pc.internal.test); fi
PUBLIC_URL="${SUPERD_TEST_PUBLIC_URL:-}"
if [ -z "$PUBLIC_URL" ] && [ "$PORT" = "4999" ]; then PUBLIC_URL=https://test.pc.internal.test; fi
if [ -n "$PUBLIC_URL" ]; then HOST_ARGS+=(--public-url "$PUBLIC_URL"); fi
if [ -n "${SUPERD_TEST_TRUSTED_HOSTS:-}" ]; then
  read -r -a TEST_TRUSTED_HOSTS <<< "$SUPERD_TEST_TRUSTED_HOSTS"
  for authority in "${TEST_TRUSTED_HOSTS[@]}"; do
    HOST_ARGS+=(--trusted-host "$authority")
  done
fi
if [ "$BIND" = "127.0.0.1" ]; then HOST_ARGS+=(--host 127.0.0.1); fi
[ "$BIND" = "127.0.0.1" ] || { echo "unsupported SUPERD_BIND: $BIND; use native loopback plus the LAN relay" >&2; exit 1; }
systemd-run --user --unit="$UNIT" "${PROXY_ARGS[@]}" \
  --property=WorkingDirectory="$REPO" \
  --property=Environment="DSH_HOME=$DSH_HOME_DIR" \
  --property=Environment="SUPERD_DSH_ANCHOR=$ANCHOR" \
  --property=Environment="SUPERD_KEEP=1" \
  --property=Environment="SUPERD_TRACE=${SUPERD_TRACE:-0}" \
  --property='UnsetEnvironment=DISPLAY WAYLAND_DISPLAY' \
  --property=Environment="PATH=${SUPERD_TEST_BIN_DIR:+${SUPERD_TEST_BIN_DIR}:}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
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
# The native CLI binds loopback; this test-only relay exposes the chosen LAN IP.
# The CLI declarations above cover both direct and relay access. Better's
# authentication-only policy remains its own independently delivered behavior.
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
# Better's password form or native 401 are valid independent package states.
# Readiness also requires rejection by a protected API.
# Actual authenticated app/API behavior is verified separately at acceptance.
door_ready=""
for _ in $(seq 1 15); do
  if "$NODE_BIN" "$LINE/test/check-pair-login.mjs" "http://127.0.0.1:${PORT}" > "$REPO/.scratch/pair-login-${PORT}.json" 2>/dev/null; then
    door_ready=1
    break
  fi
  sleep 2
done
[ -n "$door_ready" ] || { echo "authentication entry / protected API readiness failed — inspect $LOG" >&2; exit 1; }
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
