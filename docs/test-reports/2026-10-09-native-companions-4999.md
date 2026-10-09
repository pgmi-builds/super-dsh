# Native companion / stable listener acceptance — 2026-10-09

Branch: `codex/native-companions`; worktree: `/home/u1/workspaces/superd/.worktrees/native-companions`. Local final artifacts: **0.3.0-i**. No publish, commit, tag or push. User authorized 4999 plus existing DEV3 pairing, not a DEV3 deployment.

## Result and implemented contract

- Super and Better are synchronized-version, independent native bundles. Super contains neither a Better npm dependency edge nor Better physical payload. Removed the old offline child package-registration helper.
- Runtime first-use installation and Hub Settings Install share the host's native `pluginManager.installBundle`: exact installed Super package version → `better-dsh@latest` → bare `better-dsh`, stopping on verified native success. No separate package manager, registry resolver or install hook.
- Existing Better versions, disablement and removal are authoritative. Per-profile intent lives under `$DSH_HOME/superd/companions/`; legacy receipt migration removes only the corresponding old file and an empty old directory. Automatic first use does not resurrect an uninstall after a restart or Super upgrade.
- Hub Settings' first row displays local Better installation/version/disablement/progress/errors. It remains a ctx0 management surface while a DEV3 runtime is selected.
- Better no longer replaces WebServer or HMR, changes the listener address, or acknowledges preview versions on the server. Its independently switchable client contribution shadows only `settings.onboarding` / `welcome-notice` and completes each selected mount through the public owner callback.
- Native listener uses CLI loopback, trusted hosts and public URL. Test LAN access uses the existing relay. The launcher recognizes both the Better password door and the native 401 challenge, and requires anonymous protected API rejection in either case.

## Acceptance-discovered route lifecycle defect

Removing the replacement listener exposed an existing Hub lifetime error: the pairing route belonged to the Connection injection child, but `/hub`, reprobe sweep and PTY disposal belonged to its outer component. Better's native Connection replacement removed the pairing route while retaining old Hub routes; re-registration collided and `/superd/pair-auth` returned 404. Super disable/enable restored native authentication and DEV3 reverse pairing without authentication/configuration changes.

The correction moves those effects into the existing Connection injection scope. Async PTY registration is awaited by the scope so late setup is disposed during unload. No upstream source changes, listener replacement or private HMR patch was added. Real native WebServer + Connection regressions failed before the correction and passed afterwards, including repeated replacement and late PTY registration.

## Actual consumer and UI evidence

The canonical launcher installed the real Super tarball into new profile `superd-native-companions` inside the preserved `.tests/superd` home. It kept the existing shared credential seed and existing data/pairing rows. A test registry serves both verified local archives; native Better installation fetched the current exact version through the normal package operation.

| Consumer behavior | Observed result |
|---|---|
| Fresh Super-only F boot | Native runtime installation registered independent Better `0.3.0-f` |
| Native Better disable / enable / uninstall | Final I: all HTTP 200, `ok:true`, `application:applied`; no override/502 toast; Settings installed I again |
| F uninstall → Super G upgrade | Better remained absent; original Preview Notice returned |
| G Settings explicit restore | Native install returned Better `0.3.0-g` |
| G uninstall → Super I upgrade, same profile | `installed:false`, `requestedVersion:0.3.0-i`; no automatic resurrection |
| I Settings Install while DEV3 native runtime selected | Request remained `/api/superdCompanions/installBetterDash`; installed **local** Better `0.3.0-i` |
| I pairing authentication before / after Better hot installation | Dedicated native route returned 303 with native cookie in both states, and again after independent switches/uninstall/reinstall |
| DEV3 pairing | User-facing Add machine succeeded; outgoing DEV3 E and incoming local I probes both succeeded, seven runtimes each |
| Fresh browser / old session → new session | No Preview Notice; three G transitions and final I smoke verified |
| Welcome component alone off / on | Off restored original Preview Notice in a fresh browser; on suppressed it; native component changes applied |
| Independent Super switches | Final I disable/enable both applied, Better stayed enabled; four package toggles plus Better removal were five successful native mutations |
| Native listener | Same PID `2861650` across final I hot installation and all five native management changes; `127.0.0.1:4999` native listener plus `192.0.2.130:4999` relay |

Browser automation used an isolated headless browser and native accessible controls. Pairing tokens, authentication cookies and credential seed stayed out of reports/screenshots/output. No existing production pair rows were removed, and DEV3 packages/services/Caddy were unchanged.

## Verification

- Final root tests: **38 passed** (`npm test`). Covers package contracts, native HMR, exact/latest/bare fallback, coalescing, native resolved failures, migration/removal/upgrade intent, diagnostic retention and auth readiness.
- Better full suite: **69 suites, 713 passed, 4 skipped, 0 failed**. Real prepared Python and Chrome were selected through existing test fixture variables (`DASHR_TEST_PYTHON`, `DASHR_BROWSER_BIN`); no product defaults/timeouts were changed for those environment gaps.
- Gateway / pairing / mesh / PTY relevant tests: **60 passed**, including two real native-framework lifecycle regressions.
- Companion host/lifecycle scope: **16 passed**; browser companion API/fusion scope: **32 passed**.
- Hub and Better host/client typechecks and build passed. Actual TypeScript LSP definitions/references/call hierarchies and AST inspection were used; the early Better LSP process aborted after successful initial queries, while later gateway navigation completed.
- Whole diff/source review and follow-up reviews approved after fixing stale diagnostics and injection lifetime. Shell syntax and `git diff --check` passed. A legacy fusion test import of Super's removed Better dependency was corrected to the independently built sibling output; the 32-test scope then passed without restoring the forbidden dependency.

Final tarball SHA-256:

| Artifact | SHA-256 |
|---|---|
| `better-dsh-0.3.0-i.tgz` | `553c2e2d584c72bce6418fa6bc79c74f83bf1b22761a14c8b022d7651e852ed7` |
| `super-dsh-0.3.0-i.tgz` | `0fb6c26cad7bea188ce0b4a538990aa26c28c14960157b4ab251eb3a433a5379` |

Evidence remains in ignored worktree scratch: `native-companions-pack-i.log`, `native-companions-root-test-i.log`, `native-companions-better-fixture-final-test.log`, `gateway-lifecycle/`, and `native-companions-ui/` (`final-i.json`, welcome lifecycle/switch, `final-management-i.json`, native management and screenshots).

## Boundaries and retained test line

Exact failure → latest → bare and total-failure/manual-retry branches were exercised with controlled native-manager behavior tests; the actual registry consumer succeeded at the first exact request. Arbitrary future upstream/plugin hot-reload constraints can still require a native restart; the implementation reports that outcome rather than claiming universal hot replacement.

Automatic installation is scheduled at cold readiness and after native Plugin Manager changes. A watcher-only YAML mount does not start a nested package operation inside HMR; Settings Install or a cold restart supplies that path.

Keep the worktree, current test home and registry alive for user acceptance:

- Web: https://test.pc.internal.test/
- Loopback: http://127.0.0.1:4999/
- LAN: http://192.0.2.130:4999/
- Units: `superd-4999-test`, `superd-lan-4999-relay`, `superd-4999-pair-registry`.

No release or cleanup has been performed in this task.

## User acceptance and release authorization

2026-10-09: user independently disabled and uninstalled both packages through the 4999 Web UI and observed no toast messages. User accepted this round and explicitly authorized push/publication at the smallest next public letter, then stopping 4999. Registry queried before release: both latest tags `0.3.0-e`, no `0.3.0-f`; the public release version is `0.3.0-f`, distinct from local I acceptance. Publication/stop results are recorded in `2026-10-10-030-f-release.md`.
