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
    sendReceipt: { outcome: 'delivered', messageId: 'a2a-m-1', conversationId: 'conv0001', sessionId: 'sess-tgt-1' },
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
  const execFace = overrides.exec ?? {
    selfM4: () => 'm1ab',
    run: async (input) => ({ exit: 0, stdout: `ran: ${input.cmd}`, stderr: '', durationMs: 1, truncated: false, timedOut: false, outcome: 'exited' }),
    post: async (machineId, input) => {
      if (machineId === 'w2cd') throw new Error('exec is disabled for machine "w2cd" on this registry row (execEnabled=false)')
      throw new Error(`unknown machine "${machineId}" — call agents for the roster`)
    },
    pty: async (sessionKey, machine, cmd) => ({
      output: `pty-ran[${sessionKey}@${machine}]: ${cmd}\n`, exit: 0, cwd: '/tmp', timedOut: false,
      reconnected: machine === 'w3ef', durationMs: 2,
    }),
  }
  const watches = []
  const tool = createSuperdHubTool({
    service,
    delivery,
    exec: execFace,
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
    'action:"exec", cmd',
  ]) {
    assert.ok(tool.description.includes(needle), `description must mention ${needle}`)
  }
})

// ---------------------------------------------------------------- agents listing

test('{} → agents listing: machines grouping, addresses, ready/failed — THIN rows (R6 strip)', async () => {
  const { tool, service } = makeTool()
  // conversations exist in the registry, but the listing NEVER embeds them anymore
  service.state.conversations = [
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
  // THE STRIP: no conversations key anywhere in the listing
  assert.equal('conversations' in native, false)
  for (const m of value.machines) for (const a of m.agents) assert.equal('conversations' in a, false)
  assert.deepEqual(native, { id: 'na1ive', label: 'DSH', address: 'm1ab-na1ive', ready: true, failed: false })

  const omp = machineOf('m1ab').agents[1]
  assert.equal(omp.address, 'm1ab-om11p2')

  const codex = machineOf('w2cd').agents[0]
  assert.equal(codex.address, 'w2cd-cd33x1')

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

test('send without conversationId opens a new conversation (created:true, D24)', async () => {
  const { tool, service } = makeTool()
  const value = await tool.execute(
    { action: 'send', agent: 'w2cd-cd33x1', title: 'mesh sync', message: 'hello' },
    fakeExec(),
  )
  assert.equal(value.action, 'send')
  assert.equal(value.created, true)
  assert.equal(value.conversationId, 'conv0001')
  const { req } = service.state.calls.send[0]
  assert.deepEqual(req.to, { machine: 'w2cd', id: 'cd33x1' })
  assert.equal(req.conversationId, undefined)
  assert.equal(req.title, 'mesh sync')
  assert.equal(req.message, 'hello')
})

test('T3: send with conversationId but no agent omits `to` (the hub derives the route)', async () => {
  const { tool, service } = makeTool()
  await tool.execute({ action: 'send', conversationId: 'conv0001', message: 'continue' }, fakeExec())
  const { req } = service.state.calls.send[0]
  assert.equal(req.to, undefined)
  assert.equal(req.conversationId, 'conv0001')
  assert.equal(req.message, 'continue')
})

test('T3: send without conversationId still requires agent (open needs a recipient)', async () => {
  const { tool } = makeTool()
  await assert.rejects(
    () => tool.execute({ action: 'send', message: 'hi' }, fakeExec()),
    /E_MISSING_AGENT/,
  )
})

test('T3: stop without agent omits `to` (the session owner is derived from the row)', async () => {
  const { tool, service } = makeTool()
  await tool.execute({ action: 'stop', conversationId: 'conv0001' }, fakeExec())
  assert.equal(service.state.calls.stop[0].conv.to, undefined)
  assert.equal(service.state.calls.stop[0].conv.conversationId, 'conv0001')
})

// ---------------------------------------------------------------- send

test('send: receipt echo, initiator threading, NO post-send watch (R4 — replies ride envelopes)', async () => {
  const { tool, service, initiators, watches } = makeTool()
  const value = await tool.execute(
    { action: 'send', agent: 'w2cd-cd33x1', conversationId: 'conv0001', message: 'status?', delivery: 'steer' },
    fakeExec('sess-999'),
  )
  assert.equal(value.action, 'send')
  assert.equal(value.outcome, 'delivered')
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

// ---------------------------------------------------------------- exec (P4 one-shot)

test('exec: local one-shot runs on THIS machine; pty answers honestly; unknown machine is typed', async () => {
  const { tool } = makeTool()
  const value = await tool.execute({ action: 'exec', mode: 'oneshot', cmd: 'ls' }, fakeExec())
  assert.deepEqual(value, {
    action: 'exec',
    machine: 'm1ab',
    exit: 0,
    stdout: 'ran: ls',
    stderr: '',
    durationMs: 1,
    truncated: false,
    timedOut: false,
    outcome: 'exited',
  })
  const pty = await tool.execute({ action: 'exec', mode: 'pty', cmd: 'ls', machine: 'w3ef' }, fakeExec())
  assert.deepEqual(pty, {
    action: 'exec',
    mode: 'pty',
    machine: 'w3ef',
    output: 'pty-ran[sess-777@w3ef]: ls\n',
    exit: 0,
    cwd: '/tmp',
    timedOut: false,
    reconnected: true,
    durationMs: 2,
  })
  await assert.rejects(
    tool.execute({ action: 'exec', cmd: 'ls', machine: 'nowhere' }, fakeExec()),
    /E_EXEC_FAILED.*unknown machine "nowhere"/,
  )
  await assert.rejects(
    tool.execute({ action: 'exec', cmd: 'ls', machine: 'w2cd' }, fakeExec()),
    /E_EXEC_FAILED.*exec is disabled for machine "w2cd".*execEnabled=false/,
  )
  await assert.rejects(
    tool.execute({ action: 'exec', cmd: '' }, fakeExec()),
    /E_BAD_EXEC.*cmd must be a non-empty string/,
  )
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

test('parseAgentAddress: strict <m4>-<a6> shape (T4) — malformed refused at parse, never mis-split', () => {
  assert.deepEqual(parseAgentAddress('m1ab-na1ive'), { machine: 'm1ab', id: 'na1ive' })
  assert.deepEqual(parseAgentAddress('w2cd-cd33x1'), { machine: 'w2cd', id: 'cd33x1' })
  assert.throws(() => parseAgentAddress('nodash'), /E_BAD_ADDRESS/)
  assert.throws(() => parseAgentAddress('-leading'), /E_BAD_ADDRESS/)
  assert.throws(() => parseAgentAddress('trailing-'), /E_BAD_ADDRESS/)
  assert.throws(() => parseAgentAddress(''), /E_BAD_ADDRESS/)
  // 0.1.7 surface analysis: a typo must NOT parse as machine 'no' and surface
  // downstream as "unknown machine" — strict shape refuses it here.
  assert.throws(() => parseAgentAddress('no-such-agent-zzz'), /E_BAD_ADDRESS/)
  assert.throws(() => parseAgentAddress('ab-cdefgh'), /E_BAD_ADDRESS/) // machine too short
  assert.throws(() => parseAgentAddress('abcd-cdef'), /E_BAD_ADDRESS/) // agent too short
  assert.throws(() => parseAgentAddress('abcd-cdefghi'), /E_BAD_ADDRESS/) // agent too long
  assert.throws(() => parseAgentAddress('ABCD-cdefgh'), /E_BAD_ADDRESS/) // uppercase not in the alphabet
  assert.throws(() => parseAgentAddress('abcd-cdefg!'), /E_BAD_ADDRESS/) // non-alphabet char
})

// ---------------------------------------------------------------- output contract

test('render is one JSON text block; every action value passes the declared output schema', async () => {
  const { tool, service } = makeTool()
  const values = [
    await tool.execute({}, fakeExec()),
    await tool.execute({ action: 'send', agent: 'm1ab-na1ive', message: 'hi' }, fakeExec()),
    await tool.execute({ action: 'read' }, fakeExec()),
    await tool.execute({ action: 'stop', agent: 'm1ab-na1ive', conversationId: 'conv0001' }, fakeExec()),
    await tool.execute({ action: 'exec', cmd: 'ls' }, fakeExec()),
    // 0.1.7-h D1 lock: the pty result shape (mode included) must pass the SAME
    // schema — the live mesh rejected `value.mode is not a declared property`
    // because the pty rollout added the field without declaring it here.
    await tool.execute({ action: 'exec', mode: 'pty', cmd: 'ls', machine: 'w3ef' }, fakeExec()),
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
    assert.equal('conversations' in native, false, 'R6 strip: thin rows')

    // self-addressed send through the NATIVE seam (the bridged raw gateway)
    const receipt = await tool.execute(
      { action: 'send', agent: `${selfId}-${native.id}`, message: 'ping yourself' },
      fakeExec('sess-777'),
    )
    assert.equal(receipt.outcome, 'delivered')
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
    assert.ok(msg.text.includes('last output at turn end'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- agent_status (R6)

/** One cache file fixture. */
const statusFileOf = (machines) => ({ machines })

test('agent_status: registry join → shortId + "{title} [hub A2A]"; workspace fallback; unhosted; truncation; collectedAt passthrough', async () => {
  const cache = statusFileOf({
    m1ab: {
      collectedAt: 1234500,
      agents: [{
        a6: 'na1ive',
        rows: [
          { sessionId: 'session-11111111-aaaa-bbbb-cccc-dddddddddddd', mtime: 30, status: 'busy', agentAvailable: true },
          { sessionId: 'session-22222222-aaaa-bbbb-cccc-dddddddddddd', mtime: 20, status: 'idle', agentAvailable: true },
          { sessionId: 'session-33333333-aaaa-bbbb-cccc-dddddddddddd', mtime: 10, status: 'unknown', agentAvailable: false },
        ],
        workspaces: [
          { workspaceId: 'ws1', title: 'mesh playground', sessionIds: ['session-22222222-aaaa-bbbb-cccc-dddddddddddd'] },
        ],
      }],
    },
  })
  const service = fakeService()
  service.state.conversations = [
    { shortId: 'conv111', machine: 'm1ab', agent: 'na1ive', sessionId: 'session-11111111-aaaa-bbbb-cccc-dddddddddddd', title: 'mesh review', createdAt: 1, lastActivityAt: 1 },
  ]
  const { tool } = makeTool({ service, deps: { status: () => cache } })
  const value = await tool.execute({ action: 'agent_status', agent: 'm1ab-na1ive' }, fakeExec('sess-1'))
  assert.equal(value.action, 'agent_status')
  assert.equal(value.collectedAt, 1234500)
  assert.equal(value.machine, 'm1ab')
  assert.equal(value.agent, 'na1ive')
  assert.equal(value.note, undefined)
  assert.deepEqual(value.sessions, [
    // registry join: shortId + the exact marker; sessionId truncated to the uuid head
    { conversationId: 'conv111', sessionId: '111111', title: 'mesh review [hub A2A]', status: 'busy', agentAvailable: true, mtime: 30 },
    // workspace join: the workspace title verbatim, no conversationId
    { sessionId: '222222', title: 'mesh playground', status: 'idle', agentAvailable: true, mtime: 20 },
    // neither source names it → the honest unhosted fallback
    { sessionId: '333333', title: '[unhosted]', status: 'unknown', agentAvailable: false, mtime: 10 },
  ])
  // F2 (0.1.7-n): the sentinel is a wire/registry fact — the DISPLAY renders
  // the friendly untitled form (D17 sanctions display beautification)
  service.state.conversations = [
    { shortId: 'conv222', machine: 'm1ab', agent: 'na1ive', sessionId: 'session-22222222-aaaa-bbbb-cccc-dddddddddddd', title: '[undefined]', createdAt: 1, lastActivityAt: 1 },
  ]
  const again = await tool.execute({ action: 'agent_status', agent: 'm1ab-na1ive' }, fakeExec('sess-1'))
  assert.deepEqual(again.sessions[1], { conversationId: 'conv222', sessionId: '222222', title: '(untitled) [hub A2A]', status: 'idle', agentAvailable: true, mtime: 20 })
})

test('agent_status window: alive-first then mtime desc, ≤5; missing cache/bucket/agent answered honestly', async () => {
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => ({ sessionId: `session-a${i}00000-0000-0000-0000-000000000000`, mtime: 10 + i, status: 'idle', agentAvailable: false })),
    { sessionId: 'session-b0000000-0000-0000-0000-000000000000', mtime: 1, status: 'busy', agentAvailable: true },
    { sessionId: 'session-c0000000-0000-0000-0000-000000000000', mtime: 2, status: 'busy', agentAvailable: true },
  ]
  const cache = statusFileOf({ m1ab: { collectedAt: 77, agents: [{ a6: 'na1ive', rows }] } })
  const { tool } = makeTool({ deps: { status: () => cache } })
  const value = await tool.execute({ action: 'agent_status', agent: 'm1ab-na1ive' }, fakeExec('sess-1'))
  // alive-first (the two live sessions), mtime desc within each group; ≤5 total —
  // not-in-window implies nothing (the note in the description says so)
  assert.deepEqual(value.sessions.map((r) => r.sessionId), ['c00000', 'b00000', 'a30000', 'a20000', 'a10000'])
  assert.equal(value.collectedAt, 77)
  // missing agent in the bucket → honest empty + note
  const noAgent = await tool.execute({ action: 'agent_status', agent: 'm1ab-zz99y8' }, fakeExec('sess-1'))
  assert.deepEqual(noAgent.sessions, [])
  assert.equal(noAgent.collectedAt, 77)
  assert.match(noAgent.note, /no collected status/)
  // missing machine bucket → collectedAt 0 + note
  const noBucket = await tool.execute({ action: 'agent_status', agent: 'zzzz-zz99y8' }, fakeExec('sess-1'))
  assert.equal(noBucket.collectedAt, 0)
  assert.match(noBucket.note, /no collected status/)
  // no status dep wired at all → the same honest empty
  const bare = makeTool()
  const none = await bare.tool.execute({ action: 'agent_status', agent: 'm1ab-na1ive' }, fakeExec('sess-1'))
  assert.deepEqual(none.sessions, [])
  assert.equal(none.collectedAt, 0)
  // agent param required, address validated
  await assert.rejects(
    () => bare.tool.execute({ action: 'agent_status' }, fakeExec('sess-1')),
    /E_MISSING_AGENT/,
  )
  await assert.rejects(
    () => bare.tool.execute({ action: 'agent_status', agent: 'notanaddress' }, fakeExec('sess-1')),
    /E_BAD_ADDRESS/,
  )
})

test('description and schema carry the agent_status leg and the thin-roster wording', () => {
  const { tool } = makeTool()
  assert.ok(tool.description.includes('agent_status'))
  assert.ok(tool.description.includes('machines → agents (id, label, address, ready)'))
  assert.ok(!tool.description.includes('recent conversations'))
  assert.ok(tool.description.includes('5-minute sweep'))
  assert.ok(tool.description.includes('collectedAt'))
  assert.ok(JSON.stringify(tool.parameters).includes('agent_status'), 'the action enum carries agent_status')
})

test('0.1.7-n F1: cwd on the pty leg is refused loudly (no silent parameter no-op); oneshot still honors it', async () => {
  const seen = []
  const { tool } = makeTool({
    exec: {
      selfM4: () => 'm1ab',
      run: async (input) => {
        seen.push(input)
        return { exit: 0, stdout: 'pwd-out', stderr: '', durationMs: 1, truncated: false, timedOut: false, outcome: 'exited' }
      },
      post: async () => { throw new Error('unused') },
      pty: async () => ({ output: 'pty-out', exit: 0, cwd: '/tmp', timedOut: false, reconnected: false, durationMs: 1 }),
    },
  })
  await assert.rejects(
    () => tool.execute({ action: 'exec', mode: 'pty', cmd: 'pwd', cwd: '/etc' }, fakeExec()),
    /\[E_BAD_EXEC\].*cwd is not supported with mode "pty".*cd <dir>/,
  )
  // oneshot keeps honoring cwd — the asymmetry is now explicit, not silent
  await tool.execute({ action: 'exec', cmd: 'pwd', cwd: '/etc' }, fakeExec())
  assert.equal(seen[0].cwd, '/etc')
})

test('0.1.8 T3: agent is optional on continuation (route derived); D24 the single send door', () => {
  const { tool } = makeTool()
  // T3 lives on the agent parameter: required only to OPEN, derived on resume
  assert.match(tool.parameters.properties.agent.description, /REQUIRED on send only to OPEN/)
  assert.match(tool.parameters.properties.agent.description, /omit agent/)
  assert.match(tool.description, /agent optional — the hub derives the route/)
  assert.match(tool.description, /open-or-resume/)
  assert.match(tool.description, /created/)
  // T7/D29: lifecycle narrative + messaging-has-no-status guidance
  assert.match(tool.description, /Lifecycle: OPEN once/)
  assert.match(tool.description, /MESSAGING HAS NO STATUS QUERY/)
  assert.match(tool.description, /cwd is oneshot-only/)
  assert.match(tool.parameters.properties.cwd.description, /Not accepted with mode "pty"/)
})
