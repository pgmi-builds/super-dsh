// agent-status (postoffice R5): the sweep's dual-responsibility legs — the
// outbox pull (claim&clear after each successful reprobe, claimed envelopes
// delivered through the SAME ingest handler the HTTP endpoint uses) and the
// D18 session-list collection (remote agents over the presentation lane,
// local agents through their in-process faces; honest statuses only —
// running maps busy/idle, anything else 'unknown'; session/list carries NO
// title upstream, so cache rows carry exactly what the payload exposes).
// Failure retention: only a SUCCESSFUL collection replaces rows; failures
// keep the previous snapshot and record an error note.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadAgentStatus,
  recordMachineCollection,
  recordMachineFailure,
  collectRemoteMachine,
  collectLocalMachine,
  pullOutboxFor,
  statusSweepLegs,
  AGENT_STATUS_ROWS_MAX,
} from '../dist/agent-status.js'
import { runReprobeSweep, setSweepCollectors } from '../dist/mesh-link.js'
import { createA2aIngest } from '../dist/a2a-ingest.js'
import { createA2aService } from '../dist/a2a-service.js'
import { ensureSelf, upsertRemote } from '../dist/machines.js'
import { WIRE } from '../dist/wire-endpoints.js'

// ---------------------------------------------------------------- fixtures

const home = () => mkdtempSync(join(tmpdir(), 'superd-agent-status-'))
const row = (id, origin, enabled = true) => ({ id, name: id, label: id, origin, enabled, addedAt: 1 })

/** A face answering session/list with the given items + a workspace baseline (recorded calls). */
function fakeListFace(items, workspaces = []) {
  const calls = []
  return {
    calls,
    face: {
      async dispatchRpc(endpoint, payload, signal) {
        calls.push({ endpoint, payload })
        return { ok: true, value: { items } }
      },
      openWireStream(endpoint, payload, signal) {
        calls.push({ endpoint, payload })
        return (async function* () {
          yield { type: 'baseline', value: { items: workspaces } }
          await new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted'))) })
        })()
      },
    },
  }
}

/** A face whose session/list rejects (per-agent failure). */
function rejectingFace(message = 'session list rejected') {
  return {
    async dispatchRpc() { const e = new Error(message); e.wire = { code: 'session/boom', message }; throw e },
    openWireStream() { throw new Error('not needed') },
  }
}

/** Fake delivery ctx (the ingest's legs deliver into it). */
function fakeDelivery(liveSessions = new Set()) {
  const delivered = []
  const buffered = []
  return {
    delivered, buffered,
    ctx: {
      agents: { get: (sessionId) => (liveSessions.has(sessionId) ? { status: 'idle', followup: (m) => delivered.push({ sessionId, how: 'followup', message: m }) } : undefined) },
      buffer: (initiatorSessionId, message) => buffered.push({ initiatorSessionId, message }),
    },
  }
}

/** A self-routed ingest over a tmp home (mirror rows + delivery, R3/R4 shapes). */
function mkIngest(homeDir, delivery) {
  const gatewayFor = () => { throw new Error('not needed') }
  return createA2aIngest({ home: homeDir, gatewayFor, delivery })
}

const probeOk = (agents) => ({ ok: true, machineId: 'k3f9', version: '0.1.0', agents })

// ---------------------------------------------------------------- cache

test('cache: successful collection replaces rows; failure keeps the snapshot + error note; corrupt reads empty', () => {
  const h = home()
  try {
    const rows = [{ sessionId: 'session-aaa', mtime: 5, status: 'busy', agentAvailable: true }]
    recordMachineCollection(h, 'k3f9', [{ a6: 'cd33x1', rows }], () => 1234500)
    let file = loadAgentStatus(h)
    assert.deepEqual(file.machines.k3f9, { collectedAt: 1234500, agents: [{ a6: 'cd33x1', rows }] })
    assert.equal(statSync(join(h, 'superd', 'agent-status.json')).mode & 0o777, 0o600)
    // failure: rows AND collectedAt stay (the data's age); the note says what happened
    recordMachineFailure(h, 'k3f9', 'session list unreachable')
    file = loadAgentStatus(h)
    assert.deepEqual(file.machines.k3f9.agents, [{ a6: 'cd33x1', rows }])
    assert.equal(file.machines.k3f9.collectedAt, 1234500)
    assert.equal(file.machines.k3f9.error, 'session list unreachable')
    // success again clears the error
    recordMachineCollection(h, 'k3f9', [], () => 1234600)
    assert.deepEqual(loadAgentStatus(h).machines.k3f9, { collectedAt: 1234600, agents: [] })
    // a machine never seen + failure → an empty snapshot with the note
    recordMachineFailure(h, 'zzzz', 'nope')
    assert.deepEqual(loadAgentStatus(h).machines.zzzz, { collectedAt: 0, agents: [], error: 'nope' })
    // a corrupt file reads as the empty cache, never throws, and accepts fresh writes
    writeFileSync(join(h, 'superd', 'agent-status.json'), '{corrupt')
    assert.deepEqual(loadAgentStatus(h), { machines: {} })
    recordMachineCollection(h, 'k3f9', [], () => 1)
    assert.deepEqual(loadAgentStatus(h).machines.k3f9, { collectedAt: 1, agents: [] })
  } finally { rmSync(h, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- collection

test('collectRemoteMachine: honest rows over the presentation lane; per-agent face miss marked; cap ≤32', async () => {
  const h = home()
  try {
    const items = [
      { sessionId: 'session-busy1', updatedAt: 30, running: true, agentAvailable: true },
      { sessionId: 'session-idle2', updatedAt: 20, running: false, agentAvailable: true },
      { sessionId: 'session-unknwn', updatedAt: 10, agentAvailable: false }, // running not observable → unknown
      ...Array.from({ length: 40 }, (_, i) => ({ sessionId: `session-pad${i}`, updatedAt: i, running: false, agentAvailable: true })),
    ]
    const list = fakeListFace(items)
    const missing = rejectingFace('plane down')
    await collectRemoteMachine(h, row('k3f9', 'http://k3f9:4999'), probeOk([
      { id: 'cd33x1', key: 'codex', label: 'codex', ready: true, failed: false },
      { id: 'noFace9', key: 'omp', label: 'omp', ready: true, failed: false },
      { id: 'deadFa0', key: 'pi', label: 'pi', ready: false, failed: true },
    ]), { faceOf: (a6) => (a6 === 'cd33x1' ? list.face : a6 === 'deadFa0' ? missing : undefined) })
    const machine = loadAgentStatus(h).machines.k3f9
    assert.equal(machine.error, undefined)
    assert.equal(machine.agents.length, 3)
    // honest statuses + the ≤32 cap in payload order + the `_request` args key
    const codex = machine.agents[0]
    assert.equal(codex.rows.length, AGENT_STATUS_ROWS_MAX)
    assert.deepEqual(codex.rows[0], { sessionId: 'session-busy1', mtime: 30, status: 'busy', agentAvailable: true })
    assert.deepEqual(codex.rows[1], { sessionId: 'session-idle2', mtime: 20, status: 'idle', agentAvailable: true })
    assert.deepEqual(codex.rows[2], { sessionId: 'session-unknwn', mtime: 10, status: 'unknown', agentAvailable: false })
    assert.deepEqual(list.calls.map((c) => c.endpoint), ['session/list', 'workspace/follow'])
    assert.deepEqual(list.calls[0].payload, { args: { _request: {} } })
    // no face → an honest miss, never a guess
    assert.deepEqual(machine.agents[1], { a6: 'noFace9', rows: [], error: 'no gateway face for the session list' })
    assert.deepEqual(machine.agents[2], { a6: 'deadFa0', rows: [], error: 'plane down' })
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('collectLocalMachine: every local a6 through its in-process face, cached under the self bucket', async () => {
  const h = home()
  const self = ensureSelf(h, 'local')
  try {
    // seed the id store: two local agents (native + a world key)
    const { ensureAgentId } = await import('../dist/agent-ids.js')
    const nativeA6 = ensureAgentId(h, 'native')
    const ompA6 = ensureAgentId(h, 'omp')
    const nativeList = fakeListFace([{ sessionId: 'session-nat1', updatedAt: 9, running: false, agentAvailable: true }])
    const ompList = fakeListFace([{ sessionId: 'session-omp1', updatedAt: 8, running: true, agentAvailable: true }])
    const gatewayFor = (addr) => (addr.id === nativeA6 ? nativeList.face : addr.id === ompA6 ? ompList.face : undefined)
    await collectLocalMachine(h, gatewayFor)
    const machine = loadAgentStatus(h).machines[self.id]
    assert.ok(machine, 'the self bucket exists')
    assert.equal(machine.agents.length, 2)
    assert.deepEqual(machine.agents.find((a) => a.a6 === nativeA6).rows,
      [{ sessionId: 'session-nat1', mtime: 9, status: 'idle', agentAvailable: true }])
    assert.deepEqual(machine.agents.find((a) => a.a6 === ompA6).rows,
      [{ sessionId: 'session-omp1', mtime: 8, status: 'busy', agentAvailable: true }])
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('collectLocalMachine：全员失败的采集记为 machine 失败，绝不落成新的空窗口（O1b）', async () => {
  const h = home()
  const self = ensureSelf(h, 'local')
  try {
    const { ensureAgentId } = await import('../dist/agent-ids.js')
    const nativeA6 = ensureAgentId(h, 'native')
    // 重启前留下的真实快照（warm home 本来就带着一个）
    const prior = [{ sessionId: 'session-real', mtime: 7, status: 'idle', agentAvailable: true }]
    recordMachineCollection(h, self.id, [{ a6: nativeA6, rows: prior }], () => 4242)
    // 观察到的启动形态：本地 session plane 还没挂上，每个 face 都拒
    const gatewayFor = () => { throw new Error('typert gateway: session/list: active Service "sessionController" is unavailable') }
    await collectLocalMachine(h, gatewayFor)
    const bucket = loadAgentStatus(h).machines[self.id]
    assert.equal(bucket.collectedAt, 4242, '前一份快照与它的 age 都活下来（失败不替换 rows）')
    assert.deepEqual(bucket.agents, [{ a6: nativeA6, rows: prior }])
    assert.match(bucket.error, /collection failed for every agent \(1\)/)
    assert.match(bucket.error, /sessionController/)
    // 冷 home 的同一个失败：读作「尚未采集」，绝不读作「没有 session」
    const cold = home()
    try {
      const coldSelf = ensureSelf(cold, 'local')
      ensureAgentId(cold, 'native')
      await collectLocalMachine(cold, gatewayFor)
      const coldBucket = loadAgentStatus(cold).machines[coldSelf.id]
      assert.equal(coldBucket.collectedAt, 0)
      assert.deepEqual(coldBucket.agents, [])
      assert.match(coldBucket.error, /collection failed for every agent \(1\)/)
    } finally { rmSync(cold, { recursive: true, force: true }) }
  } finally { rmSync(h, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- outbox pull

test('pullOutboxFor: claims with cookie + selfId, delivers in order through the ingest, per-envelope degrade', async () => {
  const h = home()
  const self = ensureSelf(h, 'local')
  try {
    upsertRemote(h, { ...row('k3f9', 'http://k3f9:4999'), cookie: 'dsh-auth-k3f9=1' })
    // seed the initiator row so the inbound reply resolves registry attribution
    const { saveConversations } = await import('../dist/a2a-service.js')
    saveConversations(h, {
      conversations: [{
        shortId: 'ini555', machine: 'k3f9', agent: 'cd33x1', sessionId: 'sess-at-k3f9',
        title: 'mesh talk', initiatorSession: 'session-init-1', createdAt: 1, lastActivityAt: 1,
      }]
    })
    const delivery = fakeDelivery(new Set(['session-init-1']))
    const ingest = mkIngest(h, delivery.ctx)
    const gets = []
    const fetchImpl = async (url, init) => {
      gets.push({ url: String(url), init })
      assert.equal(init.method, 'GET')
      return new Response(JSON.stringify({
        v: 1, envelopes: [
          { kind: 'reply', to: { machine: self.id, agent: 'aa11bb', sessionId: 'session-init-1' }, conversation: 'ini555', text: 'first reply', messageId: 'a2a-relay-1' },
          { kind: 'reply', to: { machine: self.id, agent: 'aa11bb', sessionId: 'session-init-1' }, conversation: 'ini555', text: 'second reply', messageId: 'a2a-relay-2' },
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const delivered = await pullOutboxFor(h, row('k3f9', 'http://k3f9:4999'), ingest, { fetchImpl })
    assert.equal(delivered, 2)
    assert.equal(gets.length, 1)
    assert.equal(gets[0].url, `http://k3f9:4999/api/superd/a2a/outbox?machine=${self.id}`)
    assert.equal(gets[0].init.headers.cookie, 'dsh-auth-k3f9=1')
    // delivered IN ORDER through the SAME delivery leg the push path uses
    assert.deepEqual(delivery.delivered.map((d) => d.message.content[0].text.match(/first reply|second reply/)[0]), ['first reply', 'second reply'])
    assert.equal(delivery.delivered[0].message.source.kind, 'a2a-relay')
    assert.equal(delivery.delivered[0].message.source.conversationId, 'ini555')
  } finally { rmSync(h, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- sweep integration

test('sweep integration: one sweep → local bucket + outbox claimed + remote cache written; dead probe untouched', async () => {
  const h = home()
  const self = ensureSelf(h, 'local')
  try {
    upsertRemote(h, { ...row('k3f9', 'http://k3f9:4999'), cookie: 'dsh-auth-k3f9=1' })
    upsertRemote(h, row('dead99', 'http://dead1:4999'))
    // pre-seed the dead machine's cache — a failed probe must NOT touch it
    recordMachineCollection(h, 'dead99', [{ a6: 'dd0001', rows: [{ sessionId: 'session-old', mtime: 1, status: 'idle', agentAvailable: false }] }], () => 111)
    const { ensureAgentId, saveConversations } = await import('../dist/agent-ids.js')
    const nativeA6 = ensureAgentId(h, 'native')
    const { saveConversations: saveRows } = await import('../dist/a2a-service.js')
    saveRows(h, {
      conversations: [{
        shortId: 'ini777', machine: 'k3f9', agent: 'cd33x1', sessionId: 'sess-at-k3f9',
        initiatorSession: 'session-init-1', createdAt: 1, lastActivityAt: 1,
      }]
    })
    void saveConversations
    const delivery = fakeDelivery(new Set(['session-init-1']))
    const ingest = mkIngest(h, delivery.ctx)
    const localList = fakeListFace([{ sessionId: 'session-nat9', updatedAt: 99, running: false, agentAvailable: true }])
    const remoteList = fakeListFace([{ sessionId: 'session-rem9', updatedAt: 98, running: true, agentAvailable: true }])
    const fetchImpl = async (url, init) => {
      const u = String(url)
      if (u.startsWith('http://k3f9:4999/api/agent-runtime')) {
        return new Response(JSON.stringify({ available: true, hub: { machineId: 'k3f9', version: '0.1.0' }, agents: [{ id: 'cd33x1', key: 'codex', label: 'codex', ready: true, failed: false }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.startsWith('http://k3f9:4999/api/superd/a2a/outbox')) {
        return new Response(JSON.stringify({
          v: 1, envelopes: [
            { kind: 'reply', to: { machine: self.id, agent: nativeA6, sessionId: 'session-init-1' }, conversation: 'ini777', text: 'swept reply', messageId: 'a2a-relay-s' },
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.startsWith('http://dead1')) return Promise.reject(new Error('connection refused'))
      throw new Error(`unexpected url ${u}`)
    }
    const legs = statusSweepLegs({
      home: h,
      gatewayFor: (addr) => (addr.id === nativeA6 ? localList.face : undefined),
      ingest,
      remoteFaceOf: (a6) => (a6 === 'cd33x1' ? remoteList.face : undefined),
      fetchImpl,
    })
    await runReprobeSweep({ home: h, fetchImpl, collectors: legs })
    // local bucket collected
    const file = loadAgentStatus(h)
    assert.deepEqual(file.machines[self.id].agents,
      [{ a6: nativeA6, rows: [{ sessionId: 'session-nat9', mtime: 99, status: 'idle', agentAvailable: true }], workspaces: [] }])
    // remote bucket collected over the presentation-lane face
    assert.deepEqual(file.machines.k3f9.agents,
      [{ a6: 'cd33x1', rows: [{ sessionId: 'session-rem9', mtime: 98, status: 'busy', agentAvailable: true }], workspaces: [] }])
    // the outbox claim delivered the reply into the local initiator session
    assert.equal(delivery.delivered.length, 1)
    assert.match(delivery.delivered[0].message.content[0].text, /swept reply/)
    // the dead machine: previous snapshot intact, collectedAt unchanged
    assert.deepEqual(file.machines.dead99, { collectedAt: 111, agents: [{ a6: 'dd0001', rows: [{ sessionId: 'session-old', mtime: 1, status: 'idle', agentAvailable: false }] }] })
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('sweep degradation: a throwing outbox pull never breaks the loop; the registry route wires legs into the sweep', async () => {
  const h = home()
  try {
    upsertRemote(h, row('k3f9', 'http://k3f9:4999'))
    const calls = { local: 0, remote: 0, pull: 0 }
    const fetchImpl = async (url) => {
      const u = String(url)
      if (u.startsWith('http://k3f9:4999/api/agent-runtime')) {
        return new Response(JSON.stringify({ available: true, hub: { machineId: 'k3f9', version: '0.1.0' }, agents: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      calls.pull += 1
      throw new Error('outbox exploded')
    }
    const ingest = { ingest: async () => { throw new Error('should not reach delivery when the claim failed') } }
    const legs = statusSweepLegs({ home: h, gatewayFor: () => undefined, ingest, fetchImpl })
    // registry route: setSweepCollectors feeds runReprobeSweep without deps
    setSweepCollectors({
      onLocalCollect: async () => { calls.local += 1 },
      onRemoteProbed: legs.onRemoteProbed,
    })
    try {
      await runReprobeSweep({ home: h, fetchImpl })
      assert.equal(calls.local, 1, 'the local leg ran once via the registry')
      assert.equal(calls.pull, 1, 'the outbox claim was attempted')
      // the pull failed; the session-list collection still ran (empty roster → empty agents, machine recorded)
      const machine = loadAgentStatus(h).machines.k3f9
      assert.ok(machine, 'collection still happened despite the pull failure')
      assert.deepEqual(machine.agents, [])
      assert.equal(machine.error, undefined)
    } finally {
      setSweepCollectors(undefined)
    }
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('workspace baseline collection: join fields land in the cache; a failing follow keeps rows + notes the error', async () => {
  const h = home()
  try {
    const face = {
      async dispatchRpc() { return { ok: true, value: { items: [{ sessionId: 'session-ws001', updatedAt: 5, running: false, agentAvailable: true }] } } },
      openWireStream(endpoint, payload, signal) {
        return (async function* () {
          yield {
            type: 'baseline',
            value: { items: [
              { workspaceId: 'ws-1', path: '/home/x', title: 'repo work', sessionIds: ['session-ws001', 'session-ws002'], createdAt: 't', updatedAt: 't' },
              { workspaceId: 'ws-2', path: '/home/y', title: 'scratch', sessionIds: [], createdAt: 't', updatedAt: 't' },
              { workspaceId: '', title: 'junk', sessionIds: [] }, // dropped by validation
            ] },
          }
          await new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted'))) })
        })()
      },
    }
    await collectRemoteMachine(h, row('k3f9', 'http://k3f9:4999'), probeOk([{ id: 'cd33x1', key: 'codex', label: 'codex', ready: true, failed: false }]), { faceOf: () => face })
    const agent = loadAgentStatus(h).machines.k3f9.agents[0]
    // join fields only — path/createdAt/updatedAt trimmed; invalid rows dropped
    assert.deepEqual(agent.workspaces, [
      { workspaceId: 'ws-1', title: 'repo work', sessionIds: ['session-ws001', 'session-ws002'] },
      { workspaceId: 'ws-2', title: 'scratch', sessionIds: [] },
    ])
    assert.equal(agent.error, undefined)
    // a workspace-follow death keeps the fresh rows and notes it (title join falls back honestly)
    const dyingFace = {
      async dispatchRpc() { return { ok: true, value: { items: [] } } },
      openWireStream() { throw new Error('feed gone') },
    }
    await collectRemoteMachine(h, row('k3f9', 'http://k3f9:4999'), probeOk([{ id: 'cd33x1', key: 'codex', label: 'codex', ready: true, failed: false }]), { faceOf: () => dyingFace })
    const marked = loadAgentStatus(h).machines.k3f9.agents[0]
    assert.deepEqual(marked.rows, [])
    assert.equal(marked.workspaces, undefined)
    assert.match(marked.error, /workspace follow failed — feed gone/)
  } finally { rmSync(h, { recursive: true, force: true }) }
})
