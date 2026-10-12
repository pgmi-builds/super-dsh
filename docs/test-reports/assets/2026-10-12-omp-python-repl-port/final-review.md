# Final whole-branch review — OMP Python REPL port

Date: 2026-10-12. Reviewer: independent final reviewer. Scope: task-owned working tree against `cac344e5aea4f53c40439b0f63d1db29c86eaacc`, as supplied in `whole-branch-review-package.md`; no commits exist for this task because repository release gates take precedence. Read-only review: no source, index, HEAD, branch or running consumer changes. This report is the only checkout file written by this reviewer.

## Verdict

**Whole branch: With fixes; not ready for an unconditional merge/release.** One new Important issue is reproduced below. The execution port, graph checkpoint implementation and installed-consumer evidence otherwise satisfy the reviewed scope. The two existing root companion failures also remain an explicit integration/release gate; the root suite is not green.

**Task 3 specification: PASS for the completed `0.3.0-s` consumer-validation and Surface scope, with a minor documentation closeout item.** Exact dual artifacts, real PC and dev3 model tool calls/results, persistence and failure notices, native tools, cancel/reset, retained rosters and review entrances are documented and evidenced. This verdict applies to the reviewed `s` artifacts; it does not pre-approve a later fix build.

**Task 3 quality: Approved with non-blocking documentation polish.** The report preserves failed fixture attempts, actual cancellation text, unsupported-platform limits and the non-green root suite. It distinguishes source tests from installed acceptance and uses actual model-wire tool descriptions. Final handoff must incorporate the Important fix and the corresponding new artifact/consumer evidence.

**Whole-branch specification: NOT YET PASS** because host-side checkpoint directory failure violates the best-effort failure contract in spec §4.1.

## Strengths

- Original OMP runner and dill resources remain separate from Better-owned adapters. I independently compared actual tarball bytes with current runner/helpers/provenance/licenses, checked every dill provenance hash against the tarball, and verified both tarball SHA-256 values against the archived pair. The runner is the required `e0e660ca44193735a2de467254b050109bb23028aca71af01b9365b9ab88e974`; Super has no Better dependency/optional/peer edge.
- Node owns the child lifecycle and callback admission; per-cell callback identities reject stale work, cancellation revokes callbacks, and per-principal transactions cover cold startup, user cells, snapshotting, queries, assignments and reset. Different principals and within-cell fanout remain independent.
- Checkpointing preserves an admitted graph, checks captured live resources and static dependencies, round-trips the final graph, commits through one manifest pointer, and cleans uncommitted generations. Restore checks environment, paths, size and integrity; unsuccessful loading retires the possibly contaminated child. Current host bindings are recreated rather than serialized.
- Death wording distinguishes an unstarted observing call from a partially executed cell, and the consumer evidence demonstrates a single side-effect marker after death and recovery. The source tests cover alias/function/class behavior, nested resources, failed reducers, missing bindings, corruption, timeout, reset and lifecycle ordering rather than only startup.
- The archived PC and dev3 event records substantiate the reported behavior. In particular, cold restore returns function result `5`, alias identity `True` and pre-exception value `73`; partial restore lists the bad reducer/file/lock omissions; corruption reports EMPTY with a reason; cancellation is followed by a successful `42`; dev3 explicitly exercises `reset: true` and native read returns hashline text. I independently verified both captured eval descriptions equal the delivered markdown byte-for-byte (3029 bytes).

## Issues

### Critical

None found.

### Important

**R1 — A checkpoint-directory error rejects a successfully executed cell instead of degrading persistence.**

- Location: `better-dsh/src/runtime.ts:663` (`snapshotTurnEnd`); callers are the completed-cell path and `setTransaction`.
- Problem: `mkdirSync(dir, ...)` runs before the snapshot outcome/error boundary. An ordinary filesystem error (for example ENOTDIR, EACCES or ENOSPC) escapes the transaction after user code has already run. The caller loses the successful result and receives neither the normal failed-checkpoint notice nor its latest successful turn. `setVar` likewise reports failure after having assigned the value.
- Reproduced independently on the reviewed source with a real Python child: create a temporary regular file, use that file as `snapshotDir`, mount `DashrRuntime` through a real Cordis `Context`, then run `important_value = 73\nimportant_value` under principal `probe`. Observed:

  ```text
  run rejected Error: ENOTDIR: not a directory, mkdir '/tmp/omp-final-review-.../not-a-directory/probe'
  retained live state {"kind":"json","text":"73"}
  ```

- Impact: a best-effort persistence failure becomes an execution failure with ambiguous already-performed side effects. The same unavailable directory makes subsequent successful cells reject again. This contradicts spec §4.1 (`docs/specs/omp-python-repl-port/spec.md:55`) and the runtime's documented resolve-with-result contract. Default persistence now makes this path part of normal native-profile operation.
- Fix: place host directory preparation and snapshot dispatch within the failure-to-notice boundary, or remove the redundant host mkdir and let the already-protected helper own creation. Preserve the user cell result/exception and live state, report the checkpoint error and latest successful turn, and preserve earlier committed files. Add focused regressions for the unavailable-directory path and `setVar` so both remain usable and accurate after a persistence failure. This is a checkpoint-boundary fix, not justification to guard or suppress ordinary user code.

### Minor

**M1 — Native abort reasons still render as `[object Object]`.**

- Location: `better-dsh/src/kernel.ts:237` (also the pre-aborted path at line 230 and runtime pre-admission abort conversion).
- Evidence: both archived native cancellation cases return `Error: code run failed (abort): [object Object]`, while the session reason records `{kind: 'user'}`.
- Impact: cancellation works and subsequent execution succeeds, but the model receives an opaque reason. This is explicitly acknowledged in the implementation report and is non-blocking for this port.
- Follow-up: normalize structured abort reasons to a readable bounded description while retaining the abort kind and captured output. It can be deferred; no wider cancellation redesign is required.

**M2 — The canonical spec still presents the earlier research state without pointing directly to delivered acceptance.**

- Location: `docs/specs/omp-python-repl-port/spec.md:3` and `:45`.
- Problem: the status remains implementation-in-progress and the research paragraph says it has not undergone Better delivery testing. The historical probe statement is valid in its original time context, but the spec has no direct implementation/evidence closeout, despite Task 3 asking for that update.
- Impact: a reader of the packaged spec alone cannot readily distinguish historical research limits from the completed `s` consumer evidence. This is documentation polish, not a missing behavioral acceptance run.
- Follow-up: preserve the research history, mark its date/context, and add the current implementation/review status with a link to the canonical acceptance report when closing the final fix review. Do not claim release approval or final success while R1 remains open.

## Plan alignment and deviations

The substantive task split is respected: immutable upstream runner, Better-owned Node/Python adapters, vendored dill, then native dual-artifact verification. Omission of OMP's Agent prelude is documented and consistent with preserving DSH's own host tools. The qualified `better_snapshot.py` module name, official profile-home checkpoint default, Linux descendant cleanup, and retained review workspace have recorded rulings and match the implemented boundary. Deferring Git finalization and keeping the workspace are justified by the repository's stronger acceptance/release gate.

No additional blocking plan/spec gap was found beyond R1. The minimum Python verification and both typecheck lanes are recorded; Windows parity remains explicitly unverified rather than claimed. The existing source tests cover helper write/commit failures, but they did not cover the host mkdir exception, which explains why the broad source run did not expose R1.

## Evidence and root-suite disposition

- Read the supplied whole-branch package, spec, plan, runtime guide, main report and progress ledger; inspected the current core source, changed tests and build/resource scripts to resolve the diff context. Reviewed the earlier focused fix outcomes through the provided history and current regression tests.
- Inspected `/tmp/omp-python-full-final.log`: 88 files passed, 1 skipped; 847 tests passed, 12 skipped, 0 failed. The log predates the synchronized version metadata change (`r` to `s`), as the report states; no product-code mismatch was identified.
- Inspected `/tmp/omp-python-bundle-delivery-recheck.log`: 12/14, with failures at `test/bundle-delivery.test.mjs:60` (legacy receipt resurrects installation) and `:100` (polling loses native failed-application diagnosis). Independently byte-compared that test, `super-dsh/superd-hub/src/companions.ts` and `bundle-setup.ts` with HEAD: all unchanged. These are existing problems, not a claim that the entire integration is healthy or permission to ignore the gate. Root `npm test` remains reported as 40/42.
- Independently checked the archived pair's actual tarballs, packaged resources and captured model-wire description as described above. Reviewed actual PC/dev3 tool calls/results, including the retained target path and return-type mistakes; the subsequent native read correction is evidenced, not merely asserted by a model narrative.
- Ran only the minimal filesystem-failure probe needed for R1. No previously covered broad suite was rerun; the probe used and cleaned its own `/tmp` resources and disposed its child.

## Recommended completion

Fix R1 with focused regression coverage, then review only that fix and its necessary documentation/artifact delta. Preserve the `s` acceptance record and use the next synchronized letter build for any new consumer artifacts. Revalidate the affected checkpoint failure behavior through the delivery path and update the report/status accurately. Carry M1 as an explicit deferred minor if not addressed. Final release/integration disposition must continue to disclose the two root companion failures and obtain the repository-required user release authorization; this review supplies none.
