// A2A reply delivery (mesh P3 Task 3): source kinds + peer routing + the
// completion→delivery glue, all against a fake ctx.agents that records
// followup/steer/inject calls, plus the a2a-host gateway resolution
// (federated table first, local target registry + id-map inversion second).
//
// Structural message assertions pin the SAME fields upstream pins for its
// continuation messages (dsh-v0.1.7-rc.1, continuation-messages.ts):
// role 'user', fresh string id, content text blocks, and a source carrying
// kind + context form + producer attribution.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deliverReply,
  deliverNotice,
  wireCompletionToDelivery,
  renderA2aRelayText,
  A2A_NOTICE_SUMMARY_MAX,
} from '../dist/a2a-delivery.js'
import { createA2aService, saveConversations } from '../dist/a2a-service.js'
import { resolveA2aGatewayFor, localA2aInitiator } from '../dist/a2a-host.js'
import { ensureAgentId, agentIdMap } from '../dist/agent-ids.js'
import { ensureSelf } from '../dist/machines.js'
import { registerForeignTarget, unregisterForeignTarget } from '../dist/targets.js'
import { federateAgents, defederateMachine } from '../dist/mesh-federate.js'
import { listAgents, unregisterAgent } from '../dist/roster.js'

// ---------------------------------------------------------------- fakes

/**
 * Fake ctx.agents face: one scripted live agent (status under test control)
 * whose followup/steer/inject calls are recorded, with `get` scripted
 * separately (undefined = the initiator is not live).
 */
function fakeAgents(status = 'idle') {
  const state = { status }
  const calls = { followup: [], steer: [], inject: [] }
  const handle = {
    get status() { return state.status },
    followup: (m) => calls.followup.push(m),
    steer: (m) => calls.steer.push(m),
    inject: (m) => calls.inject.push(m),
  }
  let live = handle
  return {
    calls,
    setStatus: (s) => { state.status = s },
    dropAgent: () => { live = undefined },
    restoreAgent: () => { live = handle },
    ctxAgents: { get: (id) => (id === 'sess-init-1' ? live : undefined) },
  }
}

/** Fake delivery ctx: recorded agents face + recorded Task-2 buffer leg. */
function fakeCtx(status = 'idle') {
  const agents = fakeAgents(status)
  const buffered = []
  const ctx = {
    agents: agents.ctxAgents,
    buffer: (initiatorSessionId, message) => buffered.push({ initiatorSessionId, message }),
  }
  return { ctx, agents, buffered }
}

const INITIATOR = { machine: 'm1ab', agent: 'a2b3c4', sessionId: 'sess-init-1' }
const RELAY_META = {
  senderMachine: 'k3f9',
  senderAgent: 'q7m2xp',
  conversationId: 'sess-aaa',
  messageId: 'a2a-relay-0001',
  title: 'mesh review',
}

// ---------------------------------------------------------------- routing

test('deliverReply: idle initiator → followup with the relay message shape', () => {
  const { ctx, agents, buffered } = fakeCtx('idle')
  const out = deliverReply(ctx, INITIATOR, 'peer final text', RELAY_META)
  assert.deepEqual(out, { delivered: 'followup' })
  assert.equal(agents.calls.followup.length, 1)
  assert.equal(agents.calls.steer.length, 0)
  assert.equal(agents.calls.inject.length, 0)
  assert.equal(buffered.length, 0)

  const [msg] = agents.calls.followup
  // structural mirror of upstream createUserMessage output
  assert.equal(msg.role, 'user')
  assert.equal(typeof msg.id, 'string')
  assert.notEqual(msg.id, '')
  assert.ok(Object.isFrozen(msg), 'published message is frozen')
  assert.deepEqual(msg.content, [
    { type: 'text', text: 'Agent k3f9-q7m2xp replied (conversation "mesh review"):\n\npeer final text' },
  ])
  // source: our declared kind, the relay context form, producer attribution
  assert.equal(msg.source.kind, 'a2a-relay')
  assert.equal(msg.source.form, 'relay')
  assert.equal(msg.source.senderMachine, 'k3f9')
  assert.equal(msg.source.senderAgent, 'q7m2xp')
  assert.equal(msg.source.conversationId, 'sess-aaa')
  assert.equal(msg.source.messageId, 'a2a-relay-0001')
})

test('deliverReply: BUSY initiator → followup too (peer semantics, never steer)', () => {
  const { ctx, agents } = fakeCtx('running')
  const out = deliverReply(ctx, INITIATOR, 'late reply', RELAY_META)
  assert.deepEqual(out, { delivered: 'followup' })
  assert.equal(agents.calls.followup.length, 1)
  assert.equal(agents.calls.steer.length, 0)
})

test('deliverReply: explicit steer option honored', () => {
  const { ctx, agents } = fakeCtx('running')
  const out = deliverReply(ctx, INITIATOR, 'urgent', RELAY_META, { delivery: 'steer' })
  assert.deepEqual(out, { delivered: 'steer' })
  assert.equal(agents.calls.steer.length, 1)
  assert.equal(agents.calls.followup.length, 0)
  assert.equal(agents.calls.steer[0].source.kind, 'a2a-relay')
})

test('deliverReply: missing initiator agent → buffered via the a2a-service buffer leg', () => {
  const dropped = fakeCtx('idle')
  dropped.ctx.agents = { get: () => undefined }
  const out = deliverReply(dropped.ctx, INITIATOR, 'reply while away', RELAY_META)
  assert.deepEqual(out, { delivered: 'buffered' })
  assert.equal(dropped.agents.calls.followup.length, 0)
  assert.equal(dropped.buffered.length, 1)
  const [entry] = dropped.buffered
  assert.equal(entry.initiatorSessionId, 'sess-init-1')
  assert.equal(entry.message.messageId, 'a2a-relay-0001')
  assert.deepEqual(entry.message.from, { machine: 'k3f9', id: 'q7m2xp' })
  assert.equal(entry.message.conversationId, 'sess-aaa')
  assert.equal(
    entry.message.text,
    'Agent k3f9-q7m2xp replied (conversation "mesh review"):\n\nreply while away',
  )
  assert.equal(dropped.agents.calls.steer.length, 0)
  assert.equal(dropped.agents.calls.inject.length, 0)
})

test('renderA2aRelayText: untitled conversations render the (untitled) placeholder', () => {
  assert.equal(
    renderA2aRelayText({ ...RELAY_META, title: undefined }, 'x'),
    'Agent k3f9-q7m2xp replied (conversation "(untitled)"):\n\nx',
  )
})

// ---------------------------------------------------------------- notices

test('deliverNotice: notice form, summary bounded to 120 chars with ellipsis', () => {
  const { ctx, agents } = fakeCtx('idle')
  const long = 'x'.repeat(300)
  const out = deliverNotice(ctx, INITIATOR, long, {
    senderMachine: 'k3f9',
    senderAgent: 'q7m2xp',
    conversationId: 'sess-aaa',
    reason: 'stream-dead',
  })
  assert.deepEqual(out, { delivered: 'followup' })
  assert.equal(agents.calls.followup.length, 1)
  const [msg] = agents.calls.followup
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'a2a-notice')
  assert.equal(msg.source.form, 'notice')
  assert.equal(msg.source.reason, 'stream-dead')
  assert.equal(msg.source.conversationId, 'sess-aaa')
  assert.ok(msg.source.summary.length <= A2A_NOTICE_SUMMARY_MAX)
  assert.equal(A2A_NOTICE_SUMMARY_MAX, 120)
  // upstream boundContextSummary semantics: 119 chars + ellipsis
  assert.equal(msg.source.summary, 'x'.repeat(119) + '…')
  // the model-visible text IS the bounded summary
  assert.deepEqual(msg.content, [{ type: 'text', text: msg.source.summary }])
})

test('deliverNotice: short summary passes through verbatim; missing initiator buffers', () => {
  const { ctx, agents } = fakeCtx('idle')
  const out = deliverNotice(ctx, INITIATOR, 'stream died for "sess-aaa"', {
    senderMachine: 'k3f9',
    senderAgent: 'q7m2xp',
    conversationId: 'sess-aaa',
    reason: 'stream-dead',
  })
  assert.deepEqual(out, { delivered: 'followup' })
  assert.equal(agents.calls.followup[0].source.summary, 'stream died for "sess-aaa"')

  const dropped = fakeCtx('idle')
  dropped.ctx.agents = { get: () => undefined }
  const buffered = deliverNotice(dropped.ctx, INITIATOR, 'send failed', {
    senderMachine: 'k3f9',
    senderAgent: 'q7m2xp',
    conversationId: 'sess-aaa',
    reason: 'send-failed',
  })
  assert.deepEqual(buffered, { delivered: 'buffered' })
  assert.equal(dropped.buffered.length, 1)
  assert.equal(dropped.buffered[0].message.text, 'send failed')
  assert.equal(dropped.buffered[0].message.conversationId, 'sess-aaa')
  assert.deepEqual(dropped.buffered[0].message.from, { machine: 'k3f9', id: 'q7m2xp' })
})

test('deliverNotice: conversation-less notice on a missing initiator → dropped, never buffered', () => {
  const dropped = fakeCtx('idle')
  dropped.ctx.agents = { get: () => undefined }
  const out = deliverNotice(dropped.ctx, INITIATOR, 'stop before a conversation existed', {
    senderMachine: 'k3f9',
    senderAgent: 'q7m2xp',
    conversationId: undefined,
    reason: 'stop',
  })
  assert.deepEqual(out, { delivered: 'dropped', reason: 'no-conversation' })
  assert.equal(dropped.buffered.length, 0)
})

// ---------------------------------------------------------------- glue

/** Fake service: subscribeCompletion records the cb pair; the test fires them by hand. */
function fakeService(conversations = []) {
  const subs = []
  return {
    subs,
    listConversations: () => conversations,
    subscribeCompletion: (conv, cb, opts = {}) => {
      subs.push({ conv, cb, opts })
      const sub = subs[subs.length - 1]
      return () => { subs.splice(subs.indexOf(sub), 1) }
    },
  }
}

test('wireCompletionToDelivery: completion cb → deliverReply once with the final text', () => {
  const { ctx, agents } = fakeCtx('idle')
  const svc = fakeService([{ shortId: 'sess-aaa', title: 'mesh review' }])
  const conv = { to: { machine: 'k3f9', id: 'q7m2xp' }, conversationId: 'sess-aaa' }
  const dispose = wireCompletionToDelivery(ctx, svc, INITIATOR, conv)
  assert.equal(svc.subs.length, 1)
  assert.deepEqual(svc.subs[0].conv, conv)

  svc.subs[0].cb({
    conversationId: 'sess-aaa',
    sessionId: 'sess-aaaaaaaa-0001',
    turn: 3,
    reason: 'completed',
    text: 'the peer answer',
  })
  svc.subs[0].cb({
    conversationId: 'sess-aaa',
    sessionId: 'sess-aaaaaaaa-0001',
    turn: 4,
    reason: 'completed',
    text: 'a second turn the glue must also deliver',
  })
  assert.equal(agents.calls.followup.length, 2)
  const [first] = agents.calls.followup
  assert.equal(first.source.kind, 'a2a-relay')
  assert.equal(first.source.senderMachine, 'k3f9')
  assert.equal(first.source.conversationId, 'sess-aaa')
  assert.ok(first.content[0].text.includes('the peer answer'))
  assert.ok(first.content[0].text.includes('"mesh review"'))
  assert.ok(first.content[0].text.startsWith('Agent k3f9-q7m2xp replied'))
  // each relay carries its own durable message identity
  assert.notEqual(agents.calls.followup[0].source.messageId, agents.calls.followup[1].source.messageId)
  dispose()
})

test('wireCompletionToDelivery: requestId passes through; onError → stream-dead notice', () => {
  const { ctx, agents } = fakeCtx('idle')
  const svc = fakeService([])
  const conv = { to: { machine: 'k3f9', id: 'q7m2xp' }, conversationId: 'sess-aaa' }
  wireCompletionToDelivery(ctx, svc, INITIATOR, conv, { requestId: 'a2a-relay-0009' })
  assert.equal(svc.subs[0].opts.requestId, 'a2a-relay-0009')

  svc.subs[0].opts.onError({ code: 'a2a/stream-dead', message: 'died twice' })
  assert.equal(agents.calls.followup.length, 1)
  const [notice] = agents.calls.followup
  assert.equal(notice.source.kind, 'a2a-notice')
  assert.equal(notice.source.reason, 'stream-dead')
  assert.ok(notice.source.summary.length <= 120)
  assert.ok(notice.source.summary.includes('died twice'))
})

test('wireCompletionToDelivery: real Task-2 service + real buffer leg on a missing initiator', () => {
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-delivery-'))
  try {
    const svc = createA2aService({ home, gatewayFor: () => undefined })
    const ctx = { agents: { get: () => undefined }, buffer: (id, m) => svc.buffer(id, m) }
    const conv = { to: { machine: 'k3f9', id: 'q7m2xp' }, conversationId: 'nope' }
    // subscribeCompletion errors immediately (unknown conversation) → notice path → buffer
    wireCompletionToDelivery(ctx, svc, INITIATOR, conv)
    const swept = svc.read('sess-init-1')
    assert.equal(swept.length, 1)
    assert.equal(swept[0].initiatorSessionId, 'sess-init-1')
    assert.ok(swept[0].text.includes('nope'))
    assert.deepEqual(swept[0].from, { machine: 'k3f9', id: 'q7m2xp' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/** ---------------------------------------------------------------- host wiring */

/** RAW typertGateway recorder: canonical 6-arg stream face, scripted frames. */
function rawGatewayRecorder(frames = []) {
  const g = {
    calls: { dispatchRpc: [], openWireStream: [] },
    async dispatchRpc(endpoint, payload, signal) {
      g.calls.dispatchRpc.push({ endpoint, payload, signal })
      return { ok: true, value: {} }
    },
    openWireStream(endpoint, payload, uplink, peer, signal, control) {
      g.calls.openWireStream.push({ endpoint, payload, uplink, peer, signal, control })
      return (async function* () {
        for (const frame of frames) yield frame
      })()
    },
  }
  return g
}


const cleanupRegistries = () => {
  for (const m of ['k3f9', 'zz99']) defederateMachine(m)
  for (const e of listAgents()) unregisterAgent(e.key)
  for (const k of ['native', 'omp', 'q7m2xp']) unregisterForeignTarget(k)
}

test('resolveA2aGatewayFor: federated wire adapters pass through UNWRAPPED; local rows + the native seam are bridged raw instances', () => {
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-host-'))
  try {
    // seed the local id map + the local 'omp' target (a RAW 6-arg instance)
    const ompA6 = ensureAgentId(home, 'omp')
    const nativeA6 = ensureAgentId(home, 'native')
    const ompRaw = rawGatewayRecorder()
    registerForeignTarget({ key: 'omp', gateway: ompRaw })
    // federate one remote agent (memo table + target registry, roster row) —
    // a wire adapter with mesh-gateway's dual-face stream dispatch
    const remoteGateway = { dispatchRpc: () => {}, openWireStream: () => {} }
    federateAgents(
      { id: 'k3f9', name: 'peer-pc' },
      [{ id: 'q7m2xp', key: 'codex', label: 'Codex', ready: true, failed: false }],
      () => remoteGateway,
    )
    const nativeRaw = rawGatewayRecorder()
    const gatewayFor = resolveA2aGatewayFor({ home, nativeGateway: nativeRaw })
    const selfM4 = ensureSelf(home, 'local').id

    // FEDERATED: identity passthrough — wrapping a wire adapter would flip its
    // 3rd-argument dispatch (isUplinkLane(undefined) → false) and silently
    // drop the 5th-position abort signal (the double-bridge hazard)
    assert.equal(gatewayFor({ machine: 'k3f9', id: 'q7m2xp' }), remoteGateway)

    // LOCAL world row: NOT the raw instance — a bridge delegating in the
    // canonical order (carrier.ts:238-style positional pin)
    const ompBridge = gatewayFor({ machine: selfM4, id: ompA6 })
    assert.notEqual(ompBridge, ompRaw)
    const signal = new AbortController().signal
    ompBridge.openWireStream('session/follow', { args: {} }, signal)
    assert.equal(ompRaw.calls.openWireStream.length, 1)
    const [streamCall] = ompRaw.calls.openWireStream
    assert.equal(streamCall.endpoint, 'session/follow')
    assert.deepEqual(streamCall.payload, { args: {} })
    assert.equal(streamCall.uplink, undefined) // no-lane spelling (upstream substitutes EMPTY_ASYNC_ITERABLE)
    assert.equal(streamCall.peer, undefined)
    assert.equal(streamCall.signal, signal) // position 5 — NOT shifted into uplink
    assert.ok(streamCall.control instanceof AbortController)
    // dispatchRpc passes through as-is
    ompBridge.dispatchRpc('session/create', { args: {} }, signal)
    assert.deepEqual(ompRaw.calls.dispatchRpc, [{ endpoint: 'session/create', payload: { args: {} }, signal }])

    // NATIVE seam: the same bridge, the same canonical pin
    const nativeBridge = gatewayFor({ machine: selfM4, id: nativeA6 })
    assert.notEqual(nativeBridge, nativeRaw)
    nativeBridge.openWireStream('session/follow', { args: {} }, signal)
    assert.equal(nativeRaw.calls.openWireStream[0].uplink, undefined)
    assert.equal(nativeRaw.calls.openWireStream[0].signal, signal)
    assert.ok(nativeRaw.calls.openWireStream[0].control instanceof AbortController)

    assert.equal(gatewayFor({ machine: selfM4, id: 'unknown' }), undefined) // unknown a6
  } finally {
    cleanupRegistries()
    rmSync(home, { recursive: true, force: true })
  }
})

test('resolveA2aGatewayFor (fix round 1): completion streams FLOW over a local raw gateway — the 3/6-arg misbind is gone', async () => {
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-host-'))
  try {
    const ompA6 = ensureAgentId(home, 'omp')
    const selfM4 = ensureSelf(home, 'local').id
    // RAW instance yielding one snapshot (history) + one live turn/end —
    // under the old misbind the signal landed in `uplink` and this stream
    // never reached a frame consumer sanely
    const raw = rawGatewayRecorder([
      {
        type: 'snapshot',
        records: [
          { type: 'event', event: { type: 'turn/start', seq: 1, data: { turn: 1 } } },
          { type: 'event', event: { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: 'bridged reply' }] } } } },
        ],
      },
      { type: 'event', event: { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } } },
    ])
    registerForeignTarget({ key: 'omp', gateway: raw })
    saveConversations(home, {
      conversations: [{ shortId: 'aaa11111', machine: selfM4, agent: ompA6, sessionId: 'sess-omp-1', createdAt: 1, lastActivityAt: 1 }],
    })
    const svc = createA2aService({ home, gatewayFor: resolveA2aGatewayFor({ home }) })
    const completions = []
    const dispose = svc.subscribeCompletion(
      { to: { machine: selfM4, id: ompA6 }, conversationId: 'aaa11111' },
      (completion) => completions.push(completion),
    )
    for (let i = 0; i < 100 && completions.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    dispose()
    assert.equal(completions.length, 1)
    assert.equal(completions[0].conversationId, 'aaa11111')
    assert.equal(completions[0].turn, 1)
    assert.equal(completions[0].reason, 'completed')
    assert.equal(completions[0].text, 'bridged reply')
    // and the raw instance saw the canonical 6-arg call
    const [call] = raw.calls.openWireStream
    assert.equal(call.uplink, undefined)
    assert.equal(call.peer, undefined)
    assert.ok(call.signal instanceof AbortSignal)
    assert.ok(call.control instanceof AbortController)
  } finally {
    cleanupRegistries()
    rmSync(home, { recursive: true, force: true })
  }
})

test('localA2aInitiator: real machine m4 + the roster a6 of the calling world + the live session', () => {
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-host-'))
  try {
    const selfM4 = ensureSelf(home, 'local').id
    const initiator = localA2aInitiator(home, 'native', 'sess-live-7')
    assert.equal(initiator.machine, selfM4)
    assert.equal(initiator.agent, agentIdMap(home)['native'])
    assert.equal(initiator.sessionId, 'sess-live-7')
    assert.notEqual(initiator.agent, '') // minted, not empty
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
