# Web Deployment Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Declare serving authorities in systemd CLI arguments and preserve actual Host/Origin through Caddy on PC, dev3 and test4999.

**Architecture:** Native CLI owns deployment trust; Caddy only forwards traffic. Test launcher supplies primary machine-IP authorities and the port4999 public hostname independently of Better's delivered policy.

**Tech Stack:** Bash launcher, user-systemd, Caddy, installed DSH0.2.1-alpha.1, real Chrome/Playwright.

**Spec:** `docs/specs/web-deployment-trust/spec.md`

## Global Constraints

- User explicitly authorizes production systemd/Caddy adjustment and the required service restart/reload.
- Preserve all user data and credential seeds; do not change package code, bind policy or versions.
- Reuse accepted0.3.0-c artifact pairs through `SUPERD_TEST_PACK_DIR`; no registry publication or Git finalization.
- Only port4999 gets `test.pc.internal.test`; other configured authorities are additive.

### Task 1: Persistent launcher contract

**Files:** `super-dsh/test/start-4999.sh`, `super-dsh/test/README.md`, `docs/07-cordis-dsh-dev-test-guides.md`.

- [x] Inspect official CLI/trust implementation with real TypeScript LSP and AST; record absence of Bash LSP/AST tools rather than claiming them.
- [x] Add default `HOST_ARGS+=(--trusted-host "${LAN_IP}:${PORT}")` when the primary IP is present and `HOST_ARGS+=(--trusted-host test.pc.internal.test)` only for port4999. Keep extra-authority and loopback bind behavior.
- [x] Remove comments claiming trust CLI flags are unnecessary; document the new default declaration contract.
- [x] Preserve previously registered Better dependency/bundle state across repeat profile rebuilds; keep fresh profiles dependent on the coordinator. Require socat only in loopback relay mode. These launcher defects were observed during real execution; do not change package behavior or erase delivery receipts.
- [x] Run `bash -n super-dsh/test/start-4999.sh`; verify delivered units using actual launcher runs in Task3.

### Task 2: Production systemd and proxy alignment

**Files:** PC/dev3 user `dsh.service.d/95-public-trust.conf`; targeted blocks in `/etc/caddy/Caddyfile` on each machine.

- [x] Back up unit/drop-in files and Caddyfile in owner-only state directories on both machines.
- [x] Retain PC's existing trusted-host flag. Add dev3 `ExecStart=/home/u1/.local/bin/dsh web --no-open --trusted-host dsh.dev3.internal.test`, resetting the original ExecStart in the drop-in.
- [x] Prepare exact Caddy candidates: PC production and test use `reverse_proxy 127.0.0.1:3080` / `:4999`; dev3 retains asset/compression settings and uses `reverse_proxy 127.0.0.1:3080`. Remove only target Host/Origin rewrites and obsolete target comments.
- [x] Validate candidates with `sudo -n caddy validate --config <candidate> --adapter caddyfile` before installation. Restart dev3 DSH with the new arguments before reloading its proxy. Preserve PC's already-valid production process.
- [x] Install validated candidates preserving live file metadata; run `sudo -n systemctl reload caddy`, and inspect active configuration/units. Restore the saved file and reload only if a validation or application failure requires rollback.

### Task 3: Delivered test rigs and actual-entrance acceptance

**Files:** Existing test homes/units and verified artifact pairs; `docs/test-reports/2026-10-09-web-deployment-trust.md`.

- [x] Apply the launcher-only change to the identical dev3 launcher, with a pre-edit hash check and backup.
- [x] Relaunch PC4999 first with its existing home/profile/anchor and `.scratch/superd-pack` accepted pair; then PC4997 with Better consumer. Relaunch dev3test4998 using its existing accepted alignment pair, installation anchor, foreign-substrate home and extra review authorities.
- [x] Inspect actual ExecStart flags: each test declares direct IP:port; only4999 declares test.pc; dev3 preserves its extra review hosts.
- [x] Use real-browser authenticated PC/dev3 production domain and PCtest domain calls to session/list and directoryPicker/list and inspect actual WebSocket. Check PC4999/4997 direct LAN API and dev3test through the existing4996 review tunnel. Do not submit model prompts or add a workspace.
- [x] Confirm credential seed hashes stayed unchanged, all intended units remain active, target Caddy blocks have no Host/Origin rewriting, and record any acceptance limitation honestly.
- [x] Complete the report and explain public-url using the remote-browser scenario. Leave test endpoints running for the user.

**Result:** Completed. Evidence and execution corrections: `docs/test-reports/2026-10-09-web-deployment-trust.md`. Production and test endpoints remain active for user acceptance.
