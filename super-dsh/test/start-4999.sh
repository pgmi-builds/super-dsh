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
set -euo pipefail
# Rig knobs (docs/07 §3.3 compat/clean pairing): the defaults below are the
# COMPAT rig (long-lived home, session-format verification). A CLEAN rig:
#   SUPERD_PORT=4997 SUPERD_HOME_DIR=$PWD/.tests/superd-clean \
#     bash super-dsh/test/start-4999.sh
# (disposable home — delete it between runs; see test/README.md).
PORT="${SUPERD_PORT:-4999}"
UNIT="superd-${PORT}-test"
REPO="$HOME/workspaces/superd"
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

# Idempotent restart of THIS rig's own named units only (same names ⇒ same
# rig). A foreign listener on the port still refuses below. Repo port
# discipline: a 4999 occupant is retired ONLY on explicit user instruction —
# never kill anything this rig does not own.
systemctl --user stop "$UNIT" "$RELAY" 2>/dev/null || true
systemctl --user reset-failed "$UNIT" "$RELAY" 2>/dev/null || true
for _ in $(seq 1 15); do ss -tln | grep -q ":${PORT} " || break; sleep 1; done
if ss -tln | grep -q ":${PORT} "; then
  echo "refusing to start: port ${PORT} already listening (foreign process):" >&2
  ss -tlnp | grep ":${PORT} " >&2 || true
  if [ "$PORT" = "4999" ]; then
    echo "  4999 = shared Caddy-backed port (test.pc.internal.test). Either:" >&2
    echo "    ① SUPERD_PORT=<free> bash super-dsh/test/start-4999.sh  # socat LAN relay auto-starts" >&2
    echo "    ② user explicitly retires the occupant — never kill it silently." >&2
  else
    echo "  pick another port: SUPERD_PORT=<free> bash super-dsh/test/start-4999.sh" >&2
  fi
  exit 1
fi
WATERMARK=$(wc -l < "$LOG" 2>/dev/null || echo 0)

# ---- 1. build + pack the delivery artifact ----
"$NODE_BIN" "$LINE/scripts/pack.mjs"
TARBALL="$REPO/.scratch/superd-pack/super-dsh-$("$NODE_BIN" -p "require('$LINE/package.json').version").tgz"

# ---- 2. fresh profile consuming the tarball (consumer manifest shape) ----
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
rm -rf "$PROFILE_DIR"
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "superd-pub-profile",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "super-dsh"] } },
  "dependencies": { "super-dsh": "file:$TARBALL" }
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
(cd "$PROFILE_DIR" && $PNPM add "file:$TARBALL" --config.store-dir="$PNPM_STORE" --prefer-offline)
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
# ---- test preparation (2026-09-24 user ruling; see super-dsh/AGENTS.md
# 「测试准备」) — the line must see the world production sees, or the test
# tests the wrong thing:
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

# systemd parses space-separated tokens as separate assignments — a
# space-containing value needs its own inner quoting.
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
    --profile "$PROFILE" --no-open

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
# The fence already trusts the LAN IP in both entry forms (unit env above).
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
echo "--- listening on ${PORT}; token URL (this boot):"
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
