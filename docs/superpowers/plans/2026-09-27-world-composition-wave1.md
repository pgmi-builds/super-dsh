# World Composition Wave-1 (C2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disable the 24 dependency-cleared dead rows (agent-loop / MCP / skills / jobs / subagent families) in every world composition via the proven subtractive patch channel.

**Architecture:** One shared disable block appended to `worldMountPatches` (world-mount.ts) — the same layer that already carries the zero-listener posture — so all worlds and all recompositions carry it. No new packages, no bundle edits.

**Tech Stack:** TypeScript (superd-hub), `node --test`, pack + 4999 rig.

**Spec:** `docs/specs/world-composition-minimization/spec.md`

## Global Constraints

- KEEP invariants (spec, verified 2026-09-27): rows `agent`, `dsh-llm` family, `agent-default-model`, `settings`, `agent-preset-registry` stay (adapters inject `agents/sessions/llm/agentDefaultModel/settings/agentPresets`).
- Wave-1 = exactly the 24 rows below — nothing speculative.
- Verification per spec §Verification Protocol; rollback = remove the block.
- Worktree: `.worktrees/c2-composition-wave1`, branch `c2-composition-wave1` (independent of C1; merge order flexible).

---

### Task 1: The wave-1 disable block

**Files:**
- Modify: `super-dsh/superd-hub/src/world-mount.ts` (`worldMountPatches`)
- Test: `super-dsh/superd-hub/test/world-mount-patches.test.mjs`

**Interfaces:**
- Produces: exported `WORLD_WAVE1_DISABLED_ROWS: readonly string[]` (24 ids); `worldMountPatches(key)` returns the existing 6 layers + 24 `{ id, disabled: true }` layers (order: appended after the existing insert layer; ids are unique patch-layer restatements, apply order is inject-driven).

- [ ] **Step 1: Write the failing test** — extend the first test in `world-mount-patches.test.mjs`:

```js
test('wave-1: dead native-agent rows are disabled in every world composition', () => {
  const patches = worldMountPatches('omp')
  assert.equal(patches.length, 6 + WORLD_WAVE1_DISABLED_ROWS.length)
  const disabled = new Set(patches.filter((p) => 'id' in p && p.disabled === true).map((p) => p.id))
  for (const id of WORLD_WAVE1_DISABLED_ROWS) assert.equal(disabled.has(id), true, `${id} must be disabled`)
  // KEEP invariants stay untouched
  for (const keep of ['agent', 'agent-default-model', 'settings', 'agent-preset-registry']) {
    assert.equal(disabled.has(keep), false, `${keep} must stay enabled`)
  }
})
```

- [ ] **Step 2: Verify FAIL** (constant not exported).
- [ ] **Step 3: Implement** — in `world-mount.ts`:

```ts
/**
 * Wave-1 of world composition minimization (spec
 * docs/specs/world-composition-minimization): native-agent machinery the
 * foreign runtimes replace. Dependency-cleared 2026-09-27 against the KEEP
 * set (api controllers, session core, adapters' agents/sessions/llm/
 * agentDefaultModel/settings/agentPresets). Wave-2 candidates live in the
 * spec, NOT here.
 */
export const WORLD_WAVE1_DISABLED_ROWS: readonly string[] = [
  'agent-loop',
  'mcp-resources',
  // skills
  'skill', 'skill-filesystem', 'skill-badge', 'tool-skill', 'ui-skill',
  // jobs
  'jobs', 'tool-jobs', 'ui-jobs', 'job-controller',
  // subagents
  'subagent', 'subagent-spawn-in-process', 'subagent-fork-in-process',
  'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
  'tool-subagent-fork', 'tool-subagent-codex', 'tool-subagent-claude-code',
  'subagent-model-selection-settings', 'ui-subagent', 'ui-settings-subagent',
  'ui-settings-agent-loop',
]
```

and in `worldMountPatches`'s returned array, after the existing insert layer:
`...WORLD_WAVE1_DISABLED_ROWS.map((id) => ({ id, disabled: true })),`
- [ ] **Step 4: Build + suite** (`npm run build && node --test test/*.test.mjs` in superd-hub) → PASS (the existing first test asserts `length === 6` — update that expectation to `6 + WORLD_WAVE1_DISABLED_ROWS.length` and keep its index-0..5 shape checks).
- [ ] **Step 5: Commit** — `git commit -am "hub: wave-1 world composition disables (agent-loop/mcp/skills/jobs/subagent)"`

### Task 2: Rig verification (delivery form)

- [ ] `bash super-dsh/test/start-4999.sh` (fresh pack incl. C2; SUPERD_TRACE=1).
- [ ] Boot assertions: `world failed` count 0 in the line log; spawn trace still shows `composed rows: <N>` — record N (expect 292 − 24 = 268 minus preset-group contributions of disabled ids; report the actual).
- [ ] Dataplane matrix (reuse `.scratch/boot-timing.mjs` + envelope probes): all six agents `dataplane-ready`, timings recorded.
- [ ] Session-face matrix per runtime (alignment discipline): browser switch + landing + create-session + one prompt (+ resume once) for pi, claude, codex, hermes, omp, agy — headless playwright rig acceptable for the mechanical pass; hand the rig URL to the user for first-person acceptance.
- [ ] RSS + boot timing before/after comparison vs the 2026-09-27 baseline (RSS 371 MB, ready ≈10.4 s post-port) recorded in the report.

### Task 3: Report + gate

- [ ] `docs/test-reports/2026-09-27-c2-composition-wave1.md`: row delta, boot/RSS numbers, probe transcript, per-runtime matrix result.
- [ ] User acceptance → merge; wave-2 spec'd separately (client-ui-* family et al. per spec).
