# OMP Python REPL port: first-person re-verification of installed `0.3.0-t`

Date: 2026-10-12 (Asia/Hong_Kong). Verdict: **the exercised delivered behavior matches the ported contract; no new blocking finding.** Five minor Surface observations are recorded below for review. This report is the companion that the `0.3.0-t` acceptance record already linked; it is written from the model's own live `eval` calls against the installed package, not from source tests or fixtures.

Machine-readable probe summary: [first-person-t.json](assets/2026-10-12-omp-python-repl-port/first-person-t.json). Controller-verified native calls/results: [first-person-t-native.json](assets/2026-10-12-omp-python-repl-port/first-person-t-native.json).

## What "first person" means here

The `eval` tool **is** the artifact under test. Better's Jupyter/ZMQ substrate was replaced by the pinned OMP runner plus Better's own support and snapshot helpers; every `eval` call in this session therefore executes against the installed bytes. This session (started fresh for the test) made **41 `eval` calls with 41 corresponding results**, including fault probes, inspections and cleanup, as counted from the retained native history. The earlier count of25 was a report-counting error; it did not describe the full session.

- Test line: `super-dsh/test/start-4999.sh`, retained home `/home/u1/workspaces/superd/.tests/superd`, profile `superd-pub`.
- Session: `session-60e31824-4a37-41fe-8eea-5a4b1033cc76`.
- Installed package: `.tests/superd/profiles/superd-pub/node_modules/better-dsh` at `0.3.0-t` (matches [pair-t.json](assets/2026-10-12-omp-python-repl-port/pair-t.json): Better `a9b908e7…8064d`, Super `95ed98db…2cadf`).
- Checkpoint root for this session: `.tests/superd/better-dsh/python-repl/0b20ba86…7547/session-60e31824-4a37-41fe-8eea-5a4b1033cc76/`.
- Review entrances re-probed now: public [https://test.pc.internal.test/](https://test.pc.internal.test/) 200, [LAN 4999](http://192.0.2.130:4999/) 200, dev3 [LAN 4996](http://192.0.2.130:4996/) 200.

## Installed resources actually exercised

| Check | Observed |
| --- | --- |
| Running interpreter origin | `sys.modules["__main__"].__file__` = `…/better-dsh/lib/omp-python/runner.py` |
| Interpreter | CPython **3.11.17**, `sys.executable` = `…/better-dsh/.venv-kernel/bin/python`; manifest interpreter = managed `.uv-cache/python/cpython-3.11.17-linux-x86_64-gnu/bin/python3.11` |
| Pinned runner integrity | SHA-256 `e0e660ca44193735a2de467254b050109bb23028aca71af01b9365b9ab88e974`, 90,278 bytes |
| Jupyter/ZMQ absence | `find_spec` for `ipykernel`, `jupyter_client`, `zmq`, `jupyter` → **none**; no real references in compiled JS |
| Vendored dill | resolves to `lib/omp-python/vendor/dill/__init__.py`; manifest `dillVersion 0.4.1`; 14 runtime sources present |
| Model-facing Surface | packaged `eval-description.md` = 3029 bytes and its wording is the description delivered to this session |
| Retired mechanisms | `lib/kernel-transport.js` / `kernel-bridge.py` absent; residue is only the `kernel-env` module name and the private class name `IpyKernelBridge` |

## Results

| # | Contract | First-person evidence | Verdict |
| --- | --- | --- | --- |
| 1 | Substrate replaced, no Jupyter | `__main__` is the packaged runner; all Jupyter probes `None` | Pass |
| 2 | Cross-cell state | `omp_x = 40` in cell 1 → `omp_x + 2 == 42` in cell 2 | Pass |
| 3 | Alias / lambda / user class | `omp_alias is omp_list` true; `omp_f(4) == 5`; `OmpBox(10).bump() == 11` | Pass |
| 4 | Top-level await | `await asyncio.sleep(0)` in a cell succeeded | Pass |
| 5 | Native tool bridge | `tool.read` returned real DSH hashline text; `asyncio.gather(tool.grep, tool.glob)` returned both; 31 tools reachable | Pass |
| 6 | Tool error contract | `ToolCallError` with `toolName="read"` and `[E_NOT_FOUND]` / `[E_BAD_SHAPE]` | Pass |
| 7 | `tool.bash` bridge | `stdout` and `stderr` objects populated from the cell | Pass |
| 8 | After-cell callback admission | a task created in cell N that calls a tool later → `ToolCallError: host callback rejected: its cell is no longer active` | Pass |
| 9 | Output mapping | stdout and stderr both surfaced; scalar value `42`; exception rendered with traceback | Pass (obs. O1) |
| 10 | Exception recovery | value set before `raise` retained (`omp_before_error == 73`); the exception cell still advanced the checkpoint turn | Pass |
| 11 | Checkpoint written per completed cell | manifest turn equals completed-cell count; `names`, `dependencies`, `bindingNames`, `omitted`, `sizeBytes`, `sha256`, `previousPayload` all coherent | Pass |
| 12 | Atomic generation + permissions | manifest `sha256` equals the referenced payload file's hash; dir `0700`, manifest/payload `0600`; only current + previous generation retained | Pass |
| 13 | Injected bindings excluded | `bindingNames: ["ToolCallError","tool"]`, and `display` was filtered from `names` | Pass |
| 14 | Honest partial coverage | `[dashr] turn-19 checkpoint saved; partial coverage, omitted _r (UnsupportedResource: captured Better/runner binding), _state (UnsupportedResource: unsupported live resource TextIOWrapper)` — the cell still returned success | Pass |
| 15 | Dying cell, no replay | self-`SIGKILL` mid-cell → `worker-exit` error naming the turn-11 restore, "may have executed partially… No user code was replayed"; the cell's marker file contained exactly one byte | Pass |
| 16 | Fresh-child restore | next cell had `omp_x=40`, `omp_before_error=73`, `omp_f(4)=5`, `omp_box.bump()=11`, `omp_alias is omp_list` true, and the post-checkpoint `omp_died_here` correctly absent; runner PID changed `1050438 → 1051039` | Pass |
| 17 | Manifest validation before load | invalid JSON → `JSONDecodeError…`, EMPTY namespace | Pass |
| 18 | Payload integrity before load | one flipped byte → `ValueError: payload integrity hash mismatch`, EMPTY namespace | Pass |
| 19 | Environment validation before load | replaced `environmentHash` → `ValueError: checkpoint environment mismatch: environmentHash`, EMPTY namespace | Pass |
| 20 | `reset: true` | memory cleared; session directory deleted and rebuilt at turn 1 with `names: []`; old payloads gone | Pass |
| 21 | `%reset -f` magic | memory cleared; `tool`, `display`, `ToolCallError` reinstalled; disk cleared | Pass (obs. O2, O3) |
| 22 | Timeout/interrupt | `Error: code run failed (timeout): Python cell exceeded 2000ms`; side effect happened **once**; pre-interrupt mutation survived; pad usable afterwards | Pass |
| 23 | Internal-name isolation | `%who` listed only user names plus `tool`/`display`/`ToolCallError`; no snapshot, dill, runner or sentinel name in the user list **or** in the manifest | Pass (obs. O4) |
| 24 | Output size | 8,000-char stdout arrived with both begin and end markers intact | Pass at smoke level only (obs. O5) |

## Observations (no blocking finding)

- **O1 — traceback leaks a helper frame (minor).** User exceptions show `File "…/lib/omp-python/better_support.py", line 364, in run` above the user frames, and the frame text exposes `runner._exec_source_async(ast.unparse(tree), ns)`. It is honest but noisy for a model reader; a trimmed traceback would be a Surface improvement, not a correctness fix.
- **O2 — `%reset` status is opaque (minor).** `%reset -f` returned `[Python display: application/x-omp-status]`; the structured status payload is not legible to the model. The state effect is observable, but the confirmation is not.
- **O3 — two reset paths disagree on turn numbering (minor).** `reset: true` restarts the lineage at turn 1; the `%reset` magic clears the same memory and disk but leaves the turn counter running (continued at turn 3). Both are unambiguous because the old generations are deleted; the asymmetry is cosmetic.
- **O4 — runner compiler-seam names exist in `globals()` (low).** Eight `__omp_*` dunder names (`__omp_magic`, `__omp_shell`, `__omp_run_id__`, …) are present in the user namespace. They are hidden from `%who` and excluded from checkpoints, so the "no pollution of visible lists" contract holds; they are visible only to code that enumerates `globals()` directly and could in principle be shadowed by user code.
- **O5 — output cap not reachable first-person (scope limit).** The configured cap is 64 MiB, so only a small-output smoke check was possible. The truncation-notice path remains covered by source tests, not by this report.
- **Vendored `dill` is importable from user cells.** `importlib.util.find_spec("dill")` resolves to the packaged vendor copy. The plan's "package path first only for this child/helper" is satisfied because the child *is* the helper's process, but user code can therefore touch the checkpoint serializer. Recorded as a capability note, not a defect.

## Errors made during testing (kept for honesty)

1. `_cap.stdout` was written **inside** the `%%capture` body, so the body raised `NameError` before the magic reached its binding line. Re-testing correctly confirmed `_cap == "captured-now-hidden\n"`. My error, not a product defect.
2. A cleanup cell referenced `_leaks` instead of `_omp_leaks` and raised `NameError`; the `/tmp` cleanup lines had already executed.
3. The first no-replay marker was written to `/tmp` and could not be observed — the `bash` tool runs under `bwrap --tmpfs /tmp --unshare-pid`, so its `/tmp` is a private empty tmpfs and its PID namespace hides the eval child. The test was re-run against the shared workspace, which is the only channel both tools see. A cell-side `!ls /tmp` proved the eval child sees the host's real `/tmp`. This is a harness method fact, not an OMP defect.

## Not verified first-person

Native UI cancellation (and the already-deferred `[object Object]` structured abort reason), snapshot size-cap/timeout paths, the `setVar`/`queryVar` seam (no tool surface), byte-exact model-wire description diffing by this first-person tester, and Windows lifecycle parity. The controller subsequently compared the retained actual `request/header` eval descriptor with the installed markdown and verified byte equality; that read-only cross-check is archived in the native evidence above. Nothing here contradicts the `0.3.0-s`/`t` records; it independently confirms the model-visible behavior those records claim.

## Bottom line

Against the installed `0.3.0-t` bytes, the OMP-backed pad behaved as specified on every path this session could reach: persistent state and aliases including identity, native tool calls and cancellation-safe callback admission, honest exception recovery, per-cell best-effort checkpoints with integrity/environment validation, fresh-child restore, three distinct degraded-restore reasons that all start EMPTY without replaying code, and both reset paths clearing memory and disk. The five observations above are Surface/cosmetic candidates for a future minor; no new Critical or Important finding was produced, and no commit, tag, push, publish or production action was taken.
