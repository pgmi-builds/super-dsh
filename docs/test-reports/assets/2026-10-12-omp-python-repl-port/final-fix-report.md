# Final fix wave — R1 checkpoint failure boundary

Date: 2026-10-12. Status: **R1 source fix and focused validation complete; independent scoped re-review and new installed artifact proof remain with controller.** No release approval is implied.

## Exact changes in this wave

- `better-dsh/src/runtime.ts`: import the existing `SnapshotOutcome` type; contain host checkpoint directory preparation and awaited snapshot dispatch in one try/catch, converting thrown/rejected errors into the existing failed outcome and failure notice.
- `better-dsh/test/omp-checkpoint-boundary.spec.ts`: five real-child regression cases for unavailable directory preparation and synchronous/asynchronous snapshot dispatch failure.
- This report: `.superpowers/sdd/2026-10-12-omp-python-repl-port/final-fix-report.md`.

Scoped directory comparison against `final-fix-base/better-dsh/{src,test,scripts}` confirms only `src/runtime.ts` differs and only `test/omp-checkpoint-boundary.spec.ts` was added. No source outside that scope changed in this wave. No docs, version, packaging, upstream/vendor, production/consumer state or Git finalization operations were performed.

## Diagnosis and fix

`snapshotTurnEnd` ran `mkdirSync` and awaited `snapshotState` without an exception boundary. Both callers have already completed a user cell or host assignment. Filesystem ENOTDIR/EEXIST or a thrown/rejected snapshot dispatch therefore rejected the completed operation, suppressing its value, user exception/stdout, and normal persistence notice. The shared boundary now normalizes only those snapshot errors to `{kind: 'failed', reason: messageOf(error)}`. Existing notice rendering reports the error and the last successful checkpoint; the existing result/output ledger and setVar pending-notice channel remain intact.

The change does not replay cells, suppress user execution, alter cancellation, mutate turn numbering, advance `lastSnapshotTurn` after failure, or rewrite previous checkpoint files. The existing host directory permissions and helper commit logic are retained.

## RED → GREEN evidence

Commands were run from `/home/u1/workspaces/superd`.

1. RED before runtime implementation:

   `npm test --prefix better-dsh -- test/omp-checkpoint-boundary.spec.ts`

   Exit 1; 1 file failed, **5 tests failed**. Log: `/tmp/omp-final-fix-red.log`. Failures matched R1: two ENOTDIR rejections from completed/exception cells at `runtime.ts:663`, applied setVar rejected on EEXIST at the same boundary, and both injected dispatch throw/reject cases escaped at `runtime.ts:665`.

2. GREEN after narrow runtime change, same command:

   Exit 0; 1 file passed, **5 tests passed**. Log: `/tmp/omp-final-fix-green.log`.

3. Relevant checkpoint/restore regression lane:

   `npm test --prefix better-dsh -- test/omp-checkpoint-boundary.spec.ts test/omp-checkpoint-review.spec.ts test/omp-checkpoint-safety.spec.ts test/omp-checkpoints.spec.ts test/snapshot-restore.spec.ts test/snapshot-revive.spec.ts`

   Exit 0; **6 files, 37 tests passed**, no skips/failures. Log: `/tmp/omp-final-fix-regressions.log`.

4. Host typecheck:

   `npm run typecheck:host --prefix better-dsh`

   Exit 0 (`tsc --noEmit`). Log: `/tmp/omp-final-fix-typecheck-host.log`.

5. Client typecheck:

   `npm run typecheck:client --prefix better-dsh`

   Exit 0 (`tsc -p tsconfig.client.json`). Log: `/tmp/omp-final-fix-typecheck-client.log`.

The new cases assert returned value and preceding stdout, preserved ValueError and mutations, no-successful-checkpoint reporting, applied setVar resolution and deferred notice, retained live state via the public query channel, subsequent execution, previous turn-1 reporting and byte-for-byte preserved checkpoint files, successful saving after recovery, and real cold restore of the recovered turn-4 checkpoint. Only the otherwise-unreachable host dispatch failure is narrowly injected with a prototype spy; child execution, assignment, queries, normal saving and cold restore are real. Tests assert public behavior and files, never spy call counts. All owned children are disposed through the existing fixture cleanup.

## LSP and AST inspection

Before implementation, actually ran `typescript-language-server --stdio` through `/tmp/omp-final-fix-inspect.py`; evidence is `/tmp/omp-final-fix-lsp.log`. Definition and references resolve `snapshotTurnEnd`; incoming call hierarchy confirms its only callers are `runTransaction` and `setTransaction`. An additional cross-file `snapshotState` definition query returned an empty result; direct kernel source inspection established its existing outcome mapping and awaited internal execution.

Actually parsed runtime TypeScript with the installed TypeScript compiler AST. `/tmp/omp-final-fix-pre-ast.json` identifies the two caller methods and unprotected mkdir/dispatch. `/tmp/omp-final-fix-post-ast.json` confirms both failure-producing calls are now within the same try boundary, with callers unchanged. The Python helper's `_paths` and `save` boundary were inspected directly; no helper changes were necessary.

## Self-review and open findings

The production diff is one imported type and one narrow failure boundary. Removing the catch makes all five regression cases fail as observed in RED. Dropping cell/assignment effects, losing exception/stdout, falsely advancing the successful turn, deleting checkpoint files, or leaving the runtime unusable each violates direct behavioral/file assertions. Existing partial coverage, atomic write and restore tests remain green in the 37-test lane.

No new finding identified in self-review. M1 structured native abort rendering remains explicitly deferred. M2 spec closeout, synchronized next-letter artifacts, installed PC/dev3 delta proof and final release/integration disposition remain controller-owned. The previously documented two root companion failures remain open; this scoped wave did not rerun or claim a green root/full suite.
