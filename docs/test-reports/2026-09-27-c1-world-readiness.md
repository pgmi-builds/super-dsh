# C1 — World Readiness & Switch Handling: Rig Test Report (2026-09-27)

Branch `c1-world-readiness` (6 commits: 83da1e4 docs → 06e92b7 task 5). Spec: `docs/specs/world-readiness-and-switch-handling/spec.md`.
Rig: 4999 pack line (`superd-4999-test`, repo dsh 0.1.7-rc.1 build, SUPERD_TRACE=1), delivery form via `start-4999.sh`.

## Unit suite

`node --test --test-force-exit test/*.test.mjs` in `superd-hub`: **192 pass / 1 fail**.
The 1 failure is pre-existing and environmental: `spawn-world.test.mjs` requires the gitignored
fixture `.tests/profiles/ctx1-min` (removed in the 2026-09-26 farm sweep); untouched by this branch
(reproduces on master's tree state). New coverage: roster `failed` flag (3 tests),
`/api/agent-runtime` flag projection (1), toast core store/props (3), pre-flight decision + waiter (4).

## Delivery-form probes (live, per boot)

| Check | Result |
|---|---|
| Roster carries `ready`/`failed` on every row | ✅ `every row ready+failed: true` (all boots) |
| Warm-up observable: `ready:false` before boot completes | ✅ `sawNotReady=true`, flips to ready at ≈12–14 s after unit start (4 boots measured: 12.2–13.9 s; port-up ≈3–4 s) |
| `pi` row shape | ✅ `{"key":"pi","label":"Pi","path":"/pi/","machine":"local","ready":true,"failed":false}` |
| Hub sidebar row renders with `SuperdToastHost` mounted | ✅ hub leaf present, `fusion:true`, **zero `pageerror`** across runs |
| Real UI switch native→Pi (HubPage treeitem on the rc.1 build) | ✅ `activeAgent=pi` at t+4 s and stable through t+28 s; no revert toast; landing clean |
| Wait-gate live engagement (click during warm-up) | ⚠️ not captured: the rig's warm-cache warm-up (~12 s) is shorter than the browser automation's front-matter; the gate's decision matrix + waiter outcomes are unit-covered (8 tests). Worth one manual try on prod's next cold restart. |

Notes: rc.1 (rig) vs rc.2 (prod) native-sidebar shape differs — the switch surface on the rig build is
the HubPage tree row (roles `tree/treeitem`), on prod rc.2 it was the sidebar pill menu (`menuitem`); both
route through `attemptSwitch`. Probe tooling: `.scratch/pw/c1-full.mjs` (mint → roster watch → browser switch).

## Side effects / bookkeeping

- `.tests`-home rig boots only; prod 3080 untouched.
- `spawn-world.test.mjs` fixture gap logged for follow-up (regenerate `ctx1-min` or adjust the test).

## Acceptance state

Rig left RUNNING with the C1 build (auth seed persisted — existing cookies valid; mint URL in the log
tail if needed). Awaiting user first-person acceptance; version bump + publish only on explicit order.
