# Complete Pi bundle: native Plugin Manager URL installation

Date: 2026-10-08, Asia/Hong_Kong. Local test version **0.3.0-h**; no registry publication, commit, tag or push.

## Result and artifact

Complete Super Dash tarball at `/home/u1/view-dir/super-dsh-0.3.0-h.tgz`:

`https://view.pc.internal.test/super-dsh-0.3.0-h.tgz`

- Size: 31,430,212 bytes; npm reports approximately 129.5 MB unpacked.
- SHA256: `391ccde9af29f7da548817e097b4d7f04d6901e9e60045f80eb75d6ffdf63505`.
- Local Better tarball SHA256: `1633446cdbbba49c88309039efaf9d920575f4458378941cc5627d390efcd67f`.
- The outer package contains the exact Better archive and 748 byte-matching expanded Better files.

dev3 downloaded this HTTPS URL successfully. Its downloaded digest matched the
build and served file. Existing Caddy configuration was read, not modified.

## Product change

Pi's complete prebuilt non-optional SDK dependency closure is now physically
bundled. The build consumes a committed npm lockfile for SDK 0.84.2, uses npm ci
with scripts disabled, and nests the hoisted closure under the SDK so imports
cannot depend on development-only resolution. Adapter transport and Pi native
home behavior remain unchanged. No third-party source or manifest was edited.

`@google/genai@1.52.0` and `protobufjs@7.6.6`, their built runtimes and original
hook declarations/files are present in the archive. Consumers do not install
these as separate unapproved script-bearing packages. Existing WASM and TUI
prebuilt platform helpers are package assets; this is not a claim that the
entire Pi SDK consists solely of JavaScript.

The launcher now uses current pnpm and its default script policy/store, removing
the former Corepack pnpm 10 pin, strictDepBuilds relaxation and custom store.
No consumer build-policy configuration was added.

## dev3 native Web UI service path

On the isolated existing 4998 complete-pack test line (PC tunnel 4996), invoked
the actual HTTP RPC methods used by the native Web UI:

1. `pluginManager/inspect` with the exact HTTPS URL: accepted, kind `tarball`, host `view.pc.internal.test`.
2. `pluginManager/installBundle` with that URL and a request id: pnpm 12.10.1 exited **0**, bundle `super-dsh`, no pendingBuilds or approvedBuilds. No ignore-scripts or strict-policy relaxation was passed to this parent install.
3. Native manager returned `application: restart-required`, appropriate for replacing a loaded bundle. Restarted **only** `superd-4998-test` to validate cold code.
4. Better's existing coordinator registered the exact archived Better package as a direct dependency. Native listBundles reported Super Dash and Better Dash **0.3.0-h**, separately enabled; dev WebMCP remained separate.

The profile workspace contained only packages, nodeLinker and autoInstallPeers;
no allowBuilds/ignoredBuiltDependencies/strictDepBuilds relaxation. Evidence:
`.scratch/independent/pi-dev3-native-url-install-h.json` and native operation log
`.tests/foreign-substrate/profiles/superd-pub/.plugin-manager/logs/operation-dvNPLu/pnpm.log` on dev3.

Browser automation surfaces were unavailable (`apps: [], browsers: []`). This
acceptance exercised the real native Web UI service, not a screenshot or a
claim of an automated click-through. User production UI installation remains
the requested next acceptance step.

## Follow-up: tarball URL used as registry

The user subsequently reported `ERR_PNPM_FETCH_400`, requesting
`https://view.pc.internal.test/super-dsh-0.3.0-h.tgz/@modelcontextprotocol%2Fsdk`.
This is a dependency metadata lookup under a tarball URL, rather than the
tarball download itself. The h pack still resolves MCP and zod from npm; the
physically bundled closure described above is Better and Pi.

Read-only checks on dev3 found the profile's effective pnpm registry remained
`https://registry.npmjs.org/`, no registry override in its native manager row,
and no npm/pnpm registry environment override in the production DSH process.
Installed manager and client packages are both 0.2.0-rc.2. Their native client
passes the selected registry separately from the package spec, and remembers
that selection across dialogs/page loads as
`dsh.plugin-manager.install-registry`. The selected value in the user's
browser was not directly inspected; the exact input field used remains
unconfirmed.

Two fresh isolated dev3 fixtures under
`.scratch/registry-url-repro-h/{wrong,official}` used the same HTTPS tarball,
pnpm 12.10.1, hoisted linking and disabled automatic peer installation, with
no consumer build approval or relaxed script policy:

- Passing the tarball URL as `--registry` reproduced the user's exact MCP
  `ERR_PNPM_FETCH_400`; exit 1, Super not installed.
- Passing `https://registry.npmjs.org/` as `--registry` succeeded; exit 0,
  `super-dsh@0.3.0-h` installed, 94 packages, no script-approval request.

An earlier wrong-registry probe against the already installed native test
profile skipped dependency resolution because its lockfile was current;
the native manager returned `ambiguous-install` and restored the profile.
It was not counted as a reproduction. Both native test bundles remained
selected and their package specs intact after that probe.

For user UI acceptance, enter the HTTPS tarball in the main Add plugin input;
select the official npm registry in the separate registry selector. A
remembered Custom registry must be changed even if its panel is collapsed.
This diagnosis does not change product code or the immutable h artifact,
and does not claim the user's production UI installation has completed.
No production profile write, service restart, Caddy change or publication
was performed.

## User acceptance and release follow-up

The user confirmed the corrected production Web UI install worked, then
authorized production removal and `0.3.0-a` GitHub/npm finalization.
The [release report](2026-10-08-030-a-release.md) records the final pair,
fresh tests/consumer sessions, preserved history and publication receipts.
The final pack's runtime files are byte-identical to this accepted h artifact.

## Runtime behavior

PC 4999 consumed the complete locally built pair through the standard launcher
with pnpm 12.10.1 default policy. Both machines showed seven ready worlds, no
failed plugin entries, unique browser module ids, and separate active Super /
Better native bundle rows.

Pi behavior was verified through the full pack, not standalone adapter rigs:

- PC session `session-5746a670-14c4-4c6e-b849-3dda8e2bca05`: real create/prompt, then service cold restart and resume of the same session.
- dev3 session `session-10954ba9-e49d-4155-b132-8d227ace77d3`: same sequence after the native HTTPS install.
- Both persisted V4 JSONL logs have completed turn 2 and the expected remembered phrase `BUNDLE-pi-42`; no error end state.

Evidence: `.scratch/pi-sdk-h/pi-pc-h-turn2-evidence.json`; dev3
`.scratch/pi-dev3-h-turn2-evidence.json`. Live review line remains
`https://test.pc.internal.test/`; target test tunnel remains PC port 4996.

Tests: root suite 27/27, Pi adapter 58/58, targeted physical bundle/contracts
5/5, targeted pack/version/pair checks 5/5. The physical dependency fixture
contains a hook that throws if executed and successfully installs under
strictDepBuilds true. New contracts were observed failing before implementation.
LSP definitions/references and TypeScript compiler AST call inspection were used
before changing the orchestrator.

## Production observation and boundary

Read-only inspection found production `web` profile directly depending on
Super Dash 0.3.0, with Super absent from its selected bundles and Better absent
from direct dependencies. An inactive Super coordinator cannot register Better.
The upstream CLI deliberately preserves inactive existing dependencies during
reconciliation; the native Web UI installation explicitly selects the bundle.
The origin of the production profile's retained inactive state was not inferred.

Production `dsh.service` stayed active at PID **542116** throughout. Production
profile files, port 3080/3081, credentials and live Caddy configuration were not
changed. Installation and any production restart are left to the user.
