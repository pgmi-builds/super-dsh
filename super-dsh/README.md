# super-dsh — Super D agent hub for the DeepSeek Harness

One [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that joins local
foreign-agent runtimes into the DSH Web UI: a runtime selector in the sidebar,
a live roster, and one zero-port world per runtime mounted under `/<label>` —
same browser shell, same auth domain, per-world session separation.

**Owns no runtimes and stores no conversations.** Every adapter keeps its
native home and session format (`~/.omp`, `~/.codex`, `~/.claude`, `~/.pi`,
Hermes native, Antigravity SDK); the DSH session log inside each world's nested
home is an explicit duplicate (producer/bridge architecture), never a fork of
the foreign store.

## Install

```bash
dsh plugin --profile <name> add super-dsh@0.1.0
```

That single package composes the whole line (`@pgmi-builds/superd-hub` plus the
six primary `@pgmi-builds/agent-*` packages and three OPTIONAL SDK halves).
Restart the profile and the
home under `<DSH_HOME>/agents/<label>/` on first boot.

## Runtimes

| Label | Runtime | Integration |
|---|---|---|
| OMP | OMP (`~/.omp`) | host `omp` binary over RPC (`omp --mode rpc`, NDJSON v1), lazy per session |
| Codex | Codex CLI (`~/.codex`) | adapter world plugin |
| Claude | Claude Code (`~/.claude`) | standalone adapter, joined by the hub |
| Pi | pi coding agent (`~/.pi`) | in-process SDK |
| Hermes | Hermes (`~/.hermes`) | gateway child |
| Antigravity | agy SDK | Python bridge (`bridge/agy_bridge.py`) |

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
