# Settings lifecycle, public URL and native package provenance — 2026-10-09

## Findings and scope

PC and dev3 production both reproduced the reported mismatch after their requested public-url restarts: native Plugin Inventory reported `include:dashr-failover` disabled, with `fiberPhase: null`; `settings.describe` omitted `dashr-failover`; an actual browser still displayed **Model failover** in General. Thus the backend feature was disabled. Its editable client row was a stale capability advertisement, not evidence that model failover was running.

The package client entry is `src/failover/client/index.ts`, registered under the bare `better-dsh` package by its active root component. Disabling the separate `better-dsh/failover` Host row leaves that package client mounted. Its old unconditional slot contribution continued showing selectors; `loadConfig()` treated a missing namespace as an empty configuration, and save targeted the absent namespace. Compaction had the same unconditional registration pattern.

The fix uses the official native `configForms.whileServed` API, wrapped in `ctx.effect`, for both General contributions. The UI appears only while its corresponding Host settings owner is served, withdraws on disablement, and returns on enablement. No backend feature is automatically enabled to make the UI work, and no upstream source or native configuration API was altered.

## Production advertisement and test configuration

User explicitly requested public-url for domain deployments. PC/dev3 `95-public-trust.conf` now retains its existing trusted-host declaration and adds respectively:

- `--public-url https://dsh.pc.internal.test`
- `--public-url https://dsh.dev3.internal.test`

Both production services were daemon-reloaded and restarted successfully. Their actual startup advertisements, scrubbed of authentication tokens, are `https://dsh.pc.internal.test/` and `https://dsh.dev3.internal.test/`. Private pre-edit drop-in backups are under `/home/u1/.local/state/dsh-public-url-20261009/` on each machine. Caddy remains transparent as verified in the preceding deployment report.

The test launcher now supplies `--public-url https://test.pc.internal.test` by default on port4999, alongside its LAN:port and test.pc trusted-host flags. `SUPERD_TEST_PUBLIC_URL` explicitly declares other canonical entrances; arbitrary extra trusted authorities are not interpreted as serving URLs. dev3test4998 uses `--public-url http://192.0.2.130:4996`, its already-reachable review tunnel, retaining all existing trusted authorities. No firewall or extra proxy site was added. The two deployed launcher files have matching SHA256 `5fbe1ea71405d7dc2730084ed7fdd75a68df9d9c2b851657c4497a141a7b9f8e`.

Source verification confirms native web-app uses public-url for printed/opened links, `app:web-surface` model orientation and session-shell `DSH_WEB_URL`; it grants no trust. Startup advertisement and actual CLI arguments were verified here. No model prompt was submitted to inspect or change a production Agent's context.

## Native package identity and Code source

Production native `pluginManager.listBundles` confirmed both packages are independent installed and enabled bundles at `0.3.0-c`. Their source specs are `super-dsh@0.3.0-c` and `file:/home/u1/.dsh/bundle-artifacts/better-dsh-a9287af10438fc48ca32a048392cf5192f5cef864fe152eb2b50c99e58061563.tgz`. The new upstream UI reads these actual dependency specs; it does not classify file installations as non-native plugins.

Better is a standard npm package whose `dsh.bundle.patch` manifest entry identifies its component composition. A DSH bundle is that native declaration, not a different custom plugin format. `bundle-artifacts/` is the archive cache directory name. The coordinator registers the exact embedded archive through native profile package operations, so Better is a direct dependency and independently controlled native bundle. Its file source accurately expresses this provenance.

The existing delivery design fulfills one Super installation, the exact same-repository Better content, independent native Plugin Manager switches/YAML, and retained Better after Super removal. The host does not recursively activate and expose arbitrary transitive bundles; leaving Better solely nested would not satisfy those independent controls. Resolving a new registry dependency at startup would abandon the exact embedded artifact requirement. No delivery redesign or disguised registry source was introduced by this fix.

## Verification and artifact identity

The next test iteration is synchronized `0.3.0-d` across the private root, Better and Super manifests and Super's exact Better dependency. Build produced:

| Artifact | SHA256 |
| --- | --- |
| Better0.3.0-d | `1ff4f0da31e3d81754e70b3c3e53c6a880b4aa6976a2b7ba1e59a6c95c3549c3` |
| Super0.3.0-d | `5d653cfc50356f098db6a4c1ff74dd975bcf8832ca524e8da790621a1a1e4921` |

The pack verified749 embedded Better files against the separate local archive. PC4999 was launched and accepted first. The same archives/pair were then transferred to dev3 and consumed with its existing isolated home and registry-installed DSH0.2.1-alpha.1 anchor. After coordinator registration updated Better, each test service received the documented cold restart required for replacing loaded package code; the profile was preserved during that restart.

- New lifecycle regression tests failed before the fix for the expected reasons: a disabled Host still registered failover, and disabling it did not withdraw its row. With the fix, both passed using the real native ConfigForms/SettingsDescribeMirror and Cordis lifecycle, with only transport/slot fixtures and unrelated mobile DOM behavior isolated.
- Targeted lifecycle plus existing Host failover suite:10 tests passed. Root delivery/package suite:27 tests passed.
- Host and client typecheck lanes passed. The new browser-side test uses a `.client.spec.ts` name and is excluded from the host-only lane, so importing JSX/DOM source does not mix the two production type environments; production client code remains checked by its existing client lane.
- Real TypeScript LSP definition and call-hierarchy checks covered `whileServed`, client `apply` and `setupCompactionRow`. TypeScript AST verified both slot registrations now nest under `whileServed` and `ctx.effect`. Evidence: `.scratch/plugin-boundary-diagnosis/lsp.jsonl`, `ast-before.json`, `ast-after.json`.
- Bash syntax and `git diff --check` passed. The tested launchers performed actual artifact verification and native installation on both machines.

## First-person UI behavior

Actual browser tests ran at `https://test.pc.internal.test` and dev3's `http://192.0.2.130:4996` review entrance. Each passed all these stages without page errors:

1. Fresh browser while Host failover is disabled: no failover row, with the rest of General loaded.
2. Enable failover through its native Plugin Manager component switch: the row appears.
3. Select a real catalog model in its UI: the native settings namespace reflects the persisted fallback. Restore the prior values.
4. Disable the component through the UI: its General row disappears.
5. Reenable it through the UI: its General row returns.
6. Disable compaction independently: its namespace and row disappear while failover remains available. Restore component enablement.

The fixture restores each pre-existing component enablement and the original failover values. JSON/screenshot evidence: `.scratch/plugin-boundary-diagnosis/pc-4999-030d.json`, `dev3-030d.json` and their corresponding images.

Probe corrections were confined to test automation: the first post-restart probe began before readiness; the test-only page-mcp badge covered part of the Settings trigger, so the successful run used an ordinary pointer click on the trigger's uncovered upper-right area; the Plugins probe then awaited the package card/detail before addressing its row. No forced click, DOM hiding, client policy override or business workaround was used. Early fixture errors are retained in scratch evidence. Final tests exercise actual native UI controls and native persistence.

Whole production and shared-test credential-file hashes matched the earlier pre-operation snapshots on both machines after the new launches/UI tests. Production and tested units remained active with zero automatic restarts. Existing homes/sessions/env/auth seeds were retained, and edited fallback values and component enablement were restored. No workspace was added and no model prompt or explicit session-create RPC was submitted. A final4999 browser check also passed session/list, directoryPicker/list from the actual **Add workspace** dialog, and WebSocket establishment, with no page/API errors; it observed22 sessions, so this report does not claim the shared runtime's session count stayed constant.

## Review state

Production plugins remain the user-installed `0.3.0-c`, including the reported failover UI bug; only the requested production public-url flags/restarts have been applied. The UI fix is running as `0.3.0-d` on4999 and dev3's isolated test line. No npm publication, Git commit/tag/push, or new production package installation occurred. Existing production failover disablement was preserved. The previous intermittent session-switch reconnect issue is outside this fix.

The tested endpoints remain running for user acceptance. This report covers the changed settings UI and advertisement behavior, not a new model create/prompt/resume or failover-execution release acceptance.
