# Spec: World Composition Minimization (C2) — subtractive blueprint

Status: ratified 2026-09-27 (user ruling: use the Web profile as blueprint and SUBTRACT; wave-incremental — confident rows first, then probe further)
Baseline facts (measured 2026-09-27): each world composes 292 rows (≈190 distinct modules) from `dsh-base + dsh-web-app + adapter`; intrinsic warm-cache boot ≈10 s; worlds already hold zero listeners via 4 persisted disable rows (webserver/hmr/web-runtime/client-hmr) — the subtractive pattern is proven in production.

## Blueprint ruling

**Subtractive (option i)**, not a custom bundle (iii) and not headless-based (ii — `dsh-headless` is a 3-row one-shot task patch over base; "base + adds" is mechanically a custom bundle anyway). Rationale: worlds must stay shape-compatible with what the Web UI consumes (adapter translation targets the web profile's surfaces); row-restatement disables are the already-proven mechanism (T-D posture); upstream additions default ON and get triaged wave-by-wave rather than silently missed.

Wave-incremental: each wave = disable block + full rig verification; anything questionable stays for the next wave.

## Verified KEEP invariants (2026-09-27 dependency pass — do not violate)

- **Adapters inject `["agents","sessions","llm","agentDefaultModel","settings"]` + `agentPresets`** → rows `agent`, the `dsh-llm` family, `agent-default-model`, `settings`, `agent-preset-registry` STAY (all waves until adapters decouple).
- Session core (`dsh-session`) injects only `invariants` + `typert`.
- KEEP-set api controllers inject nothing from the wave-1 families: session-controller (`fileReferences`, `typert`, `attachments`), workspace-controller (`directoryPicker`, `remote`, `typert`, `workspaceRegistry`), account-controller (`deepseekAccount`), api-gateway (`typert`, `connection`, `webServer`).
- `mcpResources` has zero consumers in the farm; `jobs` service is consumed only by `api-job-controller` (dropped together).

## Wave-1 disable list (24 rows, dependency-cleared)

`agent-loop`, `mcp-resources`,
skill family: `skill`, `skill-filesystem`, `skill-badge`, `tool-skill`, `ui-skill`,
jobs family: `jobs`, `tool-jobs`, `ui-jobs`, `job-controller`,
subagent family: `subagent`, `subagent-spawn-in-process`, `subagent-fork-in-process`, `tool-subagent-control`, `tool-subagent-list-agents`, `tool-subagent`, `tool-subagent-fork`, `tool-subagent-codex`, `tool-subagent-claude-code`, `subagent-model-selection-settings`, `ui-subagent`, `ui-settings-subagent`, `ui-settings-agent-loop`.

Mechanism: one shared disable block in the per-world patch layer (`worldMountPatches`, world-mount.ts) — same channel that already persists the zero-listener posture — so every world and every recomposition carries it. Per-adapter customization remains a later patch layer on top (ruling preserved: default world composition + optional adapter-specific additions).

## Wave-2 candidates (NOT this change; require their own analysis)

`client-ui-*` family (~45 rows — biggest mass; verify no world-side module-manifest consumption by the fused page), `bash-sandbox`, `tools`, `terminal-controller`, `time-context`, `schedule`, `agent-instructions`, `session-title-llm`/`user-questions` (llm consumers on foreign sessions), `ui-agent-preset` + native preset rows (`preset-standard/ptc/minimal/cordis`).

## Verification protocol (every wave, delivery form on the rig)

1. Cold boot: `world failed` count 0; roster 7 agents; dataplane probes per agent (envelope bogus-method → typed error; `$events`/`session/control`/`session/follow`/`workspace/follow` via browser switch).
2. Per-runtime session face (alignment discipline §二.5): switch + landing + create-session + one prompt (+ resume) for all six runtimes.
3. Record boot timing (`.scratch/boot-timing.mjs` reuse) + unit RSS before/after; expect a measurable row-import reduction (wave-1 ≈24/292 rows; report the number, no target quota).
4. Rollback = remove the disable block and recompose (no code path depends on disabled rows by construction).

## Non-goals

- Adapter decoupling from `llm`/`agentDefaultModel` (separate future change).
- Any change to ctx0's composition.
- Lazy/deferred world spawn (boot pacing is orthogonal; readiness gating is C1).
