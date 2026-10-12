# Better Dash Python REPL execution and recovery

Implementation and acceptance are tracked in the [plan](../../superpowers/plans/2026-10-12-omp-python-repl-port.md). The [spec](spec.md) defines the recovery boundary; this guide explains the consumer contract being implemented.

Better runs a persistent Python child for each DSH session. Node communicates with an unchanged, pinned OMP runner over JSON lines. Better owns tool bindings, cancellation, output mapping and checkpoint management. Interpreter discovery reuses an explicitly configured interpreter, otherwise an active/project environment then PATH `python3` or `python`. It probes candidates and falls back from broken automatically discovered environments; it never invokes uv/pip, installs Python or creates a venv. Explicit relative paths and project environments resolve against the session workspace. Python >=3.9 is required by the packaged dill0.4.1 checkpoint helper; no3.11 or CPython implementation is selected. Better ships the Python runner and dill 0.4.1 source. It does not install Jupyter, IPython, ZeroMQ or dill into the consumer's interpreter. OMP's Agent-specific prelude is not exposed as a DSH feature.

Variables, functions, classes and imports remain available across cells while the child lives. Top-level await works; a top-level return is invalid. The final expression supplies the completion value and print supplies logs. Host tools remain callable with `await tool.<name>({...})`. Internal initialization and checkpoint cells do not appear as user results or user scratchpad variables.

`tool.read` forwards to the current DSH native read tool with its usual permissions, scheduling and results. Better supplies the call-site helper required by OMP's compiler without enabling OMP speculative reads. Interactive `input()` is unsupported and returns an actionable error. Output uses the existing text/log/result contract; a nontext-only display produces an explicit MIME notice.

`npm run kernel:check` checks existing interpreter availability without provisioning. Legacy provisioning fields `kernelEnvDir`, `kernelPythonVersion`, `kernelAutoInstall` and the `kernel:venv` command are removed. Old package-local environments/caches are left untouched and are not auto-selected. An interpreter change may make existing checkpoints incompatible; recovery reports that condition explicitly.

## Checkpoint boundary

In a native DSH profile, checkpoints belong under that profile's resolved DSH home and are isolated by profile and session. An explicitly configured checkpoint directory takes precedence; `snapshotDir: ""` disables persistence and leaves process-local state only. A standalone runtime without a native profile must explicitly choose a checkpoint directory.

A completed cell attempts a new checkpoint, including a cell that raises after changing variables. Saving a checkpoint can fail or skip values. Better reports the coverage and latest committed cell instead of claiming complete process recovery. Aliases and dependencies among retained values must survive as one object graph; values whose dependencies cannot safely be preserved are omitted or the checkpoint is rejected.

The serializer does not preserve runner state, host tool bindings, open files, sockets, subprocesses, threads, locks or database connections. Tool bindings are recreated from the current host. Current directory, environment changes, module caches and library global state are not generally restored. File modifications and network/tool side effects have their own real sources and are never replayed or rolled back by a variable checkpoint.

The checkpoint manifest records format, completed-cell sequence, interpreter/environment identity, payload size/integrity, saved names and omissions. Only a complete committed generation is eligible for restoration. A failed attempt before commit preserves the previous valid generation. If interruption prevents commit confirmation, the result reports that uncertainty; the manifest remains the authority on the latest complete generation. Restore validates the owned session checkpoint before loading it and runs once before admitting a new user cell. Damage or incompatibility produces an explicit empty-state notice. A partial restore lists the missing coverage.

`reset: true` discards the session child and its persisted checkpoints. Do not use it when you intend to retain state.

## After a crash or interruption

Read the recovery notice, check the latest successful checkpoint and inspect real external state. A cell that died after starting may already have performed side effects. Better does not automatically retry it and does not instruct blind replay. Recreate omitted resources and rerun only the operations you determine are still needed.

Snapshots are private executable serialization, not an interchange format. Do not copy arbitrary external dill files into the checkpoint directory or treat them as data imports. The owned directory, session isolation and permissions are part of the recovery contract.

## Delivery verification

The original OMP runner, its MIT license and source/hash provenance travel inside the npm package. Vendored dill carries its version, original source hashes and BSD-3-Clause license. The build verifies these resources and copies them beside compiled JavaScript; consumers never execute TypeScript or load OMP/Bun packages.

Acceptance uses the normal dual tarball launcher and a dev3 test installation. Source tests, successful build or a live Python process alone are insufficient. The final test report records exact artifacts and the observed model-visible recovery behavior.
