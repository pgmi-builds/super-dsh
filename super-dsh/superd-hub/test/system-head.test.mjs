// Protected system-surface head co-writer: the v4 session format requires a
// system/message to sit inside an open matching turn+step AND to be the
// surface's first node (protected head) or replace one. Driven against a fake
// session that reproduces the append contract; the event streams are then
// re-validated with the reader's own state rules (mirrored assertions).
import test from 'node:test'
import assert from 'node:assert/strict'
import { withSystemHead } from '../dist/system-head.js'

/** Minimal fake session reproducing the surface-append contract. */
function fakeSession() {
  const events = []
  let seq = 0
  return {
    id: 'session-fake',
    events,
    append(type, data, opts) {
      const event = { type, seq: seq++, time: 0, data, ...(opts ?? {}) }
      events.push(event)
      return event
    },
    snapshotEvents() {
      return events
    },
  }
}

/** Reader-side mirror of the v4 step/head machine: throws on violations. */
function validateReader(events) {
  let turn = null, step = null, nextStep = 1, head
  const surface = []
  for (const event of events) {
    const d = event.data ?? {}
    if (event.type === 'system/message' || event.type === 'developer/message' || event.type === 'assistant/attempt') {
      if (turn === null || step === null || d.turn !== turn || d.step !== step) {
        throw new Error(`reader: ${event.type}@${event.seq} does not match an open turn and step (${turn}/${step})`)
      }
    }
    if (event.type === 'system/message' && surface.length > 0 && head === undefined) {
      throw new Error(`reader: system/message@${event.seq} requires a protected first surface head`)
    }
    if (event.surfaceOp !== undefined) {
      if (event.surfaceOp === 'append') {
        if (event.type === 'system/message' && surface.length === 0) head = event.seq
        surface.push(event.seq)
      } else {
        const first = surface.indexOf(event.surfaceOp.startSeq)
        const last = surface.indexOf(event.surfaceOp.endSeq)
        if (first < 0 || last < first) throw new Error(`reader: ${event.type}@${event.seq} replacement range is not on the current surface`)
        const removed = surface.slice(first, last + 1)
        if (removed.some(s => !(event.sourceEventSeqs ?? []).includes(s))) throw new Error(`reader: replacement sourceEventSeqs omit a shadowed node`)
        if (head !== undefined && removed.includes(head)) {
          if (event.type !== 'system/message' || removed.length !== 1) throw new Error(`reader: replacement cannot shadow the protected system head`)
          head = event.seq
        }
        surface.splice(first, removed.length, event.seq)
      }
    }
    switch (event.type) {
      case 'turn/start':
        if (turn !== null || d.turn !== undefined && false) throw new Error('reader: turn/start does not open the expected turn')
        turn = d.turn; nextStep = 1; break
      case 'step/start':
        if (turn === null || step !== null || d.step !== nextStep) throw new Error(`reader: step/start@${event.seq} does not match the open turn and next step (want ${nextStep})`)
        step = nextStep; break
      case 'step/end':
        if (turn === null || step === null || d.turn !== turn || d.step !== step) throw new Error(`reader: step/end@${event.seq} does not match the open turn and step`)
        step = null; nextStep += 1; break
      case 'turn/end':
        if (turn === null || step !== null) throw new Error(`reader: turn/end@${event.seq} does not match the open turn with no open step`)
        turn = null; break
      default: break
    }
  }
}

test('the first user message opens the step, lands the placeholder head, then the message', () => {
  const session = fakeSession()
  const wrapped = withSystemHead(session, () => ({ role: 'system', content: [], id: 'x', source: { kind: 'system-prompt' } }))
  wrapped.append('turn/start', { turn: 1 })
  wrapped.append('request/context', { provider: 'p', model: 'm' })
  wrapped.append('user/message', { content: [] }, { surfaceOp: 'append' })
  assert.deepEqual(session.events.map(e => e.type), [
    'turn/start', 'request/context', 'step/start', 'system/message', 'user/message',
  ], 'native shape: step/start → system head → user message')
  assert.deepEqual(session.events[3].data, {
    turn: 1, step: 1, message: { role: 'system', content: [], id: 'x', source: { kind: 'system-prompt' } },
  })
  validateReader(session.events)
})

test("the adapter's duplicate step/start for the wrap-opened step is dropped, the turn still closes legally", () => {
  const session = fakeSession()
  const wrapped = withSystemHead(session, () => ({ role: 'system', content: [], id: 'x', source: { kind: 'system-prompt' } }))
  wrapped.append('turn/start', { turn: 1 })
  wrapped.append('user/message', { content: [] }, { surfaceOp: 'append' })
  const dropped = wrapped.append('step/start', { turn: 1, step: 1 }) // the adapter's own open
  assert.equal(session.events.filter(e => e.type === 'step/start').length, 1, 'no duplicate step/start in the log')
  assert.equal(dropped.type, 'step/start', 'the adapter still receives an event-shaped return')
  wrapped.append('assistant/message', { content: [] }, { surfaceOp: 'append' })
  wrapped.append('step/end', { turn: 1, step: 1 })
  wrapped.append('turn/end', { turn: 1 })
  validateReader(session.events)
})

test('a wrap-opened step still open at turn/end is closed just before it', () => {
  const session = fakeSession()
  const wrapped = withSystemHead(session, () => ({ role: 'system', content: [], id: 'x', source: { kind: 'system-prompt' } }))
  wrapped.append('turn/start', { turn: 1 })
  wrapped.append('user/message', { content: [] }, { surfaceOp: 'append' })
  wrapped.append('turn/end', { turn: 1 }) // error branch: no adapter step ever opened
  const types = session.events.map(e => e.type)
  assert.deepEqual(types, ['turn/start', 'step/start', 'system/message', 'user/message', 'step/end', 'turn/end'])
  validateReader(session.events)
})

test('stampSystemPrompt replaces the placeholder inside the open step; later stamps replace the replacement', () => {
  const session = fakeSession()
  const wrapped = withSystemHead(session, () => ({ role: 'system', content: [], id: 'p', source: { kind: 'system-prompt' } }))
  wrapped.append('turn/start', { turn: 1 })
  wrapped.append('user/message', { content: [] }, { surfaceOp: 'append' })
  wrapped.append('step/start', { turn: 1, step: 1 }) // adapter's duplicate: dropped
  wrapped.stampSystemPrompt(1, 1, { role: 'system', content: [{ type: 'text', text: 'REAL' }], id: 'r', source: { kind: 'system-prompt' } })
  const stamp = session.events.at(-1)
  assert.equal(stamp.type, 'system/message')
  const placeholderSeq = session.events.find(e => e.type === 'system/message').seq
  assert.deepEqual(stamp.surfaceOp, { op: 'replace', startSeq: placeholderSeq, endSeq: placeholderSeq })
  wrapped.stampSystemPrompt(1, 1, { role: 'system', content: [{ type: 'text', text: 'UPDATED' }], id: 'u', source: { kind: 'system-prompt' } })
  const stamp2 = session.events.at(-1)
  assert.deepEqual(stamp2.surfaceOp, { op: 'replace', startSeq: stamp.seq, endSeq: stamp.seq })
  wrapped.append('assistant/message', { content: [] }, { surfaceOp: 'append' })
  wrapped.append('step/end', { turn: 1, step: 1 })
  wrapped.append('turn/end', { turn: 1 })
  validateReader(session.events)
})

test('a stamp with no open step is queued and flushed inside the next step the adapter opens', () => {
  const session = fakeSession()
  const wrapped = withSystemHead(session, () => ({ role: 'system', content: [], id: 'p', source: { kind: 'system-prompt' } }))
  wrapped.stampSystemPrompt(1, 1, { role: 'system', content: [{ type: 'text', text: 'BOOTSTRAP' }], id: 'b', source: { kind: 'system-prompt' } })
  assert.ok(session.events.every(e => e.type !== 'system/message'), 'nothing stamped outside a step')
  wrapped.append('turn/start', { turn: 1 })
  wrapped.append('step/start', { turn: 1, step: 1 })
  const flushed = session.events.find(e => e.type === 'system/message')
  assert.ok(flushed !== undefined, 'the queued stamp flushed inside the opened step')
  assert.match(JSON.stringify(flushed.data.message), /BOOTSTRAP/)
  wrapped.append('user/message', { content: [] }, { surfaceOp: 'append' })
  wrapped.append('step/end', { turn: 1, step: 1 })
  wrapped.append('turn/end', { turn: 1 })
  validateReader(session.events)
})

test('a resumed session with an existing head gets no placeholder and stamps replace the live head', () => {
  const session = fakeSession()
  const preexisting = session.append('turn/start', { turn: 1 })
  void preexisting
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: { role: 'system', content: [], id: 'old', source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
  const wrapped = withSystemHead(session, () => { throw new Error('placeholder must not be built') })
  wrapped.append('user/message', { content: [] }, { surfaceOp: 'append' })
  assert.equal(session.events.filter(e => e.type === 'system/message').length, 1, 'no extra head')
  wrapped.append('step/end', { turn: 1, step: 1 })
  wrapped.append('turn/end', { turn: 1 })
  validateReader(session.events)
})

test('a headless legacy surface (user first, no head) is never stamped — stays valid, not corrupted', () => {
  const session = fakeSession()
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', { content: [] }, { surfaceOp: 'append' })
  const before = session.events.length
  const wrapped = withSystemHead(session, () => ({ role: 'system', content: [], id: 'p', source: { kind: 'system-prompt' } }))
  wrapped.append('user/message', { content: [] }, { surfaceOp: 'append' })
  wrapped.stampSystemPrompt(1, 1, { role: 'system', content: [], id: 'q', source: { kind: 'system-prompt' } })
  assert.equal(session.events.length, before + 1, 'only the second user message; no system append ever')
  assert.ok(session.events.every(e => e.type !== 'system/message'))
  wrapped.append('step/end', { turn: 1, step: 1 })
  wrapped.append('turn/end', { turn: 1 })
  validateReader(session.events)
})

test('direct adapter system appends get step context (notice pattern)', () => {
  const session = fakeSession()
  const wrapped = withSystemHead(session, () => ({ role: 'system', content: [], id: 'p', source: { kind: 'system-prompt' } }))
  wrapped.append('turn/start', { turn: 1 })
  wrapped.append('user/message', { content: [] }, { surfaceOp: 'append' }) // opens step 1 + head
  // agy notice: turn open, adapter thinks step 0 — the wrap normalizes into the open step
  wrapped.append('system/message', { turn: 1, step: 0, message: { role: 'system', content: [{ type: 'text', text: 'notice' }], id: 'n', source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
  const notice = session.events.at(-1)
  assert.deepEqual({ turn: notice.data.turn, step: notice.data.step }, { turn: 1, step: 1 }, 'normalized into the open step')
  wrapped.append('turn/end', { turn: 1 })
  validateReader(session.events)
})

test('multi-turn flow: wrapper step accounting stays aligned across turns', () => {
  const session = fakeSession()
  const wrapped = withSystemHead(session, () => ({ role: 'system', content: [], id: 'p', source: { kind: 'system-prompt' } }))
  // turn 1 (full adapter flow)
  wrapped.append('turn/start', { turn: 1 })
  wrapped.append('user/message', { content: [] }, { surfaceOp: 'append' })
  wrapped.append('step/start', { turn: 1, step: 1 }) // dropped duplicate
  wrapped.stampSystemPrompt(1, 1, { role: 'system', content: [], id: 'a', source: { kind: 'system-prompt' } })
  wrapped.append('assistant/message', { content: [] }, { surfaceOp: 'append' })
  wrapped.append('step/end', { turn: 1, step: 1 })
  wrapped.append('turn/end', { turn: 1 })
  // turn 2 (adapter opens its own step this time)
  wrapped.append('turn/start', { turn: 2 })
  wrapped.append('step/start', { turn: 2, step: 1 })
  wrapped.append('user/message', { content: [] }, { surfaceOp: 'append' })
  wrapped.append('step/end', { turn: 2, step: 1 })
  wrapped.append('turn/end', { turn: 2 })
  validateReader(session.events)
  const stepStarts = session.events.filter(e => e.type === 'step/start')
  assert.deepEqual(stepStarts.map(e => e.data), [{ turn: 1, step: 1 }, { turn: 2, step: 1 }])
})

// ---------------------------------------------------------------- identity (D1)

/**
 * The upstream liveness gate session-title's rename() applies — verbatim
 * shape of packages/session/session-title/src/index.ts: a session is only
 * renamable when it IS the object the store registered.
 */
function renameLiveness(store, session) {
  if (store.get(session.id) !== session) {
    throw new Error(`session "${session.id}" is not live in this store`)
  }
}

test('D1 identity: withSystemHead returns the store-registered object itself — the upstream rename liveness check passes', () => {
  // The world shape (agent-pi/src/index.ts): sessions.prepare() mints the
  // session, the adapter enters THAT object into the store
  // (`agent.ctx.sessions.enter(session)` + announce), and the Agent handle's
  // `.session` is whatever withSystemHead returns. rename() then compares
  // ctx.sessions.get(id) === agent.session. A wrapper object (the pre-fix
  // Proxy) fails that check in EVERY world context.
  const session = fakeSession()
  const store = new Map([[session.id, session]]) // sessions.enter(session)
  const wrapped = withSystemHead(session, () => ({ role: 'system', content: [], id: 'x', source: { kind: 'system-prompt' } }))
  assert.equal(wrapped, session, 'withSystemHead must not manufacture a wrapper object')
  assert.doesNotThrow(() => renameLiveness(store, wrapped), 'the liveness identity the title service demands holds')
  // and the co-writer stays armed on that same object
  wrapped.append('turn/start', { turn: 1 })
  wrapped.append('user/message', { content: [] }, { surfaceOp: 'append' })
  assert.ok(session.events.some((e) => e.type === 'system/message'), 'placeholder head landed')
  validateReader(session.events)
})

test('D1 identity: upstream holders of the same session append through the co-writer transparently', () => {
  // After the fix the store's object and the agent's object are one, so an
  // upstream service resolving the session from the store also goes through
  // the interception — the rename path's own session/title append must pass
  // through byte-untouched.
  const session = fakeSession()
  const wrapped = withSystemHead(session, () => ({ role: 'system', content: [], id: 'x', source: { kind: 'system-prompt' } }))
  wrapped.append('turn/start', { turn: 1 })
  wrapped.append('user/message', { content: [] }, { surfaceOp: 'append' })
  const ev = wrapped.append('session/title', { title: 'Rename probe', messageSeqs: [], source: { kind: 'user' } })
  assert.equal(ev.type, 'session/title')
  assert.deepEqual(session.events.at(-1).data, { title: 'Rename probe', messageSeqs: [], source: { kind: 'user' } })
  validateReader(session.events)
})

test('D1 identity: wrapping is idempotent — a second withSystemHead returns the same armed object', () => {
  const session = fakeSession()
  const placeholder = () => ({ role: 'system', content: [], id: 'x', source: { kind: 'system-prompt' } })
  const first = withSystemHead(session, placeholder)
  const second = withSystemHead(session, placeholder)
  assert.equal(first, session)
  assert.equal(second, session)
})
