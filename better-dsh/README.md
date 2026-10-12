> Part of [Super D](../README.md). `better-dsh` is an independently installable native DSH bundle. Super Dash installs it through the native Plugin Manager; both packages use synchronized versions and independent enable/disable controls. Canonical shared specifications are in root `docs/`.

# Better Dash — Dashr

Better provides a stateful `ctx.replRuntime` and the model-facing `eval` tool. Each DSH session has its own persistent Python child: variables, imports and definitions survive across cells, while sessions remain isolated. `DashrRuntime` owns the children and their lifecycle; the presentation layer exposes the Python SDK and bridges calls to the current session's host tools.

The execution path is Node → JSON lines → an unchanged, pinned OMP Python runner → Python. Better adapts the host interfaces and packages the runner resources with compiled JavaScript. No OMP package, Bun, IPython, Jupyter or ZeroMQ is required by this path. Host modules remain optional peers and keep their runtime identity; Better's own JavaScript dependencies are bundled at build time.

## Native Web policies

The bundle owns independently toggleable WebTrust, mobile behavior, password-page and onboarding contributions through native DSH interfaces. Native WebServer/HMR and CLI listener policy remain in place. `dashr-welcome-notice` shadows the native welcome entry and calls its public completion callback; disabling that component restores the native welcome item.

Super Dash installs Better as a separate native bundle. `../dev-webmcp` is a development-only test bundle and is not shipped in either product tarball.

## Install and interpreter

```sh
npm install better-dsh
```

Better uses an existing Python interpreter. An explicit `python` setting (or `DASHR_KERNEL_PYTHON`) takes precedence; otherwise discovery checks the active virtual/Conda environment, an existing workspace `.venv` or `venv`, then PATH `python3` and `python`. Candidates are actually probed, and a broken automatically discovered candidate does not hide a working fallback. Relative explicit paths resolve against the session workspace. No CPython implementation or Python3.11 version is selected. The packaged dill0.4.1 checkpoint helper requires Python >=3.9.

Better does not install Python, invoke uv/pip, or create a virtual environment. When none of the existing candidates works, the error lists the attempts and asks for an existing interpreter or a Python installation. `npm run kernel:check` checks availability without changing the environment. The runner and dill sources ship in the package; runtime checkpoints belong under the native profile home, and package upgrades do not require rebuilding a package-local Python environment.

The old `kernelEnvDir`, `kernelPythonVersion` and `kernelAutoInstall` provisioning fields and `kernel:venv` command are removed. Existing package-local `.venv-kernel` / `.uv-cache` directories are no longer selected automatically or modified; an existing interpreter can still be selected explicitly. A checkpoint made with another interpreter/environment may be incompatible and produces the usual explicit recovery notice; it is never replayed into a new environment.

The original OMP runner's source commit/hash and MIT license, and dill's source hashes/version and BSD-3-Clause license, accompany the packaged resources. Better's integration code is separate from these original files. OMP-specific Agent helpers are not exposed as DSH features.

## Configuration

Runtime fields remain configurable through the ordinary Cordis row. The implementation's schema is authoritative; the principal controls are:

| Field | Default | Meaning |
| --- | --- | --- |
| `python` | automatic discovery | Existing executable name/path; explicit selection bypasses discovery. |
| `startupTimeoutMs` | `30000` | Budget for child startup and initialization. |
| `runTimeoutMs` | `120000` | Wall budget per user cell. |
| `interruptGraceMs` | `2000` | Grace after an interrupt before terminating an unresponsive child. |
| `interruptConfirmMs` | `250` | Delay before confirming an interrupt that has not finished the cell. |
| `disposeTimeoutMs` | `5000` | Bound on graceful child teardown before forced cleanup. |
| `snapshotTimeoutMs` | `30000` | Budget for internal save/restore operations. |
| `maxOutputBytes` | `67108864` | Cap for serialized logs, completion and error output; overflow is reported. |
| `snapshotDir` | native profile checkpoint directory | Explicit directory overrides the native profile default; `""` disables persistence and retains only live process state. Standalone runtimes must explicitly configure persistence. |
| `snapshotSizeCapBytes` | `268435456` | Checkpoint payload cap; failed or over-cap saves preserve the previous committed generation. |
| `username` | `dashr` | Retained compatibility field. |

## Cells and recovery

One `eval` call runs one Python cell. Top-level `await` works and top-level `return` is invalid. The final expression supplies the completion value; a final `None` or statement produces no value. Non-JSON completions return repr text. Printed stdout/stderr become logs. Tools use `await tool.<name>({...})` and failures raise `ToolCallError`.

Operations for one session serialize, including initialization, user cells, checkpointing, variable access and reset. Different sessions can execute concurrently; one cell can fan out independent asynchronous host tool calls.

Completed cells attempt a checkpoint, including cells that raise after changing state. The helper saves an admitted user object graph, preserving shared references among retained values. Serialization failures, resource exclusions and partial coverage are reported to the model. A complete generation is committed atomically; a failed attempt before commit retains the previous valid checkpoint. If interruption prevents confirmation of the commit, Better reports that uncertainty.

On a fresh child, Better validates and attempts restoration once before admitting user code. The notice identifies the saved cell and any omissions. A damaged or incompatible checkpoint starts empty and reports why. Runner plumbing, tool bindings and OS resources are excluded. Current tools are recreated from the host; files, sockets, subprocesses, threads, locks, connections, environment mutations and external side effects are not restored as a Python process.

A dying or interrupted cell may already have performed side effects. Better never automatically retries it or blindly replays historical cells. Read the recovery notice and inspect real state before deciding which work to repeat. `reset: true` clears the session's memory and disk checkpoints.

For the full boundary and source provenance contract, see [the runtime guide](docs/specs/omp-python-repl-port/runtime-guide.md) and [spec](docs/specs/omp-python-repl-port/spec.md).

## Testing

```sh
npm run typecheck
DASHR_TEST_PYTHON=python3 npm test
```

Tests create real Python children and dispose their contexts. Stdlib-only interpreter coverage verifies that external kernel packages are unnecessary. Consumer acceptance additionally requires the root dual-tarball launcher and dev3 installed behavior; source tests and process liveness alone are insufficient.

---

# Presentation half (eval transport, SDK, bindings)

The DASHR agent-plane presentation (blueprint §7.4): the plugin half that
presents the persistent-kernel runtime to the model as **cells on one
persistent Python runner**. It contributes:

- **`eval`** — the cell transport tool: one call = one cell on the calling
  session's kernel (the `ctx.replRuntime` service). Variables, imports, and
  definitions survive across calls. Nested tool calls ride the host
  registry's native scheduling pipeline as `await tool.name({...})` inside
  the cell — one positional arguments object per call, keyword arguments
  rejected. Every registry-visible tool is bound as a member; the
  `send_message` bridge callable joins them in the same catalog block.
- **`dashr:tool-catalog`** — a generated Python SDK prompt section: one
  `async def name(args) -> Output` per visible tool (flat `tool.*` shape)
  plus the cell contract (persistent namespace, completion-value rules,
  `ToolCallError`, sub-call concurrency).
- **The model-direct collapse** — an assembly filter leaves `eval` the only
  contributed tool schema, and a monotonic guard denies a model-direct call
  naming anything else with the route back into a cell. Both are scoped to
  the mounting composition, so a PTC (native Code Mode) preset in the same
  process keeps its own presentation.
- **Masking (ADR-0002)** — exactly two upstream tool names are displaced
  from the model's surface (`send_message` and the child-scoped `report`),
  collapsed into the single dual-direction `send_message` bridge. Every
  other delegation tool (`subagent`, `subagent_fork`, `list_agents`,
  `interrupt_agent`, `workflow`, `ralph`) stays **directly exposed** as a
  native `tool.*` binding — the model calls it exactly as the host ships it.
  Masking is presentation-only: the registry is never touched.

Removed in v0.1.8b: the `refine` Continual Harness and the `compact` REPL
bridge (harness/refine became third-party territory; context compaction is
the host runtime's business, not the REPL's).

## Install

Install this package independently with the native plugin command. Use Super Dash instead when you also want the Foreign Agent Hub:

```sh
# 1. plugin — the pnpm registry-metadata cache can lag a fresh npm publish
#    by minutes-to-hours, so drop it first, or `@latest` resolves the OLD
#    version right after a release:
rm -rf ~/.cache/pnpm
dsh plugin --profile web add --config.auto-install-peers=false better-dsh@latest

# 2. restart the running instance:  systemctl --user restart dsh
```

Notes: `--config.auto-install-peers=false` is MANDATORY — the profile
already resolves `@deepseek-ai/*` peers through the harness install; letting
the package manager auto-install them adds a second, divergent copy of
cordis and friends. The version is deliberately unpinned (`@latest`).

## Coexistence with a PTC Code-Mode session

`eval` is our own transport name (the registry reserves `run_code`), so a
Code-Mode preset (`@deepseek-ai/dsh-agent-tool-presentation` with
`mode: code` over the host-plane worker-thread `codeRuntime`) composes
beside a DASHR session in one process: the PTC agent's assembly shows
`run_code` plus the TS `tools:sdk` section, the DASHR agent's shows `eval`
plus the Python `dashr:tool-catalog`, and neither execution path touches
the other's runtime.

## Composition

```ts
import dashr from 'better-dsh'

ctx.plugin(dashr, { maxParallelSubCalls: 10 })
```

One plugin, one row: `apply` mounts `DashrRuntime` first (providing
`ctx.replRuntime`), then the presentation half injects on `replRuntime` —
a composition without the runtime fails AT MOUNT, named in the preset's
activation audit, instead of at the first prompt. The dashr bundle patch
mounts the row on the HOST plane, so every agent in every preset sees the
`eval` tool (`agent → preset → global`).

## Delegation and messaging

The upstream delegation tools stay REGISTERED, EXECUTABLE, and directly
bound — `subagent`, `subagent_fork`, `list_agents`, `interrupt_agent`,
`workflow`, `ralph` are ordinary `tool.*` members the model calls exactly
as the host ships them. Two names are displaced by the single
`send_message` bridge (ADR-0001): upstream `send_message` (the
parent→child downlink) and the child-scoped `report` (the child→parent
uplink) collapse into one dual-direction channel:

- `await tool.send_message({"receiver": "child", "message": ..., "subagent_id": ...})`
  delivers down through the tool layer;
- `await tool.send_message({"receiver": "parent", "message": ...})` reports
  up through the SERVICE layer (`ctx.subagents.reportFrom(...)`) — live
  continuable children only; a root agent gets a structured `UNAUTHORIZED`.

Every binding returns structured JSON; errors are a FIELD on the result,
never a host crash — a missing `ctx.subagents` service, a depth cap, an
unknown id, or an infrastructure rejection all map to an `error` string.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `maxParallelSubCalls` | `10` | Cap on one cell's overlapping sub-calls (native scheduler contract; `1` = strictly serial). |
| *(runtime keys)* | — | The runtime slice (`python`, `snapshotDir`, timeouts, caps, kernel-env knobs) is documented in the Configuration table above. |

## Tests

```sh
npm install
export DASHR_TEST_PYTHON=python3  # or an explicit supported interpreter
npm run typecheck
npm test                # vitest --run
```

The suite needs a supported Python interpreter; the runner and checkpoint serializer are supplied by Better. `DASHR_TEST_PYTHON` selects the test interpreter.

## Relationship to upstream

Structure mirrors `@deepseek-ai/dsh-agent-tool-presentation` and the Code
Mode half of `@deepseek-ai/dsh-tools` (0.1.1-rc.2), re-pointed at the
vendored `replRuntime` Service Definition. See the module docs in
`src/index.ts` for the deliberate deltas (`eval` vs `run_code`, ordinary
scoped registration, guard-based collapse, mirrored `tools/code-dispatch-log`
waterfall).
