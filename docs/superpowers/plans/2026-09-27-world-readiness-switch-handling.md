# World Readiness & Switch Handling (C1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roster exposes world readiness/failure; the client gates switching on it with official-Toast feedback, eliminating the misleading "no response" revert during world warm-up.

**Architecture:** Server adds a `failed` flag beside the existing `ready` flag and projects both through `/api/agent-runtime`; the client's `attemptSwitch` gains a pre-flight gate (wait-while-starting, bounded 120 s) and all feedback rides the upstream `Toast` primitive instead of the self-owned dark div. `switch-core.ts` (the orchestration machine) is untouched.

**Tech Stack:** TypeScript (cordis plugin, superd-hub), React via `CLIENT_EXTERNALS` (`react`, `react-dom/client`, `@deepseek-ai/dsh-client-ui-primitives`), `node --test`.

**Spec:** `docs/specs/world-readiness-and-switch-handling/spec.md`

## Global Constraints

- Upstream source zero-modification; all changes in `super-dsh/superd-hub` (+ client bundle rebuild).
- Build entry is `node super-dsh/scripts/pack.mjs` — never hand-roll dist.
- Unit tests: `node --test test/*.test.mjs` from `super-dsh/superd-hub` (import from `../dist/index.js`; build first).
- Client half type-checks under `tsconfig.client.json`; the client bundle purity gate forbids value imports of `@deepseek-ai/*` not listed in `CLIENT_EXTERNALS` (verify `@deepseek-ai/dsh-client-ui-primitives` is listed in `superd-hub/scripts/build-client.mjs` before Task 4 — `HubPanelIcon.tsx` already value-imports `Menu`, so it must be).
- No version bump in this change (letter suffix comes at release time per repo discipline).
- Worktree: `.worktrees/c1-world-readiness`, branch `c1-world-readiness`.

---

### Task 1: Roster `failed` flag

**Files:**
- Modify: `super-dsh/superd-hub/src/roster.ts` (RosterEntry + setFailed)
- Modify: `super-dsh/superd-hub/src/index.ts` (export setFailed)
- Test: `super-dsh/superd-hub/test/roster.test.mjs`

**Interfaces:**
- Produces: `RosterEntry { key: string; label: string; ready: boolean; failed?: boolean }`; `setFailed(key: string, failed: boolean): void` (throws `roster: unknown agent ${key}`); `listAgents()` copies carry `failed` (default `false`).

- [ ] **Step 1: Write the failing test** — append to `test/roster.test.mjs` (follow its existing register/cleanup pattern):

```js
test('failed flag: defaults false, setFailed flips it, independent of ready', () => {
  registerAgent({ key: 't-fail', label: 'TF', ready: true })
  assert.equal(listAgents().find((e) => e.key === 't-fail')?.failed, false)
  setFailed('t-fail', true)
  const row = listAgents().find((e) => e.key === 't-fail')
  assert.equal(row?.failed, true)
  assert.equal(row?.ready, true, 'failed does not touch ready')
  assert.throws(() => setFailed('nope', true), /roster: unknown agent nope/)
  unregisterAgent('t-fail')
})
```

- [ ] **Step 2: Run to verify it fails** — `cd super-dsh/superd-hub && npm run build 2>/dev/null; node --test test/roster.test.mjs` → FAIL (`setFailed` is not exported / `failed` undefined).
- [ ] **Step 3: Implement** — in `roster.ts`: extend `RosterEntry` with `/** True once the world's spawn REJECTED (world-join catch) — stays mounted for diagnosis. */ failed?: boolean`; in `registerAgent` store `{ ...entry, failed: entry.failed ?? false }`; add:

```ts
/** Flip failure (world spawn rejected). Unknown keys are a plugin bug. */
export function setFailed(key: string, failed: boolean): void {
  const e = entries.get(key)
  if (!e) throw new Error(`roster: unknown agent ${key}`)
  e.failed = failed
  emit()
}
```

Add `setFailed` to the roster re-export line in `src/index.ts`.
- [ ] **Step 4: Run tests** → PASS (full file, then whole suite `node --test test/*.test.mjs`).
- [ ] **Step 5: Commit** — `git add -A super-dsh/superd-hub && git commit -m "hub: roster failed flag beside ready (C1 task 1)"`

### Task 2: world-join marks failure

**Files:**
- Modify: `super-dsh/superd-hub/src/world-join.ts` (catch block, ~line 107)

**Interfaces:**
- Consumes: `setFailed` from Task 1.

- [ ] **Step 1: Implement** — the catch becomes:

```ts
  })().catch((cause: unknown) => {
    // A failed world degrades to a failed roster row (mount stays for
    // diagnosis; ready stays false); a rejected provided promise would fail
    // the entire host boot (loader entry apply).
    console.error(`[super-dsh] ${key} world failed:`, cause)
    try { setFailed(key, true) } catch { /* roster row already gone */ }
    return null
  })
```

(import `setFailed` alongside `registerAgent, setReady` in the existing `from './roster.js'` line.)
- [ ] **Step 2: Build + full suite** → PASS. No new unit test (world-join has no unit harness; failure semantics covered by Task 1 + rig).
- [ ] **Step 3: Commit** — `git commit -am "hub: world-join marks spawn rejection as roster failed (C1 task 2)"`

### Task 3: Project readiness through `/api/agent-runtime`

**Files:**
- Modify: `super-dsh/superd-hub/src/agent-roster.ts` (AgentLink + agentLinks)
- Modify: `super-dsh/superd-hub/src/client/roster.ts` (row type carries the new fields)
- Test: `super-dsh/superd-hub/test/rpc.test.mjs`

**Interfaces:**
- Produces: `AgentLink` gains `ready: boolean; failed: boolean`; `/api/agent-runtime` GET rows: `{ key, label, path, machine, ready, failed }`. Client `AgentRuntimeRow` (whatever `fetchRoster` returns' element type is named) gains optional `ready?: boolean; failed?: boolean`.

- [ ] **Step 1: Write the failing test** — in `rpc.test.mjs`, follow the existing handleAgentRuntime test; assert a registered-but-not-ready agent serializes both flags:

```js
test('agent-runtime rows carry ready and failed', async () => {
  registerAgent({ key: 't-flags', label: 'TF', ready: false })
  setFailed('t-flags', true)
  const res = await handleAgentRuntime(new Request('http://x/api/agent-runtime'), { listRuntimes: () => ['native', 't-flags'] })
  const body = await res.json()
  const row = body.agents.find((a) => a.key === 't-flags')
  assert.equal(row.ready, false)
  assert.equal(row.failed, true)
  unregisterAgent('t-flags')
})
```

(Adapt imports/registration helpers to the file's existing shape; `agentLinks()` must read the flags from `listAgents()` entries while keeping the `takeHostMount` filter.)

- [ ] **Step 2: Verify FAIL** → run; expect `ready`/`failed` undefined.
- [ ] **Step 3: Implement** — `agent-roster.ts`: add fields to `AgentLink`; in `agentLinks()` push `{ key: agent.key, label: agent.label, path, machine: LOCAL_MACHINE, ready: agent.ready === true, failed: agent.failed === true }`. Client `roster.ts`: extend the parsed row type with `ready?: unknown; failed?: unknown` and coerce to boolean where rows are built.
- [ ] **Step 4: Build + suite** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "hub: /api/agent-runtime rows expose ready/failed (C1 task 3)"`

### Task 4: Official-Toast module (client)

**Files:**
- Create: `super-dsh/superd-hub/src/client/toast.ts`
- Test: `super-dsh/superd-hub/test/client-toast.test.mjs`

**Interfaces:**
- Produces: `showSuperdToast(text: string, options?: { tone?: 'success'; holdMs?: number }): void` — renders the upstream `Toast` primitive through `react-dom/client` into a detached host appended to `document.body`; unmounts via the primitive's `onDone`. Default `holdMs: 6000`.

- [ ] **Step 1: Verify the import lane** — `grep -n "client-ui-primitives" superd-hub/scripts/build-client.mjs` (must appear in `CLIENT_EXTERNALS`; if missing, add it — `HubPanelIcon.tsx` proves the lane).
- [ ] **Step 2: Write the failing test** (pure decision coverage + mount smoke via the existing client-test DOM stubs — follow `client-switch.test.mjs`'s harness):

```js
test('showSuperdToast mounts the official Toast and unmounts on done', async () => {
  const { showSuperdToast } = await import('../dist/client/toast.js') // adjust to the client bundle export path used by sibling tests
  // harness: minimal document.createElement/createRoot stubs per client-switch.test.mjs
  showSuperdToast('Super D: hello', { holdMs: 1 })
  // assert the Toast factory was invoked with text/tone/holdMs and that onDone removes the host
})
```

(Concrete stubbing follows the sibling file's `globalThis.document`/React shims; the assertion targets the props our wrapper passes.)
- [ ] **Step 3: Verify FAIL** (module absent).
- [ ] **Step 4: Implement**:

```ts
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'

export interface SuperdToastOptions { tone?: 'success'; holdMs?: number }
const DEFAULT_HOLD_MS = 6000

export function showSuperdToast(text: string, options: SuperdToastOptions = {}): void {
  try {
    const doc = (globalThis as { document?: Document }).document
    if (doc === undefined || doc.body === null) return
    const host = doc.createElement('div')
    doc.body.appendChild(host)
    let root: Root | undefined
    root = createRoot(host)
    root.render(React.createElement(Toast, {
      text,
      tone: options.tone,
      holdMs: options.holdMs ?? DEFAULT_HOLD_MS,
      onDone: () => { try { root?.unmount(); host.remove() } catch { /* already gone */ } },
    }))
  } catch { /* feedback is best-effort: never break the page */ }
}
```

- [ ] **Step 5: Build (`npm run build` in superd-hub, which chains tsconfig.client.json) + suite** → PASS.
- [ ] **Step 6: Commit** — `git commit -am "hub client: official Toast primitive feedback module (C1 task 4)"`

### Task 5: Pre-flight gate + toast swap in `client/switch.ts`

**Files:**
- Modify: `super-dsh/superd-hub/src/client/switch.ts` (showToast → showSuperdToast; attemptSwitch gate + waitReady)
- Test: `super-dsh/superd-hub/test/client-switch.test.mjs` (extend)

**Interfaces:**
- Consumes: `showSuperdToast` (Task 4), roster rows with `ready`/`failed` (Task 3), `fetchRoster` from `./roster.js`.
- Produces: `attemptSwitch(label)` behavior matrix per spec §Decision 4; module-internal `waitReady(label, boundMs, faces?)` with injectable `{ fetchRow(): Promise<AgentRuntimeRow | undefined>; setTimeout; clearTimeout }` for tests.

- [ ] **Step 1: Write failing tests** — matrix per spec: ready → machine runs; failed → toast, machine NOT run; not-ready → wait → flips ready → machine runs; not-ready → bound expiry → failure toast; second attemptSwitch cancels a pending wait (no late machine run). Drive via the existing harness's bound-run spy and stubbed roster face.
- [ ] **Step 2: Verify FAIL.**
- [ ] **Step 3: Implement** — replace `showToast` body with a delegation to `showSuperdToast` (keep the local name/call sites; revert toast call gains `{ holdMs: 6000 }`); add the gate:

```ts
let pendingWait: (() => void) | undefined
const WAIT_BOUND_MS = 120_000
const WAIT_POLL_MS = 1_000

async function rosterRowOf(label: string, fetchRow: () => Promise<unknown> = defaultFetchRow): Promise<{ ready?: boolean; failed?: boolean } | undefined> {
  try { return (await fetchRow()) as { ready?: boolean; failed?: boolean } | undefined } catch { return undefined }
}

async function waitReady(label: string, faces: WaitFaces): Promise<boolean> {
  const timer = faces.setTimeout
  return new Promise<boolean>((resolve) => {
    let stop = false
    pendingWait = () => { stop = true; resolve(false) }
    const tick = async () => {
      if (stop) return
      const row = await rosterRowOf(label, faces.fetchRow)
      if (stop) return
      if (row?.failed === true) { resolve(false); return }
      if (row?.ready === true) { resolve(true); return }
      timer(tick, WAIT_POLL_MS)
    }
    void tick()
    timer(() => { if (!stop) { stop = true; resolve(false) } }, WAIT_BOUND_MS)
  })
}
```

`attemptSwitch` becomes: cancel `pendingWait`; if `label !== 'native'`, fetch the row once — `failed` → toast `Super D: ${label} failed to start — see the service log.` and return `true`; `ready !== true` → toast `Super D: ${label} is starting…` then `await waitReady(...)`; false → timeout toast; true → `void run(label)`. Unknown/errored roster → run the machine as today (its probe decides).
- [ ] **Step 4: Build + full suite + `node super-dsh/scripts/build-client` if separate** → PASS (client-bundle-drift test included).
- [ ] **Step 5: Commit** — `git commit -am "hub client: switch pre-flight readiness gate + official toast (C1 task 5)"`

### Task 6: Rig verification (delivery form)

- [ ] Rebuild pack + boot 4999 line (`bash super-dsh/test/start-4999.sh`; port discipline auto).
- [ ] During warm-up (first ~15 s after port-up), headless-browser switch to `pi` (reuse `.scratch/pw` playwright-core rig): expect "starting" feedback then auto-landing; steady-state switch to `claude` lands; roster JSON shows `ready:false → true` transition and `failed:false`.
- [ ] Revert-path smoke: stop… do NOT stop worlds on prod; on the rig only, verify the official toast renders on a bogus-agent revert via the machine's probe path (`agent=bogus` menu absence makes this unit-covered instead — skip live).
- [ ] Report to `docs/test-reports/2026-09-27-c1-world-readiness.md` (probe transcript + timings). Commit.
- [ ] Hand the running rig URL to the user for first-person acceptance (验收模式).

### Task 7: Merge + release gate

- [ ] Merge `c1-world-readiness` → master after user acceptance; version letter bump + npm publish ONLY on explicit user order (repo red line §〇.1).
