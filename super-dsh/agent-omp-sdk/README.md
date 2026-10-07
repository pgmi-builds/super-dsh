# @pgmi-builds/agent-omp-sdk — OMP (SDK) adapter (opt-in)

The **second** OMP adapter package, alongside `@pgmi-builds/agent-omp` (the RPC
line). It is a complete, standalone copy of the pre-RPC-era OMP bridge — no
shared code with the RPC package.

- **World key** `omp-sdk`, roster label `OMP (SDK)`, world home
  `<dshHome>/agents/omp-sdk` (deliberately not `agents/omp`).
- **Off by default**: the `agent-omp-sdk` row in the super-dsh composite carries
  `disabled: true`, so while the row is off not one byte of this package is
  imported and nothing is fetched. Turning the row on (plugin manager
  `setPluginEnabled` / `dsh plugin`) IS the switch — no env var, no config key.
- **Why it exists**: the RPC shape is one `omp` child per Dash session
  (~240 MB private each). This shape hosts **N sessions in one bun sidecar**
  and shares `authStorage` / `modelRegistry` across them, so the marginal cost
  per extra session is far lower.

## No dependency is declared, and nothing is fetched at install time

`package.json` declares an **empty `dependencies`** — no coding-agent package,
no `bun`, no `optionalDependencies`, no `postinstall`. `dsh plugin add` only
unpacks this package; `npm pack` contains no SDK bytes (only our own
`sidecar/main.ts` source, which imports the package *inside the fetched
runtime*).

The durable runtime is fetched **lazily**, on the first real prompt of an
`omp-sdk` session (draft / browse / passive queries stay at zero action, the
same zero-spawn window the RPC line holds):

```
<worldHome>/sdk-runtime/
  bin/bun                        bun release (linux-x64) unzipped into place
  package.json / node_modules/   the pinned coding-agent package, installed with that bun
  sidecar/main.ts                this package's sidecar (bun resolves node_modules from here)
  dist/protocol.js               the compiled protocol module the sidecar imports
<worldHome>/sdk-runtime.json     marker: {pluginVersion, packageVersion, bunVersion, bunPath, installedAt}
<worldHome>/sdk-runtime.lock     atomic (mkdir) bootstrap lock
<worldHome>/sdk-runtime.error.log  written only by a failed fetch
```

The marker is written **last**; a marker whose identity (`pluginVersion`,
`packageVersion`, `bunVersion`) does not match the running adapter is treated as
absent and refetched. The install is deliberately **slim**: `bun add --exact
--ignore-scripts --omit=optional @oh-my-pi/pi-coding-agent@<pin>
@oh-my-pi/pi-natives-<platform>@<pin>` — `--ignore-scripts` blocks package build
scripts, `--omit=optional` drops the ~234 MB `@huggingface/transformers` +
`onnxruntime-*` weight whose native postinstall is blocked anyway, and the
platform binding package is re-added explicitly because `@oh-my-pi/pi-natives`
needs it to load (`OMP_SDK_KEEP_OPTIONAL=1` reinstates the full tree). After the
install the fetcher copies the sidecar and the compiled protocol module in, then
runs a **post-install smoke import** (`<bun> -e 'await import("@oh-my-pi/pi-coding-agent")'`,
agent dir redirected inside the runtime tree) and only then writes the marker —
a pin that cannot be imported (18.4.9 is such a pin) fails loud here instead of
at the first prompt.

A failed fetch writes the error log and throws a single actionable error naming
`OMP_SDK_PACKAGE_VERSION`; it never degrades silently into a confusing sidecar
crash, and it never falls back to the RPC line (that is another row the user did
not enable).

## Wiring (where the fetch is triggered, and where it is not)

- `world-plugin.ts` mounts the world and prints ONE report-only diagnostic when
  the runtime is not on disk yet. It never fetches, spawns or imports the
  runtime.
- `index.ts` (`OmpProvider`) builds its transport in the constructor — that
  builds a pool object, nothing else.
- `transport.ts` / `lazy-rpc.ts` (`LazyOmpRpc`) construct per-session wrappers
  with **zero** side effects; a new-chat draft leaves nothing server-side.
- `sidecar-client.ts` (`OmpSdkSidecar#start`) is the ONE place `ensureSdkRuntime`
  is awaited. `start()` is reached only from `LazyOmpRpc#ensure()`, i.e. from the
  first `prompt` / `followUp` / `steer` / `ensureStarted`.
- `sdk-client.ts` (`createOmpSdkSidecarPool`) holds the refcounted singleton:
  two sessions of one dsh process share one bun child, and the pool releases
  (and stops) it when the last client closes.

## Manual warm-up

```sh
node scripts/fetch-sdk-runtime.mjs <dsh-home>      # world home = <dsh-home>/agents/omp-sdk
# or, with the home in the environment:
DSH_HOME=<dsh-home> npm run fetch-sdk-runtime
```

The script is a dev/test tool: it refuses any home outside this repository's
`.tests` tree (the launcher red line) and has no `~/.dsh` default. It shares
`createSdkRuntimeDeps` with the adapter's first-prompt fetch, so the two paths
cannot drift.

Pins: `OMP_SDK_PACKAGE_VERSION` (default `18.5.0` — do not use 18.4.9, whose
source-level import is broken; `18.2.11` is the last known-good fallback) and
`OMP_SDK_BUN_VERSION` (default `1.4.2`).

## Build & test

```sh
npm run build     # tsc -p tsconfig.json
npm test          # node --test test/*.test.mjs  (imports dist/, zero network, zero real bun)
```

The suite is fakes-only: the runtime bootstrap is driven through its injected
`SdkRuntimeDeps`, and the sidecar spawn path through an injected `runtimeFetch`.
No test downloads, spawns bun or touches a real home.
