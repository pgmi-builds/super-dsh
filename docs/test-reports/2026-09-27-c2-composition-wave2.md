# C2 Wave-2 — Client-Lane Strip (native-ui-only completion): Rig Test Report (2026-09-27)

Branch `c2-composition-wave1` (wave-2 stacked). Spec: `docs/specs/world-composition-minimization/spec.md`.

## The mid-flight defect and its fix

First wave-2 cut disabled `modules` outright → **`omp world failed: 1 required plugin did not activate (modules)`** — the row's activation work fails in world trees ("client bundles not found"), and the omp fiber counts it required. The pre-wave-2 `{ id: 'modules', inject: ['webServer'] }` restatement was load-bearing PARKING, not decoration. Fix: park it again (46 rows remain disabled).

## Composition delta (composed `cordis.yml`, rig pi world)

| Metric | Wave-2 | Wave-1 | Baseline |
|---|---|---|---|
| Total rows | 182 | 287 | 292 |
| Disabled | 93 | 50 | 4 |
| **Enabled** | **89** | 237 | 288 |
| Client-lane enabled | exactly 1 (`connection`, gateway inject) | 47 | 47 |

`modules` parked on the never-provided `webServer` ✓; KEEP invariants (`agent`/llm family/`agent-default-model`/`settings`/`agent-preset-registry`) enabled ✓.

## Boot & runtime

`world failed` **0**; all six dataplanes ready ≈11.4 s post-port; RSS ≈380.8 MB (±10 MB noise vs baselines — the stripped rows were module-table registrations, not heavy imports). Six-runtime UI matrix: **all LANDED ×6, clean native returns ×6, zero pageerror, no toasts**.

## Rig state

Left RUNNING with wave-2 build. Prompt-face per runtime still the user's first-person item.
