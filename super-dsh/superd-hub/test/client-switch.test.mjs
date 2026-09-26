// Client switch (native-ui-fusion Task 4): the pure orchestration core behind
// the in-page agent switch — storage-namespace key computation, the session
// landing decision table (persisted 'dsh.sessions.current' under the target
// NS), and the fallback state machine (timeout / roster-probe failure →
// revert to native + toast, never a page lock).
//
// switch-core.ts is a host-half module (plain TS, no DOM, no client imports)
// precisely so node tests can import it from dist — the client-shim precedent
// in reverse: pure logic lives where tsc emits, the DOM/connection face is
// injected. Seat DOM behavior is verified on the pack line (Task 6).
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NATIVE_AGENT,
  SESSIONS_CURRENT_KEY,
  SWITCH_FALLBACK_MS,
  namespacedKey,
  storageNamespace,
  parseLandingTarget,
  seatClickDecision,
  hubRowActive,
  createSwitchController,
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

// ---- landing decision table ----------------------------------------------

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

// ---- fallback state machine ----------------------------------------------

/** A fully observable fake host: every effect is recorded, time is manual. */
function fakeHost(overrides = {}) {
  const log = { setAgent: [], openSession: [], openNewChat: [], reconnect: [], toast: [] }
  const seq = []
  let genListeners = []
  let cacheListeners = []
  const timers = []
  const storage = new Map([['dsh.sessions.current', JSON.stringify({ sessionId: 'native-s1' })]])
  // The patched Storage reads its namespace at call time from the atom — the
  // fake mirrors exactly that: the read resolves against the active label.
  let active = 'native'
  const host = {
    setAgent(label) { active = label; log.setAgent.push(label); seq.push(`setAgent:${label}`) },
    readPersistedSelection() { return storage.get(namespacedKey(active, SESSIONS_CURRENT_KEY)) ?? null },
    openSession(target) { log.openSession.push(target); seq.push(`openSession:${JSON.stringify(target)}`) },
    openNewChat() { log.openNewChat.push(true); seq.push('openNewChat') },
    reconnect() { log.reconnect.push(true); seq.push('reconnect') },
    onGenerationEstablished(fn) { genListeners.push(fn); return () => { genListeners = genListeners.filter((f) => f !== fn) } },
    onCachesRefreshed(fn) { cacheListeners.push(fn); return () => { cacheListeners = cacheListeners.filter((f) => f !== fn) } },
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
    establish: () => { for (const fn of [...genListeners]) fn() },
    generationListeners: () => genListeners.length,
    refreshCaches: () => { for (const fn of [...cacheListeners]) fn() },
    cacheListeners: () => cacheListeners.length,
    fireTimer: (t) => { if (!t.cleared) t.fn() },
  }
}

test('happy path: setAgent → land on the target NS session → reconnect → settle on generation', async () => {
  const fx = fakeHost()
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-s7' }))
  const done = createSwitchController(fx.host).run('omp')
  assert.deepEqual(fx.log.setAgent, ['omp'], 'state + NS swap first')
  assert.deepEqual(fx.log.openSession, ['omp-s7'], 'lands on the persisted target session')
  assert.deepEqual(fx.log.openNewChat, [], 'no new chat when a session was navigable')
  assert.deepEqual(fx.log.reconnect, [true], 'reconnect after landing')
  assert.equal(fx.timers.length, 1, 'fallback timer armed')
  assert.equal(fx.generationListeners(), 1, 'generation subscription armed')
  fx.establish()
  await done
  assert.deepEqual(fx.log.toast, [], 'no toast on success')
  assert.equal(fx.timers[0].cleared, true, 'fallback timer disarmed')
  assert.equal(fx.generationListeners(), 0, 'generation subscription released')
})

test('no value / read failure → new chat landing deferred to fresh caches, old content stays (no clearing calls)', async () => {
  for (const setup of [(fx) => null, (fx) => fx.setStored('omp', 'garbage{')]) {
    const fx = fakeHost()
    setup(fx)
    const done = createSwitchController(fx.host).run('omp')
    assert.deepEqual(fx.log.openSession, [])
    assert.deepEqual(fx.log.openNewChat, [], 'nothing lands before the target plane caches are fresh')
    fx.refreshCaches()
    assert.deepEqual(fx.log.openNewChat, [true], 'blank-session landing after the cache refresh')
    assert.deepEqual(fx.log.openSession, [], 'the previous agent session id is never re-opened')
    fx.establish()
    await done
  }
})

test('openSession throwing degrades to the deferred new-chat landing, never out of run()', () => {
  const fx = fakeHost({ openSession() { throw new Error('retain failed') } })
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-s7' }))
  const done = createSwitchController(fx.host).run('omp')
  assert.deepEqual(fx.log.openNewChat, [])
  fx.refreshCaches()
  assert.deepEqual(fx.log.openNewChat, [true])
  fx.establish()
  return done.then(() => {})
})

test('native switch: same path over the bare NS', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('native')
  assert.deepEqual(fx.log.setAgent, ['native'])
  assert.deepEqual(fx.log.openSession, ['native-s1'], 'native persisted session re-landed')
  fx.establish()
  await done
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
  assert.equal(fx.generationListeners(), 0, 'subscription released on revert')
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

// ---- T-A: the new-chat landing never resolves the previous agent's workspace
// Live-acceptance defect (2026-09-26): with no valid per-agent NS pointer the
// landing ran BEFORE reconnect, so upstream `startSession()` resolved
// `currentWorkspaceId ?? recent` from wire-derived caches still holding the
// PREVIOUS agent's plane → `workspace/not-found` toast + the view pinned to
// the dead previous session id. The new-chat landing therefore defers until
// the target plane's caches are fresh; the pointer landing stays immediate
// (session-targeted, no workspace resolution — the clean round-4 behavior).

test('matrix native→foreign, no pointer: new-chat landing fires only after reconnect + fresh caches', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('omp')
  assert.deepEqual(fx.seq, ['setAgent:omp', 'reconnect'], 'no landing before the plane is retargeted')
  fx.refreshCaches()
  assert.deepEqual(fx.seq, ['setAgent:omp', 'reconnect', 'openNewChat'], 'landing rides the cache refresh')
  fx.establish()
  await done
  assert.deepEqual(fx.log.openSession, [], 'the red line: never navigates to the previous agent session')
  assert.deepEqual(fx.log.toast, [], 'no failure feedback on the happy path')
})

test('matrix foreign→foreign, no pointer: same deferral across worlds', async () => {
  const fx = fakeHost()
  fx.setStored('omp', 'garbage{') // omp NS holds no usable pointer
  const done = createSwitchController(fx.host).run('codex')
  assert.deepEqual(fx.log.setAgent, ['codex'])
  assert.deepEqual(fx.log.openNewChat, [], 'no stale landing while the codex plane caches are stale')
  fx.refreshCaches()
  assert.deepEqual(fx.log.openNewChat, [true])
  fx.establish()
  await done
})

test('matrix foreign→native, no pointer: deferral applies on the way home too', async () => {
  const fx = fakeHost()
  fx.setStored('native', null) // bare NS, no pointer
  const done = createSwitchController(fx.host).run('native')
  assert.deepEqual(fx.log.openNewChat, [], 'native plane caches are equally stale right after setAgent')
  fx.refreshCaches()
  assert.deepEqual(fx.log.openNewChat, [true])
  fx.establish()
  await done
})

test('matrix native↔foreign with pointer: landing is immediate and pre-reconnect (round-4 behavior unchanged)', async () => {
  const fx = fakeHost()
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-s7' }))
  const done = createSwitchController(fx.host).run('omp')
  assert.deepEqual(fx.seq, ['setAgent:omp', 'openSession:"omp-s7"', 'reconnect'],
    'pointer landing precedes reconnect, exactly as today')
  assert.deepEqual(fx.log.openNewChat, [], 'no new-chat detour')
  assert.equal(fx.cacheListeners(), 0, 'no cache subscription armed for a pointer landing')
  fx.establish()
  await done
})

test('settle before caches refresh: the deferred landing still fires after establishment', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('omp')
  fx.establish() // generation first, baseline later
  await done
  assert.deepEqual(fx.log.openNewChat, [], 'settle alone does not land')
  fx.refreshCaches()
  assert.deepEqual(fx.log.openNewChat, [true], 'the pending landing survives the settle')
})

test('timeout revert cancels the pending landing: a later refresh is inert (red line)', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('omp')
  fx.fireTimer(fx.timers[0])
  await done
  assert.deepEqual(fx.log.setAgent, ['omp', 'native'], 'reverted to native')
  assert.equal(fx.log.toast.length, 1)
  fx.refreshCaches()
  assert.deepEqual(fx.log.openNewChat, [], 'no landing after the revert — the machine stays consistent')
  assert.equal(fx.cacheListeners(), 0, 'landing subscription released')
})

test('probe-failure revert cancels the pending landing', async () => {
  const fx = fakeHost({ probeTarget: () => Promise.resolve(false) })
  const done = createSwitchController(fx.host).run('omp')
  await done
  fx.refreshCaches()
  assert.deepEqual(fx.log.openNewChat, [], 'a reverted switch never lands')
  assert.deepEqual(fx.log.setAgent, ['omp', 'native'])
})

test('supersede cancels the prior attempt\'s pending landing', async () => {
  const fx = fakeHost()
  fx.setStored('codex', JSON.stringify({ sessionId: 'codex-s2' }))
  const controller = createSwitchController(fx.host)
  const first = controller.run('omp') // no pointer → deferred
  const second = controller.run('codex') // pointer → immediate
  await first
  assert.deepEqual(fx.log.openSession, ['codex-s2'])
  fx.refreshCaches()
  assert.deepEqual(fx.log.openNewChat, [], 'the superseded attempt must not land')
  fx.establish()
  await second
  assert.deepEqual(fx.log.toast, [], 'supersede stays silent')
})

test('the deferred landing fires exactly once', async () => {
  const fx = fakeHost()
  const done = createSwitchController(fx.host).run('omp')
  fx.refreshCaches()
  fx.refreshCaches()
  fx.establish()
  await done
  assert.deepEqual(fx.log.openNewChat, [true], 'one cache edge, one landing; further edges are inert')
})

test('openNewChat throwing never escapes run(); the machine still settles consistently', async () => {
  const fx = fakeHost({ openNewChat() { throw new Error('startSession exploded') } })
  const done = createSwitchController(fx.host).run('omp')
  fx.refreshCaches()
  fx.establish()
  await done
  assert.deepEqual(fx.log.toast, [], 'a failed landing is upstream-reported, not a revert')
  assert.deepEqual(fx.log.setAgent, ['omp'], 'no revert: the switch itself succeeded')
})

// ---- the caches-fresh gate (host-half pure factory) -----------------------
// The client binding composes this with the real `workspaces.list` store +
// the connection generation observable. Semantics: fire when the store's
// items array is REPLACED (a baseline install always mints a new array) with
// a ready phase, where the anchor is re-taken at every generation
// establishment — so the dying old plane's last increments can never pass.

/** A minimal fake of the workspace store + generation observable pair. */
function cacheGateFixture() {
  const listeners = []
  const genListeners = []
  let items = ['stale-ws']
  let phase = 'ready'
  let generation
  const list = {
    getSnapshot: () => ({ items, phase }),
    subscribe(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1) } },
  }
  const generationFace = {
    getSnapshot: () => generation,
    subscribe(fn) { genListeners.push(fn); return () => { const i = genListeners.indexOf(fn); if (i !== -1) genListeners.splice(i, 1) } },
  }
  return {
    list,
    generationFace,
    establish: (value = 'gen-2') => { generation = value; for (const fn of [...genListeners]) fn() },
    installBaseline: (next) => { items = next; for (const fn of [...listeners]) fn() },
    sameArrayChurn: () => { for (const fn of [...listeners]) fn() },
    setPhase: (p) => { phase = p; for (const fn of [...listeners]) fn() },
  }
}

test('gate: a post-establishment baseline replacement fires once', () => {
  const fx = cacheGateFixture()
  let fired = 0
  const dispose = observeCachesRefreshed(fx.list, fx.generationFace, () => { fired += 1 })
  fx.establish()
  fx.installBaseline(['fresh-ws'])
  assert.equal(fired, 1, 'the target plane baseline is the all-clear')
  dispose()
})

test('gate: pre-establishment churn (the old plane\'s dying increments) never fires', () => {
  const fx = cacheGateFixture()
  let fired = 0
  const dispose = observeCachesRefreshed(fx.list, fx.generationFace, () => { fired += 1 })
  fx.installBaseline(['old-plane-churn']) // items replaced BEFORE establishment
  assert.equal(fired, 0, 'absorbed: the establishment re-anchor retakes the reference')
  fx.establish()
  fx.installBaseline(['fresh-ws'])
  assert.equal(fired, 1)
  dispose()
})

test('gate: same-reference notifications and non-ready phases do not fire; the disposer stops it', () => {
  const fx = cacheGateFixture()
  let fired = 0
  const dispose = observeCachesRefreshed(fx.list, fx.generationFace, () => { fired += 1 })
  fx.sameArrayChurn()
  fx.establish()
  fx.sameArrayChurn()
  fx.setPhase('pending')
  fx.installBaseline(['fresh-ws'])
  assert.equal(fired, 0, 'no reference change, no ready phase → no all-clear')
  fx.setPhase('ready')
  assert.equal(fired, 1, 'the baseline install with ready phase passes')
  dispose()
  fx.installBaseline(['another-ws'])
  assert.equal(fired, 1, 'disposed: no further fires')
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

test('seat click, world page: no interception, no orchestration', () => {
  let attempts = 0
  const decide = (active) => seatClickDecision({
    fusion: false,
    active,
    attempt: () => { attempts += 1; return true },
  })
  assert.deepEqual(decide(false), { preventDefault: false, attempted: false })
  assert.deepEqual(decide(true), { preventDefault: false, attempted: false })
  assert.equal(attempts, 0, 'the URL is the state — the real hyperlinks stay in charge')
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

test('hub row active, world page: the mount path decides (interim arm; T-C deletes it)', () => {
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
