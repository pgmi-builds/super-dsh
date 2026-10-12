# OMP Python REPL port implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Track steps with checkboxes. Repository acceptance and release gates override skill commit steps: no commits, tags, pushes or publishing before acceptance, report and user release.

**Goal:** Replace Better's Jupyter/ZMQ substrate with the pinned OMP Python runner, retaining tool calls, session state and honest best-effort checkpoints without consumer pip installs.

**Architecture:** Node owns one Python child per session and serializes user and internal execution over OMP's NDJSON protocol. Unmodified upstream resources have provenance and licenses; Better owns initialization, binding callbacks, namespace filtering, checkpoints, output mapping and lifecycle. Checkpoints preserve an admitted object graph and expose incomplete coverage without replaying user code.

**Tech Stack:** Node child_process, TypeScript, Python stdlib, vendored dill 0.4.1, Vitest, Cordis/DSH native composition.

**Spec:** `docs/specs/omp-python-repl-port/spec.md`. User approved BOTH phases on 2026-10-12.

## Global constraints

- `runner.py` is copied byte for byte from commit `fa5ff4a3a977a28b93d025f4cf50f046e019f18c`; expected SHA256 `e0e660ca44193735a2de467254b050109bb23028aca71af01b9365b9ab88e974`.
- Copy required MIT notices and original source provenance; no OMP package import or Bun runtime. Use packaged `.py` resources, compiled JS at runtime.
- Vendor dill 0.4.1 Python sources unchanged with BSD-3-Clause notices; no consumer pip install. Python interpreter remains required, supported baseline >=3.9 subject to pinned runner verification.
- Preserve `ReplRuntime` public seam and lossless JSON/tool-error/cancellation contracts. No upstream checkout edits.
- Internal cells serialize with user cells and cannot pollute visible output/user namespace lists. No unowned listener or callback admission after cell completion.
- Checkpoints exclude runner/Better/tool bindings and OS resources, commit atomically, retain previous valid generation after failure/cap, validate manifest/environment/integrity before load, and report skipped state and latest successful turn.
- Do not automatically retry/replay the death-observing cell or assert it did not execute if it began. Reset clears memory and disk.
- Use existing checkout on `codex/omp-python-repl-port`; preserve unrelated working changes. LSP/AST inspection evidence is `/tmp/omp-lsp-ast.json` plus protocol research evidence.
- Test versions synchronize using root `version:release`; next round `0.3.0-s`. No npm publish, Git commit/tag/push or production actions.
- Acceptance requires current launcher tarballs at PC4999 and dev3 independent test installation, actual model-visible tool use, report under `docs/test-reports/`, and running browser review URL.

## Task 1: Replace execution substrate and deliver resources

**Files:** create `better-dsh/src/omp-python/` for pinned runner, own support, provenance/notices; replace `src/kernel.ts`, `src/kernel-env.ts`, `src/bootstrap.ts` and `src/python.ts` as needed; remove retired `src/kernel-transport.ts`/`src/kernel-bridge.py`; update `scripts/copy-kernel-bridge.mjs`, `scripts/kernel-provision.mjs`, package scripts/notices and affected execution/env tests.

**Interfaces:** preserve bridge methods `start()`, `executeCell(code, opts)`, `queryVar(name)`, `setVar(name, valueJson)`, `snapshotState(payloadPath, manifestPath, spec)`, `restoreState(payloadPath, manifestPath)`, `dispose()`; preserve `pid`, `isRunning`, `isDead`. Add outcome fields only when Task2 consumes them. Host callback handler retains `{global, function, args}` request and `{ok,result|message}` reply.

- [x] Read pinned source/protocol report `/tmp/omp-python-protocol-research.md` and actual existing runtime contracts. Record any deliberate adaptation in provenance.
- [x] Add failing execution test using a temporary stdlib-only Python venv: `python3 -m venv --without-pip <dir>` and `setupRuntime({python:<dir>/bin/python})`; run `x=40`, then `x+2`, assert value42 and no Jupyter dependency. Add OMP magic/shell behavior test and binding gather/error/cancel tests where existing coverage is insufficient.
- [x] Run `npm --prefix better-dsh test -- test/runtime.spec.ts test/kernel-env.spec.ts`, save expected missing-ipykernel failure as RED evidence.
- [x] Copy runner unchanged; provide Better support module with per-child authenticated HTTP or dedicated inherited callback pipes (prefer pipes when portable). Route async tool calls concurrently within a serialized cell; correlate request/response and discard stale replies.
- [x] Implement Node NDJSON transport/startup probe, actual OMP source transformation/execution, typed completion mapping, text output, error/abort/timeout mapping, no invisible truncation, and bounded termination/close. Separate internal output consumption from user results. Preserve None suppression, top-level await and return rejection.
- [x] Resolve/probe >=3.9 interpreter without requiring ipykernel, jupyter_client, pyzmq or external dill. Preserve configured interpreter/managed venv compatibility without installing kernel packages; provide actionable interpreter errors.
- [x] Copy all Python resources/licenses/provenance into `lib/` after build; remove obsolete bridge/provision mechanisms and update descriptions which claim IPython.
- [x] Run execution/binding/output/cancel/lifecycle suites and host typecheck; verify no orphan children. Task reviewer checks protocol, state/cancellation ordering and packaged resource resolution before Task2.

## Task 2: Checkpoints and truthful recovery

**Files:** create Better-owned `src/omp-python/better_snapshot.py`; vendor runtime-only dill source under `src/omp-python/vendor/dill/`; update `src/runtime.ts`, `src/kernel.ts` outcome types and helpers; update `test/snapshot-restore.spec.ts`, `test/snapshot-revive.spec.ts`, variable tests and lifecycle tests.

**Interfaces:** keep `SnapshotSpec {turn, skills, sizeCapBytes}`. Snapshot success includes admitted names, skipped names/reasons and turn. Restore success includes count, skipped/partial coverage and turn; degraded outcome includes reason. Runtime puts save/restore/death notices into model-visible `logs` or error while preserving `maxOutputBytes`.

- [x] Add failing fresh-process restoration tests for `x=[1,2]`, alias `y=x`, lambda `f=lambda n:x[0]+n`, a user class/instance, and `setVar`; assert `f(4)==5`, `x is y`, and valid internal-name filtering.
- [x] Add failing mixed namespace test with a bad `__reduce__` and live file/lock handle alongside good variables; assert partial recovery lists omissions and retains aliases. If dependencies/shared references cannot safely be separated, refuse graph and report failure instead of falsely promising preservation.
- [x] Add corrupt manifest/payload, environment mismatch, cap/timeout with previous generation retention, failed user cell, reset deletion, death during side-effecting cell and namespace-query isolation tests. Assert no code replay; failure states remain usable.
- [x] Run the targeted tests to record RED failures before implementation.
- [x] Vendor dill0.4.1 runtime source and license/provenance; explicitly put package path first only for this child/helper, without runtime install or upstream source modifications.
- [x] Implement own helper selecting user bindings against startup/internal/injected bindings, blocking resources, probing candidates then round-tripping the final graph to verify it before commit. Manifest records format, Python/interpreter/environment, checkpoint turn, payload size/hash, names, omissions and coverage. All helper locals stay in helper module/function scopes.
- [x] Use a complete-generation commit (single atomic manifest pointer to immutable payload, or equivalent single-file envelope) so a crash cannot pair new payload with old metadata. Use restricted per-session dirs and validate size/hash/environment before dill.load; never accept arbitrary external checkpoint paths.
- [x] Runtime snapshots completed cells after success or user exception, and setVar when applicable; reports failures/partial/cap honestly, including latest successful checkpoint. Restore once before first user cell. Preserve affected session counters; distinguish unstarted observation from partially executed dying call, and never demand blind replay of side effects.
- [x] Set checkpoint path through official DSH home/profile APIs in delivered composition, preserving explicit custom directory or disabled choice. Reset removes current and retained owned generations.
- [x] Run checkpoint/execution suites and host/client typechecks; reviewer checks reference preservation, atomicity, permissions and model-facing recovery wording.

## Task 3: Consumer validation, Surface and review handoff

**Files:** update `better-dsh/eval-description.md`, relevant canonical docs and package-catalog as needed; update spec status with implementation evidence; write `docs/test-reports/2026-10-12-omp-python-repl-port.md`.

- [x] Update runtime-visible tool guidance to explain OMP-backed Python, interpreter prerequisite, process-local state plus best-effort checkpoints, skipped resources and no automatic replay. Avoid claiming complete process restoration.
- [x] Run full affected Better tests and both typecheck lanes. Run root packaging checks and `npm run version:release -- 0.3.0-s` before a clean dual pack.
- [x] Inspect actual tarball resources/hashes/licenses and absence of obsolete ZMQ or consumer pip install, plus two independent bundles contract.
- [x] Launch via `super-dsh/test/start-4999.sh` in retained `.tests/superd`; first-person model performs Python assignment, cross-cell lookup, native tool call, exception recovery, cancellation and reset. Inspect model-visible results.
- [x] Transfer exact two tarballs and `pair.json` to retained dev3 test environment; use same launcher/prebuilt pair with independent host anchor. Run equivalent actual installed REPL/state/restore probes. Never touch production homes/ports/Caddy.
- [x] Exercise installed checkpoint creation, fresh-child restore, partial restore/corruption and death side effects through actual consumer runtime; correlate files/manifests and model notices with results.
- [x] Write exact artifact hashes, versions, checks/failures, session IDs, target services and review URL in report. Leave test web running for user review. No commit/publish; report any remaining externally blocked verification honestly.

## Final review follow-up

The `s` acceptance record is retained. Independent whole-branch review reproduced a host filesystem error escaping the checkpoint best-effort boundary.

- [x] Fix R1 and run focused real-child regressions plus both typechecks; one scoped final re-review.
- [x] Synchronize `0.3.0-t`, build the ordinary dual pack, and verify exact resources/artifacts.
- [x] Revalidate checkpoint filesystem-failure degradation and native read/state continuity through both installed consumers; archive evidence and leave both Web entrances running.

Structured native cancellation reasons still render `[object Object]`; this non-blocking minor remains recorded. The two unchanged root companion test failures remain a separate integration/release gate.
