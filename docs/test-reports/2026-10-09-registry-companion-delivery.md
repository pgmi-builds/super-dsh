# Exact registry companion delivery — 2026-10-09

User direction supersedes Better physical embedding: Super declares Better as an ordinary synchronized exact dependency. Current unpublished iteration is **0.3.0-f**, retaining the preceding failover/compaction client lifecycle fix.

**Later release acceptance:** [0.3.0-d release report](2026-10-09-030-d-release-and-cleanup.md) records the user-selected next public letter, both machines' successful fresh native create/prompt/cold-resume acceptance, and publication/cleanup. This document preserves F's historical results; its unresolved acceptance paragraph below is not the current release status.

## Delivered behavior

- `super-dsh.dependencies.better-dsh = "0.3.0-f"`; Better is absent from `bundledDependencies`, the files list, nested archive content and any delivery descriptor. Pi's separately authorized bundled dependency remains unchanged.
- Both packages still build from this repository. Pair verification checks SHA256, synchronized versions/exact edge, independent Super YAML, absent physical Better payload and real browser exports. The development artifact extraction only supplies real local imports/types; it is excluded from Super's npm archive.
- One user npm installation downloads both exact registry packages. DSH only exposes explicit direct dependencies/selected bundles, so Super owns a small native registration coordinator; Better contains no coordinator, child registration script or delivery row. This also prevents an old directly installed Better from supplying a stale coordinator to an upgraded Super.
- Registration runs under the native profile writer lock. Existing npm-hoisted exact files need only profile/npm lock root metadata updates; actual `npm ci --offline` verifies the lock remains consumable. Old direct version conflicts use the consumer's npm cache through native package operations, offline. pnpm profiles use native `saveManifest` and `runProfilePnpm(['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'])`. No second registry fetch or installation hook. A cache failure reports failure, without online fallback.
- Native `add --offline` is intentionally avoided: inspected upstream operations run an online `pnpm view` preflight for named registry specs even when add is offline. The unnamed native install path avoids that lookup.
- Successful registration records versions in `companion-registration/`. Same-version explicit removal, retained disablement, receipt recovery, native writer-lock races and cancellation are covered. Existing old `bundle-artifacts` files are retained, never copied/replaced by this version. Removing Super retains the directly registered Better.
- New Better Code source is truthfully `better-dsh@0.3.0-f`. No provenance is forged. Independent YAML/bundle/component controls remain native.

The dependency declaration follows the [official npm package.json contract](https://docs.npmjs.com/cli/configuring-npm/package-json/). Ship Better before Super so the exact dependency exists when consumers install Super. Public publication is still subject to this release's explicit approval.

## Artifacts and environments

| Artifact | SHA256 |
| --- | --- |
| Better 0.3.0-f | `ca87532dfcf374291fb1f5d91696af90dc0b3b274694c0e913680e610fc7e552` |
| Super 0.3.0-f | `139bde9cbdfe5b1150ae041804b1ab6cc72fb1fc6fad6b41d0003b7f3b9e77e9` |

The full official `npm run pack` pipeline built both. PC4999 accepted first, then the unchanged archives/pair were transferred to dev3; target SHA256 matched. PC uses the existing aligned source-build DSH0.2.1-alpha.1; dev3 uses its isolated exact registry-installed DSH0.2.1-alpha.1 anchor. Production plugins/services/Caddy were not changed by this task.

The existing launcher owns a read-only loopback registry gateway (`superd-4999-pair-registry`, port14999; target port14998). It serves these unmodified unpublished archives/metadata, redirects other dependencies to the configured normal registry and refuses write methods. This is test delivery infrastructure, not public npm publication, an override, a preinstalled companion or a changed consumer manifest. The profile's registry setting is shared with native Plugin Manager.

Launcher preserves the existing profile, saved component patches, other dependencies and Better selection instead of deleting the profile. Shared auth seed and test env conventions remain. Build/pair verification now precedes stopping a running rig. Target launcher/support files were backed up under `.scratch/registry-dependency-backup`; prior profile/patch snapshots are retained.

## Verification

Actual LSP definition/references/call hierarchy and TypeScript AST were used before implementation. The expensive global `runProfilePnpm` references request timed out; definitions/call hierarchy were obtained on the subsequent run, along with the coordinator's incoming/outgoing calls. No upstream edits or fake type stubs.

- Root package/delivery suite: **27 passed**, including native real package operations, fresh/updated npm consumers, offline `npm ci`, disablement/removal, lost receipt, uninstall races, cancellation and missing exact version failure.
- Better targeted client lifecycle/Host failover: **10 passed**; Host and browser typecheck passed. Full pack compiled every component and both client faces, and verified Pi's existing bundled closure.
- A plain full-artifact consumer with an empty npm cache made **one** `npm install super-dsh@0.3.0-f` (normal script policy, no approval override). Test registry observed both manifests and both exact `.tgz` downloads. Better was initially transitive, both installed versions were F, subsequent native registration made **zero** registry requests and wrote an exact direct dependency/npm lock edge. Evidence: `.scratch/registry-dependency/npm-full.json` and install log.
- Real native Plugin Manager UI registry install on both PC4999 and dev3 used one install operation, no pending/approved build scripts and no page errors. Both resulting sources are exact registry specs. The native UI initially installs disabled; its enable control was completed afterward (PC during its matrix; target through the actual native switch). Evidence: `pc-f-install.json`, `dev3-f-install.json`, `dev3-enable.log` in the scratch evidence directory.
- The Better details page visibly renders `better-dsh@0.3.0-f` in Code source on both machines; screenshots and JSON proofs retained.
- Nine-state independent Super/Better enablement matrices passed on both. The seven-entry roster is native, agy, Claude, Codex, Hermes, OMP and Pi; all worlds mounted ready without failed fibers when Super enabled. Both-off/independent-on cases and reactivation were checked. The two observed HTTP reconnects per matrix occurred when replacing Better's WebServer during bundle toggling, not during session switching.
- Actual General UI checks cover initially disabled failover absence, live on/off/on, real model selection persistence and independent compaction disappearance; fixtures restore prior component states/fallback values. All six stages passed on PC and dev3 with both registry bundles enabled, without browser errors.
- PC actual Add workspace picker/API returned200, session/list200 and one `/api/remote.mux` socket without errors/API failures. The dialog was canceled.

## Actual sessions and limits

PC native create/prompt executed Better's real `eval`, producing `DEPENDENCY-EVAL-42: 42`; following a cold restart the same session resumed and remembered the marker. Pi/Codex/Claude/OMP/Hermes each completed create/prompt and same-session resume after restart. Antigravity was attempted for both turns but returned its existing billing-related `QUOTA`; it is **not** recorded as a passed model test.

On dev3, Pi/Codex/Claude/OMP/Hermes each passed actual create/prompt and same-session resume after the cold restart. Antigravity again returned billing `QUOTA` and is not passed. Native first-turn create/prompt executed the real Better `eval` successfully, but **native history-recall acceptance failed**: the completed second turn did not return the previous result/password. A third diagnostic prompt, without supplying the password, returned `NO_HISTORY`.

The native session is `session-d3e1a366-4f61-49b5-8e03-615bf9bf1346`. Its original user/tool/assistant events remain on disk. Reconstructing that exact log with the target's actual installed `@deepseek-ai/dsh-session` and calling `Session.create(...).deriveMessages()` returned 14 messages containing both the first password and eval result, with no surface replacement events. All three turns have durable completed events and DeepSeek delivery acceptance watermarks. Official Agent Loop passes `session.deriveMessages()` into generation, and the DeepSeek adapter serializes its supplied history before request submission. These checks rule out simple on-disk deletion and show offline derivation retains history; they do **not** prove the live outbound payload or establish whether the failure is in the live Host/provider path or model behavior. The native resume issue remains unresolved; this report does not claim complete runtime release acceptance. Diagnostic evidence is `.scratch/registry-dependency/native-history-diagnostic.json` and `native-derived-history.json`.

The earlier target probe ran before native UI enablement, found Super absent/disabled and created no session; it was invalidated and rerun after enabling. Initial browser fixture failures were UI targeting/readiness issues (Add plugin opens its dialog directly; Registry includes its chosen source in its accessible name; the page-mcp badge covers part of Settings). The final fixtures use observed official controls and an uncovered ordinary pointer point, without force-clicks or DOM changes. An early archive-list verification hit Node's default1MB output buffer; its explicit bounded16MB buffer accommodates the existing large Pi closure. Failed/in-progress packs were discarded; the final F pair was generated by the full pipeline. No fixture workaround was added to business code.

Loaded package/provenance replacement and first registration on this Host retain the documented cold-restart boundary. Ordinary independent bundle switches remain live. With Super disabled, its coordinator defers registration until Super is enabled.

## Review and release state

Keep [PC4999](https://test.pc.internal.test) and [dev3 review](http://192.0.2.130:4996) running for user review; both test registry services remain available for native Plugin Manager. Both bundles and the test component switches are restored enabled with original fallback selections. Production and shared test credential seed hashes matched the pre-task snapshots on both machines. No npm publish, public registry mutation, Git commit/tag/push or production package upgrade occurred. This task has not published F to public npm. Public-registry acceptance follows explicit publication approval, after resolving the native resume acceptance failure and accounting for the Antigravity quota limit.
