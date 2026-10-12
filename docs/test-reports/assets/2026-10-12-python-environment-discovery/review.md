# Independent Python environment review

Base: `db6545dec55cfbb7fda6d67839d5d7fafc776f36`; reviewed working tree on `codex/omp-python-environment`.

## Strengths

- Provisioning, uv execution, the Python3.11 preference, package-local environment selection, daemon startup provisioning, and obsolete config fields are removed together. Resolver has no filesystem writes or installation commands.
- Explicit interpreter errors remain explicit instead of silently choosing a different interpreter. Relative paths are anchored to the session workspace. Resolved absolute `sys.executable` avoids a second PATH lookup selecting a different executable at launch.
- Discovery runs inside per-principal kernel creation; active/project activation reaches the owned Python child. Whole-principal transactions and the existing restore/degraded-child retirement paths remain intact.
- Runner, dill, and checkpoint source implementations are unchanged. Existing snapshot environment fingerprint checks precede graph loading, so environment changes degrade explicitly without replaying cells.
- Eleven new tests exercise real subprocesses under isolated PATH, including broken-candidate fallback, no uv execution, explicit selection, project activation, and distinct session workspaces.

## Findings

### P2 — renamed availability command omitted from published files (fixed during review)

`better-dsh/package.json:74` initially whitelisted deleted `scripts/kernel-provision.mjs`, while `package.json:84` invoked new `scripts/kernel-check.mjs`. The first independent `npm pack --dry-run --ignore-scripts --json` listed neither script: installed `npm run kernel:check` would fail with MODULE_NOT_FOUND. Reported to implementer; whitelist now names `scripts/kernel-check.mjs`. A second independent dry-run confirms it and `lib/kernel-env.js` are included.

No other material implementation defects or unjustified departures found in the approved scope. The single active/project environment selection follows the pinned OMP reference; removing its managed `~/.omp/python-env` candidate and preferring PATH `python3` then `python` are consistent with the approved Better contract.

## Verification and limits

- Read root/Better AGENTS and code-review skill/template; inspected changed implementation, tests, package manifest and README/runtime guide against base and pinned OMP runtime reference.
- Actually queried TypeScript LSP definitions/references and incoming/outgoing calls for `resolveKernelEnv` and `ensureKernel`; inspected current TypeScript AST call sites across resolver/runtime/plugin. Resolver is called from per-kernel creation, not plugin startup.
- Independent package dry-run verifies correction; full tests/typechecks and the eleven real-process test results are implementer-run evidence, not rerun by this reviewer.
- Windows-specific process/environment behavior is not covered by the new Unix-only fixture suite. Consumer tarball/dev3 create/prompt/resume and model-visible recovery acceptance remain required by the repository contract and are outside this static review verdict.

## Assessment

Source review passes after the packaging correction. Proceed to corrected dual-package tarball and target-runtime acceptance; this verdict does not authorize registry publication, Git finalization, or production changes.
