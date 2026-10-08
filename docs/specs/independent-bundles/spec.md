# Independent Super Dash / Better Dash bundles

Approved 2026-10-08: install one self-contained Super Dash pack; native Installed page has independent Super Dash and Better Dash rows. dev WebMCP remains unchanged. Better's independent pack and YAML remain usable without Hub.

Super keeps the locally built Better package bundled and also carries its exact independent tarball plus a SHA256 descriptor. A package-owned delivery coordinator caches that tarball under the current harness home and invokes the official installed DSH CLI in a separate process. This registers Better as a direct profile dependency and independent selected bundle; Super stops composing Better YAML itself. No registry Better download, lifecycle install scripts, upstream changes, fake UI rows, permanent profile helper rows, or development-only dependency promotion.

The coordinator implementation belongs to Better's generic pack delivery component. Super's setup entry reuses its bundled implementation. Either active capability bundle can maintain delivery; neither active means synchronization waits until next activation. First registration selects Better; updates use native CLI reconciliation, retaining existing disabled selections. Cached archives are immutable and survive owner package removal. A removed companion is not silently reinstalled by the same owner artifact.

Native existing-package replacement requires process restart: source installation and running code are distinguished in diagnostics. Scheduling cannot escape HMR's AsyncLocalStorage; the official child CLI avoids nested HMR transactions. Disposal cancels coordination without awaiting a child competing for the manager's profile lock. Runtime package-manager/installation facts come from the real host.

Turning Better off restores native WebServer, connection, onboarding and welcome policies; deployment-specific native trusted-host configuration remains the operator's responsibility. Super remains operable under native host configuration. Turning Super off removes Hub/A2A/foreign worlds while Better's native tools remain. Reenable is repeatable and sessions persist.

Acceptance: real single-Super tarball first install, native listBundles/listPlugins and UI, each independently off/on, both off/on, cold restart, disabled Better upgrade, Super-off Better-active update, exact local archived/bundled bytes, standalone Better regression, PC4999 and dev3 target installation. Reports precede user release approval; no publish/commit/tag/push in this task.

## Repeatable toggle lifecycle

Real 4999 acceptance found stale roster/target registrations and an inherited native
HMR transaction marker after WebServer replacement. Foreign world ownership now
registers cleanup before boot, removes routing/roster synchronously, awaits the
native world fiber disposal, and prevents stale pending completion from publishing.

Better provides a native HMR subclass preserving the upstream queue, watcher and
shutdown implementation. A narrowly guarded compatibility bridge clears only the
native transaction ALS store before entering a new transaction; a scoped mutable
liveness token still rejects actual nesting. The public API exposes no context reset.
A process-wide AsyncLocalStorage snapshot was rejected because it resets Agent
initiator attribution and initiator-run lineage. The bridge performs no upstream
edits and fails explicitly if the installed native HMR no longer has this contract.
Regression acceptance covers actual HTTP callbacks, native watcher self-disposal,
queue serialization/failure, and preservation of other initiator context.
