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
  createSwitchController,
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
  let genListeners = []
  const timers = []
  const storage = new Map([['dsh.sessions.current', JSON.stringify({ sessionId: 'native-s1' })]])
  // The patched Storage reads its namespace at call time from the atom — the
  // fake mirrors exactly that: the read resolves against the active label.
  let active = 'native'
  const host = {
    setAgent(label) { active = label; log.setAgent.push(label) },
    readPersistedSelection() { return storage.get(namespacedKey(active, SESSIONS_CURRENT_KEY)) ?? null },
    openSession(target) { log.openSession.push(target) },
    openNewChat() { log.openNewChat.push(true) },
    reconnect() { log.reconnect.push(true) },
    onGenerationEstablished(fn) { genListeners.push(fn); return () => { genListeners = genListeners.filter((f) => f !== fn) } },
    probeTarget() { return Promise.resolve(true) },
    toast(message) { log.toast.push(message) },
    setTimeout(fn, ms) { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimeout(t) { t.cleared = true },
    ...overrides,
  }
  return {
    host,
    log,
    timers,
    setStored(label, raw) { storage.set(namespacedKey(label, SESSIONS_CURRENT_KEY), raw) },
    establish: () => { for (const fn of [...genListeners]) fn() },
    generationListeners: () => genListeners.length,
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

test('no value / read failure → new chat landing, old content stays (no clearing calls)', async () => {
  for (const setup of [(fx) => null, (fx) => fx.setStored('omp', 'garbage{')]) {
    const fx = fakeHost()
    setup(fx)
    const done = createSwitchController(fx.host).run('omp')
    assert.deepEqual(fx.log.openSession, [])
    assert.deepEqual(fx.log.openNewChat, [true], 'blank-session landing')
    fx.establish()
    await done
  }
})

test('openSession throwing degrades to the new-chat landing, never out of run()', async () => {
  const fx = fakeHost({ openSession() { throw new Error('retain failed') } })
  fx.setStored('omp', JSON.stringify({ sessionId: 'omp-s7' }))
  const done = createSwitchController(fx.host).run('omp')
  assert.deepEqual(fx.log.openNewChat, [true])
  fx.establish()
  await done
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
