# 0.3.0-d release and cleanup

User authorized publication and push after testing, using the smallest next letter above the public version, then stopping test services and removing temporary worktrees/homes. Both public `latest` tags were 0.3.0-c; 0.3.0-d was absent. Unpublished F was a development iteration, not the registry version increment. This report supersedes F's pending release acceptance, while retaining its historical diagnostic evidence.

## Verified change and artifacts

Super declares ordinary `dependencies.better-dsh = "0.3.0-d"`, with no Better files/archive/embedding descriptor in its npm archive. Both packages build from this repository. Native offline registration retains independent YAML, registry Code source and enable/disable choices; plain npm consumers preserve a usable npm lock. Failover/compaction General rows follow their live Host settings owner through the official client lifecycle API. Test CLI trusted-host/public-url flags and profile/credential preservation remain in the existing launcher.

The official dual `npm run pack` pipeline produced the unchanged archives tested on PC first and dev3 next:

| Package | SHA256 |
| --- | --- |
| better-dsh 0.3.0-d | `ac5682e346862ca53a91e3ba988d45b363b5d955447176455199f0ad07236eb8` |
| super-dsh 0.3.0-d | `f4080693c61d35dabd47f4fd107399a012d021965b7adf0f44efafcbd8f41e60` |

No production package/service/Caddy change was made in this release task. PC uses the aligned source-built Host; dev3 uses its isolated registry DSH0.2.1-alpha.1 installation. Actual LSP/AST traced package operations and the official request-extension observation seam; no new upstream source edits or fake host types.

## Verification

- Root delivery/package suite: 27 passed. Hub and nine adapters: 1,756 passed, zero failures. Better: 68 files passed, 711 tests passed, 4 skipped. Host/browser typechecking and full pack passed. `git diff --check` passed.
- A new empty-cache full-artifact npm consumer executed one user install. Registry observed both manifests and both exact tarballs. Better initially remained transitive; native registration generated zero registry requests and an exact direct npm lock edge.
- PC and dev3 actual native Plugin Manager each installed Super through one operation, with both exact registry sources and no pending build approvals/browser errors. Better's native details page visibly displayed `better-dsh@0.3.0-d`.
- Nine independent Super/Better enablement states passed on each machine, including both off, each alone, both together and reactivation. All seven roster entries mounted ready without failed fibers. Better WebServer replacement during bundle switching produces an expected HTTP reconnect; this is distinct from session switching.
- Six General UI stages passed on each: disabled failover absent; enabled selection persisted; live disable removes it; reenable restores it; compaction independently disappears. Original component switches and fallback selections were restored.
- Native DSH on both machines actually created a session, called Better eval (`DEPENDENCY-EVAL-42: 42`), completed, then after cold restart resumed the same session and returned both its previous output and `DEPENDENCY-ALPHA-LOCAL` without receiving the answer in the second prompt. PC session `session-7febc0ea-61a1-46d5-bd67-f453993233dd`; dev3 `session-d194e24a-677d-4d74-a516-2633a8943be4`.
- Pi, Codex, Claude, OMP and Hermes passed actual create/prompt and same-session cold resume on both machines. First-turn completion was checked before restarting, and all second turns completed with remembered markers.
- Antigravity actual create/prompt/resume requests were exercised on both machines and returned the pre-existing provider billing `QUOTA`. Its successful model generation is externally blocked and is **not** claimed as passed. No Antigravity model/provider implementation was changed by this release.
- Production and shared test credential seed hashes matched their pre-task snapshots on both machines.

Evidence is retained under `.scratch/release-030-d/`, `.scratch/registry-dependency/` and the General UI fixture's `.scratch/plugin-boundary-diagnosis/` outputs.

The final README correction says registration waits specifically for Super to be enabled. The full official pack was rerun; archive-content comparison proves Better unchanged and Super changed only `package/README.md` (all runtime/client/manifests byte-identical). Final archives were reinstalled through the native UI on PC then dev3; installed README content and received SHA256/pair validation matched, with one install operation and no browser errors each. Runtime acceptance above applies to the identical executable files; no code change followed it.

## Diagnostic and fixture corrections

F's dev3 native session continued to answer `NO_HISTORY`. A temporary read-only plugin, registered through the official DeepSeek request-extension API and returning no extension value, observed the actual serialized base request containing both the first user password and eval result. Offline canonical derivation also retained them. This excludes local on-disk deletion and omission from that observed request, but does not establish whether provider processing or model behavior produced the incorrect recall. The observer was removed; neutral fresh-session D acceptance passed on both machines without it. No speculative product/history patch was introduced.

The old compatibility fixture pointed at a globally installed Host that had since been upgraded. It was replaced with the actual supported prior `@deepseek-ai/dsh-app-boot@0.2.0-rc.2` installation in an isolated compatibility anchor. Browser tests initially used an unrelated variable; rerunning with the component's documented `DASHR_BROWSER_BIN` passed the full suite. A cached fixture cookie was stale; the matrix authenticated once at its start and kept that cookie across its switches. Early session probes restarted before every runtime completed and overlapped bundle switches; those results were discarded and the final scene serialized completion, restart and resume. These were fixture corrections, with no business-code workaround.

An independent requesting-code-review reviewer found no current implementation blocker. A bounded future caveat remains in upstream native compatibility-rejection repair: it omits offline/script flags. The reviewed synchronized manifests on aligned DSH0.2.1-alpha.1 do not reach that branch; incompatible future replacements require renewed review. Loaded package/provenance promotion retains the Host's documented cold-restart boundary.

## Publication and cleanup

Publication is authorized by the current user instruction. The verified Better archive was submitted first and became publicly available with `latest=0.3.0-d`; its downloaded archive matches the table SHA256. Super's unchanged verified archive was submitted next and npm returned success with asynchronous processing. At this checkpoint its public version was still pending; public pair download/install verification and the final release tag follow after registry visibility. No repeated publication or rollback was attempted.

Cleanup completed independently while waiting for registry processing:

- PC4999, dev3 4998 and PC4997 were all test services and are stopped. Old PC4993/4994 test services, PC4996 review tunnel, both read-only test registry gateways and old failed test-unit records were also removed/stopped. `ss` found no 499x or test-registry listeners on either machine; neither retained any `superd*` unit.
- Removed the two clean tracked linked worktrees (`codex-app-server`, `p0-api-wrap`) and the empty retired `foreign-substrate` directory. The former worktrees' Git branches remain. Main checkout has no runtime symlink referencing them.
- Removed 10 temporary PC test-home directories and three dev3 probe/tool-install directories. Retained PC `.tests/superd` and `.tests/better-dsh`, dev3 `.tests/foreign-substrate`, its exact DSH Host installation anchor, compatibility dependencies and shared credential seed. Old4993/4994 test assets were archived with mode0600 before directory removal.
- Retained profiles' generated registry configuration now points at public npm; local test-gateway tarball URLs for the two release packages were normalized to their public equivalents without changing integrity or version. Future launcher runs manage their own gateway configuration again.
- Source/report staging excludes unrelated private `.claude/settings.local.json`. Production services and user runtime homes were not cleaned or upgraded.

Evidence: `cleanup-pc-initial.json`, `cleanup-dev3-initial.json`, `stopped-services-pc.json`, the protected `obsolete-homes-user-assets.tgz`, and registry/public installation records under `.scratch/release-030-d/`.
