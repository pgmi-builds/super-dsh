// SuperD Hub tool face (mesh P3 Task 4): the single model-facing surface that
// makes A2A callable from a DSH session. These tests pin the call-shape
// dispatch against a fake service + fake exec context, the receipt shapes,
// the roster/conversations listing, the exec placeholder leg, the description
// key sentences (address format / NEVER poll / stop semantics / delivery
// meaning), the initiator-identity threading (exec.agent.id → A2aInitiator),
// and the ROW wiring: dormant without a tools service, and — once wired —
// the canonical 6-arg bridge onto ctx0's raw typertGateway plus the full
// send → completion → buffer → read loop over a real T2/T3 service stack.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSuperdHubTool, parseAgentAddress, RECENT_CONVERSATIONS_MAX } from '../dist/hub-tool.js'
import { wireHubToolRow, name as rowName } from '../dist/a2a-row.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

// ---------------------------------------------------------------- fakes

/** Minimal exec context: the tool reads only exec.agent?.id (Agent.id: SessionId). */
function fakeExec(sessionId = 'sess-777') {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'superd-hub',
    arguments: {},
    agent: sessionId == null ? undefined : { id: sessionId },
    signal: new AbortController().signal,
    token: Symbol('toolExecutionToken'),
    deferContext() { },
    concludeTurn() { },
  }
}

/** Fake T2/T3 service face: records every call, scripted responses. */
function fakeService() {
  const state = {
    calls: { newConversation: [], send: [], subscriptions: [], stop: [], read: [] },
    conversations: [],
    newConversationResult: { shortId: 'conv0001', sessionId: 'sess-tgt-1' },
    sendReceipt: { outcome: 'injected', messageId: 'a2a-m-1', conversationId: 'conv0001', sessionId: 'sess-tgt-1' },
    stopResult: { scope: 'turn', cancelled: true },
    unread: [],
  }
  const svc = {
    state,
    async newConversation(addr, title) {
      state.calls.newConversation.push({ addr, title })
      return { ...state.newConversationResult }
    },
    async send(req, initiator) {
      state.calls.send.push({ req, initiator })
      return { ...state.sendReceipt }
    },
    subscribeCompletion(conv, cb, opts = {}) {
      const sub = { conv, cb, opts, disposed: false }
      state.calls.subscriptions.push(sub)
      return () => { sub.disposed = true }
    },
    async stop(conv, scope) {
      state.calls.stop.push({ conv, scope })
      return { ...state.stopResult }
    },
    read(initiatorSessionId) {
      state.calls.read.push({ initiatorSessionId })
      const out = state.unread
      state.unread = []
      return out
    },
    listConversations() {
      return state.conversations.map((r) => ({ ...r }))
    },
    buffer(initiatorSessionId, message) {
      state.unread.push({ ...message, initiatorSessionId, bufferedAt: 1 })
    },
  }
  return svc
}

/** Fake T3 delivery face (live handle only for the scripted session). */
function fakeDelivery(liveFor = 'sess-777') {
  const buffered = []
  const handle = { status: 'idle', followup() { }, steer() { }, inject() { } }
  return {
    buffered,
    agents: { get: (id) => (id === liveFor ? handle : undefined) },
    buffer: (initiatorSessionId, message) => { buffered.push({ initiatorSessionId, message }) },
  }
}

/** Recorded initiator factory — the row's localA2aInitiator seam. */
function fakeInitiators() {
  const built = []
  return {
    built,
    initiatorOf: (sessionId) => {
      const initiator = { machine: 'm1ab', agent: 'aa11bb', sessionId }
      built.push(initiator)
      return initiator
    },
  }
}

function fakeRosterView() {
  return {
    self: { id: 'm1ab', label: 'local' },
    remotes: [
      { id: 'w2cd', label: 'dev3' },
      { id: 'w3ef', label: 'laptop' },
    ],
    agents: [
      { id: 'na1ive', key: 'native', label: 'DSH', path: '/', machine: 'local', ready: true, failed: false },
      { id: 'om11p2', key: 'omp', label: 'OMP', path: '/omp/', machine: 'local', ready: true, failed: false },
      { id: 'cd33x1', key: 'cd33x1', label: 'Codex · dev3', path: '/hub/?agent=cd33x1', machine: 'w2cd', ready: true, failed: false },
      { id: 'pi44x2', key: 'pi44x2', label: 'Pi · laptop', path: '/hub/?agent=pi44x2', machine: 'w3ef', ready: false, failed: true },
      // federated row whose machine row is gone from machines.json — still listed
      { id: 'zz99y8', key: 'zz99y8', label: 'Ghost · removed', path: '/hub/?agent=zz99y8', machine: 'w9zz', ready: false, failed: false },
    ],
  }
}

function makeTool(overrides = {}) {
  const service = overrides.service ?? fakeService()
  const delivery = overrides.delivery ?? fakeDelivery()
  const initiators = overrides.initiators ?? fakeInitiators()
  const watches = []
  const tool = createSuperdHubTool({
    service,
    delivery,
    roster: overrides.roster ?? fakeRosterView,
    initiatorOf: initiators.initiatorOf,
    onWatch: (dispose) => { watches.push(dispose) },
    ...overrides.deps,
  })
  return { tool, service, delivery, initiators, watches }
}

// ---------------------------------------------------------------- description

test('description carries the key sentences: address format, NEVER poll, stop semantics, delivery meaning', () => {
  const { tool } = makeTool()
  assert.equal(tool.name, 'superd-hub')
  for (const needle of [
    'SuperD Hub',
    '<m4>-<a6>',
    'agents',
    'NEVER poll',
    'resumable',
    'turn-only',
    'steer',
    'queue',
    'not yet implemented',
  ]) {
    assert.ok(tool.description.includes(needle), `description must mention ${needle}`)
  }
})

// ---------------------------------------------------------------- agents listing

test('{} → agents listing: machines grouping, addresses, ready/failed, conversations', async () => {
  const { tool, service } = makeTool()
  // 7 native conversations: only the 5 most recent survive, newest first
  service.state.conversations = [
    { shortId: 'old00001', machine: 'm1ab', agent: 'na1ive', sessionId: 's0', createdAt: 1, lastActivityAt: 50 },
    ...Array.from({ length: 5 }, (_, i) => ({
      shortId: `nat0000${i + 1}`, machine: 'm1ab', agent: 'na1ive', sessionId: `s${i + 1}`,
      createdAt: 1, lastActivityAt: 100 + i * 10,
    })),
    { shortId: 'titl0001', machine: 'm1ab', agent: 'na1ive', sessionId: 's6', title: 'mesh review', createdAt: 1, lastActivityAt: 500 },
    { shortId: 'dev00001', machine: 'w2cd', agent: 'cd33x1', sessionId: 's7', title: 'dev3 chat', createdAt: 1, lastActivityAt: 200 },
  ]
  const value = await tool.execute({}, fakeExec())
  assert.equal(value.action, 'agents')

  const machineOf = (m) => value.machines.find((row) => row.machine === m)
  // machine order: self first, then remotes in pairing order, unknown leftovers last
  assert.deepEqual(value.machines.map((m) => m.machine), ['m1ab', 'w2cd', 'w3ef', 'w9zz'])
  assert.equal(machineOf('m1ab').label, 'local')
  assert.equal(machineOf('w2cd').label, 'dev3')
  assert.equal(machineOf('w9zz').label, 'w9zz') // no machines.json row → label falls back to the m4

  const native = machineOf('m1ab').agents[0]
  assert.equal(native.id, 'na1ive')
  assert.equal(native.label, 'DSH')
  assert.equal(native.address, 'm1ab-na1ive')
  assert.equal(native.ready, true)
  assert.equal(native.failed, false)
  // alive-first = newest lastActivityAt first; ≤ RECENT_CONVERSATIONS_MAX; title only when set
  assert.equal(native.conversations.length, RECENT_CONVERSATIONS_MAX)
  assert.deepEqual(
    native.conversations.map((c) => c.conversationId),
    ['titl0001', 'nat00005', 'nat00004', 'nat00003', 'nat00002'],
  )
  assert.deepEqual(native.conversations[0], { conversationId: 'titl0001', title: 'mesh review', lastActivityAt: 500 })
  assert.deepEqual(native.conversations[1], { conversationId: 'nat00005', lastActivityAt: 140 })

  const omp = machineOf('m1ab').agents[1]
  assert.equal(omp.address, 'm1ab-om11p2')
  assert.deepEqual(omp.conversations, [])

  const codex = machineOf('w2cd').agents[0]
  assert.equal(codex.address, 'w2cd-cd33x1')
  assert.deepEqual(codex.conversations, [{ conversationId: 'dev00001', title: 'dev3 chat', lastActivityAt: 200 }])

  const pi = machineOf('w3ef').agents[0]
  assert.equal(pi.ready, false)
  assert.equal(pi.failed, true)
  assert.equal(machineOf('w9zz').agents[0].address, 'w9zz-zz99y8')
})

test('{action:"agents"} is the explicit spelling of the default', async () => {
  const { tool } = makeTool()
  const value = await tool.execute({ action: 'agents' }, fakeExec())
  assert.equal(value.action, 'agents')
  assert.ok(Array.isArray(value.machines))
})

// ---------------------------------------------------------------- new_conversation

test('new_conversation: address parsed, service called, receipt shape', async () => {
  const { tool, service } = makeTool()
  const value = await tool.execute(
    { action: 'new_conversation', agent: 'w2cd-cd33x1', title: 'mesh sync' },
    fakeExec(),
  )
  assert.deepEqual(value, {
    action: 'new_conversation',
    conversationId: 'conv0001',
    sessionId: 'sess-tgt-1',
    agent: 'cd33x1',
    machine: 'w2cd',
  })
  assert.deepEqual(service.state.calls.newConversation, [
    { addr: { machine: 'w2cd', id: 'cd33x1' }, title: 'mesh sync' },
  ])
})

test('new_conversation without a title passes undefined', async () => {
  const { tool, service } = makeTool()
  await tool.execute({ action: 'new_conversation', agent: 'm1ab-na1ive' }, fakeExec())
  assert.deepEqual(service.state.calls.newConversation, [
    { addr: { machine: 'm1ab', id: 'na1ive' }, title: undefined },
  ])
})

// ---------------------------------------------------------------- send

test('send: receipt echo, initiator threading, NO post-send watch (R4 — replies ride envelopes)', async () => {
  const { tool, service, initiators, watches } = makeTool()
  const value = await tool.execute(
    { action: 'send', agent: 'w2cd-cd33x1', conversationId: 'conv0001', message: 'status?', delivery: 'steer' },
    fakeExec('sess-999'),
  )
  assert.equal(value.action, 'send')
  assert.equal(value.outcome, 'injected')
  assert.equal(value.messageId, 'a2a-m-1')
  assert.equal(value.conversationId, 'conv0001')
  assert.equal(value.sessionId, 'sess-tgt-1')
  assert.ok(value.note.includes('never poll'))

  // initiator identity: exec.agent.id → initiatorOf → the service's initiator
  assert.deepEqual(initiators.built.map((i) => i.sessionId), ['sess-999'])
  assert.deepEqual(service.state.calls.send, [{
    req: {
      to: { machine: 'w2cd', id: 'cd33x1' },
      conversationId: 'conv0001',
      message: 'status?',
      delivery: 'steer',
    },
    initiator: { machine: 'm1ab', agent: 'aa11bb', sessionId: 'sess-999' },
  }])

  // R4: the cross-wire completion watch is RETIRED — the tool wires NOTHING
  // after a send; replies ride reply/notice envelopes through the ingest.
  assert.equal(service.state.calls.subscriptions.length, 0)
  assert.equal(watches.length, 0)
})

test('send without conversationId/title omits them; delivery defaults are not forced', async () => {
  const { tool, service } = makeTool()
  await tool.execute({ action: 'send', agent: 'm1ab-na1ive', message: 'hello' }, fakeExec())
  const { req } = service.state.calls.send[0]
  assert.equal(req.conversationId, undefined)
  assert.equal(req.title, undefined)
  assert.equal(req.delivery, undefined)
  assert.equal(req.message, 'hello')
})

test('send failed receipt: error echoed, no completion watch, no note', async () => {
  const { tool, service, watches } = makeTool()
  service.state.sendReceipt = {
    outcome: 'failed',
    messageId: 'a2a-m-2',
    sessionId: '',
    error: { code: 'a2a/gateway-unavailable', message: 'a2a: no gateway for w2cd-cd33x1' },
  }
  const value = await tool.execute({ action: 'send', agent: 'w2cd-cd33x1', message: 'x' }, fakeExec())
  assert.equal(value.outcome, 'failed')
  assert.equal(value.messageId, 'a2a-m-2')
  assert.equal(value.conversationId, undefined)
  assert.equal(value.sessionId, '')
  assert.deepEqual(value.error, { code: 'a2a/gateway-unavailable', message: 'a2a: no gateway for w2cd-cd33x1' })
  assert.equal(value.note, undefined)
  assert.equal(service.state.calls.subscriptions.length, 0)
  assert.equal(watches.length, 0)
})

// ---------------------------------------------------------------- read

test('read: unread sweep keyed by the initiator session, from rendered as address', async () => {
  const { tool, service } = makeTool()
  service.state.unread = [
    {
      messageId: 'a2a-relay-1',
      initiatorSessionId: 'sess-777',
      from: { machine: 'w2cd', id: 'cd33x1' },
      conversationId: 'conv0001',
      text: 'Agent w2cd-cd33x1 replied (conversation "mesh"):\n\nall green',
      bufferedAt: 1234,
    },
  ]
  const value = await tool.execute({ action: 'read' }, fakeExec('sess-777'))
  assert.equal(value.action, 'read')
  assert.equal(value.count, 1)
  assert.deepEqual(value.messages, [{
    messageId: 'a2a-relay-1',
    from: 'w2cd-cd33x1',
    conversationId: 'conv0001',
    text: 'Agent w2cd-cd33x1 replied (conversation "mesh"):\n\nall green',
    bufferedAt: 1234,
  }])
  assert.deepEqual(service.state.calls.read, [{ initiatorSessionId: 'sess-777' }])
})

// ---------------------------------------------------------------- stop

test('stop: turn scope default, conv ref from the address', async () => {
  const { tool, service } = makeTool()
  const value = await tool.execute(
    { action: 'stop', agent: 'w2cd-cd33x1', conversationId: 'conv0001' },
    fakeExec(),
  )
  assert.deepEqual(value, { action: 'stop', stopped: true, scope: 'turn' })
  assert.deepEqual(service.state.calls.stop, [
    { conv: { to: { machine: 'w2cd', id: 'cd33x1' }, conversationId: 'conv0001' }, scope: 'turn' },
  ])
})

test('stop session scope: the turn-only degradation note rides along', async () => {
  const { tool, service } = makeTool()
  service.state.stopResult = { scope: 'turn-only', cancelled: true, reason: 'no session-close endpoint upstream' }
  const value = await tool.execute(
    { action: 'stop', agent: 'w2cd-cd33x1', conversationId: 'conv0001', scope: 'session' },
    fakeExec(),
  )
  assert.deepEqual(value, {
    action: 'stop',
    stopped: true,
    scope: 'turn-only',
    reason: 'no session-close endpoint upstream',
  })
  assert.deepEqual(service.state.calls.stop[0].scope, 'session')
})

test('stop idle (D5): stopped:false + the honest note; session scope keeps the degradation reason', async () => {
  const { tool, service } = makeTool()
  service.state.stopResult = { scope: 'turn', cancelled: false, note: 'no turn was active' }
  const value = await tool.execute(
    { action: 'stop', agent: 'w2cd-cd33x1', conversationId: 'conv0001' },
    fakeExec(),
  )
  assert.deepEqual(value, { action: 'stop', stopped: false, scope: 'turn', note: 'no turn was active' })
  service.state.stopResult = { scope: 'turn-only', cancelled: false, note: 'no turn was active', reason: 'no session-close endpoint upstream' }
  const session = await tool.execute(
    { action: 'stop', agent: 'w2cd-cd33x1', conversationId: 'conv0001', scope: 'session' },
    fakeExec(),
  )
  assert.deepEqual(session, {
    action: 'stop',
    stopped: false,
    scope: 'turn-only',
    reason: 'no session-close endpoint upstream',
    note: 'no turn was active',
  })
})

// ---------------------------------------------------------------- exec placeholder

test('exec: placeholder leg', async () => {
  const { tool } = makeTool()
  const value = await tool.execute({ action: 'exec', mode: 'oneshot', cmd: 'ls' }, fakeExec())
  assert.deepEqual(value, { action: 'exec', note: 'not yet implemented: exec (P4)' })
})

// ---------------------------------------------------------------- gates

test('fail-loud gates: bad address / missing fields / no agent session', async () => {
  const { tool } = makeTool()
  await assert.rejects(
    tool.execute({ action: 'send', agent: 'nodash', message: 'x' }, fakeExec()),
    /E_BAD_ADDRESS/,
  )
  await assert.rejects(
    tool.execute({ action: 'send', message: 'x' }, fakeExec()),
    /E_MISSING_AGENT/,
  )
  await assert.rejects(
    tool.execute({ action: 'send', agent: 'm1ab-na1ive' }, fakeExec()),
    /E_MISSING_MESSAGE/,
  )
  await assert.rejects(
    tool.execute({ action: 'stop', agent: 'm1ab-na1ive' }, fakeExec()),
    /E_MISSING_CONVERSATION/,
  )
  await assert.rejects(
    tool.execute({ action: 'agents' }, fakeExec(null)),
    /E_NO_SESSION/,
  )
})

test('parseAgentAddress: first-dash split, both halves required', () => {
  assert.deepEqual(parseAgentAddress('m1ab-na1ive'), { machine: 'm1ab', id: 'na1ive' })
  assert.deepEqual(parseAgentAddress('w2cd-cd33x1'), { machine: 'w2cd', id: 'cd33x1' })
  assert.throws(() => parseAgentAddress('nodash'), /E_BAD_ADDRESS/)
  assert.throws(() => parseAgentAddress('-leading'), /E_BAD_ADDRESS/)
  assert.throws(() => parseAgentAddress('trailing-'), /E_BAD_ADDRESS/)
  assert.throws(() => parseAgentAddress(''), /E_BAD_ADDRESS/)
})

// ---------------------------------------------------------------- output contract

test('render is one JSON text block; every action value passes the declared output schema', async () => {
  const { tool, service } = makeTool()
  const values = [
    await tool.execute({}, fakeExec()),
    await tool.execute({ action: 'new_conversation', agent: 'm1ab-na1ive' }, fakeExec()),
    await tool.execute({ action: 'send', agent: 'm1ab-na1ive', message: 'hi' }, fakeExec()),
    await tool.execute({ action: 'read' }, fakeExec()),
    await tool.execute({ action: 'stop', agent: 'm1ab-na1ive', conversationId: 'conv0001' }, fakeExec()),
    await tool.execute({ action: 'exec' }, fakeExec()),
  ]
  for (const value of values) {
    const violations = validateJsonSchemaValue(tool.output.schema, value, '')
    assert.deepEqual(violations, [], `output schema must accept the ${value.action} value`)
    const blocks = tool.output.render({}, value)
    assert.deepEqual(blocks, [{ type: 'text', text: JSON.stringify(value) }])
  }
  // the failed-send receipt shape passes too
  service.state.sendReceipt = { outcome: 'failed', messageId: 'm', sessionId: '', error: { code: 'c', message: 'm' } }
  const failed = await tool.execute({ action: 'send', agent: 'w2cd-cd33x1', message: 'x' }, fakeExec())
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, failed, ''), [])
})

// ---------------------------------------------------------------- row wiring

/** Fake cordis ctx: records inject/effect; services only when scripted. */
function fakeRowCtx() {
  const state = { injects: [], effects: [], registered: [] }
  const ctx = {
    state,
    inject(names, cb) { state.injects.push({ names, cb }) },
    effect(fn, label) { state.effects.push({ fn, label }); return () => { } },
    get(name) { return undefined },
  }
  return ctx
}

test('row: dormant without the tools service — inject declared, nothing registered, zero filesystem effects', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-tool-dormant-'))
  try {
    const ctx = fakeRowCtx()
    wireHubToolRow(ctx, { home })
    // one dynamic inject, both hard deps named; the callback never ran
    assert.deepEqual(ctx.state.injects.map((i) => i.names), [['tools', 'typertGateway']])
    assert.equal(ctx.state.registered.length, 0)
    assert.equal(ctx.state.effects.length, 0)
    assert.equal(existsSync(join(home, 'superd')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('row: name and default export shape', async () => {
  const { default: rowPlugin, name, inject } = await import('../dist/a2a-row.js')
  assert.equal(name, 'superd-a2a')
  assert.equal(rowName, 'superd-a2a')
  assert.deepEqual(inject, [])
  assert.equal(rowPlugin.name, 'superd-a2a')
  assert.equal(typeof rowPlugin.apply, 'function')
})

/** Fake RAW typertGateway: canonical 6-arg stream face, scripted rpc results,
 * follow frames built from the prompt's requestId (T2's arming key). */
function fakeRawGateway() {
  const g = {
    calls: { dispatchRpc: [], openWireStream: [] },
    promptRequestId: undefined,
    async dispatchRpc(endpoint, payload, signal) {
      g.calls.dispatchRpc.push({ endpoint, payload, signal })
      if (endpoint === 'session/create') return { ok: true, value: { sessionId: 'sess-tgt-native' } }
      if (endpoint === 'session/prompt') {
        g.promptRequestId = payload.args.request.requestId
        return { ok: true, value: undefined }
      }
      return { ok: true, value: {} }
    },
    openWireStream(endpoint, payload, uplink, peer, signal, control) {
      g.calls.openWireStream.push({ endpoint, payload, uplink, peer, signal, control })
      const rpcId = g.promptRequestId
      return (async function*() {
        yield {
          type: 'snapshot',
          records: [
            { type: 'event', event: { type: 'turn/start', seq: 1, data: { turn: 1 } } },
            { type: 'event', event: { type: 'user/message', seq: 2, data: { source: { rpcId } } } },
            { type: 'event', event: { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: 'peer final answer' }] } } } },
            { type: 'event', event: { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } } },
          ],
        }
      })()
    },
  }
  return g
}

test('row: registers the tool; send → bridged canonical stream → auto-buffer → read sweep (full loop)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-tool-row-'))
  try {
    const ctx = fakeRowCtx()
    const raw = fakeRawGateway()
    wireHubToolRow(ctx, { home })
    const [{ cb }] = ctx.state.injects
    const subCtx = {
      tools: { register(def) { ctx.state.registered.push(def); return () => { } } },
      // postoffice R3: the row now also declares the a2a endpoint's nested
      // connection inject — record it like the outer one (its callback no-ops
      // without a real connection service, same as registerMeshRpc in tests)
      inject(names, cb) { ctx.state.injects.push({ names, cb }) },
      effect(fn, label) { ctx.state.effects.push({ fn, label }); return () => { } },
      get: (name) => (name === 'typertGateway' ? raw : undefined),
    }
    cb(subCtx)

    const [tool] = ctx.state.registered
    assert.equal(tool.name, 'superd-hub')

    // roster view over the real tmpdir home: self m4 + native a6 minted on demand
    const roster = await tool.execute({}, fakeExec('sess-777'))
    const selfId = roster.machines[0].machine
    assert.match(selfId, /^[a-z0-9]{4}$/)
    const native = roster.machines[0].agents[0]
    assert.match(native.id, /^[a-z0-9]{6}$/)
    assert.equal(native.key ?? native.label !== undefined, true)
    assert.deepEqual(native.conversations, [])

    // self-addressed send through the NATIVE seam (the bridged raw gateway)
    const receipt = await tool.execute(
      { action: 'send', agent: `${selfId}-${native.id}`, message: 'ping yourself' },
      fakeExec('sess-777'),
    )
    assert.equal(receipt.outcome, 'injected')
    assert.equal(receipt.sessionId, 'sess-tgt-native')

    // R4: the completion watch is the INGEST's own (armed on the envelope's
    // messageId; no row effect, no cross-wire follow) — it opened the follow
    // stream over the bridged raw gateway below.

    // THE bridge pin: canonical 6-arg order onto the raw instance — the
    // uplink undefined = the canonical no-lane spelling (the gateway
    // substitutes EMPTY_ASYNC_ITERABLE itself), peer undefined, signal 5th,
    // control 6th — the raw instance never sees a shifted signal
    assert.equal(raw.calls.openWireStream.length, 1)
    const [call] = raw.calls.openWireStream
    assert.equal(call.endpoint, 'session/follow')
    assert.equal(call.uplink, undefined)
    assert.equal(call.peer, undefined)
    assert.ok(call.signal instanceof AbortSignal)
    assert.ok(call.control instanceof AbortController)

    // completion fired from snapshot history → initiator not live (no agents
    // service in the fake ctx) → bounded unread buffer → read sweeps it
    let swept = { count: 0, messages: [] }
    for (let i = 0; i < 100 && swept.count === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      swept = await tool.execute({ action: 'read' }, fakeExec('sess-777'))
    }
    assert.equal(swept.count, 1)
    const [msg] = swept.messages
    assert.equal(msg.from, `${selfId}-${native.id}`)
    assert.equal(msg.conversationId, receipt.conversationId)
    assert.ok(msg.text.includes('peer final answer'))
    assert.ok(msg.text.includes('replied'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
