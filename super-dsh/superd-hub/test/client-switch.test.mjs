// Client switch (native-ui-fusion Task 4 + T-F): the pure orchestration core
// behind the in-page agent switch — storage-namespace key computation, the
// landing decision (persisted 'dsh.sessions.current' under the target NS,
// resolved with NATIVE restore semantics), and the fallback state machine
// (timeout / roster-probe failure → revert to native + toast, never a page
// lock).
//
// switch-core.ts is a host-half module (plain TS, no DOM, no client imports)
// precisely so node tests can import it from dist — the client-shim precedent
// in reverse: pure logic lives where tsc emits, the DOM/connection face is
// injected. Seat DOM behavior is verified on the pack line (Task 6).
//
// T-F (2026-09-26, user ruling "按原生的语义去理解…把这个 last visit session 也
// 做一下"): the landing replicates upstream's fresh-load restore —
// watchNavigation waits for BOTH lists' ready phase (navigation.ts:284-316)
// and restoreSelection walks subagentAddress → fresh-byId sessionId →
// recent-workspace → default-workspace (navigation.ts:318-347). Every landing
// defers to the both-lists gate; the pointer no longer lands pre-reconnect
// (that ordering read stale sessions and broke native's own last-visited
// restore — the live defect this task fixes).
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NATIVE_AGENT,
  SESSIONS_CURRENT_KEY,
  SWITCH_FALLBACK_MS,
  LANDING_QUIET_MS,
  FUSION_OFF_HINT,
  namespacedKey,
  storageNamespace,
  parseLandingTarget,
  planRestoreLanding,
  seatClickDecision,
  hubRowActive,
  activeAgentName,
  machineGroup,
  machineGroups,
  switchAffordance,
  createSwitchController,
  createReadinessWaiter,
  decidePreFlight,
  observeCachesRefreshed,
} from '../dist/switch-core.js'
import { FUSION_FLAG_GLOBAL, apply as applyFusion, renderFusionTransport } from '../dist/fusion-transport.js'

// ---- NS key computation -------------------------------------------------

test('storageNamespace: native is bare, foreign is <label>:', () => {
  assert.equal(storageNamespace('native'), '')
  assert.equal(storageNamespace('omp'), 'omp:')
  assert.equal(storageNamespace('codex'), 'codex:')
})

test('namespacedKey: the sessions-current key lands under the active NS', () => {
  assert.equal(namespacedKey('native', SESSIONS_CURRENT_KEY), 'dsh.sessions.current')
  assert.equal(namespacedKey('omp', SESSIONS_CURRENT_KEY), 'omp:dsh.sessions.current')
  assert.equal(NATIVE_AGENT, 'native')
})

// ---- landing decision table (the persisted-selection parser) --------------

test('landing: a persisted session id is navigable', () => {
  assert.equal(parseLandingTarget(JSON.stringify({ sessionId: 's-1' })), 's-1')
})

test('landing: a subagent address wins over the session id (upstream restore order)', () => {
  const address = { parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' }
  const target = parseLandingTarget(JSON.stringify({ sessionId: 's-1', subagentAddress: address }))
  assert.deepEqual(target, address)
})

test('landing: no value / empty / garbage / wrong shapes → new chat', () => {
  assert.equal(parseLandingTarget(null), null)
  assert.equal(parseLandingTarget(undefined), null)
  assert.equal(parseLandingTarget(''), null)
  assert.equal(parseLandingTarget('not json {'), null)
  assert.equal(parseLandingTarget('42'), null)
  assert.equal(parseLandingTarget('"str"'), null)
  assert.equal(parseLandingTarget('[]'), null)
  assert.equal(parseLandingTarget('{}'), null)
  assert.equal(parseLandingTarget(JSON.stringify({ sessionId: '' })), null)
  assert.equal(parseLandingTarget(JSON.stringify({ sessionId: 42 })), null)
  assert.equal(parseLandingTarget(JSON.stringify({ sessionId: null })), null)
  assert.equal(parseLandingTarget(JSON.stringify({ subagentAddress: 'plain-string' })), null)
})

// ---- T-F: the landing plan (restoreSelection precedence, replicated) ------
// planRestoreLanding mirrors upstream restoreSelection (navigation.ts:318-347)
// against the FRESH wire-derived caches: subagentAddress → open (no cache
// consultation); sessionId → fresh byId (non-blank opens; blank resolves to
// its workspace — the reuseBlank nuance, covered exactly by the public
// startSession face's connectWorkspace scan); a stale id falls through to the
// no-pointer ladder; recent workspace → startSession(that workspace); both
// lists empty → the default-workspace mirror; unreadable caches → no plan.

const PLAN_WS = { workspaceId: 'ws-1', sessionIds: ['s-a', 's-b'], createdAt: '2026-01-01T00:00:00.000Z' }
const PLAN_CACHES = {
  workspaces: { items: [PLAN_WS] },
  sessions: {
    ids: ['s-a', 's-b'],
    byId: { 's-a': { id: 's-a', blank: false, updatedAt: 1 }, 's-b': { id: 's-b', blank: true, updatedAt: 2 } },
  },
}

test('plan: subagentAddress wins without any cache consultation', () => {
  const address = { parentSessionId: 'p', childSessionId: 'c' }
  assert.deepEqual(planRestoreLanding(address, PLAN_CACHES), { kind: 'open-session', target: address })
})

test('plan: fresh byId hit — non-blank opens, blank resolves to its workspace', () => {
  assert.deepEqual(planRestoreLanding('s-a', PLAN_CACHES), { kind: 'open-session', target: 's-a' })
  assert.deepEqual(planRestoreLanding('s-b', PLAN_CACHES), { kind: 'start-session', workspaceId: 'ws-1' })
})

test('plan: blank hit without a workspace still opens the id (upstream: !blank || workspace undefined)', () => {
  const caches = {
    workspaces: { items: [{ workspaceId: 'ws-1', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z' }] },
    sessions: { ids: ['s-b'], byId: { 's-b': { id: 's-b', blank: true } } },
  }
  assert.deepEqual(planRestoreLanding('s-b', caches), { kind: 'open-session', target: 's-b' })
})

test('plan: a stale sessionId falls to the recent-workspace ladder (upstream: summary undefined)', () => {
  assert.deepEqual(planRestoreLanding('gone-s1', PLAN_CACHES), { kind: 'start-session', workspaceId: 'ws-1' })
})

test('plan: recent = latest session updatedAt, not createdAt order (recentWorkspace replication)', () => {
  const caches = {
    workspaces: { items: [
      { workspaceId: 'ws-old', sessionIds: ['a1'], createdAt: '2026-03-01T00:00:00.000Z' },
      { workspaceId: 'ws-new', sessionIds: ['b1'], createdAt: '2026-01-01T00:00:00.000Z' },
    ] },
    sessions: { ids: ['a1', 'b1'], byId: {
      a1: { id: 'a1', blank: false, updatedAt: 10 },
      b1: { id: 'b1', blank: false, updatedAt: 999 },
    } },
  }
  assert.deepEqual(planRestoreLanding(null, caches), { kind: 'start-session', workspaceId: 'ws-new' })
  const byCreatedAt = {
    workspaces: { items: [
      { workspaceId: 'ws-only', sessionIds: ['x1'], createdAt: '2026-05-01T00:00:00.000Z' },
    ] },
    sessions: { ids: [], byId: {} },
  }
  assert.deepEqual(planRestoreLanding(null, byCreatedAt), { kind: 'start-session', workspaceId: 'ws-only' },
    'a workspace with no listed sessions falls back to its createdAt')
})

test('plan: no pointer, both lists empty → default workspace; unreadable caches → no plan', () => {
  const empty = { workspaces: { items: [] }, sessions: { ids: [], byId: {} } }
  assert.deepEqual(planRestoreLanding(null, empty), { kind: 'default-workspace' })
  assert.deepEqual(planRestoreLanding('s-1', empty), { kind: 'default-workspace' },
    'a stale pointer on an empty plane is the fresh-boot case too')
  assert.equal(planRestoreLanding('s-1', undefined), undefined, 'unreadable caches land nothing')
  const degenerate = { workspaces: { items: [] }, sessions: { ids: ['x'], byId: { x: { id: 'x', blank: false } } } }
  assert.equal(planRestoreLanding(null, degenerate), undefined,
    'workspaces=0 with sessions>0: upstream leaves the view as it is — so does the plan')
})

// ---- fallback state machine ----------------------------------------------

/** A fake wire-derived snapshot store (workspaces or sessions). */
function fakeListStore(initial) {
  let snapshot = initial
  const listeners = []
  return {
    face: {
      getSnapshot: () => snapshot,
      subscribe(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1) } },
    },
    install(next) { snapshot = next; for (const fn of [...listeners]) fn() },
    listenerCount: () => listeners.length,
  }
}

/** The fake's "previous plane" stale data (what the stores hold pre-repull). */
const STALE_WS = { items: [{ workspaceId: 'stale-ws', sessionIds: ['old-s1'], createdAt: '2026-01-01T00:00:00.000Z' }], phase: 'ready' }
const STALE_SS = { ids: ['old-s1'], byId: { 'old-s1': { id: 'old-s1', blank: false, updatedAt: 10 } }, phase: 'ready' }
/** The fake's target-plane fresh data (what the repull installs). */
const FRESH_WS = { items: [{ workspaceId: 'ws-1', sessionIds: ['s-1'], createdAt: '2026-01-15T00:00:00.000Z' }], phase: 'ready' }
const FRESH_SS = { ids: ['s-1'], byId: { 's-1': { id: 's-1', blank: false, updatedAt: 100 } }, phase: 'ready' }

/**
 * A fully observable fake host: every effect is recorded, time is manual.
 * The freshness gate is the REAL `observeCachesRefreshed` composed over the
 * two fake stores + a fake generation — machine-level tests exercise the same
 * both-lists gate the client binding wires (T-F).
 */
function fakeHost(overrides = {}) {
  const log = { setAgent: [], openSession: [], startSession: [], openDefaultWorkspace: [], reconnect: [], toast: [] }
  const seq = []
  const timers = []
  const storage = new Map([['dsh.sessions.current', JSON.stringify({ sessionId: 'native-s1' })]])
  let active = 'native'
  const workspaces = fakeListStore(STALE_WS)
  const sessions = fakeListStore(STALE_SS)
  let generation
  const genListeners = []
  const genFace = {
    getSnapshot: () => generation,
    subscribe(fn) { genListeners.push(fn); return () => { const i = genListeners.indexOf(fn); if (i !== -1) genListeners.splice(i, 1) } },
  }
  const host = {
    setAgent(label) { active = label; log.setAgent.push(label); seq.push(`setAgent:${label}`) },
    readPersistedSelection() { return storage.get(namespacedKey(active, SESSIONS_CURRENT_KEY)) ?? null },
    openSession(target) { log.openSession.push(target); seq.push(`openSession:${JSON.stringify(target)}`) },
    startSession(workspaceId) { log.startSession.push(workspaceId); seq.push(`startSession:${workspaceId ?? 'inherit'}`) },
    openDefaultWorkspace() { log.openDefaultWorkspace.push(true); seq.push('openDefaultWorkspace') },
    readRestoreCaches() {
      const w = workspaces.face.getSnapshot()
      const s = sessions.face.getSnapshot()
      return { workspaces: { items: w.items, phase: w.phase }, sessions: { ids: s.ids, byId: s.byId, phase: s.phase } }
    },
    reconnect() { log.reconnect.push(true); seq.push('reconnect') },
    onGenerationEstablished(fn) {
      return genFace.subscribe(() => { if (genFace.getSnapshot() !== undefined) fn() })
    },
    onCachesRefreshed(fn, gate) {
      // The client binding's composition: sessions.ids plays items, and the
      // T-G membership face answers from byId (the face the restore pointer
      // resolves against). The machine's gate request (pointer face, quiet
      // window, timers) rides through untouched, so the machine-level tests
      // exercise the same membership-aware gate the client binding wires.
      const sessionsFace = {
        getSnapshot: () => {
          const s = sessions.face.getSnapshot()
          return { items: s.ids, phase: s.phase }
        },
        subscribe: (l) => sessions.face.subscribe(l),
        contains: (id) => sessions.face.getSnapshot().byId[id] !== undefined,
      }
      return observeCachesRefreshed(workspaces.face, sessionsFace, genFace, fn, gate)
    },
    probeTarget() { return Promise.resolve(true) },
    toast(message) { log.toast.push(message); seq.push('toast') },
    setTimeout(fn, ms) { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimeout(t) { t.cleared = true },
    ...overrides,
  }
  return {
    host,
    log,
    seq,
    timers,
    setStored(label, raw) { storage.set(namespacedKey(label, SESSIONS_CURRENT_KEY), raw) },
    establish: () => { generation = 'gen-switch'; for (const fn of [...genListeners]) fn() },
    installWorkspacesBaseline: (next) => { workspaces.install({ ...next, phase: 'ready' }) },
    installSessionsBaseline: (next) => { sessions.install({ ...next, phase: 'ready' }) },
    refreshCaches() {
      workspaces.install({ ...FRESH_WS })
      sessions.install({ ...FRESH_SS })
    },
    gateSubscriptions: () => workspaces.listenerCount() + sessions.listenerCount(),
    generationSubscriptions: () => genListeners.length,
    fireTimer: (t) => { if (!t.cleared) t.fn() },
  }
}

test('happy path (T-F): pointer landing defers to the both-lists gate, then lands the persisted session', async () => {
  const fx = fakeHost()
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-s7' }))
  const done = createSwitchController(fx.host).run('omp')
  assert.deepEqual(fx.log.setAgent, ['omp'], 'state + NS swap first')
  assert.deepEqual(fx.seq, ['setAgent:omp', 'reconnect'], 'no navigation before the gate — the pointer must be read against fresh data')
  assert.equal(fx.timers.length, 1, 'fallback timer armed')
  fx.establish()
  await done
  fx.installWorkspacesBaseline(FRESH_WS)
  assert.deepEqual(fx.log.openSession, [], 'workspaces alone do not open the gate (the T-A gap: sessions still stale)')
  fx.installSessionsBaseline({ ids: ['omp-s7'], byId: { 'omp-s7': { id: 'omp-s7', blank: false, updatedAt: 5 } } })
  assert.deepEqual(fx.log.openSession, ['omp-s7'], 'the persisted target session lands once BOTH lists are fresh')
  assert.deepEqual(fx.log.startSession, [], 'no new-chat detour')
})

test('native-return-with-pointer: switching back to native lands native\'s persisted last-visited session (not new chat)', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('native')
  assert.deepEqual(fx.log.setAgent, ['native'])
  assert.deepEqual(fx.log.openSession, [], 'nothing lands while the native plane caches are stale')
  fx.establish()
  await done
  fx.installWorkspacesBaseline(FRESH_WS)
  fx.installSessionsBaseline({ ids: ['native-s1'], byId: { 'native-s1': { id: 'native-s1', blank: false, updatedAt: 7 } } })
  assert.deepEqual(fx.log.openSession, ['native-s1'], 'native\'s own last-visited restore works again')
  assert.deepEqual(fx.log.startSession, [])
})

test('subagentAddress precedence: the address wins over the sessionId at landing time (upstream restore order)', async () => {
  const fx = fakeHost()
  const address = { parentSessionId: 'p-1', childSessionId: 'c-1', mode: 'continuable' }
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-s7', subagentAddress: address }))
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  fx.refreshCaches()
  assert.deepEqual(fx.log.openSession, [address], 'openSession receives the address object, not the session id')
  assert.deepEqual(fx.log.startSession, [])
})

test('blank pointer: the landing connects the pointer\'s workspace (reuseBlank nuance via the public startSession face)', async () => {
  const fx = fakeHost()
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-b1' }))
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  fx.installWorkspacesBaseline({ items: [{ workspaceId: 'ws-9', sessionIds: ['omp-b1'], createdAt: '2026-01-01T00:00:00.000Z' }] })
  fx.installSessionsBaseline({ ids: ['omp-b1'], byId: { 'omp-b1': { id: 'omp-b1', blank: true, cwd: '/x', updatedAt: 5 } } })
  assert.deepEqual(fx.log.startSession, ['ws-9'], 'a blank pointer resolves to its workspace, exactly like native\'s restore')
  assert.deepEqual(fx.log.openSession, [])
})

test('stale pointer: a sessionId the fresh list never shows ladders after the quiet window (T-G)', async () => {
  // T-G semantic: a pointer that is not a list member no longer ladders on
  // the fresh edge (the list may still be growing incrementally) — it holds
  // for the quiet window, then takes the ladder as an honest miss.
  const fx = fakeHost()
  fx.setStored('omp', JSON.stringify({ sessionId: 'gone-s1' }))
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  fx.installWorkspacesBaseline({ items: [
    { workspaceId: 'ws-old', sessionIds: ['a1'], createdAt: '2026-03-01T00:00:00.000Z' },
    { workspaceId: 'ws-new', sessionIds: ['b1'], createdAt: '2026-01-01T00:00:00.000Z' },
  ] })
  fx.installSessionsBaseline({ ids: ['a1', 'b1'], byId: {
    a1: { id: 'a1', blank: false, updatedAt: 10 },
    b1: { id: 'b1', blank: false, updatedAt: 999 },
  } })
  assert.deepEqual(fx.log.startSession, [], 'T-G: the ladder waits — the list may still be growing')
  const quiet = fx.timers.find((t) => t.ms === LANDING_QUIET_MS)
  assert.ok(quiet !== undefined, 'the quiet window is armed while a non-member pointer holds the gate')
  fx.fireTimer(quiet)
  assert.deepEqual(fx.log.startSession, ['ws-new'], 'recent = latest session updatedAt (native recentWorkspace)')
  assert.deepEqual(fx.log.openSession, [], 'the dead id is never opened')
})

test('foreign-no-pointer (non-empty plane): the fresh-boot-equivalent recent-workspace landing, never an unconditional blank', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  fx.refreshCaches()
  assert.deepEqual(fx.log.startSession, ['ws-1'], 'a new session opens in the most recent workspace (startSession face)')
  assert.deepEqual(fx.log.openDefaultWorkspace, [])
  assert.deepEqual(fx.log.openSession, [], 'the previous agent session id is never re-opened')
})

test('foreign-no-pointer (fresh-boot empty plane): the default-workspace mirror — NOT an unconditional blank', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  fx.installWorkspacesBaseline({ items: [] })
  fx.installSessionsBaseline({ ids: [], byId: {} })
  assert.deepEqual(fx.log.openDefaultWorkspace, [true], 'both lists empty → native\'s initializeDefaultWorkspace mirror')
  assert.deepEqual(fx.log.startSession, [], 'never an unconditional blank')
})

test('a failing caches read lands nothing (safe direction: no landing beats a wrong one)', async () => {
  const fx = fakeHost({ readRestoreCaches() { throw new Error('store gone') } })
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  fx.refreshCaches()
  assert.deepEqual(fx.log.startSession, [])
  assert.deepEqual(fx.log.openSession, [])
  assert.deepEqual(fx.log.openDefaultWorkspace, [])
})

test('a landing face throwing at gate time never escapes run(); the machine still settles', async () => {
  const fx = fakeHost({ openSession() { throw new Error('retain failed') } })
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-s7' }))
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  // T-G: the pointer must be a list MEMBER for the gate to hand the landing
  // over — the baseline below carries it, so the throwing face is reached.
  fx.installWorkspacesBaseline(FRESH_WS)
  fx.installSessionsBaseline({ ids: ['omp-s7'], byId: { 'omp-s7': { id: 'omp-s7', blank: false, updatedAt: 5 } } })
  assert.deepEqual(fx.log.setAgent, ['omp'], 'no revert: the switch itself succeeded')
  assert.deepEqual(fx.log.toast, [], 'a failed landing is contained, not a revert')
})

test('timeout with no generation → revert: native + reconnect + toast, resolves', async () => {
  const fx = fakeHost()
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-s7' }))
  const done = createSwitchController(fx.host).run('omp')
  fx.fireTimer(fx.timers[0])
  await done
  assert.deepEqual(fx.log.setAgent, ['omp', 'native'], 'reverted to native')
  assert.equal(fx.log.reconnect.length, 2, 'second reconnect re-targets the native plane')
  assert.equal(fx.log.toast.length, 1, 'a visible toast says so')
  assert.match(fx.log.toast[0], /omp/)
  assert.equal(fx.timers[0].cleared, true)
  assert.equal(fx.generationSubscriptions(), 0, 'subscription released on revert')
})

test('roster probe failure → immediate revert, timer never fires', async () => {
  const fx = fakeHost({ probeTarget: () => Promise.resolve(false) })
  const done = createSwitchController(fx.host).run('codex')
  await done
  assert.deepEqual(fx.log.setAgent, ['codex', 'native'])
  assert.equal(fx.log.toast.length, 1)
  assert.equal(fx.timers[0].cleared, true, 'armed timer disarmed by the revert')
})

test('a rejected probe counts as a probe failure', async () => {
  const fx = fakeHost({ probeTarget: () => Promise.reject(new Error('control plane down')) })
  const done = createSwitchController(fx.host).run('codex')
  await done
  assert.deepEqual(fx.log.setAgent, ['codex', 'native'])
})

test('a settled generation beats the probe and the timer stays quiet', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  assert.deepEqual(fx.log.setAgent, ['omp'], 'no revert after settle')
  assert.deepEqual(fx.log.toast, [])
})

test('a second switch supersedes the first without reverting it', async () => {
  const fx = fakeHost()
  const controller = createSwitchController(fx.host)
  const first = controller.run('omp')
  const second = controller.run('codex')
  await first
  assert.deepEqual(fx.log.setAgent, ['omp', 'codex'], 'no revert interleaved')
  assert.deepEqual(fx.log.toast, [], 'superseded attempt stays silent')
  fx.establish()
  await second
  assert.deepEqual(fx.log.setAgent, ['omp', 'codex'])
})

test('late generation/probe events after a revert are inert', async () => {
  const fx = fakeHost({ probeTarget: () => Promise.resolve(false) })
  const done = createSwitchController(fx.host).run('omp')
  await done // reverted via probe
  fx.establish()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(fx.log.setAgent, ['omp', 'native'], 'exactly one revert')
  assert.equal(fx.log.toast.length, 1)
})

test('the fallback window defaults to the documented N seconds', () => {
  const fx = fakeHost()
  createSwitchController(fx.host).run('omp')
  assert.equal(fx.timers[0].ms, SWITCH_FALLBACK_MS)
  assert.ok(SWITCH_FALLBACK_MS >= 5_000 && SWITCH_FALLBACK_MS <= 30_000, 'a human-scale switch window')
})

// ---- T-F landing timing: gate, cancellation machinery, watchdog -----------
// EVERY landing defers to the both-lists gate now (the pointer included —
// the pre-reconnect pointer landing read stale sessions and broke native's
// own last-visited restore). The cancellation machinery from 8dde3b0 is
// unchanged: revert kills the pending landing, a supersede kills the prior
// attempt's still-armed landing through the controller-scope handle, and the
// settle arms a staleness watchdog that disarms a baseline that never lands.

test('timeout revert cancels the pending landing: a later refresh is inert (red line)', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('omp')
  fx.fireTimer(fx.timers[0])
  await done
  assert.deepEqual(fx.log.setAgent, ['omp', 'native'], 'reverted to native')
  assert.equal(fx.log.toast.length, 1)
  fx.refreshCaches()
  assert.deepEqual(fx.log.startSession, [], 'no landing after the revert — the machine stays consistent')
  assert.deepEqual(fx.log.openSession, [])
  assert.equal(fx.gateSubscriptions(), 0, 'landing gate subscriptions released')
})

test('probe-failure revert cancels the pending landing', async () => {
  const fx = fakeHost({ probeTarget: () => Promise.resolve(false) })
  const done = createSwitchController(fx.host).run('omp')
  await done
  fx.refreshCaches()
  assert.deepEqual(fx.log.startSession, [], 'a reverted switch never lands')
  assert.deepEqual(fx.log.setAgent, ['omp', 'native'])
})

test('supersede cancels the prior attempt\'s pending landing', async () => {
  const fx = fakeHost()
  fx.setStored('codex', JSON.stringify({ sessionId: 'codex-s2' }))
  const controller = createSwitchController(fx.host)
  const first = controller.run('omp') // no pointer → landing armed
  const second = controller.run('codex') // pointer → also gated, its own landing
  await first
  fx.establish() // B's generation
  fx.installWorkspacesBaseline(FRESH_WS)
  fx.installSessionsBaseline({ ids: ['codex-s2'], byId: { 'codex-s2': { id: 'codex-s2', blank: false, updatedAt: 3 } } })
  assert.deepEqual(fx.log.openSession, ['codex-s2'], 'the surviving attempt lands its pointer')
  assert.deepEqual(fx.log.startSession, [], 'the superseded attempt must not land')
  await second
  assert.deepEqual(fx.log.toast, [], 'supersede stays silent')
})

test('rapid double-switch, both armed: only the latest attempt\'s landing survives (controller-scope handle, new gate)', async () => {
  const fx = fakeHost()
  fx.setStored('codex', JSON.stringify({ sessionId: 'codex-s2' }))
  const controller = createSwitchController(fx.host)
  const first = controller.run('omp') // no pointer → landing armed
  fx.establish() // A settles; its landing is still armed
  await first
  assert.deepEqual(fx.log.startSession, [], 'A has not landed yet (baseline pending)')
  const second = controller.run('codex') // supersede AFTER the settle
  assert.equal(fx.timers[1].cleared, true, 'the settled attempt\'s staleness watchdog is disarmed by the supersede')
  fx.establish() // B's establishment re-anchors the surviving gate
  fx.installWorkspacesBaseline(FRESH_WS)
  fx.installSessionsBaseline({ ids: ['codex-s2'], byId: { 'codex-s2': { id: 'codex-s2', blank: false, updatedAt: 3 } } })
  assert.deepEqual(fx.log.openSession, ['codex-s2'], 'B lands on its pointer through the gate')
  assert.deepEqual(fx.log.startSession, [], 'red line: the settled attempt never fires its landing over B')
  fx.establish()
  await second
  assert.deepEqual(fx.log.toast, [], 'supersede stays silent')
})

test('staleness watchdog: a baseline that never installs disarms the landing (safe direction)', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('omp')
  fx.establish() // settle with the landing still pending → watchdog armed
  await done
  assert.equal(fx.timers.length, 2, 'fallback timer + the post-settle staleness watchdog')
  assert.equal(fx.timers[1].ms, SWITCH_FALLBACK_MS, 'the watchdog reuses the fallback window')
  fx.fireTimer(fx.timers[1])
  fx.refreshCaches()
  assert.deepEqual(fx.log.startSession, [], 'a stale landing never fires long after the switch')
  assert.deepEqual(fx.log.openSession, [])
  assert.equal(fx.gateSubscriptions(), 0, 'the watchdog tore down the gate')
})

test('the staleness watchdog is disarmed once the landing fires', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  fx.refreshCaches()
  assert.deepEqual(fx.log.startSession, ['ws-1'], 'the landing fired within the window')
  assert.equal(fx.timers[1].cleared, true, 'watchdog off once the landing fired')
  fx.fireTimer(fx.timers[1])
  assert.deepEqual(fx.log.startSession, ['ws-1'], 'a fired watchdog is inert')
})

test('the deferred landing fires exactly once', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  fx.refreshCaches()
  fx.refreshCaches()
  assert.deepEqual(fx.log.startSession, ['ws-1'], 'one gate edge, one landing; further edges are inert')
})

test('startSession throwing never escapes run(); the machine still settles consistently', async () => {
  const fx = fakeHost({ startSession() { throw new Error('startSession exploded') } })
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  fx.refreshCaches()
  await done
  assert.deepEqual(fx.log.toast, [], 'a failed landing is upstream-reported, not a revert')
  assert.deepEqual(fx.log.setAgent, ['omp'], 'no revert: the switch itself succeeded')
})

test('the landing reads the pointer through the target NS (setAgent-first ordering holds at gate time)', async () => {
  // The read happens in the landing callback, long after setAgent — the
  // patched Storage namespaces at call time, so it must still resolve the
  // TARGET NS's pointer (the active agent only changes again on a revert,
  // which kills the landing first).
  const fx = fakeHost()
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-s7' }))
  fx.setStored('codex', JSON.stringify({ sessionId: 'codex-s9' }))
  const controller = createSwitchController(fx.host)
  const first = controller.run('omp')
  const second = controller.run('codex')
  fx.establish()
  await first
  await second
  fx.installWorkspacesBaseline(FRESH_WS)
  fx.installSessionsBaseline({ ids: ['codex-s9'], byId: { 'codex-s9': { id: 'codex-s9', blank: false, updatedAt: 9 } } })
  assert.deepEqual(fx.log.openSession, ['codex-s9'], 'the read resolved the codex NS (active at gate time), not the omp one')
})

// ---- T-G: the membership-aware landing gate (machine level) ---------------
// Browser-proven defect (rig probes .scratch/switch-probe/): the sessions
// list is minted INCREMENTALLY post-reconnect (upstream handleSessionAdded →
// projectList re-sets the store with a fresh ids array PER ADDED session,
// service.ts:677) — the T-F gate consumed the landing on the FIRST
// post-establishment identity change, when byId was still partial and lacked
// the pointer's session, so every switch laddered into a brand-new session.
// The gate now holds while a pointer exists but is not yet a list MEMBER
// (byId face), firing on membership — or, when the list goes quiet (no
// identity change for a configurable window, default LANDING_QUIET_MS), on
// the quiet ladder (honest miss: stored blanks legitimately never appear).
// No pointer → the first fresh edge still fires (fresh-boot path unchanged).
// The machine's staleness watchdog remains the hard bound on the whole wait.

test('T-G incremental growth: the gate rides out partial-list edges and lands the pointer the moment its row arrives', async () => {
  const fx = fakeHost()
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-s7' }))
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  fx.installWorkspacesBaseline(FRESH_WS)
  // Upstream shape: the list grows ONE session per edge, each with a fresh
  // ids array identity (handleSessionAdded one at a time).
  fx.installSessionsBaseline({ ids: ['a1'], byId: { a1: { id: 'a1', blank: false, updatedAt: 1 } } })
  assert.deepEqual(fx.log.openSession, [], 'edge 1: byId partial, pointer absent — no landing, no ladder')
  assert.deepEqual(fx.log.startSession, [], 'the defect: the old gate laddered into a new session HERE')
  fx.installSessionsBaseline({ ids: ['a1', 'b1'], byId: {
    a1: { id: 'a1', blank: false, updatedAt: 1 },
    b1: { id: 'b1', blank: false, updatedAt: 2 },
  } })
  assert.deepEqual(fx.log.openSession, [], 'edge 2: still partial — the gate keeps holding')
  assert.deepEqual(fx.log.startSession, [])
  fx.installSessionsBaseline({ ids: ['a1', 'b1', 'omp-s7'], byId: {
    a1: { id: 'a1', blank: false, updatedAt: 1 },
    b1: { id: 'b1', blank: false, updatedAt: 2 },
    'omp-s7': { id: 'omp-s7', blank: false, updatedAt: 3 },
  } })
  assert.deepEqual(fx.log.openSession, ['omp-s7'], 'the pointer lands the moment its session joins the list')
  assert.deepEqual(fx.log.startSession, [], 'membership, not the ladder — startSession is never called')
  const quiet = fx.timers.find((t) => t.ms === LANDING_QUIET_MS)
  assert.ok(quiet !== undefined, 'a quiet window was armed while holding')
  assert.equal(quiet.cleared, true, 'the quiet window is off once membership fired')
})

test('T-G quiet-window ladder: the pointer never appears, edges stop, the ladder fires exactly once', async () => {
  const fx = fakeHost()
  fx.setStored('omp', JSON.stringify({ sessionId: 'gone-s1' }))
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  fx.installWorkspacesBaseline(FRESH_WS)
  fx.installSessionsBaseline({ ids: ['a1'], byId: { a1: { id: 'a1', blank: false, updatedAt: 1 } } })
  assert.deepEqual(fx.log.startSession, [], 'holding: a non-member pointer does not ladder on the fresh edge')
  const firstQuiet = fx.timers.find((t) => t.ms === LANDING_QUIET_MS)
  assert.ok(firstQuiet !== undefined, 'the quiet window arms at the default LANDING_QUIET_MS')
  // Growth resumes: an identity change during the window restarts it.
  fx.installSessionsBaseline({ ids: ['a1', 'b1'], byId: {
    a1: { id: 'a1', blank: false, updatedAt: 1 },
    b1: { id: 'b1', blank: false, updatedAt: 2 },
  } })
  assert.equal(firstQuiet.cleared, true, 'an identity change during the window restarts it (the list is still growing)')
  const secondQuiet = fx.timers.filter((t) => t.ms === LANDING_QUIET_MS).at(-1)
  assert.ok(secondQuiet !== undefined && secondQuiet !== firstQuiet, 'a fresh window is armed after the restart')
  fx.fireTimer(secondQuiet)
  assert.deepEqual(fx.log.startSession, ['ws-1'], 'quiet + still no membership → the honest-miss ladder fires')
  assert.equal(fx.log.startSession.length, 1, 'exactly one landing')
  assert.deepEqual(fx.log.openSession, [], 'the never-listed id is never opened')
  fx.installSessionsBaseline({ ids: ['a1', 'b1', 'c1'], byId: { c1: { id: 'c1', blank: false, updatedAt: 3 } } })
  assert.equal(fx.log.startSession.length, 1, 'the fired landing is inert to later edges')
})

test('T-G blank pointer the list never shows: quiet, then the ladder (upstream stored-blank semantics)', async () => {
  // byId legitimately excludes some blanks (and a stored blank from another
  // plane never appears in the target list at all): the quiet ladder is the
  // faithful miss — startSession resolves recent/current like upstream's own
  // stale-pointer boot path, never a second blank.
  const fx = fakeHost()
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-blank-elsewhere' }))
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  fx.installWorkspacesBaseline(FRESH_WS)
  fx.installSessionsBaseline({ ids: ['a1'], byId: { a1: { id: 'a1', blank: false, updatedAt: 1 } } })
  assert.deepEqual(fx.log.startSession, [], 'no instant ladder for the invisible blank')
  fx.fireTimer(fx.timers.filter((t) => t.ms === LANDING_QUIET_MS).at(-1))
  assert.deepEqual(fx.log.startSession, ['ws-1'], 'the quiet miss ladders into the recent workspace, once')
  assert.deepEqual(fx.log.openSession, [])
})

test('T-G no-pointer mode: the first fresh edge still fires immediately, with no quiet window at all', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('omp')
  fx.establish()
  await done
  fx.installWorkspacesBaseline(FRESH_WS)
  fx.installSessionsBaseline({ ids: ['a1'], byId: { a1: { id: 'a1', blank: false, updatedAt: 1 } } })
  assert.deepEqual(fx.log.startSession, ['ws-1'], 'fresh-boot path unchanged: fires on the first fresh edge')
  assert.equal(fx.timers.some((t) => t.ms === LANDING_QUIET_MS), false, 'no pointer → no quiet window ever armed')
  assert.deepEqual(fx.log.openSession, [])
})

test('T-G the staleness watchdog bounds the membership wait: disarm, no landing, quiet timer torn down', async () => {
  const fx = fakeHost()
  fx.setStored('omp', JSON.stringify({ sessionId: 'gone-s1' }))
  // A quiet window far longer than the fallback: only the watchdog may end this switch.
  const done = createSwitchController(fx.host, { fallbackMs: 50, quietWindowMs: 10_000 }).run('omp')
  fx.establish()
  await done
  fx.installWorkspacesBaseline(FRESH_WS)
  fx.installSessionsBaseline({ ids: ['a1'], byId: { a1: { id: 'a1', blank: false, updatedAt: 1 } } })
  const quiet = fx.timers.find((t) => t.ms === 10_000)
  assert.ok(quiet !== undefined, 'the configured quiet window is what arms')
  const watchdog = fx.timers[1]
  assert.equal(watchdog.ms, 50, 'the machine-level watchdog (post-settle) is armed')
  fx.fireTimer(watchdog)
  assert.equal(quiet.cleared, true, 'the watchdog tears the quiet window down with the gate')
  fx.fireTimer(quiet) // even a fired stale handle lands nothing
  fx.installSessionsBaseline({ ids: ['a1', 'x1'], byId: { x1: { id: 'x1', blank: false, updatedAt: 2 } } })
  assert.deepEqual(fx.log.startSession, [], 'the membership wait never outlives the watchdog')
  assert.deepEqual(fx.log.openSession, [])
  assert.equal(fx.gateSubscriptions(), 0, 'the watchdog disarmed the whole landing, as today')
})

test('T-G rapid double-switch: the controller-scope supersede still kills a quiet-held landing', async () => {
  const fx = fakeHost()
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-slow' })) // never a member → holds with the quiet window armed
  fx.setStored('codex', JSON.stringify({ sessionId: 'codex-s2' }))
  const controller = createSwitchController(fx.host)
  const first = controller.run('omp')
  fx.establish()
  await first
  fx.installWorkspacesBaseline(FRESH_WS)
  fx.installSessionsBaseline({ ids: ['a1'], byId: { a1: { id: 'a1', blank: false, updatedAt: 1 } } })
  const heldQuiet = fx.timers.find((t) => t.ms === LANDING_QUIET_MS)
  assert.ok(heldQuiet !== undefined, 'A is holding with its quiet window armed')
  const second = controller.run('codex') // supersede AFTER the settle, mid-hold
  assert.equal(heldQuiet.cleared, true, 'the supersede disarms the held window through the controller-scope handle')
  fx.establish() // B's establishment re-anchors the surviving gate
  // B's own re-pull mints NEW baseline arrays (identity is the freshness
  // token — re-sending A's already-installed arrays would rightly count as
  // no baseline at all).
  fx.installWorkspacesBaseline({ items: [
    { workspaceId: 'ws-codex', sessionIds: ['codex-s2'], createdAt: '2026-02-01T00:00:00.000Z' },
  ] })
  fx.installSessionsBaseline({ ids: ['codex-s2'], byId: { 'codex-s2': { id: 'codex-s2', blank: false, updatedAt: 3 } } })
  assert.deepEqual(fx.log.openSession, ['codex-s2'], 'B lands its pointer through the same extended gate')
  assert.deepEqual(fx.log.startSession, [], 'red line: A\'s quiet ladder never fires over B')
  fx.fireTimer(heldQuiet) // belt: even a fired stale handle lands nothing
  assert.deepEqual(fx.log.startSession, [])
  await second
  assert.deepEqual(fx.log.toast, [], 'supersede stays silent')
})

// ---- the both-lists caches-fresh gate (host-half pure factory) ------------
// The client binding composes this with the real `workspaces.list` +
// `sessions.list` stores (sessions.ids playing items) + the connection
// generation observable. Semantics: fire ONCE, only after BOTH stores have
// replaced their items post-establishment with a ready phase — the T-A gate
// watched workspaces alone, so a plane whose sessions list landed later
// still served stale byId rows to the landing decision (the live defect).

/** A minimal fake of the store pair + generation observable. */
function cacheGateFixture() {
  const makeStore = (initial) => {
    let snapshot = initial
    const listeners = []
    return {
      getSnapshot: () => snapshot,
      subscribe(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1) } },
      install(next) { snapshot = { ...snapshot, ...next }; for (const fn of [...listeners]) fn() },
      churnSameReference() { for (const fn of [...listeners]) fn() },
      setPhase(phase) { snapshot = { ...snapshot, phase }; for (const fn of [...listeners]) fn() },
    }
  }
  const workspaces = makeStore({ items: ['stale-ws'], phase: 'ready' })
  const sessions = makeStore({ items: ['stale-s1'], phase: 'ready' })
  let generation
  const genListeners = []
  const generationFace = {
    getSnapshot: () => generation,
    subscribe(fn) { genListeners.push(fn); return () => { const i = genListeners.indexOf(fn); if (i !== -1) genListeners.splice(i, 1) } },
  }
  return {
    workspaces,
    sessions,
    generationFace,
    establish: (value = 'gen-2') => { generation = value; for (const fn of [...genListeners]) fn() },
    installWorkspaces: (items) => workspaces.install({ items }),
    installSessions: (items) => sessions.install({ items }),
  }
}

test('gate: a post-establishment replacement of BOTH lists fires once (workspaces first)', () => {
  const fx = cacheGateFixture()
  let fired = 0
  const dispose = observeCachesRefreshed(fx.workspaces, fx.sessions, fx.generationFace, () => { fired += 1 })
  fx.establish()
  fx.installWorkspaces(['fresh-ws'])
  assert.equal(fired, 0, 'the T-A gap: workspaces alone must not open the gate')
  fx.installSessions(['fresh-s1'])
  assert.equal(fired, 1, 'the both-lists all-clear')
  dispose()
})

test('gate: sessions landing later than workspaces is the same single fire (the live race, order flipped)', () => {
  const fx = cacheGateFixture()
  let fired = 0
  const dispose = observeCachesRefreshed(fx.workspaces, fx.sessions, fx.generationFace, () => { fired += 1 })
  fx.establish()
  fx.installSessions(['fresh-s1'])
  assert.equal(fired, 0, 'sessions alone do not open the gate either')
  fx.installWorkspaces(['fresh-ws'])
  assert.equal(fired, 1)
  dispose()
})

test('gate: pre-establishment churn (the old plane\'s dying increments) never counts', () => {
  const fx = cacheGateFixture()
  let fired = 0
  const dispose = observeCachesRefreshed(fx.workspaces, fx.sessions, fx.generationFace, () => { fired += 1 })
  fx.installWorkspaces(['old-plane-churn'])
  fx.installSessions(['old-plane-churn'])
  assert.equal(fired, 0, 'absorbed: the establishment re-anchor retakes both references')
  fx.establish()
  fx.installWorkspaces(['fresh-ws'])
  fx.installSessions(['fresh-s1'])
  assert.equal(fired, 1)
  dispose()
})

test('gate: same-reference notifications and non-ready phases do not count; the disposer stops it', () => {
  const fx = cacheGateFixture()
  let fired = 0
  const dispose = observeCachesRefreshed(fx.workspaces, fx.sessions, fx.generationFace, () => { fired += 1 })
  fx.establish()
  fx.workspaces.churnSameReference()
  fx.sessions.churnSameReference()
  fx.installWorkspaces(['fresh-ws'])
  fx.sessions.setPhase('pending') // non-ready: even a real replacement does not count
  fx.installSessions(['fresh-s1'])
  assert.equal(fired, 0, 'no ready phase on the sessions list → no all-clear')
  fx.sessions.install({ items: ['fresher-s1'], phase: 'ready' })
  assert.equal(fired, 1, 'the real replacement with a ready phase passes')
  dispose()
  fx.installSessions(['another-s1'])
  assert.equal(fired, 1, 'disposed: no further fires')
})

test('gate T-G: a non-member pointer holds the gate; a byId-only gain (same ids identity) opens it', () => {
  // Upstream publishRetention re-sets byId WITHOUT minting a new ids array
  // (service.ts:565) — membership must be consulted on EVERY sessions
  // notification, identity change or not, or such a gain would sit unseen
  // until the quiet ladder.
  const fx = cacheGateFixture()
  let fired = 0
  const members = new Set(['stale-s1'])
  const sessionsFace = {
    getSnapshot: (fx.sessions).getSnapshot,
    subscribe: (fx.sessions).subscribe,
    contains: (id) => members.has(id),
  }
  const quietTimers = []
  const dispose = observeCachesRefreshed(fx.workspaces, sessionsFace, fx.generationFace, () => { fired += 1 }, {
    pointerSessionId: () => 'wanted',
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; quietTimers.push(t); return t },
    clearTimeout: (t) => { t.cleared = true },
    quietMs: 1234,
  })
  fx.establish()
  fx.installWorkspaces(['fresh-ws'])
  fx.installSessions(['a1'])
  assert.equal(fired, 0, 'both lists fresh but the pointer is not a member — the gate holds')
  assert.equal(quietTimers.length, 1, 'the quiet window armed while holding')
  assert.equal(quietTimers[0].ms, 1234, 'the configured quiet window is what arms')
  members.add('wanted')
  fx.sessions.churnSameReference() // the publishRetention shape: membership gains, ids identity unchanged
  assert.equal(fired, 1, 'membership consulted on the same-identity notification')
  assert.equal(quietTimers[0].cleared, true, 'the quiet window is off once fired')
  dispose()
})

// ---- the __SUPERD_UI_FUSION__ baked global (review §4.6 双半边通道) ------
// The flag global must ride the SAME gated listener as the Task-3 transport
// script, so the two halves can never disagree: gate on → atom + patches +
// flag land together; gate off → nothing is emitted at all.

/** The emission harness: inject/ordered-listener semantics of a cordis ctx. */
function harness() {
  const injectCbs = []
  const listeners = []
  return {
    inject(_deps, cb) { injectCbs.push(cb) },
    on(_event, fn) { listeners.push(fn) },
    materialize() { for (const cb of [...injectCbs]) cb() },
    emit(table) { for (const fn of [...listeners]) fn(table) },
  }
}

test('gate on: the flag global rides the same listener as the transport script', () => {
  const ctx = harness()
  applyFusion(ctx, { enabled: true })
  ctx.materialize()
  const table = []
  ctx.emit(table)
  assert.equal(table.length, 2, 'exactly two rows: the transport script + the flag global')
  assert.equal(table[0].kind, 'script')
  assert.ok(table[0].text.includes('__SUPERD_UI_STATE__'), 'row one is the fusion transport')
  assert.deepEqual(table[1], { kind: 'global', name: FUSION_FLAG_GLOBAL, value: true })
  assert.equal(FUSION_FLAG_GLOBAL, '__SUPERD_UI_FUSION__')
})

test('gate off: neither half is emitted', () => {
  const ctx = harness()
  applyFusion(ctx, { enabled: false })
  ctx.materialize()
  const table = []
  ctx.emit(table)
  assert.equal(table.length, 0, 'a disabled row injects no script and no flag global')
  assert.equal(renderFusionTransport(), renderFusionTransport(), 'the script stays a constant')
})

// ---- the seat click-interception contract (review round 1; T-B keeps it) --
// Spec: 融合页 = state 切换（拦截 click，无导航）— on a fusion page a left
// click NEVER navigates, the already-active entry included (the old
// short-circuit let the anchor through: an `href="/"` reload discarding the
// in-page switch state, or a foreign href abandoning the fused page). The
// consumer maps `preventDefault` onto the DOM event; `attempt` stands for
// `attemptSwitch`, and its return value can never re-open navigation.
// T-B (user ruling: "strip off the old agent-selector, use the hub ui
// components"): the sidebar-bottom RuntimeSeat is retired and the Hub UI
// surfaces (HubPage rows + the HubPanelIcon chevron menu) become the sole
// consumers of this SAME table — the contract is inherited verbatim, which is
// exactly why the table outlives the seat.

test('seat click, non-fusion: no interception, no orchestration (inert — T-C retired the href arm)', () => {
  let attempts = 0
  const decide = (active) => seatClickDecision({
    fusion: false,
    active,
    attempt: () => { attempts += 1; return true },
  })
  assert.deepEqual(decide(false), { preventDefault: false, attempted: false })
  assert.deepEqual(decide(true), { preventDefault: false, attempted: false })
  assert.equal(attempts, 0, 'the table passes through; with no href there is simply nothing to navigate')
})

test('seat click, fusion + active entry: intercepted with no switch attempt (review round 1)', () => {
  let attempts = 0
  const decision = seatClickDecision({
    fusion: true,
    active: true,
    attempt: () => { attempts += 1; return true },
  })
  assert.deepEqual(decision, { preventDefault: true, attempted: false })
  assert.equal(attempts, 0, 'switching to the active agent is a no-op — but the click never navigates')
})

test('seat click, fusion + inactive entry: intercepted and the switch runs', () => {
  let attempts = 0
  const decision = seatClickDecision({
    fusion: true,
    active: false,
    attempt: () => { attempts += 1; return true },
  })
  assert.deepEqual(decision, { preventDefault: true, attempted: true })
  assert.equal(attempts, 1, 'exactly one orchestration attempt per click')
})

test('seat click, fusion + unbound orchestration: still intercepted, never navigated', () => {
  // attemptSwitch() reporting false must not hand the click back to the
  // anchor: the fused page is not abandoned on a left click (review round
  // 1); the href survives for middle-click / open-in-new-tab / copy link.
  const decision = seatClickDecision({ fusion: true, active: false, attempt: () => false })
  assert.deepEqual(decision, { preventDefault: true, attempted: false })
})

// ---- the Hub UI row active-indication (T-B) -------------------------------
// RuntimeSeat retired; the Hub surfaces are the sole switch surface. They
// inherit the decision table above and add one indication fact: which roster
// row shows as the active agent. Fusion pages read the page atom's
// `activeAgent` (the switch state — the URL is irrelevant on a fused page);
// world pages keep the interim mount-path arm (T-C deletes it).

test('hub row active, fusion: the atom activeAgent decides by key — native included', () => {
  assert.equal(hubRowActive({ fusion: true, agentKey: 'omp', agentPath: '/omp/', activeAgent: 'omp', mountPath: '/' }), true)
  assert.equal(hubRowActive({ fusion: true, agentKey: 'codex', agentPath: '/codex/', activeAgent: 'omp', mountPath: '/' }), false)
  assert.equal(hubRowActive({ fusion: true, agentKey: 'native', agentPath: '/', activeAgent: 'native', mountPath: '/' }), true,
    'the native entry is a switch target like any other')
  assert.equal(hubRowActive({ fusion: true, agentKey: 'native', agentPath: '/', activeAgent: 'omp', mountPath: '/' }), false)
})

test('hub row active, fusion: no atom reading (undefined) matches nothing', () => {
  assert.equal(hubRowActive({ fusion: true, agentKey: 'omp', agentPath: '/omp/', activeAgent: undefined, mountPath: '/' }), false)
  assert.equal(hubRowActive({ fusion: true, agentKey: 'native', agentPath: '/', activeAgent: undefined, mountPath: '/' }), false)
})

test('hub row active, non-fusion: the mount path decides (contract arm; the UI href is retired since T-C)', () => {
  assert.equal(hubRowActive({ fusion: false, agentKey: 'omp', agentPath: '/omp/', activeAgent: undefined, mountPath: '/omp/' }), true)
  assert.equal(hubRowActive({ fusion: false, agentKey: 'omp', agentPath: '/omp/', activeAgent: undefined, mountPath: '/codex/' }), false)
  assert.equal(hubRowActive({ fusion: false, agentKey: 'native', agentPath: '/', activeAgent: undefined, mountPath: '/' }), true)
})

test('T-B composition: a Hub row click runs the SAME table the seat ran', () => {
  // Exactly the wiring the HubPage rows and the HubPanelIcon menu use:
  // hubRowActive feeds `active`, attemptSwitch stands behind `attempt`, and
  // preventDefault maps onto the DOM event. Pinned end-to-end at the pure
  // layer so the two surfaces cannot drift from the inherited contract.
  const wiring = ({ fusion, activeAgent, agentKey, agentPath, mountPath, bound }) => {
    const active = hubRowActive({ fusion, agentKey, agentPath, activeAgent, mountPath })
    let attempts = 0
    const decision = seatClickDecision({
      fusion,
      active,
      attempt: () => { attempts += 1; return bound },
    })
    return { preventDefault: decision.preventDefault, attempted: decision.attempted, attempts }
  }
  // Fusion, inactive entry, bound orchestration: intercepted + switched.
  assert.deepEqual(
    wiring({ fusion: true, activeAgent: 'native', agentKey: 'omp', agentPath: '/omp/', mountPath: '/', bound: true }),
    { preventDefault: true, attempted: true, attempts: 1 },
  )
  // Fusion, active entry (native active, native row): intercepted, NO attempt.
  assert.deepEqual(
    wiring({ fusion: true, activeAgent: 'native', agentKey: 'native', agentPath: '/', mountPath: '/', bound: true }),
    { preventDefault: true, attempted: false, attempts: 0 },
  )
  // Fusion, unbound orchestration: intercepted, click swallowed, no navigation.
  assert.deepEqual(
    wiring({ fusion: true, activeAgent: 'native', agentKey: 'omp', agentPath: '/omp/', mountPath: '/', bound: false }),
    { preventDefault: true, attempted: false, attempts: 1 },
  )
  // World page (interim arm): plain hyperlink, no interception, no attempt.
  assert.deepEqual(
    wiring({ fusion: false, activeAgent: undefined, agentKey: 'omp', agentPath: '/omp/', mountPath: '/', bound: true }),
    { preventDefault: false, attempted: false, attempts: 0 },
  )
})

// ---- the sidebar row selector + machine grouping (native-workspace-look) ---
// The hub row reads the constant `Hub` on every page: the active agent no
// longer appends to the label (`Hub > <name>` was round 1) — it rides the
// row's right-edge selector, whose runtime mark sits beside its chevron
// (HubPanelIcon), and whose `title` names it via `activeAgentName`. The
// selector's menu groups the roster by machine (`AgentLink.machine` — carried
// on the wire, defaulted to 'local' once at the roster parse boundary) as one
// heading row per machine group, the way the native workspace list groups its
// sections. Pure halves pinned here; the visual treatment lives in
// HubPanelIcon, the registration (constant label — no re-registration push)
// in client/index.ts.

test('active agent name: the roster label decides, unknown keys degrade to the raw key', () => {
  const roster = [
    { key: 'native', label: 'DSH', path: '/', machine: 'local' },
    { key: 'codex', label: 'Codex', path: '/codex/', machine: 'local' },
  ]
  assert.equal(activeAgentName('native', roster), 'DSH')
  assert.equal(activeAgentName('codex', roster), 'Codex')
  assert.equal(activeAgentName('mystery', roster), 'mystery', 'an unbaked key still names itself')
  assert.equal(activeAgentName(undefined, roster), undefined)
  assert.equal(activeAgentName('', roster), undefined)
})

test('selector title: the atom key resolves through the roster (the wiring HubPanelIcon runs)', () => {
  // Round 2: the name is the selector's `title`, never a row-label suffix —
  // the row label is the constant `Hub` and the entry registers once.
  const roster = [{ key: 'native', label: 'DSH', path: '/', machine: 'local' }, { key: 'omp', label: 'OMP', path: '/omp/', machine: 'local' }]
  const title = (key) => {
    const name = activeAgentName(key, roster)
    return name === undefined ? 'Agent selector' : `Agent selector: ${name}`
  }
  assert.equal(title('native'), 'Agent selector: DSH')
  assert.equal(title('omp'), 'Agent selector: OMP')
  assert.equal(title(undefined), 'Agent selector', 'flag off: the bare affordance name')
})

test('machine group key: the row\'s own machine — no helper fallback (the parse boundary owns the default)', () => {
  assert.equal(machineGroup({ key: 'omp', label: 'OMP', path: '/omp/', machine: 'local' }), 'local')
  assert.equal(machineGroup({ key: 'omp', label: 'OMP', path: '/omp/', machine: 'dev3' }), 'dev3')
})

test('machine grouping: one group per machine, first-appearance order, members keep roster order', () => {
  const rows = [
    { key: 'native', label: 'DSH', path: '/', machine: 'local' },
    { key: 'codex', label: 'Codex', path: '/codex/', machine: 'dev3' },
    { key: 'omp', label: 'OMP', path: '/omp/', machine: 'local' },
    { key: 'claude', label: 'Claude', path: '/claude/', machine: 'dev3' },
    { key: 'pi', label: 'Pi', path: '/pi/', machine: 'lab2' },
  ]
  assert.deepEqual(machineGroups(rows), [
    { machine: 'local', agents: [rows[0], rows[2]] },
    { machine: 'dev3', agents: [rows[1], rows[3]] },
    { machine: 'lab2', agents: [rows[4]] },
  ])
})

test('machine grouping: two machines → two groups — the heading and divider render between them', () => {
  // The wire's live shape now (roster carries machine): this machine's rows
  // plus a foreign machine's. HubPanelIcon turns each group into a heading row
  // (the machine name) followed by its entries, with a separator row before
  // every group after the first — the native view-options menu's own shape.
  const rows = [
    { key: 'native', label: 'DSH', path: '/', machine: 'local' },
    { key: 'codex', label: 'Codex', path: '/codex/', machine: 'dev3' },
    { key: 'omp', label: 'OMP', path: '/omp/', machine: 'dev3' },
  ]
  const groups = machineGroups(rows)
  assert.deepEqual(groups, [
    { machine: 'local', agents: [rows[0]] },
    { machine: 'dev3', agents: [rows[1], rows[2]] },
  ])
  assert.ok(groups.length > 1, 'more than one group → the menu draws a heading + divider per group after the first')
})

test('machine grouping: an all-local roster (the wire\'s today shape) is ONE group in roster order', () => {
  const rows = [
    { key: 'native', label: 'DSH', path: '/', machine: 'local' },
    { key: 'codex', label: 'Codex', path: '/codex/', machine: 'local' },
  ]
  assert.deepEqual(machineGroups(rows), [{ machine: 'local', agents: rows }])
  assert.deepEqual(machineGroups([]), [])
})

// ---- the flag-off Hub-rows shape (path-separation Part 2, T-E closeout) ---
// Flag OFF on a ctx0 page = NO foreign entry at all (T-C retired the
// /<label>/ routes, T-D retired the world web UIs — there is nothing a row
// could navigate to). The chosen shape: the roster stays informational, but
// the switch affordance does NOT render — inert rows + the visible
// degradation hint, never a silently dead control, and no hrefs ship in the
// Hub UI at all (the delivered-artifact red line is pinned in
// fusion-flag.test.mjs).

test('switch affordance, fusion page: available — the sole switch surface renders', () => {
  assert.deepEqual(switchAffordance(true), { available: true, hint: '' })
})

test('switch affordance, flag off: unavailable with the degradation hint — never a dead control', () => {
  assert.deepEqual(switchAffordance(false), { available: false, hint: FUSION_OFF_HINT })
  assert.ok(FUSION_OFF_HINT.includes('fusion off'), 'the hint names the degradation itself')
  assert.ok(FUSION_OFF_HINT.includes('no foreign entry'), 'the hint states the flag-off reality: no foreign entry exists')
})

// ---- C1: the switch pre-flight (readiness gate) ----------------------------

test('decidePreFlight: native and unknown rows run; failed reports; not-ready waits', () => {
  assert.equal(decidePreFlight('native', undefined), 'run')
  assert.equal(decidePreFlight('pi', undefined), 'run', 'roster miss defers to the machine probe')
  assert.equal(decidePreFlight('pi', { ready: true, failed: false }), 'run')
  assert.equal(decidePreFlight('pi', { ready: false, failed: true }), 'failed')
  assert.equal(decidePreFlight('pi', { ready: false }), 'wait')
  assert.equal(decidePreFlight('pi', {}), 'wait', 'absent ready (older host shape) waits')
})

test('readiness waiter: polls until the row flips ready', async () => {
  const rows = [{ ready: false }, { ready: false }, { ready: true }]
  const timers = []
  let i = 0
  const w = createReadinessWaiter({
    fetchRow: async () => rows[Math.min(i++, rows.length - 1)],
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    clearTimeout: () => {},
  }, { pollMs: 1 })
  const done = w.wait('pi')
  // timers[0] is the BOUND — never fire it; each round drives only the
  // newest timer (the poll).
  for (let round = 0; round < 2; round++) {
    await Promise.resolve(); await Promise.resolve()  // let the fetchRow settle
    timers[timers.length - 1]()                       // drive the newest poll
  }
  await Promise.resolve(); await Promise.resolve()
  assert.equal(await done, 'ready')
})

test('readiness waiter: failed short-circuits; bound expires; cancel wins', async () => {
  const mk = (row) => {
    const timers = []
    return { timers, w: createReadinessWaiter({
      fetchRow: async () => row,
      setTimeout: (fn) => { timers.push(fn); return timers.length },
      clearTimeout: () => {},
    }, { boundMs: 100, pollMs: 1 }) }
  }
  let a = mk({ failed: true })
  let d = a.w.wait('pi')
  await Promise.resolve(); await Promise.resolve()
  assert.equal(await d, 'failed')

  let b = mk({ ready: false })
  d = b.w.wait('pi')
  await Promise.resolve(); await Promise.resolve()
  b.timers.splice(0).forEach((fn) => fn())          // first timer is the bound
  assert.equal(await d, 'bound')

  let c = mk({ ready: false })
  d = c.w.wait('pi')
  await Promise.resolve(); await Promise.resolve()
  c.w.cancel()
  assert.equal(await d, 'cancelled')
})
