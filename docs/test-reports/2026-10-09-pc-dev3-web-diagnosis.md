# PC / dev3 Web diagnosis after DSH 0.2.1-alpha.1 reinstall

Scope: investigate the user's production-domain feedback and the unaffected 4999 control. No production configuration change, plugin toggle, service restart, prompt, publish, commit or push was performed during diagnosis. Browser startup in fresh contexts initially invoked the native blank-session creation path; subsequent traces restored an existing nonblank selection. User conversations were only opened for replay.

## PC: confirmed Host-trust rejection

Production entry: `https://dsh.pc.internal.test`. The active `dsh.service` command is `dsh web --no-open`, without `--trusted-host`. Caddy forwards directly to `127.0.0.1:3080`, preserving the public Host.

Read-only unauthenticated POST probes to `/api/directoryPicker/list`:

| Entry / Host | Result |
| --- | --- |
| Direct loopback, Host `127.0.0.1:3080` | 401 |
| Direct loopback, Host `dsh.pc.internal.test` | 403 |
| Direct loopback, public Host plus matching public Origin | 403 |
| Actual public HTTPS proxy | 403 |

The native `ConnectionRpcHost.requestRejection()` applies `isTrustedApiRequest()` before browser authentication. The first result reaches authentication; the other results fail the Host fence. This explains blank data lists and the directory-picker error. Prior authenticated loopback checks found the retained native sessions; blank lists at the public entrance do not establish data loss.

Official repair mechanism: declare `--trusted-host dsh.pc.internal.test` on this deployment. `--public-url` advertises an entrance and does not grant trust. This report does not apply that repair or restart production. The earlier reinstall acceptance covered loopback and missed the actual PC domain entrance.

dev3 differs: its Caddy upstream explicitly sets Host to `127.0.0.1:3080` and removes Origin. The same native fence therefore accepts its requests before authentication. PC's Caddy comments describe a historical custom loopback-host allowance, but this investigation did not verify the old installed artifact; the confirmed cause is the current native fence / deployment mismatch.

## dev3: genuine intermittent connection recovery reproduced

Production registry DSH is `0.2.1-alpha.1`; the user manually installed Super / Better `0.3.0-c`. User reports no corresponding symptom on the retained 4999 line.

Playwright used the real production domain and clicked two existing native sessions in the `superd` workspace, without submitting messages. Results:

| Trace | Switches | Physical WebSocket result |
| --- | --- | --- |
| Initial domain trace | 4 | One `/api/remote.mux` socket, no closure |
| Domain trace with actual connection-control observer | 4 | One closure; replacement socket established |
| Further domain trace with CloseEvent / protocol diagnostics | 4 | One socket, no closure |
| Same production service through diagnosis-only loopback SSH tunnel, bypassing Caddy | 4 | One socket, no closure |

The reproduced trace recorded native `Reconnecting...` at timestamp 1791480180022, `Connected` at 1791480180819, and the control disappearing at 1791480182970. Its physical socket closed at 1791480180020 and a replacement was created at 1791480180522. This is genuine connection recovery, not merely conversation text or an assumed status. The initial whole-body text match was discarded because the replayed conversation contains the word “reconnecting.”

No WebSocket Close control frame was captured in the reproduced trace; the later, deeper trace did not reproduce a closure. The precise close code, initiator and trigger remain unresolved. A successful four-switch loopback control cannot by itself establish that Caddy caused an intermittent failure.

`Sidebar Session opening failed: Session reference ... is released` also appeared during a domain trace that had no connection loss. The stack resolves to native `ClientSessionReference.release()` through `SidebarSessionView.dispose()`, including React teardown. It is insufficient evidence that reference release causes the socket loss.

Source comparison from `dsh-v0.2.0-rc.2` to `dsh-v0.2.1-alpha.1` found no changes in the native Connection runtime, mux Client, SettingsRoot connection-feedback logic or ConnectionIndicator. Native navigation and sidebar rendering do have changes. Ordinary native `openSession()` replaces the main reference; the Super Hub's explicit `connection.reconnect()` belongs to agent/world switching. These findings do not exclude a data-dependent or timing-dependent interaction in the delivered plugin composition.

Actual TypeScript LSP definition and incoming/outgoing call-hierarchy queries covered the trust predicate, Hub switch entry and mux reconnect method. Actual TypeScript AST traversal checked native navigation, Hub click sites and explicit socket-close paths. Evidence files are local ignored artifacts under `.scratch/pc-dev3-021-diagnosis/`; tokens and conversation snapshots are not included in this report.

The production units remained active with `NRestarts=0` and unchanged activation times: PC 2026-10-09 00:34:18 HKT; dev3 2026-10-09 00:34:48 CST. The diagnosis-only SSH tunnel was stopped; the existing 4999 line remains running.

Disposition: PC root cause established, repair not applied. dev3 symptom reproduced intermittently, root cause not yet established; next decisive evidence is a reproducing trace with the close event/initiator and the user's exact old-session pair. Do not classify native session switching as intentionally reconnecting or declare alignment failure resolved on the current evidence.

## Follow-up: authorized PC repair and deployment audit

The user subsequently explicitly authorized adding the CLI trust flag and restarting PC DSH, and requested an audit of possible old CLI/environment or YAML trust remnants on dev3.

PC repair: created `/home/u1/.config/systemd/user/dsh.service.d/95-public-trust.conf`, resetting ExecStart to `/opt/node-current/bin/node /home/u1/.local/bin/dsh web --no-open --trusted-host dsh.pc.internal.test`. Existing unit/drop-in files were backed up under `/home/u1/.local/state/dsh-pc-trust-20261009/`. Ran user-systemd daemon-reload and restart successfully. No `--public-url` was added. New activation time is 2026-10-09 01:49:41 HKT; process command line contains the new flag and `NRestarts=0`.

Immediately after restart, while the PC profile still contained only Corti, the actual public directory-picker API changed from 403 to 401 without an authentication cookie: the native Host fence now admits the declared hostname. Subsequent authenticated actual-domain tests returned session-list 200 / 979 entries and successful directory-list 200. A real Chrome UI showed populated workspaces; clicking native Add workspace opened the populated directory chooser and its request returned 200, with no page errors. No workspace was added and no prompt was submitted.

Read-only deployment audit examined the actual running process command lines and relevant environment keys, global CLI symlinks/package versions, native Connection top-level JavaScript artifact hashes, current web profile YAML, root nonsecret YAML, and the pre-reinstall archived web profile YAML. Both global cores are `0.2.1-alpha.1`, resolve the global registry CLI, and have identical checked Connection JS hashes. Before this PC repair, neither unit passed a trusted-host flag. dev3's running process has no trusted-host flag and no DSH trust/public-URL environment declaration. Current main profile YAML on either machine has no trusted-host/public-URL override; archived dev3 declarations were the native dynamic `ctx.webStartup.trustedHosts` / `ctx.webRuntime.trustedHosts` expressions, not old literal domain grants. Retained agent-world YAML likewise contains native dynamic expressions; those files do not establish a grant in the production root web profile.

The confirmed pre-plugin deployment difference is outside npm and plugin YAML: PC's existing Caddy block preserves the public Host/Origin; dev3's existing block rewrites Host to `127.0.0.1:3080` and removes Origin. Consequently native dev3 can admit the proxy request even when Super / Better are absent. The reinstall retained the proxy configurations, as recorded in its receipt. The missing acceptance coverage was comparison and verification of both real public entrances; the observed difference does not establish dirty plugin uninstall.

Concurrent installation state matters: the first PC audit found Corti only; later its profile package.json modification time was 01:53:33 HKT and it contained Super / Better `0.3.0-c`. This turn did not install those packages. dev3 already had the user's manually installed pair. The newly delivered Better composition explicitly enables `dashr-web-trust.config.trustAllHosts: true`, whose owned admission delegate keeps native cookie authentication and removes the Host/Origin fence. Therefore current dev3 unauthenticated raw-Host variants all return 401; that is the new installed plugin behavior and is not evidence of an old trusted-host list. The PC UI acceptance above took place after this concurrent package installation; the native-only post-restart 401 observation preceded it.

PC's production service was restarted once for the authorized flag change. dev3 remained at its original 00:34:48 CST activation/PID 728521; its service and Caddy were not changed. The existing 4999 service remains active at its original activation. No source change, release, commit or push was performed. A future normalization of the proxy deployments would use explicit native trusted-host declarations on both machines and transparent proxy headers, but is not applied by this follow-up.
