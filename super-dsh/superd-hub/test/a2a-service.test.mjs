// A2A conversation service (mesh P3 Task 2): registry persistence, send
// receipts, completion capture over the session/follow stream, stop scopes,
// and the bounded unread buffer — all against a scripted fake gateway whose
// recorded calls are asserted byte-exactly against the wire-endpoints mirrors.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createA2aService, A2A_MESSAGE_TEMPLATE, renderA2aEnvelope, A2A_BUFFER_MAX, loadConversations, saveConversations, shortIdFor } from '../dist/a2a-service.js'
import { WIRE } from '../dist/wire-endpoints.js'
import { EnvelopeError } from '../dist/envelope.js'

// ---------------------------------------------------------------- fixtures

/** Scripted fake gateway: a queue of rpc results / streams; every call recorded. */
function fakeGateway() {
  const calls = []
  const rpcScript = []
  const streamScript = []
  const face = {
    async dispatchRpc(endpoint, payload, signal) {
      calls.push({ kind: 'rpc', endpoint, payload })
      const next = rpcScript.shift() ?? { result: { ok: true, value: {} } }
      if (next.throw) throw next.throw
      return next.result
    },
    openWireStream(endpoint, payload, signal) {
      calls.push({ kind: 'stream', endpoint, payload })
      const next = streamScript.shift() ?? { end: true }
      return (async function*() {
        if (next.throw) throw next.throw
        if (!next.end) for (const frame of next.frames ?? []) yield frame
        if (next.die) throw next.die
        // stay open like a live follow stream until disposed/aborted
        await new Promise((_, reject) => {
          if (signal?.aborted) { reject(new Error('aborted')); return }
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      })()
    },
  }
  return {
    calls,
    rpc: (entry) => rpcScript.push(entry),
    stream: (entry) => streamScript.push(entry),
    face,
    streamOpens: () => calls.filter((c) => c.kind === 'stream').length,
    rpcs: (endpoint) => calls.filter((c) => c.kind === 'rpc' && c.endpoint === endpoint),
  }
}

const mkService = (gw, opts = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const svc = createA2aService({
    home,
    gatewayFor: (addr) => (addr.machine === 'nowhere' ? undefined : gw.face),
    now: () => 1234500,
    ...opts,
  })
  return { home, svc }
}

const ADDR = { machine: 'k3f9', id: 'q7m2xp' }
const INITIATOR = { machine: 'm1ab', agent: 'a2b3c4', sessionId: 'sess-init-1' }
const teaching = (i, title, shortId, message) =>
  `A2A message from ${i.machine}-${i.agent} (conversation "${title}", reply via SuperD Hub send with conversationId ${shortId}):\n\n${message}`

const seedConversation = (gw, sessionId = 'sess-gggggggg-7777') => {
  gw.rpc({ result: { ok: true, value: { sessionId } } })
}

// follow-stream frame builders (upstream SessionFollowFrame vocabulary)
const ev = (type, data, seq) => ({ type: 'event', event: { type, seq, time: 1, data } })
const snap = (records) => ({ type: 'snapshot', header: { version: 1, id: 's' }, cursor: 0, records, hasMore: false, projections: {} })
const userMsg = (rpcId, seq) => ev('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: 'in' }], source: { kind: 'user', rpcId, clientTimeZone: 'UTC' } }, seq)
const asstMsg = (turn, text, seq) => ev('assistant/message', { turn, step: 0, interrupted: false, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text }] }, stream: [] }, seq)
const turnEnd = (turn, seq, kind = 'completed') => ev('turn/end', { turn, reason: { kind } }, seq)

/** Poll until cond() is truthy (small steps, bounded wait). */
const until = async (cond, ms = 200) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('timed out')
}
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- newConversation

test('newConversation: create+rename payloads byte-exact per mirrors; row persisted 0600; shortId = first 6 of the id (prefix-free base)', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-aaaaaaaa-1111' } } })
  gw.rpc({ result: { ok: true, value: { title: 'Bug triage', seq: 3 } } })
  const { home, svc } = mkService(gw)
  try {
    const out = await svc.newConversation(ADDR, 'Bug triage')
    assert.equal(out.shortId, 'sess-a')
    assert.equal(out.sessionId, 'sess-aaaaaaaa-1111')
    assert.deepEqual(gw.rpcs(WIRE.sessionCreate).map((c) => c.payload), [{ args: { request: {} } }])
    assert.deepEqual(gw.rpcs(WIRE.sessionTitle).map((c) => c.payload), [{
      args: { request: { sessionId: 'sess-aaaaaaaa-1111', title: 'Bug triage' } },
    }])
    const rows = loadConversations(home).conversations
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], {
      shortId: 'sess-a', machine: ADDR.machine, agent: ADDR.id,
      sessionId: 'sess-aaaaaaaa-1111', title: 'Bug triage',
      createdAt: 1234500, lastActivityAt: 1234500,
    })
    assert.equal(statSync(join(home, 'superd', 'a2a-conversations.json')).mode & 0o777, 0o600)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('newConversation: no title → no rename call; gateway missing → typed error; rejected title → structured warning (D1 hardening)', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-bbbbbbbb-2222' } } })
  const { home, svc } = mkService(gw)
  try {
    const out = await svc.newConversation(ADDR)
    assert.equal(out.shortId, 'sess-b')
    assert.equal(gw.rpcs(WIRE.sessionTitle).length, 0)
    // gateway unavailable → typed error
    await assert.rejects(
      () => svc.newConversation({ machine: 'nowhere', id: 'zzzzzz' }),
      (e) => e instanceof EnvelopeError && e.wire.code === 'a2a/gateway-unavailable',
    )
    // business {ok:false,error} on the rename → NOT a throw anymore: the
    // conversation exists upstream and the row is addressable, so the caller
    // gets the ids back with a warning (D1: never orphan, never bare Error:)
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-cccccccc-3333' } } }) // create
    gw.rpc({ result: { ok: false, error: { code: 'session/title-invalid', message: 'bad title' } } }) // rename rejected
    const warned = await svc.newConversation(ADDR, 'x')
    assert.equal(warned.shortId, 'sess-c')
    assert.equal(warned.sessionId, 'sess-cccccccc-3333')
    assert.equal(warned.warning, 'title not set: bad title')
    const rows = loadConversations(home).conversations
    assert.equal(rows.find((r) => r.sessionId === 'sess-cccccccc-3333').title, undefined, 'rejected title not persisted')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('newConversation: world-context liveness failure shape → structured result, row addressable (D1 wire shape)', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-eeeeeeee-5555' } } })
  gw.rpc({ result: { ok: false, error: { code: 'gateway/internal', message: 'failed to rename session "sess-eeeeeeee-5555": Error: session "sess-eeeeeeee-5555" is not live in this store' } } })
  const { home, svc } = mkService(gw)
  try {
    const out = await svc.newConversation(ADDR, 'Rename probe A')
    assert.equal(out.shortId, 'sess-e')
    assert.equal(out.sessionId, 'sess-eeeeeeee-5555')
    assert.match(out.warning, /^title not set: failed to rename session/)
    assert.match(out.warning, /is not live in this store/)
    const rows = loadConversations(home).conversations
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sessionId, 'sess-eeeeeeee-5555')
    assert.equal(rows[0].title, undefined)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('send create-path: rejected title → failed receipt carrying the orphan sessionId in details (D1 hardening)', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-ffffffff-6666' } } }) // create
  gw.rpc({ result: { ok: false, error: { code: 'gateway/internal', message: 'failed to rename session "sess-ffffffff-6666": Error: session "sess-ffffffff-6666" is not live in this store' } } })
  const { home, svc } = mkService(gw)
  try {
    const receipt = await svc.send({ to: ADDR, title: 'Nope', message: 'never sent' }, INITIATOR)
    assert.equal(receipt.outcome, 'failed')
    assert.equal(receipt.sessionId, 'sess-ffffffff-6666')
    assert.equal(receipt.conversationId, 'sess-f')
    assert.equal(receipt.error.code, 'gateway/internal')
    assert.deepEqual(receipt.error.details, { orphanSessionId: 'sess-ffffffff-6666', conversationId: 'sess-f' })
    const rows = loadConversations(home).conversations
    assert.equal(rows.find((r) => r.sessionId === 'sess-ffffffff-6666').title, undefined)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- send

test('send without conversationId: create path — create(+rename) then prompt; injected receipt; row persisted', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-dddddddd-4444' } } }) // create
  gw.rpc({ result: { ok: true, value: { title: 'Sync review', seq: 2 } } })    // rename
  gw.rpc({ result: { ok: true, value: { accepted: true } } })                  // prompt
  const { home, svc } = mkService(gw)
  try {
    const receipt = await svc.send({ to: ADDR, title: 'Sync review', message: 'check the build' }, INITIATOR)
    assert.equal(receipt.outcome, 'injected')
    assert.match(receipt.messageId, /^a2a-/)
    assert.equal(receipt.conversationId, 'sess-d')
    assert.equal(receipt.sessionId, 'sess-dddddddd-4444')
    assert.equal(receipt.error, undefined)
    // prompt payload: the mirror shape with the teaching envelope as text part
    const prompt = gw.rpcs(WIRE.promptSubmit)[0].payload
    assert.deepEqual(prompt, {
      args: {
        request: {
          requestId: receipt.messageId,
          sessionId: 'sess-dddddddd-4444',
          mode: 'queue',
          content: [{ type: 'text', text: teaching(INITIATOR, 'Sync review', 'sess-d', 'check the build') }],
        },
      },
    })
    const rows = loadConversations(home).conversations
    assert.equal(rows.length, 1)
    assert.equal(rows[0].title, 'Sync review')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('send with conversationId: no create call; stored sessionId; lastActivityAt bump; shortId stable across service restart', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-eeeeeeee-5555' } } })
  gw.rpc({ result: { ok: true, value: { accepted: true } } })
  const { home, svc } = mkService(gw)
  try {
    const first = await svc.send({ to: ADDR, message: 'one' }, INITIATOR)
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    // fresh service over the same home = restart; conversationId still resolves
    const svc2 = createA2aService({ home, gatewayFor: () => gw.face, now: () => 1234999 })
    const second = await svc2.send({ to: ADDR, conversationId: first.conversationId, message: 'two', delivery: 'steer' }, INITIATOR)
    assert.equal(second.outcome, 'injected')
    assert.equal(second.conversationId, first.conversationId)
    assert.equal(second.sessionId, 'sess-eeeeeeee-5555')
    assert.equal(gw.rpcs(WIRE.sessionCreate).length, 1) // no second create
    assert.deepEqual(gw.rpcs(WIRE.promptSubmit)[1].payload.args.request, {
      requestId: second.messageId,
      sessionId: 'sess-eeeeeeee-5555',
      mode: 'steer',
      content: [{ type: 'text', text: teaching(INITIATOR, '(untitled)', first.conversationId, 'two') }],
    })
    const rows = loadConversations(home).conversations
    assert.equal(rows[0].lastActivityAt, 1234999)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('send failure taxonomy: gateway throw → failed verbatim; business {ok:false} → failed verbatim; unknown id → failed', async () => {
  const gw = fakeGateway()
  const { home, svc } = mkService(gw)
  try {
    // transport throw before inject — error verbatim (code + message)
    gw.rpc({ throw: new EnvelopeError({ code: 'gateway/unreachable', message: 'mesh-gateway: POST failed — ECONNREFUSED' }) })
    const r1 = await svc.send({ to: ADDR, message: 'x' }, INITIATOR)
    assert.equal(r1.outcome, 'failed')
    assert.equal(r1.sessionId, '')
    assert.deepEqual(r1.error, { code: 'gateway/unreachable', message: 'mesh-gateway: POST failed — ECONNREFUSED' })
    // business rejection — error body verbatim incl. details
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-ffffffff-6666' } } })
    gw.rpc({ result: { ok: false, error: { code: 'session/agent-busy', message: 'busy', details: { sessionId: 'sess-ffffffff-6666' } } } })
    const r2 = await svc.send({ to: ADDR, message: 'x' }, INITIATOR)
    assert.equal(r2.outcome, 'failed')
    assert.equal(r2.sessionId, 'sess-ffffffff-6666')
    assert.deepEqual(r2.error, { code: 'session/agent-busy', message: 'busy', details: { sessionId: 'sess-ffffffff-6666' } })
    // unknown conversation id → failed with actionable next step
    const r3 = await svc.send({ to: ADDR, conversationId: 'nope1234', message: 'x' }, INITIATOR)
    assert.equal(r3.outcome, 'failed')
    assert.equal(r3.error.code, 'a2a/conversation-not-found')
    assert.match(r3.error.message, /without conversationId/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('teaching template: ONE exported constant; renderer fills initiator identity; untitled fallback', () => {
  assert.equal(
    A2A_MESSAGE_TEMPLATE,
    'A2A message from {machine}-{agent} (conversation "{title}", reply via SuperD Hub send with conversationId {shortId}):\n\n{message}',
  )
  assert.equal(
    renderA2aEnvelope({ machine: 'm1ab', agent: 'a2b3c4', title: 'T', shortId: 'sess-ddd', message: 'hi' }),
    'A2A message from m1ab-a2b3c4 (conversation "T", reply via SuperD Hub send with conversationId sess-ddd):\n\nhi',
  )
  assert.ok(renderA2aEnvelope({ machine: 'm', agent: 'a', shortId: 's', message: 'x' }).includes('"(untitled)"'))
})

// ---------------------------------------------------------------- subscribeCompletion

test('subscribeCompletion armed by requestId: cb exactly once with final assistant text; auto-dispose', async () => {
  const gw = fakeGateway()
  const { home, svc } = mkService(gw)
  try {
    seedConversation(gw)
    const { shortId: conversationId } = await svc.newConversation(ADDR)
    const fired = []
    gw.stream({
      frames: [
        snap([
          ev('turn/start', { turn: 1 }, 1),
          userMsg('a2a-mine', 2),
          asstMsg(1, 'first attempt', 3),
          asstMsg(1, 'final answer text', 4), // LAST assistant/message of turn 1 wins
        ]),
        turnEnd(1, 5),
        ev('turn/start', { turn: 2 }, 6), // later traffic must not re-fire
        asstMsg(2, 'next turn', 7),
        turnEnd(2, 8),
      ],
      die: new Error('cut'),
    })
    const dispose = svc.subscribeCompletion(
      { to: ADDR, conversationId },
      (c) => fired.push(c),
      { requestId: 'a2a-mine' },
    )
    await until(() => fired.length === 1)
    await settle()
    assert.equal(fired.length, 1)
    assert.deepEqual(fired[0], {
      conversationId, sessionId: 'sess-gggggggg-7777', turn: 1, reason: 'completed', text: 'final answer text',
    })
    dispose()
    await settle()
    assert.equal(gw.streamOpens(), 1) // armed fire auto-disposed; no resubscribe for the scripted death
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('subscribeCompletion unarmed: one cb per observed turn completion; interrupted attempts excluded', async () => {
  const gw = fakeGateway()
  const { home, svc } = mkService(gw)
  try {
    seedConversation(gw)
    const { shortId: conversationId } = await svc.newConversation(ADDR)
    const fired = []
    gw.stream({
      frames: [
        ev('turn/start', { turn: 1 }, 1),
        asstMsg(1, 'a1', 2),
        turnEnd(1, 3),
        ev('turn/start', { turn: 2 }, 4),
        asstMsg(2, 'interrupted partial', 5), // replaced attempt — not final
        ev('assistant/message', { turn: 2, step: 0, interrupted: true, message: { role: 'assistant', content: [{ type: 'text', text: 'interrupted partial' }] }, stream: [] }, 6),
        asstMsg(2, 'real answer', 7),
        turnEnd(2, 8, 'aborted'),
      ],
    })
    const dispose = svc.subscribeCompletion({ to: ADDR, conversationId }, (c) => fired.push(c))
    await until(() => fired.length === 2)
    dispose()
    // follow payload: the mirror shape, address + assistantStream exactly as the UI passes it
    const streamCall = gw.calls.find((c) => c.kind === 'stream')
    assert.deepEqual(streamCall.payload, {
      args: { request: { address: { kind: 'session', sessionId: 'sess-gggggggg-7777' }, assistantStream: true } },
    })
    assert.equal(fired.length, 2)
    assert.deepEqual(fired.map((f) => [f.turn, f.text, f.reason]), [[1, 'a1', 'completed'], [2, 'real answer', 'aborted']])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('subscribeCompletion armed race: snapshot already carries the whole turn → cb fires from history', async () => {
  const gw = fakeGateway()
  const { home, svc } = mkService(gw)
  try {
    seedConversation(gw)
    const { shortId: conversationId } = await svc.newConversation(ADDR)
    const fired = []
    gw.stream({
      frames: [snap([
        ev('turn/start', { turn: 1 }, 1),
        userMsg('a2a-late', 2),
        asstMsg(1, 'already answered', 3),
        turnEnd(1, 4),
      ])],
    })
    svc.subscribeCompletion({ to: ADDR, conversationId }, (c) => fired.push(c), { requestId: 'a2a-late' })
    await until(() => fired.length === 1)
    assert.equal(fired[0].text, 'already answered')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('subscribeCompletion stream death: exactly one resubscribe; second death → onError, never a third open', async () => {
  const gw = fakeGateway()
  const { home, svc } = mkService(gw)
  try {
    seedConversation(gw)
    const { shortId: conversationId } = await svc.newConversation(ADDR)
    const fired = []
    const errors = []
    gw.stream({ die: new Error('socket cut') })                              // first death
    gw.stream({ frames: [turnEnd(1, 9)], die: new Error('second cut') })      // resubscribe fires, then dies again
    const dispose = svc.subscribeCompletion({ to: ADDR, conversationId }, (c) => fired.push(c), {
      onError: (e) => errors.push(e),
    })
    await until(() => fired.length === 1 && errors.length === 1)
    assert.equal(gw.streamOpens(), 2)
    assert.equal(errors[0].code, 'a2a/stream-dead')
    assert.match(errors[0].message, /second cut/)
    await settle()
    assert.equal(gw.streamOpens(), 2) // no third dial
    dispose()
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('subscribeCompletion armed history: terminal reason passes through verbatim (aborted turn in snapshot)', async () => {
  const gw = fakeGateway()
  seedConversation(gw)
  const { home, svc } = mkService(gw)
  try {
    const { shortId: conversationId } = await svc.newConversation(ADDR)
    const fired = []
    gw.stream({
      frames: [snap([
        ev('turn/start', { turn: 1 }, 1),
        userMsg('a2a-stop', 2),
        asstMsg(1, 'partial work', 3),
        turnEnd(1, 4, 'aborted'), // the turn ended ABORTED inside the snapshot
      ])],
    })
    svc.subscribeCompletion({ to: ADDR, conversationId }, (c) => fired.push(c), { requestId: 'a2a-stop' })
    await until(() => fired.length === 1)
    assert.equal(fired[0].reason, 'aborted') // NOT the hardcoded 'completed'
    assert.equal(fired[0].text, 'partial work')
    await settle()
    assert.equal(fired.length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('subscribeCompletion: duplicate turn/end frame delivery fires the cb exactly once', async () => {
  const gw = fakeGateway()
  seedConversation(gw)
  const { home, svc } = mkService(gw)
  try {
    const { shortId: conversationId } = await svc.newConversation(ADDR)
    const fired = []
    gw.stream({
      frames: [
        ev('turn/start', { turn: 1 }, 1),
        asstMsg(1, 'once only', 2),
        turnEnd(1, 3),
        turnEnd(1, 3), // duplicate frame (replay/retry) — must not re-fire
        ev('turn/start', { turn: 2 }, 4),
        asstMsg(2, 'second turn', 5),
        turnEnd(2, 6),
      ],
    })
    const dispose = svc.subscribeCompletion({ to: ADDR, conversationId }, (c) => fired.push(c))
    await until(() => fired.length === 2) // both turns complete...
    await settle()
    assert.equal(fired.length, 2) // ...and turn 1 fired exactly once despite the duplicate
    assert.deepEqual(fired.map((f) => [f.turn, f.text]), [[1, 'once only'], [2, 'second turn']])
    dispose()
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- stop

test('stop: turn scope → session/cancel mirror payload; session scope → turn-only degradation with typed reason', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-hhhhhhhh-8888' } } }) // create
  gw.rpc({ result: { ok: true, value: { accepted: true } } }) // prompt
  gw.rpc({ result: { ok: true, value: { accepted: true } } }) // cancel 1
  gw.rpc({ result: { ok: true, value: { accepted: true } } }) // cancel 2
  // D5: each stop first reads turn liveness over a follow snapshot — first
  // stop sees a LIVE turn, second sees idle (turn 1 already ended)
  gw.stream({ frames: [snap([ev('turn/start', { turn: 1 }, 1)])] })
  gw.stream({ frames: [snap([ev('turn/start', { turn: 1 }, 1), turnEnd(1, 2)])] })
  const { home, svc } = mkService(gw)
  try {
    const { conversationId } = await svc.send({ to: ADDR, message: 'x' }, INITIATOR)
    const turn = await svc.stop({ to: ADDR, conversationId }, 'turn')
    assert.deepEqual(turn, { scope: 'turn', cancelled: true })
    const session = await svc.stop({ to: ADDR, conversationId }, 'session')
    assert.deepEqual(session, { scope: 'turn-only', cancelled: false, note: 'no turn was active', reason: 'no session-close endpoint upstream' })
    // both scopes dialed the cancel endpoint with the mirror payload
    assert.deepEqual(gw.rpcs(WIRE.turnCancel).map((c) => c.payload), [
      { args: { request: { sessionId: 'sess-hhhhhhhh-8888' } } },
      { args: { request: { sessionId: 'sess-hhhhhhhh-8888' } } },
    ])
    await assert.rejects(
      () => svc.stop({ to: ADDR, conversationId: 'missing00' }, 'turn'),
      (e) => e instanceof EnvelopeError && e.wire.code === 'a2a/conversation-not-found',
    )
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- buffer + read

test('read: per-initiator sweep; bounded at 32 (oldest dropped)', () => {
  const gw = fakeGateway()
  const { home, svc } = mkService(gw)
  try {
    for (let i = 0; i < A2A_BUFFER_MAX + 2; i++) {
      svc.buffer('sess-init-1', { messageId: `m${i}`, from: ADDR, conversationId: 'sess-ddd', text: `msg ${i}` })
    }
    svc.buffer('sess-init-2', { messageId: 'other', from: ADDR, conversationId: 'sess-ddd', text: 'other' })
    // targeted read sweeps exactly that initiator
    const only = svc.read('sess-init-2')
    assert.equal(only.length, 1)
    assert.equal(only[0].text, 'other')
    assert.equal(svc.read('sess-init-2').length, 0)
    // bounded: 34 pushed → 32 kept, oldest dropped
    const all = svc.read()
    assert.equal(all.length, A2A_BUFFER_MAX)
    assert.equal(all[0].text, `msg 2`)
    assert.equal(all[all.length - 1].text, `msg ${A2A_BUFFER_MAX + 1}`)
    assert.ok(all.every((m) => m.initiatorSessionId === 'sess-init-1'))
    assert.equal(svc.read().length, 0) // swept
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- registry

test('registry: collision lengthening; corrupt file reads empty and accepts fresh writes', async () => {
  const gw = fakeGateway()
  const { home, svc } = mkService(gw)
  try {
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-aaaaaaaa-0001' } } })
    const a = await svc.newConversation(ADDR)
    assert.equal(a.shortId, 'sess-a')
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-aaaaaaaab002' } } }) // same first 6
    const b = await svc.newConversation(ADDR)
    assert.equal(b.shortId, 'sess-aaa') // lengthened 6→8 (step 2)
    assert.notEqual(a.shortId, b.shortId)
    // corrupt file → empty shape, never throws
    writeFileSync(join(home, 'superd', 'a2a-conversations.json'), '{corrupt', 'utf8')
    assert.deepEqual(loadConversations(home), { conversations: [] })
    assert.deepEqual(svc.listConversations(), [])
    // and the service keeps working (fresh write replaces the corruption)
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-zzzzzzzz-0003' } } })
    const c = await svc.newConversation(ADDR)
    assert.equal(loadConversations(home).conversations.length, 1)
    assert.equal(c.shortId, 'sess-z')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('send guards: conversation registered under a different machine → typed mismatch receipt', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-mmmmmmmm-9999' } } })
  const { home, svc } = mkService(gw)
  try {
    const { conversationId } = await svc.send({ to: ADDR, message: 'x' }, INITIATOR)
    const r = await svc.send({ to: { machine: 'other', id: ADDR.id }, conversationId, message: 'x' }, INITIATOR)
    assert.equal(r.outcome, 'failed')
    assert.equal(r.error.code, 'a2a/conversation-machine-mismatch')
    assert.equal(gw.rpcs(WIRE.promptSubmit).length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- D2 shortId mint

test('shortIdFor (D2): strips the session- prefix, mints 6 of the uuid, lengthens 6→8→10 (step 2)', () => {
  const row = (shortId, sessionId) => ({ shortId, machine: 'm', agent: 'a', sessionId, createdAt: 1, lastActivityAt: 1 })
  // prefix-strip + mint: first 6 chars of the uuid — never the constant 'session-'
  assert.equal(shortIdFor('session-3138ea83-1778-4abc-9def-0123456789ab', []), '3138ea')
  // no prefix → the whole id is the base (older/foreign spellings)
  assert.equal(shortIdFor('abc123def456', []), 'abc123')
  // collision-lengthen 6→8→10
  const r1 = row('3138ea', 'session-aaaaaaaa-0001')
  assert.equal(shortIdFor('session-3138ea83-7777-1', [r1]), '3138ea83', '6 collides → 8')
  const r2 = row('3138ea83', 'session-aaaaaaaa-0002')
  assert.equal(shortIdFor('session-3138ea83-7777-1', [r1, r2]), '3138ea83-7', '8 collides → 10')
  // a legacy shortId stays reserved as taken: a new mint lengthens past it
  const legacy = row('4ce3e1', 'session-bbbbbbbb-0003')
  assert.equal(shortIdFor('session-4ce3e180-cccc', [legacy]), '4ce3e180')
  // re-seen sessionId keeps its row's shortId whatever it looks like
  assert.equal(shortIdFor('session-bbbbbbbb-0003', [legacy]), '4ce3e1')
})

test('registry (D2): legacy non-degenerate rows untouched; re-seen sessions keep their stored shortIds', async () => {
  const gw = fakeGateway()
  const { home, svc } = mkService(gw)
  try {
    saveConversations(home, { conversations: [
      { shortId: '4ce3e1', machine: ADDR.machine, agent: ADDR.id, sessionId: 'session-4ce3e180-aaaa', createdAt: 1, lastActivityAt: 1 },
      { shortId: 'zzz999', machine: ADDR.machine, agent: ADDR.id, sessionId: 'session-zzz99900-bbbb', createdAt: 1, lastActivityAt: 1 },
    ] })
    // re-seen legacy session → its row's shortId, verbatim
    gw.rpc({ result: { ok: true, value: { sessionId: 'session-4ce3e180-aaaa' } } })
    const again = await svc.newConversation(ADDR)
    assert.equal(again.shortId, '4ce3e1')
    // a fresh session colliding with a legacy shortId lengthens past it
    gw.rpc({ result: { ok: true, value: { sessionId: 'session-4ce3e180-cccc' } } })
    const fresh = await svc.newConversation(ADDR)
    assert.equal(fresh.shortId, '4ce3e180')
    // the legacy rows are untouched
    const rows = loadConversations(home).conversations
    assert.deepEqual(
      rows.filter((r) => ['session-4ce3e180-aaaa', 'session-zzz99900-bbbb'].includes(r.sessionId)).map((r) => r.shortId),
      ['4ce3e1', 'zzz999'],
    )
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- D5 honest stop

test('stop honesty (D5): idle snapshot → cancelled:false + note on BOTH scopes; the cancel still fires', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-nnnnnnnn-0000' } } }) // create
  const { home, svc } = mkService(gw)
  try {
    const { conversationId } = await svc.send({ to: ADDR, message: 'x' }, INITIATOR)
    gw.rpc({ result: { ok: true, value: { accepted: true } } })                       // cancel 1
    gw.stream({ frames: [snap([ev('turn/start', { turn: 2 }, 1), turnEnd(2, 2)])] }) // idle: turn ended
    const idleTurn = await svc.stop({ to: ADDR, conversationId }, 'turn')
    assert.deepEqual(idleTurn, { scope: 'turn', cancelled: false, note: 'no turn was active' })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })          // cancel 2
    gw.stream({ frames: [snap([turnEnd(1, 3)])] })                       // idle: no turn/start at all
    const idleSession = await svc.stop({ to: ADDR, conversationId }, 'session')
    assert.deepEqual(idleSession, { scope: 'turn-only', cancelled: false, note: 'no turn was active', reason: 'no session-close endpoint upstream' })
    // today's wire behavior is unchanged: both idle stops still fired the cancel
    assert.equal(gw.rpcs(WIRE.turnCancel).length, 2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('stop honesty (D5): undeterminable liveness (stream death) stays conservative — today\'s shape', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-nnnnnnnn-0001' } } })
  const { home, svc } = mkService(gw)
  try {
    const { conversationId } = await svc.send({ to: ADDR, message: 'x' }, INITIATOR)
    gw.rpc({ result: { ok: true, value: { accepted: true } } })        // cancel
    gw.stream({ throw: new Error('plane gone before any snapshot') })  // liveness undeterminable
    const blind = await svc.stop({ to: ADDR, conversationId }, 'turn')
    assert.deepEqual(blind, { scope: 'turn', cancelled: true })
    assert.equal(gw.rpcs(WIRE.turnCancel).length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- D7 gateway misses

test('gateway misses (D7): unknown-agent / unknown-machine branches as typed errors and failed receipts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const missFor = new Map()
  const svc = createA2aService({ home, gatewayFor: (addr) => missFor.get(addr.id), now: () => 1 })
  try {
    missFor.set('zzzzzz', { miss: 'unknown-agent' })
    await assert.rejects(
      () => svc.newConversation({ machine: 'k3f9', id: 'zzzzzz' }),
      (e) => e instanceof EnvelopeError && e.wire.code === 'a2a/unknown-agent'
        && e.wire.message === 'a2a: unknown-agent k3f9-zzzzzz (no such agent on machine k3f9)',
    )
    missFor.set('zzzzzz', { miss: 'unknown-machine' })
    await assert.rejects(
      () => svc.newConversation({ machine: 'k3f9', id: 'zzzzzz' }),
      (e) => e instanceof EnvelopeError && e.wire.code === 'a2a/unknown-machine'
        && e.wire.message === 'a2a: unknown-machine k3f9 (not paired)',
    )
    missFor.set('zzzzzz', { miss: 'unknown-agent' })
    const r = await svc.send({ to: { machine: 'k3f9', id: 'zzzzzz' }, message: 'x' }, INITIATOR)
    assert.equal(r.outcome, 'failed')
    assert.deepEqual(r.error, { code: 'a2a/unknown-agent', message: 'a2a: unknown-agent k3f9-zzzzzz (no such agent on machine k3f9)' })
    // unreachable keeps today's code and message
    missFor.set('zzzzzz', { miss: 'unreachable' })
    await assert.rejects(
      () => svc.newConversation({ machine: 'k3f9', id: 'zzzzzz' }),
      (e) => e instanceof EnvelopeError && e.wire.code === 'a2a/gateway-unavailable'
        && e.wire.message === 'a2a: no gateway for k3f9-zzzzzz — machine unreachable or not paired',
    )
  } finally { rmSync(home, { recursive: true, force: true }) }
})
