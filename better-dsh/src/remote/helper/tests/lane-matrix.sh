#!/bin/sh
# superd-run lane-matrix — behavioral validation on real lanes (spec §5.2 safety contract:
# all group signals stay INSIDE the container/remote scope; never bare on a desktop uid).
# usage: lane-matrix.sh <local-binary> <triple> ssh:<host>|docker:<container>
set -u
BIN=$(readlink -f "$1"); TRIPLE=$2; SPEC=$3
MODE=${SPEC%%:*}; NAME=${SPEC#*:}
VER=0.1.0
SSHOPTS="-o BatchMode=yes -o ConnectTimeout=10"
P=0; F=0
ok() { echo "  PASS: $1"; P=$((P + 1)); }
bad() { echo "  FAIL: $1"; F=$((F + 1)); }

if [ "$MODE" = docker ]; then
  RB="/root/.cache/superd/run/$TRIPLE-$VER/superd-run"
  run() { docker exec -i -- "$NAME" /bin/sh -c "$1"; }
else
  RB="\$HOME/.cache/superd/run/$TRIPLE-$VER/superd-run"
  run() { ssh $SSHOPTS "$NAME" "$1"; }
fi

echo "== deploy [$SPEC]"
if [ "$MODE" = docker ]; then
  docker exec -i -- "$NAME" /bin/sh -c "mkdir -p /root/.cache/superd/run/$TRIPLE-$VER" \
    && docker cp "$BIN" "$NAME:$RB" >/dev/null \
    && docker exec -i -- "$NAME" chmod 0755 "$RB" || { echo "deploy failed"; exit 1; }
else
  ssh $SSHOPTS "$NAME" "mkdir -p \"\$HOME/.cache/superd/run/$TRIPLE-$VER\"" \
    && scp -q -o BatchMode=yes "$BIN" "$NAME:.cache/superd/run/$TRIPLE-$VER/superd-run" \
    && ssh $SSHOPTS "$NAME" "chmod 0755 \"\$HOME/.cache/superd/run/$TRIPLE-$VER/superd-run\"" || { echo "deploy failed"; exit 1; }
fi

echo "== [$SPEC] tests"
out=$(run "\"$RB\" banner"); echo "$out" | grep -q "proto=1 name=superd-run" && ok banner || bad banner
echo "$out" | grep -q "target=$TRIPLE" && ok "banner target=$TRIPLE" || bad "banner target"

out=$(run "\"$RB\" run --tag m1 -- /bin/sh -c 'echo OUT; exit 7'; echo RC=\$?")
echo "$out" | grep -q '^OUT$' && ok "stdout passthrough" || bad "stdout passthrough"
echo "$out" | grep -q '^RC=7$' && ok "verbatim exit 7" || bad "verbatim exit 7 ($out)"

run "\"$RB\" run --tag m2 -- /bin/sh -c 'true' >/dev/null 2>&1; [ -e /tmp/superd-oneshot-m2.pgid ] && echo STALE || echo CLEAN" | grep -q CLEAN && ok "pidfile cleaned" || bad "pidfile cleaned"

run "\"$RB\" run --tag m3 -- /bin/sh -c 'sleep 94321 & echo d' >/dev/null 2>&1; sleep 0.5; n=0; for p in /proc/[0-9]*; do [ \"\$p\" = \"/proc/\$\$\" ] && continue; grep -q 'sleep 94321' \"\$p/cmdline\" 2>/dev/null && n=\$((n+1)); done; [ \"\$n\" -gt 0 ] && echo ALIVE || echo DEAD" | grep -q DEAD && ok "straggler termed" || bad "straggler termed"

out=$(run "\"$RB\" run --tag m4 -- /bin/sh -c 'exec sleep 94322' >/dev/null 2>&1 & sleep 0.5; \"$RB\" killgroup --tag m4; sleep 0.3; n=0; for p in /proc/[0-9]*; do [ \"\$p\" = \"/proc/\$\$\" ] && continue; grep -q 'sleep 94322' \"\$p/cmdline\" 2>/dev/null && n=\$((n+1)); done; [ \"\$n\" -gt 0 ] && echo ALIVE || echo DEAD")
echo "$out" | grep -q 'remaining=0' && ok "killgroup drains" || bad "killgroup drains ($out)"
echo "$out" | grep -q 'DEAD' && ok "killgroup target dead" || bad "killgroup target dead"

run "\"$RB\" killgroup --pgid 1 >/dev/null 2>&1; echo RC=\$?" | grep -q '^RC=64$' && ok "pgid<=1 refused" || bad "pgid<=1 refused"

out=$(run "\"$RB\" run --tag m5 -- /bin/sh -c 'exec sleep 94323' >/dev/null 2>&1 & sleep 0.5; echo 12345 > /tmp/superd-oneshot-m5.pgid.st; \"$RB\" killgroup --tag m5 >/dev/null 2>&1; echo REFUSE=\$?; n=0; for p in /proc/[0-9]*; do [ \"\$p\" = \"/proc/\$\$\" ] && continue; grep -q 'sleep 94323' \"\$p/cmdline\" 2>/dev/null && n=\$((n+1)); done; [ \"\$n\" -gt 0 ] && echo ALIVE || echo DEAD; rm -f /tmp/superd-oneshot-m5.pgid.st; \"$RB\" killgroup --tag m5")
echo "$out" | grep -q '^REFUSE=64$' && ok "tampered sidecar refused" || bad "tampered sidecar refused ($out)"
echo "$out" | grep -q '^ALIVE$' && ok "refusal left target running" || bad "refusal left target running"
echo "$out" | grep -q 'remaining=0' && ok "compat killgroup (no sidecar)" || bad "compat killgroup (raw: $(printf '%s' "$out" | tr '\n' '|'))"

if [ "$MODE" = ssh ]; then
  echo "== [$SPEC] PDEATHSIG (kill local ssh client)"
  ssh $SSHOPTS "$NAME" "\"$RB\" run --tag pd1 -- /bin/sh -c 'exec sleep 94324'" >/dev/null 2>&1 &
  SSPID=$!
  sleep 1
  kill -9 $SSPID 2>/dev/null
  sleep 1.5
  run "n=0; for p in /proc/[0-9]*; do [ \"\$p\" = \"/proc/\$\$\" ] && continue; grep -q 'sleep 94324' \"\$p/cmdline\" 2>/dev/null && n=\$((n+1)); done; [ \"\$n\" -gt 0 ] && echo LEAK || echo CLEAN" | grep -q CLEAN && ok "disconnect cleanup (0 extra hop)" || bad "disconnect cleanup"
fi

echo "== [$SPEC] summary: $P passed, $F failed"
[ "$F" -eq 0 ]
