# Pi SDK physical delivery

Approved direction, 2026-10-08: produce a complete local Super Dash tarball for
installation through dev3's native Web UI Plugin Manager, served from
`/home/u1/view-dir`. No npm publication or production DSH restart/installation.

The existing in-process Pi adapter stays unchanged. Super Dash physically
bundles `@earendil-works/pi-coding-agent@0.84.2` and its complete non-optional
runtime dependency tree. Build-time npm ci uses a committed lockfile and
`--ignore-scripts --omit=dev --omit=optional`; consumers require neither build
approval configuration nor compilation. Third-party scripts and manifests
remain unmodified. The two observed hooks perform no necessary compilation:
Google's preinstall prints a no-op; protobufjs's postinstall checks versions.
WASM and upstream prebuilt TUI platform helpers are existing package assets,
not installation-time generated binaries; this is not an all-JavaScript claim.

Better Dash must still be freshly built locally, physically bundled and
archived with its exact digest. A single Super Dash installation, when enabled,
registers Better through the native coordinator; both native rows remain
independent. Native CLI reconciliation preserves disabled existing bundles;
Web UI install explicitly enables the selected bundle.

The source pin, locked Pi tree and shipped Pi manifest must agree. Missing or
changed identity fails packing. A synthetic transitive-hook fixture must
exercise the real bundling helper; final consumer installation must exercise
native Web UI inspect/installBundle without approvedBuilds, ignore-scripts or
relaxed strictDepBuilds. Validate HTTP download from dev3, exact served bytes,
native independent rows and real Pi create/prompt/resume via complete pack.

Use synchronized local test version 0.3.0-h. Published 0.3.0 is immutable.
