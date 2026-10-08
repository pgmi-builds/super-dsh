# 2026-10-08 — Independent native Super Dash / Better Dash bundles

## Result and scope

Final candidate: synchronized `super-dsh@0.3.0-g` and `better-dsh@0.3.0-g`. A single self-contained Super tarball registers Better as a separate direct profile bundle. Native Plugin Manager has three installed rows on the test line: Super, Better, and the unchanged dev WebMCP. Super no longer composes Better YAML. Both bundles retain independent switches and their own components.

No npm publish, GitHub commit/tag/push, upstream source edits, production home/3080/3081 or Caddy changes were made in this task. Work remains on `codex/monorepo-030` for user acceptance.

Subsequent release: the user accepted this candidate and explicitly authorized **0.3.0**. Both synchronized packages were published and registry artifacts verified; see [the release report](2026-10-08-030-publish.md). The statements below describe the original g acceptance stage.

## Delivered artifacts

| Artifact | SHA256 |
| --- | --- |
| `better-dsh-0.3.0-g.tgz` | `8486a24b3be750de75be9c8feb42c0212264ad9fc423798572dddd6795b61b8c` |
| `super-dsh-0.3.0-g.tgz` | `8715a68ffd9bfd134c9febc0560fac475d624ca68b960446338b3af72da4eefc` |

Normal root paired build constructed both from local source. Super contains 748 exact Better files plus the exact independent archive and SHA descriptor. Received-pair validation also checks browser exports; no registry Better source or source-link consumer was used. PC and dev3 consume the same pair. No package installation hooks were introduced.

## Implementation and acceptance-discovered repairs

- Better owns the generic delivery coordinator; Super's setup entry reuses the bundled implementation. Either active bundle can coordinate the local companion through public installed DSH package operations in a separate process.
- Immutable archive cache is under the current test home. Native profile writer lock guards owner/artifact and companion intent. Retained disablement survives updates; an explicit same-artifact uninstall is honored, including a concurrent uninstall and a recovered missing receipt.
- Cancellation waits for bounded native lock windows instead of exiting during lock metadata writes. It does not await a competing native operation from a row's disposer.
- Better's native HMR subclass clears only the inherited native transaction ALS through a guarded compatibility bridge. Original queue, config/module watchers and disposal remain intact. Genuine nesting is rejected. Agent attribution and teardown lineage remain unchanged. Public APIs expose no selective reset; a whole-process ALS snapshot was rejected for its attribution side effects.
- Foreign rows now own roster, mount, target, sibling-root lifetime and GET/HEAD publication. Cleanup registers before boot, removes addressability synchronously, waits native disposal and rejects stale pending boot/publication.
- Actual E consumer found a missing OMP client artifact. Paired pack now builds and includes `agent-omp/lib/client`, and refuses missing declared browser exports.
- dev3 found first-install pnpm store flags were not persisted for later native operations. Launcher now writes the same test store into ordinary profile `.npmrc`; subsequent native package operations use that store. This is launcher environment isolation, not a business override.

## Checks

| Check | Result |
| --- | --- |
| Root delivery/package/native HMR regressions | 25/25 passed |
| Native world lifecycle + UI fusion injection regressions | 57/57 passed, including 24 lifecycle cases |
| Better host/client real-type checks | passed |
| Normal paired build + received archive validation | passed |
| Independent review | Important uninstall/receipt/cancellation findings fixed and re-reviewed; no remaining Critical/Important finding |

LSP definitions/references/call hierarchy and TypeScript AST were used on the native manager/HMR operations and world ownership paths. Tests use actual Cordis, native HMR/AgentRegistry and actual pnpm package operations. World lifecycle fixtures replace only external boot/provision boundaries. Browser injection fixtures explicitly compose both independent bundles; they do not substitute for consumer registration acceptance.

## Real consumer behavior

PC uses the actual same-checkout DSH build; dev3 uses installed `@deepseek-ai/dsh@0.2.0-rc.2` under its global installation anchor and retained `.tests/foreign-substrate` home. Native APIs and authenticated app responses were exercised on PC4999 and target4998 via the existing4996 SSH review tunnel.

Both machines passed nine-state repeated native toggle sequences covering: both on, Better only, Super only, both off, and reactivation in both bundle orders. WebMCP stayed enabled. Each reactivation restored the native + six-runtime roster, all ready; no failed plugin fibers, duplicate roster items, or duplicate client module ids. Super-off foreign RPC routes cease serving their RPC surface. Better-only native tool behavior remains.

| Runtime behavior | PC | dev3 |
| --- | --- | --- |
| Better-only native model actually calls `eval` and returns `MONOREPO-EVAL-42: 42` | passed | passed |
| OMP create → real prompt → resume after Super off/on | passed | passed |
| Codex create → real prompt → resume after Super off/on | passed | passed |
| Pi create → real prompt → resume after Super off/on | passed | passed |
| Hermes create → real prompt → resume after Super off/on | passed | passed |
| Claude create → real prompt → resume after Super off/on | passed | passed |
| Antigravity mount/create/prompt/resume admission | passed | passed |
| Antigravity actual model completion | blocked: native cloud billing403 / QUOTA | blocked: native cloud billing403 / QUOTA |

Each successful foreign resume retained the first turn's runtime-specific passphrase in the same session. The optional SDK rows stayed at their default disabled state; their ownership paths have native lifecycle unit coverage, not fresh SDK model-turn acceptance in this task.

Standalone Better4997 consumes only the Better tarball plus dev WebMCP, has no Hub/foreign bundle, and completed the same actual native `eval` behavior. PC also resumed an E-created native session after cold G installation and recovered both the tool output and passphrase. PC upgrades retained disabled Better through native installation and cold restart. With Super disabled and Better active, an F→G owner upgrade was synchronized by Better alone; the resulting direct Better version was G while Super remained disabled. dev3 retained disabled Better across a cold restart as well.

Raw safe structured evidence lives in ignored `.scratch/independent/`: paired manifest, native inventory, nine-state matrices, model admission/session ids and terminal-event summaries. Session proofs are checked against real `session.v4.jsonl.zstd` logs; no credential/token values are included in this report.

The Super-disabled upgrade proof is `maintainer-f-commit.json`, `maintainer-f-native.json`, `maintainer-g-commit.json` and `maintainer-g-native.json`. Each native installation completed before the next restart. Both receipt/digest and released writer locks were checked; after the final cold restart, only Better's components were active, both package versions were G, and Super remained disabled. Final PC/dev3 matrices restore both bundles enabled for user acceptance.

## Limits and operational behavior

- Browser CUA surfaces were unavailable (`Browser is not available: iab`), so no visual click/screenshot acceptance is claimed. Native Plugin Manager APIs, its bundle/component metadata and authenticated app/module graph were verified. User visual acceptance remains.
- Switching Better replaces the WebServer provider and closes the current HTTP connection. Native state is saved; direct callers may see a socket close and reverse-proxy callers a transient502. Reconnect/refresh reads the applied state. This was explicitly exercised rather than treated as a failed switch.
- Better-off restores native Web/login/onboarding policies. Test remote authorities are supplied through official `--trusted-host`; Super carries none of Better's permissive host policy.
- Native existing-package replacement requires restart before claiming running-code upgrade. Both-disabled companion synchronization waits until activation. Same-artifact uninstall is respected; a new owner artifact can deliver a new companion.
- An existing isolated world-mount unit fixture emits a `webRuntime` duplicate warning while passing; real consumer graphs have no failed fibers. Its default home was isolated. An initial fixture run wrote profile entries under the retained test home; those entries were preserved rather than assuming they were disposable.

## Access retained for user acceptance

- PC: https://test.pc.internal.test/
- dev3 review: http://192.0.2.130:4996/
- Standalone Better: http://192.0.2.130:4997/

The password entry and shared test cookie seed remain in place. Test services are left running. No release approval is inferred from implementation authorization.
