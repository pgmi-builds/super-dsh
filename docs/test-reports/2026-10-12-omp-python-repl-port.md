# OMP Python REPL port: implementation and acceptance

Date: 2026-10-12 (Asia/Hong_Kong). Status: both phases implemented and consumer acceptance complete (`s` full matrix plus `t` reviewed fix/delivered delta); no release approval, Git finalization or npm publication.

Companion report: [first-person re-verification](2026-10-12-omp-python-repl-port-first-person.md) — the model's own live `eval` calls against the installed `0.3.0-t` pair (state, native tools, timeout/interrupt, death/restore, partial coverage, corruption and reset).

## Scope and authority

The user approved both the OMP execution-chain port and vendored-dill checkpoint recovery on 2026-10-12. Canonical [spec](../specs/omp-python-repl-port/spec.md), [runtime guide](../specs/omp-python-repl-port/runtime-guide.md) and [execution plan](../superpowers/plans/2026-10-12-omp-python-repl-port.md). Existing checkout is used on `codex/omp-python-repl-port`; unrelated pre-existing changes remain untouched.

OMP source is fixed to `fa5ff4a3a977a28b93d025f4cf50f046e019f18c`. Original runner is 90,278 bytes, SHA-256 `e0e660ca44193735a2de467254b050109bb23028aca71af01b9365b9ab88e974`. Its MIT license travels with the resource. Better's adaptation and snapshot helper are separate source files. dill baseline is0.4.1 with BSD-3-Clause license.

## Pre-implementation evidence

Actual TypeScript language-server definition/reference/call-hierarchy queries traced `DashrRuntime.run` to bridge execution, host dispatch, restore and checkpoint operations. TypeScript AST inspection enumerated bridge construction and execution/query/setVar/save/restore call sites. Evidence: `/tmp/omp-lsp-ast.json`, `/tmp/omp-runtime-call-hierarchy.json`.

Pinned runner research used actual pyright definitions/references and Python AST import/control-flow inspection. Unchanged-runner probes covered native stdout, SIGINT and next-cell state, partial mutation after exception, explicit image MIME output, internal helper namespace isolation and ignored `silent` flags. Evidence: `/tmp/omp-python-protocol-research.md`, `/tmp/omp-python-lsp-probe-output.txt`, `/tmp/omp-python-protocol-probe-output.txt`. These are research probes, not installed-consumer acceptance.

Baseline command: `npm --prefix better-dsh test -- test/runtime.spec.ts test/snapshot-revive.spec.ts test/snapshot-restore.spec.ts test/kernel-env.spec.ts`. Result: 4 files,22 tests passed before implementation. Log: `/tmp/omp-python-baseline.log`.

Task1 RED tests used a stdlib-only venv and OMP magic/shell syntax. Existing implementation failed for missing ipykernel and unsupported syntax, as expected;17 existing tests passed. Log: `/tmp/omp-task1-red.log`.

Native model catalog was inspected from the retained PC test line; available route at inspection time: `deepseek-official/deepseek-flash` and `deepseek-official/deepseek-v4-pro`. Acceptance selects from the actual live catalog, not a hardcoded historical provider alias.

## Execution verification

The initial port passed 48 execution/binding/environment checks,9 cancellation checks,3 selected lifecycle checks and host/client typechecks. Independent review then reproduced four gaps: native `tool.read` compiler helper, surviving foreground shell work after cancellation, same-cell reset/input and synthetic `__file__`. The independent scoped re-review accepted all four fixes for both specification and quality. The final focused execution/cancellation suite passed16/16; these source results do not substitute for installed-consumer acceptance.

An isolated Python3.9.25 interpreter under `.scratch/omp-python-repl/python-cache` compiled the unchanged runner and all14 unchanged dill runtime files. The actual `omp-execution.spec.ts` integration suite then passed11/11 on Python3.9.25 (`/tmp/omp-task1-python39.log`), including native tool read, magic/reset and cancellation behavior. Snapshot graph/safety checks also passed19/19 on Python3.9.25 before the subsequent independent snapshot review identified additional edge cases.

## Broad source run and follow-up

`DASHR_TEST_PYTHON=/usr/bin/python3 npm --prefix better-dsh test` initially completed88 files with830 passed,9 failed and12 skipped tests (`/tmp/omp-python-full-better.log`). Follow-up isolated causes rather than changing unrelated business code:

- Six browser failures came from missing distro Chrome at the default path. The existing cached Chrome was supplied through `DASHR_BROWSER_BIN`; browser-device10/10 passed (`/tmp/omp-python-browser-recheck.log`).
- The remote cross-copy fixture lacked its ignored `.scratch` parent. Creating the test scratch directory made container-copy3/3 pass (`/tmp/omp-python-container-recheck.log`).
- The presentation fixture used stale `read.path`; the actual upstream `tool-fs/src/read.ts` declares `file_path`. Aligning the fixture with the corrected delivered example made presentation20/20 pass (`/tmp/omp-python-presentation-recheck.log`).
- The docstring expectation assumed pre3.13 compilation. Direct native source/AST compilation on actual3.14 and3.11 established the version difference; [Python3.13 release notes](https://docs.python.org/3.13/whatsnew/3.13.html#other-language-changes) document compiler whitespace stripping. The corrected test compares an independent same-interpreter native compile; docstring and multiline checks passed2/2 on both3.14.4 and3.9.25. No product semantic override is required.

The initial checkpoint implementation passed94/94 scoped integration checks and both typecheck lanes. Independent review then reproduced startup-name admission/restore mismatch, missed partial/slot callback dependencies, and failed-write orphan growth. All four review findings, including failed-respawn wording, are now addressed and the independent scoped re-review passed both specification and quality. Final focused checkpoint verification is32/32; minimum Python3.9.25 graph/safety/review verification is27/27; both typechecks and original-resource copying passed.

Final full Better rerun used the actual system Python plus the existing Chrome fixture and scratch parent: **88 files passed,1 file skipped;847 tests passed,12 skipped;0 failed** (`/tmp/omp-python-full-final.log`,203.42s). Snapshot fix regressions and the native-compiler docstring assertion are included. Root versions synchronized to `0.3.0-s` before the normal dual pack.

## Root package checks

The ordinary dual build/pack succeeded for `0.3.0-s`; the independent bundle verifier accepted both artifacts. Better tarball SHA-256 `73dfb82d1b259438225770144937f7f3fa0b8a7656b01deec59df197e8714071`; Super tarball SHA-256 `1626e2a52f4936ccd3492cb34b12272bde0fe16b0ef9d81344115368a0808fd2`. Actual Better tarball verification confirmed the fixed runner hash, all14 dill runtime sources plus original license hashes, helpers/licenses, and absence of obsolete transport or consumer install hooks (`/tmp/omp-python-artifact-s.log`).

`npm test` root package suite completed40/42 passed,2 failed (`/tmp/omp-python-root-checks.log`). Both reproduce in standalone bundle-delivery12/14 (`/tmp/omp-python-bundle-delivery-recheck.log`): legacy companion receipt re-arms on a later controller, and polling clears a native failed-application diagnosis. The test and `companions.ts`/`bundle-setup.ts` sources have zero diff from HEAD; this port changes none of them. These existing companion findings remain recorded for final review; root suite is **not** reported green. No unrelated business workaround was applied.

## Installed consumer results

Both targets consumed the exact synchronized `0.3.0-s` pair through the canonical launcher. Existing independent Better installations were upgraded through native Plugin Manager, which returned `restart-required` and package exit0; only test services restarted to load code. No test-specific snapshot override was used. Shipped default persistence resolves under the official test profile home.

| Proof | PC4999 | dev3 independent installation |
| --- | --- | --- |
| Persistent list/alias/function, TLA, typed completion | Passed | Passed |
| Native `tool.glob` and native `tool.read(file_path)` | Passed | Passed after correcting target fixture path |
| Exception after assignment retains value73 | Passed | Passed |
| Real host restart restores function, alias identity and value | Turn4 restored | Turn6 restored |
| Mixed bad reducer/nested file/lock omitted with reasons | Passed before/after restart | Passed before/after restart |
| One dying cell, partial-execution notice, no replay | Marker count1 | Marker count1 |
| Actual native session cancel, subsequent cell42 | Passed | Passed |
| Timeout1s, next42, native magic/shell, reset/input guard | Passed | Passed |
| Explicit reset:true clears previous memory/checkpoints | Source tests; native %reset installed | Installed explicit reset:true passed |
| Intentionally corrupt manifest starts EMPTY with reason | Passed | Passed |
| Actual model-wire eval description equals packaged markdown | Byte-identical3029bytes | Byte-identical3029bytes |

PC sessions: basic/cold/death `session-b432b933-d6eb-47fe-8067-89b953c207c9`; partial/corruption `session-83cc13a4-924b-4ead-9321-603ea26bb339`; cancellation `session-7f381e15-b209-40f9-9be3-9d21a0414bb6`; magic/timeout/reset `session-f56c1076-54b8-48cc-8d37-8bbf16e660bf`. Actual calls/results, sequence IDs and exact notices are retained in [PC evidence](assets/2026-10-12-omp-python-repl-port/pc.json).

PC default snapshot root is `.tests/superd/better-dsh/python-repl/0b20ba864208b04c6d9d3a51a9decf4fd46c24812dffc08c3ab9223ff9d87547/`. Basic turn4 admitted `asyncio,g,omp_alias,omp_before_error,omp_f,omp_x,r`, with no omissions; payload456982bytes. Managed CPython3.11.17 and packaged dill0.4.1 were exercised. Directory0700, manifest/payload0600 verified. Native read returned original DSH hashline text. The death result explicitly said the cell may have executed partially and no user code was replayed; subsequent actual model read verified one marker. Corruption was injected only into the acceptance partial session's manifest while the test host was stopped, after backing up/hash-verifying its original generation.

Dev3 uses the independent DSH0.2.1-alpha.1 installation anchor and retained `.tests/foreign-substrate` home. Its compatible managed CPython3.11.15 was actually selected, rather than the inventoried system3.14.4. Installed runner/helpers/licenses/dill sources were hashed; both installed bundle versions are0.3.0-s. Root independently rechecked received artifact hashes, installed versions/runner hash, marker count1 and all three active target test units. Detailed sessions/sequences and exact outputs: [dev3 report](assets/2026-10-12-omp-python-repl-port/dev3.md), [compact native events](assets/2026-10-12-omp-python-repl-port/dev3.json), [final checkpoint metadata](assets/2026-10-12-omp-python-repl-port/dev3-checkpoints-final.json).

The initial target relative `package.json` fixture did not exist; native read correctly raised E_NOT_FOUND. A later actual native read used the installed profile's absolute package.json and passed. The model also made and corrected a dict-versus-string assumption. Those errors remain in evidence. Actual cancellation reports an abort and captured start marker but retains the existing rough `[object Object]` reason text; neither target automatically repeated the sleep.

Actual `request/header` records prove the model received the packaged eval description, including OMP, interpreter prerequisites, best-effort state, resource omissions and no automatic retries. Actual reset schema explicitly deletes checkpoints. The model's own narrative is not used as the behavior verdict: native tool call/result records establish each result.

## Review entrances and remaining limits

PC [https://test.pc.internal.test/](https://test.pc.internal.test/) and [LAN4999](http://192.0.2.130:4999/) remain running. dev3's same installed service is available through the owned test SSH forward [LAN4996](http://192.0.2.130:4996/). Both public PC and direct LAN-forward HTTP entrances returned200; the forward required no target configuration, firewall or Caddy change. Native authentication remains in force.

Both rosters contain7 local runtimes plus7 preserved paired entries,14 total, all ready and not failed. Pairing state was retained. PC test journal and target log contain0 world-failed entries. Active PC units: `superd-4999-test`, its registry/relay, and `superd-4996-dev3-review`. Active target units: `superd-4998-test`, `superd-4998-pair-registry`, `superd-lan-4998-relay`.

Snapshotting is a best-effort executable Python object graph, with exclusions and omission reporting, rather than whole-process recovery. Dynamic globals/eval and arbitrary extension resources cannot be exhaustively inspected. Environment checks do not hash every installed third-party distribution. Linux consumer behavior is verified; Windows lifecycle parity remains unverified. No production home, production3080/3081 service or live Caddy configuration was part of this work.

Independent whole-branch review accepted the `s` consumer/Surface scope and found one Important checkpoint-boundary issue: host directory preparation could reject a successfully executed cell or `setVar`. The final fix wave and `0.3.0-t` delivered delta verification are complete. The rough structured abort reason is a deferred minor; the canonical spec now distinguishes historical research from delivered acceptance. No commit, tag, push or npm publication occurred. Root companion-suite failures above remain a separate release/integration gate.

## Execution decisions

- Reused the suitable checkout on a dedicated codex branch, retaining unrelated changes. Cost if wrong: weaker filesystem isolation requires careful ownership review.
- Deferred skill intermediate commits to obey repository acceptance/release gates; reviews use exact backups and owned working diffs. Cost: intermediate evidence remains local until Git finalization.
- Used official profileContext for default checkpoint home, preserving custom directory/disabled choices. Cost: standalone contexts must explicitly opt into disk persistence.
- Cancellation cleans new current-cell descendants while retaining prior persistent children; unproven cleanup retires the runner. Cost: escaped processes and unverified platforms remain outside the Linux proof.
- Named the helper better_snapshot.py to match the qualified bridge seam. Cost: documentation generic snapshot.py references need alignment; no public interface changed.
- Preserved the local SDD workspace because repository gates prohibit the commits that would otherwise make Git its durable record. Cost: ignored review artifacts need retention until finalization; canonical evidence is additionally archived beside this report.

## Final review fix and next artifact

The independent whole-branch review reproduced R1: a host checkpoint-directory error could reject a completed cell or applied `setVar`. The final fix contains directory preparation and awaited dispatch in the existing failure-to-notice boundary. Five real-child tests failed before the change and passed after it; the covering checkpoint/restore lane passed **37/37** across6 files. Host and client typechecks both passed. Logs: `/tmp/omp-final-fix-{red,green,regressions,typecheck-host,typecheck-client}.log`. [Archived source-check logs](assets/2026-10-12-omp-python-repl-port/source-check-logs.json). Actual LSP definition/reference/call hierarchy and TypeScript AST inspection confirmed the two callers and the repaired boundary. Earlier committed files and latest successful turn are retained; execution values/stdout/user exceptions remain visible.

Scoped independent final re-review accepted R1 (specification PASS, quality Approved), closed M2 and found no new Critical/Important issue. [Initial review](assets/2026-10-12-omp-python-repl-port/final-review.md), [fix report](assets/2026-10-12-omp-python-repl-port/final-fix-report.md), [scoped re-review](assets/2026-10-12-omp-python-repl-port/final-fix-review.md).

The ordinary synchronized `0.3.0-t` dual pack and pair/resource verifiers passed. Better SHA-256 `a9b908e75c1292b066d912fd01b2098906df3adfc2c1fea90da66cd75b28064d`; Super SHA-256 `95ed98db2f32311df121b02c4d281ccc4d3967807eccfd4d2f2b3c52d4d2cadf`. [Exact pair](assets/2026-10-12-omp-python-repl-port/pair-t.json), [original-resource proof](assets/2026-10-12-omp-python-repl-port/artifacts-t.json). Installed delta checks passed on both targets. The complete `s` matrix above is retained; this later round verified the affected filesystem-failure behavior, live-state continuity and native read through both delivered consumers.

PC installed `t` delta passed in fresh session `session-a9d9b725-91e3-4809-af99-ea68411ecf9c`: initial value73 and checkpoint turn1; fixture blocks only this owned new session's checkpoint directory; the exactly-once increment returns74 with stdout and a failed-checkpoint notice naming turn1, `isError:false`; restoring the fixture leaves live value74 and allows checkpoint saving again. Native read through `await tool.read({"file_path": "…/profiles/superd-pub/package.json"})` returns original DSH hashline text and preserves74. A preceding probe mistakenly used Python keyword arguments, which the existing binding rejects; its actual error is retained, then corrected with the documented positional mapping. No product change was made for that fixture mistake. Final checkpoint is turn5; actual model-wire eval description equals the installed3029-byte markdown. [PC t native evidence](assets/2026-10-12-omp-python-repl-port/pc-t.json).

Dev3 installed `t` delta also passed in fresh session `session-f1a7ffd9-6b2d-4975-92c8-4315c9d8dda7`: exactly one eval per stage returned73, then74 with nonfatal EEXIST/last successful turn1, then74 after directory recovery, then native hashline read plus74. All results were `isError:false`, with final checkpoint turn4 and a retained recovered turn3 generation. The fixture is fully restored; both physical bundle versions are t, 7 local plus7 retained paired agents are ready, world-failed0, and all3 target test units remain active. An immediate postrestart readiness request returned404 before route mount; the normal readiness retry returned authenticated200 before any model prompt. Root independently verified received tarball hashes, physical versions, runner hash and active units. [Dev3 t report](assets/2026-10-12-omp-python-repl-port/dev3-t.md), [compact native evidence and root verification](assets/2026-10-12-omp-python-repl-port/dev3-t.json).

Final artifact is `0.3.0-t`; the complete original `s` acceptance record remains immutable. Only the final status/evidence closeout in canonical docs was updated after t packing; the installed tool guidance and executable resources are the verified packaged bytes. PC and dev3 review entrances remain running. The source review has no open blocking port finding; deferred structured abort wording and the two unchanged root companion failures remain disclosed. No release/integration approval or Git/npm finalization is implied.

## Independent first-person t report reconciliation

The companion [first-person report](2026-10-12-omp-python-repl-port-first-person.md) independently exercises installed `0.3.0-t` and reports no new blocking finding. Read-only inspection of its retained session `session-60e31824-4a37-41fe-8eea-5a4b1033cc76` confirms **41 eval calls and41 matching results**; the earlier prose count25 has been corrected. The original probe summary is preserved with controller verification metadata, and the exact eval call/result records are additionally archived in [native evidence](assets/2026-10-12-omp-python-repl-port/first-person-t-native.json). The actual model-wire descriptor matches the installed3029-byte description. No fault cell was rerun for this reconciliation.

Five observations are retained: helper traceback noise, opaque `%reset` status, different turn numbering between reset paths, compiler helper names visible to direct `globals()` inspection, and the first-person output-cap coverage limit. Code inspection confirms the first four describe current behavior; the fifth is a verification limitation, with source-test coverage retained. They do not invalidate state/restore/native-read acceptance. O1–O3 remain possible Surface follow-up work; O4 remains a documented compiler seam, and O5 remains an explicit coverage limit. No implementation or artifact change was made in response to this report.
