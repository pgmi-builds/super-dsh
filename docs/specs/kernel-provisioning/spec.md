# Existing Python interpreter discovery

Updated 2026-10-12 by explicit user correction. This replaces the former iKernel managed-provisioning contract. Execution and recovery are specified in [OMP Python REPL](../omp-python-repl-port/spec.md); consumer behavior is in its [runtime guide](../omp-python-repl-port/runtime-guide.md).

## Requirements

### Existing interpreters only

Better SHALL run an existing Python interpreter. It SHALL NOT invoke uv/pip, download Python, create or repair a virtual environment, or place Python environment/cache state in the installed npm package. No CPython implementation or Python3.11 preference is applied. The packaged dill0.4.1 checkpoint helper requires Python >=3.9.

### Explicit selection

An explicit `python` executable name/path SHALL bypass automatic discovery. Bare `python3` is an explicit executable name, not a provisioning sentinel. Relative paths SHALL resolve against the session workspace and `~/` against the user's home. An unusable explicit selection SHALL report the actual failure without silently substituting another interpreter. Existing explicit virtual environments SHALL receive their activation environment.

### Automatic discovery

Without explicit selection, Better SHALL probe an existing active virtual/Conda environment or workspace `.venv`/`venv`, then PATH `python3` and `python`. A broken automatically discovered candidate SHALL permit a working fallback without repair. Resolved executable identity and activation environment SHALL reach the spawned child. One session's project interpreter SHALL NOT be cached as the choice for another workspace.

### Readiness and failure

Availability is checked when the session needs its Python child. Plugin mounting SHALL NOT provision an environment. With no working candidate, the error SHALL identify attempted interpreters and explain how to install Python or configure an existing executable. `npm run kernel:check` SHALL perform discovery only, with no installation side effects.

### Runtime state and migration

Checkpoints SHALL remain under the native profile home (or explicitly configured snapshot directory), isolated by profile/session. Old `kernelEnvDir`, `kernelPythonVersion`, `kernelAutoInstall` fields and `kernel:venv` command are removed. Existing package-local `.venv-kernel`/`.uv-cache` files SHALL be left untouched and SHALL NOT be selected automatically. An interpreter/environment change SHALL pass the existing checkpoint compatibility checks and report incompatible recovery explicitly; no user cell is replayed.
