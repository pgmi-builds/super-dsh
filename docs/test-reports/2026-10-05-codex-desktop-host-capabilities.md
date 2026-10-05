# Codex desktop capabilities: core versus host services

2026-10-05, Asia/Hong_Kong. Read-only investigation for the desktop-first adapter design. This report is scratch evidence, not product acceptance. No app-server, daemon, helper, MCP server, live desktop tool pipe, browser action, or authentication flow was started. No config/auth file was opened or changed in this investigation. Packaged resources were read statically; existing sanitized probe reports supplied runtime evidence.

## Finding

The desktop core and npm CLI can be the identical Rust executable. The existing binary/identity probe proves that the local desktop 0.160.0 and DEV3 npm 0.160.0 core hashes match, and that the desktop core generates SOL using Super D's own client identity with a clean environment. That result does not require impersonating the desktop.

Given the same core executable, effective argv, working directory, home/config, environment, protocol inputs, and accessible external resources/services, there is no remaining separate “desktop core” implementation to explain different core behavior. “Same binary + args/home/env” alone is incomplete: desktop supplies RPC capabilities, per-thread config, plugins, subprocesses, browsers, and tool hosts after launch. Selecting its binary gives the adapter its core version; it does not instantiate those surrounding services.

Evidence reused: `docs/test-reports/2026-10-05-codex-native-default-probe.md` and `docs/test-reports/2026-10-05-codex-binary-client-identity-probe.md`. These already distinguish version from identity and describe shared model-cache writes. The 0.154.0 failure/0.160.0 SOL success is an observed pair, not proof that 0.160.0 is SOL's first supported version.

## Default desktop core launch

In extracted `application-network-startup-ouXbhtc5.js`:

- Offset 252711: default extra argv `-c features.code_mode_host=true`.
- Offset 265134: default full command has `app-server --analytics-default-enabled`; optional desktop env base-URL overrides become config argv. Analytics is a desktop policy choice, not evidence of an inference requirement.
- Offset 261363: spawn environment inherits the parent, sets `LOG_FORMAT=json`, `RUST_LOG` default `warn`, and `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` default `Codex Desktop`; sets `CODEX_CLI_PATH` for the local resolved executable and `CODEX_MCP_NODE_PATH` for bundled Node; updates PATH for native/runtime helpers, Git and rg. These are actual launch differences. Own client identity should remain Super D's identity.
- Offset 259580: stdio is the normal local route. Optional local-daemon use is gated by `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`, absence of certain overrides, and a daemon version check; `CODEX_APP_SERVER_FORCE_CLI=1` suppresses the daemon path. The resolver need not attach to that daemon.

In extracted `bootstrap-D3_zvIvQ.js`, offset 1317120, desktop initialize declares `experimentalApi=true`, extensions, optional MCP form support, optional attestation support, and notification opt-outs; local host uses explicit gateway OAuth. These are independent of `clientInfo.name/title/version`. Do not copy attestation or gateway claims unless the client actually implements them. Generated `InitializeCapabilities.ts` confirms these fields and has no standard “desktop=true” switch.

## Code mode is a core helper, available outside desktop

Packaged files include `/usr/lib/chatgpt/resources/codex-code-mode-host`, a separate executable from both `/usr/lib/chatgpt/resources/codex` and `cua_node/bin/node_repl`.

Official source describes a process-scoped local code-mode host, or a remote HTTP/2 gRPC host selected by `--code-mode-host URL`. The protobuf service maintains JavaScript sessions and routes nested tool calls back to their owner. This is distinct from desktop app tools and browser REPL MCP transport. Current source warns that direct-tool mode can fall back, while code-mode/code-mode-only execution can fail closed if unavailable. A binary resolver should preserve the original executable/package location and companion resources, rather than copying only the core into an unrelated directory.

Sources: [app-server host selection](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/code_mode_host.rs), [code-mode service protocol](https://github.com/openai/codex/blob/main/codex-rs/code-mode-protocol/src/grpc/codex.code_mode.v1.proto), [core availability behavior](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/code_mode/mod.rs), [official package layout](https://github.com/openai/codex/blob/main/scripts/codex_package/README.md). These `main` sources explain architecture, not a byte-for-byte audit of installed 0.160.0 internals. No helper was executed.

## Desktop app tools require a desktop-owned service

`desktop-main.js` offset 3704470 creates a native app-tools pipe before clients start, generating a fresh verification identity and exporting `CODEX_APP_TOOLS_PIPE_PATH` and task-workspace verification env. At offset 301002 its host starts a framed RPC service, uses socket peer authorization and Unix permissions 0600, and holds pending calls. The desktop message handler supplies actual tool implementations and catalog.

Offset 178369: missing `CODEX_APP_TOOLS_PIPE_PATH`, bundled plugin, definition, or runtime causes `Codex app tools unavailable for this Core launch`; the MCP entry is disabled. The packaged definition is `plugins/openai-bundled/plugins/codex-app-tools/.mcp.json`, launching `scripts/launch_codex_app_tools_mcp` + `server.mjs`; it is disabled in the packaged baseline. Desktop enables it using plugin or legacy MCP config overrides. A mere env name is insufficient without a working host.

Static packaged `codex-app-tools/server.mjs`, lines 24773–25165:

- Standard MCP runs over stdio between core and plugin server.
- Plugin server forwards `tools/list`, `tools/call`, `tools/cancel` to the desktop pipe; framing is 4-byte little-endian payload length plus JSON UTF-8, maximum 8 MiB.
- Calls carry namespace, tool, arguments, threadId, turnId, callId, callerSource and optional hostId. Executor thread metadata is required; it is not an anonymous generic RPC proxy.
- Desktop host additionally handles signed `browser/access` and `taskWorkspace/prepare` responses. These bind permission/workspace answers to the request and generated verification identity.
- MCP results map the desktop host's `contentItems` and success into MCP content/error fields.

The generated app-server protocol has `item/tool/call` and dynamic tool result types, but that transports a request; client/host execution remains necessary. Browser settings, artifact opening, task management and similar native app tools are implemented by the desktop process. This investigation neither connected to the pipe nor established a supported way to reuse it from Super D.

## Browser and computer use require additional runtimes and hosts

Packaged runtime manifest: `/usr/lib/chatgpt/resources/cua_node/manifest.json` declares Linux x64 runtime 0.0.27, Node `24.21.0-cua.1`, `bin/node`, `bin/node_repl`, `lib/node_modules`. Packages include `@oai/browser-desktop`, `@oai/cua-repl`, `@oai/sky`; browser-service scripts are bundled with browser/chrome plugins.

`desktop-main.js` offsets 85033 and 166075–170300 resolve browser Node and REPL paths (optional `CODEX_BROWSER_USE_NODE_PATH` / `CODEX_NODE_REPL_PATH`), choose browser backends `iab`, `chrome`, `mcpapps`, check enabled/available plugins and feature policy, and construct thread-local `mcp_servers.node_repl` config. Shared packaged `src-ZHMZMKol.js` offsets 6668–8100 supplies concrete REPL env:

- `NODE_REPL_NODE_PATH`, `NODE_REPL_NODE_MODULE_DIRS`, `NODE_REPL_TRUSTED_CODE_PATHS`, `CODEX_HOME`, and core path for sandbox execution.
- `NODE_REPL_TRUSTED_SERVICES` maps browser to installed browser-service and, when enabled, sky to `@oai/sky/service`.
- Browser-specific instructions/backends, optional model checks, browser auth broker and access policy are separate inputs.
- Native computer service env includes `SKY_CUA_SERVICE_PATH`, `SKY_CUA_SERVICE_NATIVE_PIPE_PATH`, or Windows `SKY_CUA_NATIVE_PIPE` / `SKY_CUA_NATIVE_PIPE_DIRECTORY`; macOS also uses `NODE_REPL_HOST_SERVICES_PIPE_PATH`.

The unified computer-use plugin baseline `.mcp.json` has disabled `cua_repl`; its launcher requires absolute `CUA_REPL_NODE_REPL_PATH`, `CUA_REPL_ENABLED_SURFACES`, and configures browser/sky trusted services plus tool instructions. Desktop chooses and injects its real launch/runtime configuration.

Native computer surfaces are platform and service dependent: inspected desktop selection allows macOS computer surfaces after plugin/service checks; Windows has native-helper readiness checks. This Linux package's presence of portable helper sources does not establish working native Linux computer use. Browser capability is independently configured. OS permissions, viewer lifecycle, browser sessions and user/account feature policy are material external state, not implied by the core's hash.

## Version and protocol risk

The packaged application-network launcher has minimum app-server `0.141.0`, with `0.0.0` as development bypass. This is its desktop connection floor, not Super D's supported-version contract. The packaged shared module also has a separate `0.142.0` baseline check and explicit feature gates, including:

| Capability | Packaged threshold |
| --- | --- |
| MCP app-context metadata | 0.142.0-alpha.3 |
| MCP tool exposure (checked before unified browser setup) | 0.147.0 |
| Plugin MCP config overrides | 0.151.0-alpha.1 |
| MCP OAuth refresh coordination | 0.154.0-alpha.1 |
| Gateway OAuth | 0.157.0-alpha.11 |
| MCP status by name | 0.159.0-alpha.11 |

Evidence: `src-ZHMZMKol.js` within read-only `app.asar`, offsets 38800–42100; `desktop-main.js` unified setup predicate offset 151643. These capability-specific gates explain why one generic version floor does not promise every desktop feature.

Official app-server docs say schemas are generated for the exact binary version and experimental fields require negotiated opt-in. Generated desktop protocol inspected here supports `approvalsReviewer`, sandbox fields, experimental capabilities and bidirectional requests. Required create/turn/resume, approval, cancellation and tool-notification paths must be exercised on each selected version. Prior success with one no-tool ephemeral generation proves model access, not all adapter protocol paths. There is no discovered universal upper-version guarantee or official Super D minimum.

Sources: [app-server protocol and schema generation](https://learn.chatgpt.com/docs/app-server), [client identity attribution](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server). The latter describes a different OAuth integration route; it is not permission to replace native auth or reuse desktop identity. Its preview limitations also distinguish local tools from hosted Responses tools: [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Historical claim verified narrowly

The official Codex repository's maintainer cutover announcement identifies the earlier TypeScript implementation and the first official Rust-powered release (`rust-v0.2.0`, July 2025). The current official npm entry source resolves a platform-native executable and forwards argv, stdio and signals. Therefore an npm Node entry today is packaging/launcher evidence, not evidence the core still runs in TypeScript. Desktop Electron adds host/UI infrastructure around the Rust app-server; the inspected binaries can still be identical.

Sources: [official Rust cutover](https://github.com/openai/codex/discussions/1266), [official npm launcher](https://github.com/openai/codex/blob/main/codex-cli/bin/codex.js). No broader Claude/Gemini implementation-history analogy was investigated or asserted.

## Design implication and limits

Desktop-first native-core resolution is supported by local evidence, with CLI fallback useful for headless or missing-desktop machines. Preserve Super D client identity; obtain model catalogs from the selected core. Preserve companion executable/resources when code mode is desired. Desktop tool inheritance is a separate integration task requiring host/plugin/protocol/permission support; importing live pipe env opportunistically cannot be claimed as desktop capability parity.

Unproven here: live desktop pipe reuse, complete browser/OS helper handshake, tool operation under Super D's own identity, model-access delta's exact Rust/API cause, version-wide compatibility, and delivery-form acceptance. No product source changes were made by this investigation.
