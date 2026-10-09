# super-dsh — Super D agent hub for the DeepSeek Harness

One [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that joins local
foreign-agent runtimes into the DSH Web UI: a runtime selector in the sidebar,
a live roster, and one zero-port data world per runtime behind `/hub` —
same browser shell, same auth domain, per-world session separation.

**Owns no runtimes and stores no conversations.** Every adapter keeps its
native home and session format (`~/.omp`, `~/.codex`, `~/.claude`, `~/.pi`,
Hermes native, Antigravity SDK); the DSH session log inside each world's nested
home is an explicit duplicate (producer/bridge architecture), never a fork of
the foreign store.

## Install

```bash
dsh plugin --profile <name> add super-dsh@latest
```

That single package composes the whole line (`@pgmi-builds/superd-hub` plus the
six primary `@pgmi-builds/agent-*` packages and three OPTIONAL SDK halves).
Restart the profile after replacing a loaded package. Each foreign world's
DSH home is created under `<DSH_HOME>/agents/<label>/` on first boot.

## Better Dash delivery

Super installs [Better Dash](../better-dsh/) at runtime through the native DSH
Plugin Manager, requesting its installed Super version first, then `better-dsh@latest`, then bare
`better-dsh` after each preceding failure. The packages have no dependency edge or shared physical payload;
both retain independent native Plugin Manager rows and component switches.

First-use intent lives under `$DSH_HOME/superd/companions/`, so manual removal
remains removed across restarts and upgrades. Hub Settings offers explicit
reinstallation. Both packages ship at synchronized versions; publish Better
before Super. Pi's prebuilt SDK retains its separate bundled delivery.

Better's welcome policy uses the official client onboarding slot. Native
WebServer and HMR stay in place; listener configuration belongs to deployment.

## Runtimes

| Label | Runtime | Integration |
|---|---|---|
| OMP | OMP (`~/.omp`) | host `omp` binary over RPC (`omp --mode rpc`, NDJSON v1), lazy per session |
| Codex | Codex app-server (`~/.codex`) | CLI first, desktop core and lazy world-home fetch fallback |
| Claude | Claude Code (`~/.claude`) | standalone adapter, joined by the hub |
| Pi | pi coding agent (`~/.pi`) | in-process SDK |
| Hermes | Hermes (`~/.hermes`) | gateway child |
| Antigravity | agy SDK | Python bridge (`bridge/agy_bridge.py`) |

### Foreign-agent Hub facility

Super D sessions in Pi, OMP, and Codex can use the same `superd-hub` facility
for agent roster/status, messaging, and shell execution. Tool descriptions,
argument validation, receipts, and reply guidance come from the existing Hub.
Replies wake the initiating session automatically; do not poll for them.

Pi and OMP share one native extension. It is loaded incrementally on the first
prompt, preserving normal extension discovery and native tools. Its per-session
wrapper lives under the Super D world home (`hub-extensions`, mode 0600), with a
session capability for a loopback-only HTTP listener. No global extension is
installed in `~/.pi` or `~/.omp`. Some OMP versions present registered extension
tools as devices: read `xd://superd-hub` for instructions and write action JSON
to that device.

Codex uses the official experimental app-server `dynamicTools` interface on
new threads. Callbacks bind to that thread and the Super D session; existing
native tools/plugins remain available. No global plugin is installed in
`~/.codex`. Resuming a thread created through this integration restores its
saved tool definition. Older threads without that definition need a new
Super D conversation to gain the facility. A native Codex client resuming one
of these threads does not supply Super D's callback host.

Pi/OMP extension closures cannot transparently renew an already-loaded listener
capability when the Hub row is unmounted/remounted. Restart Super D and resume
the conversation after that operation; the tool reports this recovery path
when its connection becomes unavailable. Whole-app restart/resume is tested.

Draft creation and passive history viewing create no extension file, listener,
or agent process. Closing a session invalidates its capability. Interrupted
tool operations retain conservative upstream recovery guidance about unknown
outcomes rather than encouraging blind retries.

### Codex in 0.1.11

Codex discovers the local OpenAI OAuth login as a read-only provider in the
model selector. Selecting it explicitly overrides a third-party provider in the
native config, while credentials and native configuration stay in the native
home. Third-party providers remain selectable per session.

The adapter prefers the installed desktop core, then the CLI, then the bundled
0.160.0 core (`CODEX_BIN` overrides discovery). Desktop host browser and computer
use services are separate and are not attached by this adapter.

**Provider compatibility:** each provider defines its own message, reasoning,
and encrypted-state formats. Selecting another provider does not guarantee
that it can consume the existing session history. Successful continuation
across endpoints is an observed convenience, not an adapter guarantee.
The adapter surfaces provider errors; if the selected provider rejects the
history, start a new session with that provider.

### Opt-in SDK halves

Three runtimes also ship a preserved in-process SDK transport beside the primary
line: `agent-omp-sdk`, `agent-agy-sdk` and `agent-codex-sdk`. Each is a complete
standalone copy of its adapter with an injectable transport, and each

- is **`disabled: true`** in this package's composite patch — turning the row on
  IS the switch (`plugin-presence IS the roster`), and it runs under its own
  world key (`omp-sdk` / `agy-sdk` / `codex-sdk`) so it can sit beside the
  primary row without a duplicate-key error;
- declares **no dependency at all** — not a dependency, not an optional, not a
  peer — so `dsh plugin add super-dsh` installs and downloads nothing for it,
  and ships no postinstall;
- supports the same multi-provider surface as its primary line (the Codex halves
  share one provider store implementation, one native-config reader, one route
  resolver and one `codexProviders` panel; only the launch encoding differs —
  argv for the app-server child, a config object for the SDK);
- fetches its own durable runtime into `<DSH_HOME>/agents/<key>/` on the FIRST
  real prompt (bun + the coding-agent tree for OMP, a Python venv for agy, the
  `@openai/codex-sdk` tree for Codex), where it survives restarts and upgrades.
  Pre-warm with `npm run fetch-sdk-runtime` in the package.

## Design

- **S1** selector handoff is one hop; the dispatcher never addresses sessions.
- **S2** activation is roster membership; worlds spawn as sibling roots
  (`boot()` on the CTX0 tree), never through `runProfile()`.
- **S3/S7** `<DSH_HOME>/agents/<runtime>/` is that runtime's whole world; native
  app data stays in the native home; one-way valve — never read back.
- **S4** worlds own no port; delegation is in-process (zero-byte proxying).
- **S6** the router is dumb: consumer switching + new-session generator only.

Full topology: the `superd` monorepo (`github.com/pgmi-builds/superd`),
`super-dsh/AGENTS.md` + `docs/00-blueprint.md` (v0.4a) + ADR 0001–0007.
