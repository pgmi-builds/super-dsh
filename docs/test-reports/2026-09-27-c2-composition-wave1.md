# C2 Wave-1 — World Composition Minimization: Rig Test Report (2026-09-27)

Branch `c2-composition-wave1` (from master incl. C1). Spec: `docs/specs/world-composition-minimization/spec.md`.
Rig: 4999 pack line, repo dsh 0.1.7-rc.1 build, `SUPERD_TRACE=1`.

## Composition delta (ground truth: composed `cordis.yml`, rig pi world)

- Total rows 292 → **287** (dedupe side-effects of the restatements); disabled rows 4 → **50 raw entries / 26 unique ids** (posture 4 + wave-1 22).
- **Wave-1 materialized 22/24 ids as top-level disables**; the 2 misses (`tool-subagent-codex`, `tool-subagent-claude-code`) exist only as **preset-group-nested rows** — inert without native-preset activation (foreign sessions never activate them); recorded as residual, not blocking.
- **KEEP invariants verified enabled**: `agent`, `agent-default-model`, `settings`, `agent-preset-registry` (adapters' `agents/sessions/llm/agentDefaultModel/settings/agentPresets` injects).

## Boot & runtime

| Metric | Wave-1 | Baseline (pre-C2) |
|---|---|---|
| `world failed` count | **0** | 0 |
| Port-up → all dataplanes ready | ≈11–12 s | ≈10.4 s |
| RSS (host + 6 worlds) | 370.7 MB | 371.2 MB |
| Composed-rows trace | 182 (count includes disabled rows) | 187 |

Interpretation: wave-1's rows are light (tool/preset/client-manifest class) — the win is **surface contraction** (24 fewer mounting code paths per world), not boot perf; the heavy imports (llm stack, session machinery, api controllers) are all KEEP by adapter dependency. The mass reduction lives in wave-2 (client-ui-* family ≈45 rows), spec'd for its own round.

## Six-runtime switch matrix (real UI, HubPage tree rows)

| Runtime | Switch | Return to native | Page errors |
|---|---|---|---|
| pi / claude / codex / hermes / omp / agy | **LANDED ×6** | **OK ×6** | 0 |

No failure toasts anywhere; roster flags (C1) live on every row.

## Not covered (honest)

- Per-runtime **create+prompt** face (alignment §二.5): switch+landing verified for all six; the prompt face is left for the user's first-person pass on the running rig (foreign runtimes use their native homes' credentials).
- The 2 preset-nested subagent tool rows (above).

## Rig state

Left RUNNING with the wave-1 build (`superd-4999-test`; auth seed shared — dashr's `.test/home/.credentials.yaml` now symlinks to this repo's rig seed, so the user's cookie is valid across both repos' rigs).
