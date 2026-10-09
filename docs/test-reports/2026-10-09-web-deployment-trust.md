# PC / dev3 deployment trust alignment — 2026-10-09

User authorized production systemd/Caddy alignment and test-rig changes: declare trusted authorities through the official CLI, preserve actual Host/Origin through the proxy, and reserve `test.pc.internal.test` for port4999. DSH remains `0.2.1-alpha.1`; the accepted Better/Super artifacts remain `0.3.0-c`. No publication, version change, commit or push was performed.

## Applied deployment

| Instance | Actual systemd trusted-host arguments | Proxy |
| --- | --- | --- |
| PC production3080 | `dsh.pc.internal.test` | Transparent public-domain proxy to `127.0.0.1:3080` |
| dev3 production3080 | `dsh.dev3.internal.test` | Transparent public-domain proxy to `127.0.0.1:3080`; existing compression/cache settings retained |
| PC Super4999 | `192.0.2.130:4999`, `test.pc.internal.test` | Transparent test-domain proxy to `127.0.0.1:4999`; direct LAN access retained |
| PC Better4997 | `192.0.2.130:4997` | Direct LAN; no test.pc declaration |
| dev3 Super4998 | `187.127.111.29:4998`, `dev3.internal.test:4998`, `192.0.2.130:4996` | Existing PC4996 review tunnel retained; no test.pc declaration |

The dev3 primary interface address is public, not a private LAN address. The launcher uses its existing primary-IP discovery and declares `IP:port` on each test port; `SUPERD_TEST_TRUSTED_HOSTS` remains additive. Listener bind and authentication policy were not changed.

PC's already-active production drop-in `/home/u1/.config/systemd/user/dsh.service.d/95-public-trust.conf` retains the earlier authorized flag and Node executable. dev3 has the same drop-in mechanism, with `ExecStart=` followed by `/home/u1/.local/bin/dsh web --no-open --trusted-host dsh.dev3.internal.test`. dev3 daemon-reload and restart succeeded; PC did not need another production restart.

Both machines keep private backups under `/home/u1/.local/state/dsh-web-trust-20261009/`. Caddy candidates were validated before installation; reloads succeeded. Active runtime configuration, read through the local Caddy admin API, confirms all three targeted proxy handlers have no request-header overrides. Other proxy sites, including3081, were outside this change.

## Delivery and launcher behavior

PC4999 was relaunched first, followed by PC4997 and dev34998, through `super-dsh/test/start-4999.sh`. Each reused its existing home, profile, DSH anchor and the verified accepted dual-artifact pair. Better archive SHA256: `a9287af10438fc48ca32a048392cf5192f5cef864fe152eb2b50c99e58061563`; Super archive SHA256: `d9a2402dde554204d703e7cc342762d66ffeec54e1c2faec9a36608b90e2a37a`. No altered package archive was manufactured under the released version.

The first PC4999 restart exposed an existing repeat-launch defect: the launcher removed Better's registered direct dependency but retained its delivery receipt. The shipped coordinator correctly interpreted that state as an intentional same-artifact removal, so cold restart alone could not restore Better. I restored the previously registered accepted Better archive through the official native `runProfilePnpm` package operation, then fixed the launcher to retain an existing Better dependency and its independent bundle enablement during profile reconstruction. The subsequent complete launcher run passed. Fresh profiles still declare only the selected consumer and rely on the delivered coordinator for first promotion; no receipt was deleted and no launcher first-promotion override was introduced.

The dev3 initial preflight also exposed an unconditional socat requirement despite the selected wide-bind mode. The launcher now requires socat only for explicit loopback relay mode. dev3 then completed the normal launch without introducing a relay or installing a replacement dependency. The final launcher on both machines has SHA256 `443c63640dec95aa84a425a9a1b54aa93de6513bff6e99484c272f52e67336b4`.

## First-person browser acceptance

Actual Chrome/Playwright sessions authenticated at each entrance, loaded an existing session, observed `/api/remote.mux`, clicked **Add workspace**, and verified the resulting directory-list request. The dialog was canceled without adding a workspace; no model prompt was submitted.

| Entrance | Session list HTTP / count | Directory RPC | UI picker request | WebSocket / page errors |
| --- | --- | --- | --- | --- |
| `https://dsh.pc.internal.test` | 200 /979 | 200, ok | 200 | Established /none |
| `https://dsh.dev3.internal.test` | 200 /71 | 200, ok | 200 | Established /none |
| `https://test.pc.internal.test` | 200 /21 | 200, ok | 200 | Established /none |
| `http://192.0.2.130:4999` | 200 /21 | 200, ok | 200 | Established /none |
| `http://192.0.2.130:4997` | 200 /7 | 200, ok | 200 | Established /none |
| `http://192.0.2.130:4996` →dev3test4998 | 200 /7 | 200, ok | 200 | Established /none |

Browser JSON and screenshots are in `.scratch/web-deployment-trust/` under tags `pc-prod`, `dev3-prod`, `pc-4999-domain`, `pc-4999-lan`, `pc-4997-lan`, and `dev3-test-review`. No API failures were recorded in the successful runs.

Initial LAN browser runs encountered503 through this machine's client HTTP proxy, while direct curl and authenticated API calls returned200. LAN browsers were rerun with `--no-proxy-server`, retaining their actual LAN Host/Origin and authentication. An intermediate4997 run timed out during navigation; its next run reached the UI but the one-second picker sampling window was insufficient. The final probe awaited the actual directory response and passed. These probe failures did not justify changes to serving policy.

Final checks found PC and dev3 production units and all three test units active, with `NRestarts=0`. Whole production and shared-test credential-file hashes match the pre-operation snapshots on both machines. Existing data/settings/auth seeds were retained. `bash -n` and `git diff --check` passed.

Actual TypeScript LSP definition and call-hierarchy requests checked `webCommand`, `resolveLanTrust`, and `isTrustedApiRequest`; TypeScript AST inspected the official CLI option declarations. Evidence is in `.scratch/web-deployment-trust/lsp.jsonl` and `ast.json`. Bash LSP, shellcheck and ast-grep were unavailable; the Bash checks used syntax verification and actual complete launcher execution instead.

Acceptance limits: Better's delivered `trustAllHosts: true` authentication-only policy remains enabled, so these successful authenticated requests do not independently prove native Host-fence rejection while Better is absent. The actual CLI declarations and transparent proxy are verified. dev3's public test port was not opened in its firewall; browser acceptance used its existing review tunnel. This task does not establish a fix for the previously observed intermittent session-switch reconnection, nor repeat the package's model create/prompt/resume release acceptance.

## Public URL scenario

The checked upstream CLI describes `--public-url` as advertisement only, granting no trust. `packages/bundle/web-app/src/index.ts` uses it for printed/opened links, the `app:web-surface` system-prompt section and session-shell `DSH_WEB_URL`. Without it, the advertised root defaults to the server's loopback URL.

For example, DSH runs on dev3 while the user opens its GUI from PC. `dsh web --no-open --trusted-host dsh.dev3.internal.test --public-url https://dsh.dev3.internal.test` advertises the address the user can actually reach. A native Agent asked to identify/open the current GUI can read `DSH_WEB_URL` and receives the public URL rather than dev3's `127.0.0.1:3080`; opening the latter on PC would refer to PC itself. Trust declarations, authentication, listener bind and Caddy routing still require their own configuration. No public-url flag was added by this task.

All test endpoints remain running for user acceptance, especially `https://test.pc.internal.test` and `http://192.0.2.130:4999`.
