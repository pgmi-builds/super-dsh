import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, EchoAgent, EchoAgentFactory, echoContent } from '../dist/index.js'

// ---------------------------------------------------------------------------
// Fake harness (M0 fake-ctx style; no dsh boot).
//
// EchoAgent/Factory touch, per instance:
//   ctx.sessions.prepare/enter/announce   (factory publication chain)
//   ctx.agents.enter/announce             (factory publication chain)
//   ctx.agent                             (owner, usually undefined)
//   ctx.effect(fn, label)                 (lifecycle disposer)
//   ctx.get('sessionPersistence')         (optional persistence)
//   ctx.events.dispatch('emit', args)     (agentEvents emit — returns callbacks)
//   ctx.logger?.warn                      (optional; agentEvents error containment)
// The real Inbox + agentEvents from @deepseek-ai/dsh-agent run against these
// fakes (root node_modules, same pinned version as the runtime).
// ---------------------------------------------------------------------------

function makeFakeSession(id, persistedEvents = []) {
  const events = [...persistedEvents]
  let seq = events.length
  const session = {
    id,
    get header() { return { version: 2, id, createdAt: 1, isSeeded: false } },
    inheritedEventCount: 0,
    ownEvents: () => events.slice(),
    snapshotEvents: (from = 0) => events.slice(from),
    get seq() { return seq },
    append(type, data, opts) {
      const event = { type, seq: seq++, time: Date.now(), data: structuredClone(data), ...(opts ?? {}) }
      events.push(event)
      session.appendLog.push(event)
      return event
    },
    appendLog: [],
  }
  return session
}

function makeFakeCtx({ sessionsList = [], persistence = undefined } = {}) {
  const emissions = []
  const agentsCalls = { enter: [], announce: [] }
  const sessionsCalls = { enter: [], announce: [] }
  const effects = []
  const sessions = {
    prepare: (id, options) => {
      const s = makeFakeSession(id, [...(options?.seed ?? [])])
      sessionsList.push(s)
      return s
    },
    enter: (session) => { sessionsCalls.enter.push(session); return () => {} },
    announce: (session) => { sessionsCalls.announce.push(session) },
  }
  const agents = {
    enter: (agent, owner) => { agentsCalls.enter.push({ agent, owner }); return () => {} },
    announce: (agent) => { agentsCalls.announce.push(agent) },
  }
  const ctx = {
    sessions,
    agents,
    agent: undefined,
    events: { dispatch: (_mode, args) => { emissions.push(args); return [] } },
    effect(fn, _label) {
      const dispose = fn()
      effects.push(typeof dispose === 'function' ? dispose : () => {})
      return () => { const d = effects.pop(); d?.() }
    },
    get: (name) => (name === 'sessionPersistence' ? persistence : undefined),
    // cordis Context.extend: derived context with own props over a prototype
    // chain to the base (Object.create pattern).
    extend(props) { return Object.assign(Object.create(this), props) },
  }
  return { ctx, emissions, agentsCalls, sessionsCalls, effects, sessionsList }
}

function textMessage(text, id = 'msg-1') {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function eventTypes(session) {
  return session.appendLog.map((e) => e.type)
}

// ---------------------------------------------------------------------------

test('apply() registers the factory under the echo key via appendFactory', () => {
  const registered = new Map()
  let disposed = false
  const effects = []
  const ctx = {
    agents: {
      appendFactory: (key, factory) => {
        registered.set(key, factory)
        return () => { disposed = true; registered.delete(key) }
      },
    },
    effect(fn) { const d = fn(); effects.push(typeof d === 'function' ? d : () => {}); return effects[effects.length - 1] },
  }
  apply(ctx)
  assert.deepStrictEqual([...registered.keys()], ['echo'])
  assert.ok(registered.get('echo') instanceof EchoAgentFactory)
  // teardown symmetry: the effect disposer removes the slot
  const dispose = effects.pop()
  dispose()
  assert.strictEqual(registered.size, 0)
  assert.ok(disposed)
})

test('apply() fails loud without a MultiAgentRegistry', () => {
  const ctx = { agents: {}, effect() { return () => {} } }
  assert.throws(() => apply(ctx), /MultiAgentRegistry/)
})

test('createAgent mints a session: opening events, ordered publication, session-start', async () => {
  const { ctx, emissions, agentsCalls, sessionsCalls, sessionsList } = makeFakeCtx()
  const factory = new EchoAgentFactory(ctx)
  const handle = await factory.createAgent(ctx, { sessionId: 'session-echo-1', meta: { cwd: '/tmp' } })
  const session = sessionsList[0]

  // opening event set (permission/preset, sandbox/mode, approval/policy)
  assert.deepStrictEqual(eventTypes(session).slice(0, 3),
    ['permission/preset', 'sandbox/mode', 'approval/policy'])

  // publication chain: sessions.enter before announce; agents.enter before announce
  assert.strictEqual(sessionsCalls.enter[0], session)
  assert.strictEqual(sessionsCalls.announce[0], session)
  assert.strictEqual(agentsCalls.enter[0].agent, handle.agent)
  assert.strictEqual(agentsCalls.announce[0], handle.agent)

  assert.ok(handle.agent instanceof EchoAgent)
  assert.strictEqual(handle.agent.id, 'session-echo-1')
  assert.strictEqual(handle.agent.status, 'idle')
  assert.strictEqual(handle.agent.session, session)

  const startEmission = emissions.find((args) => args[1] === 'agent/session-start')
  assert.ok(startEmission, 'agent/session-start emitted')
  assert.strictEqual(startEmission[2].source, 'startup')

  assert.strictEqual(typeof handle.dispose, 'function')
})

test('createAgent passes options through to persistence create (pipe principle)', async () => {
  const calls = []
  const persistence = {
    create: async (header, options) => {
      calls.push({ header, options })
      return makeFakeHandle([])
    },
    open: async () => makeFakeHandle([]),
  }
  const { ctx, sessionsList } = makeFakeCtx({ persistence })
  await new EchoAgentFactory(ctx).createAgent(ctx, { sessionId: 'session-p', inheritedEventCount: 0 })
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].header.id, 'session-p')
  // suffix flush: the three opening events were appended through the handle
  assert.deepStrictEqual(handleAppends.map((batch) => batch.map((e) => e.type)).flat(),
    ['permission/preset', 'sandbox/mode', 'approval/policy'])
})

test('followup drives one full echo turn with the correct event sequence', async () => {
  const { ctx, sessionsList, emissions } = makeFakeCtx()
  const { agent } = await new EchoAgentFactory(ctx).createAgent(ctx, { sessionId: 'session-turn' })
  const session = sessionsList[0]

  agent.followup(textMessage('hello echo'))
  // synchronous part: running + turn/open events already committed
  assert.strictEqual(agent.status, 'running')
  assert.deepStrictEqual(eventTypes(session).slice(3), ['turn/start', 'user/message', 'step/start'])
  const userEvent = session.appendLog.find((e) => e.type === 'user/message')
  assert.strictEqual(userEvent.data.content[0].text, 'hello echo')
  assert.strictEqual(userEvent.surfaceOp, 'append')

  await agent.whenIdle()
  assert.deepStrictEqual(eventTypes(session).slice(3),
    ['turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
  const assistant = session.appendLog.find((e) => e.type === 'assistant/message')
  assert.strictEqual(assistant.data.message.content[0].text, '[echo] hello echo')
  assert.strictEqual(assistant.data.message.source.provider, 'echo')
  assert.strictEqual(assistant.surfaceOp, 'append')
  const turnEnd = session.appendLog.find((e) => e.type === 'turn/end')
  assert.deepStrictEqual(turnEnd.data.reason, { kind: 'completed' })

  // status mirrored through agent/status: running then idle
  const statuses = emissions.filter((a) => a[1] === 'agent/status').map((a) => a[2].status)
  assert.deepStrictEqual(statuses, ['running', 'idle'])
})

test('queued followups run sequentially, each in its own turn', async () => {
  const { ctx, sessionsList } = makeFakeCtx()
  const { agent } = await new EchoAgentFactory(ctx).createAgent(ctx, { sessionId: 'session-q' })
  agent.followup(textMessage('one', 'm1'))
  agent.followup(textMessage('two', 'm2'))
  await agent.whenIdle()
  const session = sessionsList[0]
  const turns = session.appendLog.filter((e) => e.type === 'turn/start')
  assert.deepStrictEqual(turns.map((e) => e.data.turn), [1, 2])
  const echoes = session.appendLog.filter((e) => e.type === 'assistant/message')
  assert.deepStrictEqual(echoes.map((e) => e.data.message.content[0].text), ['[echo] one', '[echo] two'])
})

test('cancel aborts the pending echo: no assistant message, turn/end aborted', async () => {
  const { ctx, sessionsList } = makeFakeCtx()
  const { agent } = await new EchoAgentFactory(ctx).createAgent(ctx, { sessionId: 'session-cancel' })
  agent.followup(textMessage('never answered'))
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  const session = sessionsList[0]
  const types = eventTypes(session)
  assert.ok(!types.includes('assistant/message'))
  const turnEnd = session.appendLog.find((e) => e.type === 'turn/end')
  assert.strictEqual(turnEnd.data.reason.kind, 'aborted')
  assert.strictEqual(agent.status, 'idle')
})

test('cancel discards queued but unstarted followups (simplified keepInbox)', async () => {
  const { ctx, sessionsList } = makeFakeCtx()
  const { agent } = await new EchoAgentFactory(ctx).createAgent(ctx, { sessionId: 'session-qc' })
  agent.followup(textMessage('first', 'm1'))
  agent.followup(textMessage('second', 'm2'))
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  const session = sessionsList[0]
  assert.strictEqual(session.appendLog.filter((e) => e.type === 'turn/start').length, 1)
  assert.ok(!eventTypes(session).includes('assistant/message'))
})

test('whenIdle resolves immediately on a fresh agent', async () => {
  const { ctx } = makeFakeCtx()
  const { agent } = await new EchoAgentFactory(ctx).createAgent(ctx, { sessionId: 'session-idle' })
  await agent.whenIdle() // must not hang
  assert.strictEqual(agent.status, 'idle')
})

test('runMaintenance runs the task immediately and preserves its value', async () => {
  const { ctx } = makeFakeCtx()
  const { agent } = await new EchoAgentFactory(ctx).createAgent(ctx, { sessionId: 'session-maint' })
  const value = await agent.runMaintenance(async (signal) => {
    assert.ok(signal instanceof AbortSignal)
    return 42
  })
  assert.strictEqual(value, 42)
})

test('resume loads the persisted log through the persistence handle', async () => {
  const persisted = [
    { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write' } },
    { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const persistence = {
    open: async (id) => makeFakeHandle(persisted, { id }),
    create: async () => makeFakeHandle([]),
  }
  const { ctx, emissions, sessionsList } = makeFakeCtx({ persistence })
  const { agent } = await new EchoAgentFactory(ctx).resume(ctx, { resumeSessionId: 'session-resumed' })
  assert.strictEqual(agent.id, 'session-resumed')
  const startEmission = emissions.find((args) => args[1] === 'agent/session-start')
  assert.strictEqual(startEmission[2].source, 'resume')

  // the recreated agent continues the turn numbering from the persisted log
  agent.followup(textMessage('after resume'))
  await agent.whenIdle()
  const turnStart = sessionsList[0].appendLog.find((e) => e.type === 'turn/start')
  assert.strictEqual(turnStart.data.turn, 2)
})

test('resume without persistence fails loud', async () => {
  const { ctx } = makeFakeCtx()
  await assert.rejects(
    () => new EchoAgentFactory(ctx).resume(ctx, { resumeSessionId: 'session-x' }),
    /persistence is not configured/,
  )
})

test('setup runs before publication and its commit runs at the boundary', async () => {
  const order = []
  const { ctx, agentsCalls } = makeFakeCtx()
  await new EchoAgentFactory(ctx).createAgent(ctx, {
    sessionId: 'session-setup',
    setup: (agentCtx) => {
      order.push('setup')
      assert.ok(agentCtx)
      return { commit() { order.push('commit') } }
    },
  })
  // publication happened only after setup+commit
  order.push('announce')
  assert.strictEqual(agentsCalls.announce.length, 1)
})

test('echoContent prefixes the first text block, or inserts a marker block', () => {
  assert.deepStrictEqual(echoContent([{ type: 'text', text: 'hi' }]),
    [{ type: 'text', text: '[echo] hi' }])
  const blocks = echoContent([{ type: 'image', url: 'x' }, { type: 'text', text: 'cap' }])
  assert.strictEqual(blocks[0].type, 'text')
  assert.strictEqual(blocks[0].text, '[echo]')
  assert.strictEqual(blocks.length, 3)
})

// --- helpers ---------------------------------------------------------------

let handleAppends = []

function makeFakeHandle(persistedEvents, { id = 'session-h' } = {}) {
  handleAppends = []
  return {
    id,
    header: { version: 2, id, createdAt: 1, isSeeded: false },
    inheritedEventCount: 0,
    read: async () => ({ events: persistedEvents, eventState: { exclusiveOwnership: true } }),
    append: async (events) => { handleAppends.push(events) },
    close: async () => {},
  }
}
