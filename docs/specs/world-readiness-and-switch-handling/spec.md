# Spec: World Readiness State & Switch Handling (C1)

Status: ratified 2026-09-27 (user approved decomposition C1-first; design from the 2026-09-27 diagnosis session)
Upstream context: prod 0.1.5-a switch failures diagnosed 2026-09-27 — roster lists worlds before boot completes, `/api/agent-runtime` exposes no readiness, the switch machine reverts at 10 s with a misleading "no response", and the revert toast is a self-owned dark div off the platform's design language.

## Problem

1. `world-join.ts` registers the host mount BEFORE `await spawnWorld(...)` resolves; `agentLinks()` filters on mount ownership only. The roster therefore advertises a world while it is still composing (six worlds × 292 rows in-process).
2. The roster's `ready` flag (`roster.ts`, flipped by `setReady` after spawn resolves) is invisible to clients — `/api/agent-runtime` rows carry only key/label/path/machine.
3. A world whose spawn REJECTED stays mounted + not-ready forever (`world-join` catch only console.errors) — indistinguishable from "still starting".
4. `client/switch.ts#showToast` is a self-owned fixed dark div at `bottom:64px` — not the platform toast design, easy to miss.

## Decisions

1. **Roster carries failure state**: `roster.ts` entries gain `failed: boolean` + `setFailed(key, failed)` mirroring `setReady`. `world-join`'s catch calls `setFailed(key, true)` (mount stays for diagnosis; `ready` stays false).
2. **Projection exposes readiness**: `AgentLink` gains `ready: boolean` and `failed: boolean` (sourced from `listAgents()`); `/api/agent-runtime` rows carry both. `available` keeps its current mount-based meaning (addressability) — consumers gate on the row flags, not on `available`.
3. **Toast rides the official primitive**: new `superd-hub/src/client/toast.ts` renders the upstream `Toast` from `@deepseek-ai/dsh-client-ui-primitives` (top-center banner, dark surface in both themes, warn-orange icon seat, green `tone="success"`) via `react-dom/client` `createRoot` into a detached container; exports `showSuperdToast(text, opts?)`. Failure toasts hold ~6000 ms (primitive docblock guidance). Replaces `showToast` in `client/switch.ts` (revert feedback + default-workspace failure).
4. **Switch pre-flight gate (client)**: `attemptSwitch(label)` consults the roster row before running the machine:
   - `row.ready === true` → run the machine unchanged;
   - `row.failed` → toast "启动失败" feedback, no switch;
   - `row.ready === false` → do NOT swap the UI; toast "starting" feedback; poll the roster every ~1 s (bounded 120 s); on ready → run the machine; on bound expiry → failure toast; a new `attemptSwitch` supersedes a pending wait;
   - `native` / unknown → unchanged behavior.
   The gate lives in the client binding (`client/switch.ts`); `switch-core.ts` stays a pure orchestration machine over an established plane.
5. **No server-side selection anywhere** (existing invariant): readiness is information, not a switch.

## Non-goals

- Making worlds boot faster (that is C2 — composition minimization).
- Changing `SWITCH_FALLBACK_MS` (10 s stays; post-ready stalls keep its meaning).
- Roster push/subscription (polling during the bounded wait window is sufficient and matches the existing probe pattern).

## Acceptance

- Unit: roster `failed` transitions; `/api/agent-runtime` rows carry `ready`/`failed`; toast module mounts the official primitive (decision logic tested pure); `attemptSwitch` gating matrix (ready → machine; failed → toast, no machine; not-ready → wait → ready → machine; not-ready → timeout → failure toast; supersede cancels wait).
- Rig (delivery form): restart line → switch to a foreign agent during warm-up → "starting" feedback → auto-lands when ready; steady-state switch unchanged; revert path (stopped world) shows the official toast.
