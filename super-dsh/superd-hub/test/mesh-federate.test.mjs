// Federation registrar (mesh P2 Task 3): a paired machine's probed roster
// lands in the LOCAL registries — targets.ts (a6 → wire gateway) plus roster.ts
// rows carrying `machine` — and mesh-link's lifecycle events drive converge /
// degrade / defederate. Pins: pair → visible (targets + roster + agentLinks),
// reprobe convergence unregisters stale agents, DELETE defederates, probe
// unreachable degrades (rows KEPT, ready=false, failed=false), local label and
// a6 dual demux hit the right gateway (a6 rides the wire toward the peer's
// RUNTIME key), duplicate federate is idempotent (no registerAgent throw, no
// roster churn), ordering native → local → remote (machine label, agent label).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  federateAgents, defederateMachine, defederateStaleMachine, degradeMachine,
  federatedGatewayOf, startMeshFederation,
} from '../dist/mesh-federate.js'
import { pairMachine, reprobeMachine, cookieOf, onMeshFederationEvent, resetMachineStatus } from '../dist/mesh-link.js'
import { listAgents, registerAgent, unregisterAgent, onRosterChanged } from '../dist/roster.js'
import { getTarget, listRuntimeKeys, registerForeignTarget, unregisterForeignTarget } from '../dist/targets.js'
import { agentLinks } from '../dist/agent-roster.js'
import { registerHostMount } from '../dist/world-host.js'
import { handleMeshMachines, MESH_API_BASE } from '../dist/mesh-rpc.js'
import { registerHubRoute } from '../dist/hub-route.js'
import { upsertRemote } from '../dist/machines.js'

const home = () => mkdtempSync(join(tmpdir(), 'superd-mesh-federate-'))

/** Drop ALL module-level registry state (roster rows, targets, federation memo). */
function sweep() {
  const machines = new Set(listAgents().filter((e) => e.machine !== undefined).map((e) => e.machine))
  for (const m of machines) defederateMachine(m)
  for (const e of listAgents()) unregisterAgent(e.key)
  for (const k of listRuntimeKeys()) if (k !== 'native') unregisterForeignTarget(k)
}

/** Fake local world gateway (hub-route.test.mjs worldGateway shape + a tag). */
function fakeGateway(tag) {
  const calls = []
  return {
    tag,
    calls,
    async dispatchRpc(endpoint, payload, signal) { calls.push({ endpoint, payload, aborted: signal.aborted }); return { ok: true, value: tag } },
    openWireStream() { return (async function*() { })() },
  }
}

/** Minimal "remote hub" fixture (mesh-link.test.mjs 同款) + the wire half this
 *  task consumes: POST /hub/api?agent=<key> answers a server-response envelope
 *  echoing `wire:<key>` — driving a federated gateway through the REAL
 *  /hub demux exercises the peer-facing contract, not a stub. */
function startRemoteHub(opts = {}) {
  const state = {
    machineId: opts.machineId ?? 'k3f9',
    token: opts.token ?? 'ok',
    agents: opts.agents ?? [{ id: 'q7m2xp', key: 'codex', label: 'Codex', ready: true, failed: false }],
    probeStatus: undefined, // set → /api/agent-runtime answers this status (unreachable probe)
    validCookies: new Set(),
    posts: [], // native-face POSTs: { url, agent } — pins the no-query shape
  }
  let seq = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      if (url.searchParams.get('token') !== state.token) { res.statusCode = 403; res.end('bad token'); return }
      const value = `v${++seq}`
      state.validCookies.add(value)
      res.statusCode = 303
      res.setHeader('Location', './')
      res.setHeader('Set-Cookie', `dsh-auth-x=${value}; Path=/; HttpOnly; SameSite=Lax`)
      res.end()
      return
    }
    if (url.pathname === '/api/agent-runtime') {
      if (state.probeStatus !== undefined) { res.statusCode = state.probeStatus; res.end('probe broken'); return }
      const values = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).filter(Boolean).map((p) => p.slice(p.indexOf('=') + 1))
      if (!values.some((v) => state.validCookies.has(v))) { res.statusCode = 401; res.end('auth required'); return }
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ available: true, agents: state.agents, hub: { machineId: state.machineId, version: '0.1.6' } }))
      return
    }
    if (url.pathname === '/api' && req.method === 'POST') {
      // ctx0's own envelope surface (native face): NO ?agent= demux key
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        state.posts.push({ url: req.url, agent: url.searchParams.get('agent') })
        const env = JSON.parse(raw)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { ok: true, value: 'wire:native' } }))
      })
      return
    }
    if (url.pathname === '/hub/api' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const env = JSON.parse(raw)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { ok: true, value: `wire:${url.searchParams.get('agent')}` } }))
      })
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        server,
        state,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(done) }),
      })
    })
  })
}

// ---- hub-route drive helpers (fakeReal/fakeRes/envelopeReq, hub-route.test.mjs 同款) ----

function fakeReal() {
  return {
    routes: new Map(),
    upgrades: new Map(),
    register(route) { this.routes.set(`${route.kind}:${route.path}`, route); return () => this.routes.delete(`${route.kind}:${route.path}`) },
    registerUpgrade(route) { this.upgrades.set(route.path, route); return () => this.upgrades.delete(route.path) },
  }
}

function fakeRes() {
  return {
    status: 0, headers: undefined, body: undefined, chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers },
    write(chunk) { this.chunks.push(chunk); return true },
    end(body) { this.body = body },
  }
}

function envelopeReq(url) {
  return {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} })) },
  }
}

/** The composed demux exactly as gateway.ts constructs it: federation table
 *  (a6 exact) first, then the shared local target registry (label aliases). */
const demux = (label) => federatedGatewayOf(label) ?? getTarget(label)?.gateway

test('federateAgents：a6 行进 targets+roster；label=<Label> · <name>；machine 字段就位；空 a6 跳过；peer native 行照常采纳', () => {
  sweep()
  const gw = { codex: fakeGateway('gw-codex'), omp: fakeGateway('gw-omp'), native: fakeGateway('gw-native') }
  const seen = []
  federateAgents(
    { id: 'k3f9', name: 'dev3' },
    [
      { id: 'q7m2xp', key: 'codex', label: 'Codex', ready: true, failed: false },
      { id: 'ab12cd', key: 'omp', label: 'OMP', ready: false, failed: true },
      { id: 'zz9nat', key: 'native', label: 'Native', ready: true, failed: false }, // peer 的 native 行：a6 采纳，不跳过
      { id: '', key: 'junk', label: 'Junk', ready: true, failed: false }, // 空 a6：不可 keyed
    ],
    (agent) => { seen.push(agent.key); return gw[agent.key] },
  )
  assert.deepEqual(listAgents(), [
    { key: 'q7m2xp', label: 'Codex · dev3', machine: 'k3f9', ready: true, failed: false },
    { key: 'ab12cd', label: 'OMP · dev3', machine: 'k3f9', ready: false, failed: true },
    { key: 'zz9nat', label: 'Native · dev3', machine: 'k3f9', ready: true, failed: false },
  ])
  assert.equal(getTarget('zz9nat').gateway, gw.native, "the peer's native row registers its gateway like any other row")
  assert.equal(getTarget('q7m2xp').gateway, gw.codex)
  assert.equal(getTarget('ab12cd').gateway, gw.omp)
  assert.deepEqual(seen, ['codex', 'omp', 'native'], 'the factory receives the full agent row (face selection material)')
  assert.ok(listRuntimeKeys().includes('zz9nat'))
  assert.equal(listRuntimeKeys().filter((k) => k === 'native').length, 1, 'the LOCAL native reserve is untouched by adoption')
  sweep()
  assert.deepEqual(listAgents(), [])
  assert.equal(getTarget('q7m2xp'), undefined)
  assert.equal(getTarget('zz9nat'), undefined)
})

test('幂等：重复 federate 无 throw、零 roster churn；ready/label 变化 → 替换行', () => {
  sweep()
  let emits = 0
  const off = onRosterChanged(() => { emits += 1 })
  try {
    const agents = [{ id: 'q7m2xp', key: 'codex', label: 'Codex', ready: true, failed: false }]
    federateAgents({ id: 'k3f9', name: 'dev3' }, agents, () => fakeGateway('g'))
    const afterFirst = emits
    federateAgents({ id: 'k3f9', name: 'dev3' }, agents, () => fakeGateway('g2')) // 二次：同数据
    assert.equal(emits, afterFirst, 'converged 行不重发 roster 事件')
    assert.equal(listAgents().length, 1)
    // 变化（远端 rename + ready 翻转）→ 幂等替换（先 unregister 再 register，不 throw）
    federateAgents({ id: 'k3f9', name: 'dev3' }, [{ id: 'q7m2xp', key: 'codex', label: 'Codex2', ready: false, failed: false }], () => fakeGateway('g3'))
    assert.deepEqual(listAgents(), [{ key: 'q7m2xp', label: 'Codex2 · dev3', machine: 'k3f9', ready: false, failed: false }])
    assert.ok(emits > afterFirst)
  } finally {
    off()
    sweep()
  }
})

test('defederateStaleMachine 收敛：live a6 保留、消失者注销；degradeMachine 行保留 ready=false failed=false', () => {
  sweep()
  const agents = [
    { id: 'q7m2xp', key: 'codex', label: 'Codex', ready: true, failed: false },
    { id: 'ab12cd', key: 'omp', label: 'OMP', ready: true, failed: false },
  ]
  federateAgents({ id: 'k3f9', name: 'dev3' }, agents, () => fakeGateway('g'))
  // 本地行不受远端收敛影响
  registerAgent({ key: 'omp', label: 'OMP local', ready: true })
  defederateStaleMachine('k3f9', new Set(['q7m2xp']))
  assert.deepEqual(listAgents().map((e) => e.key).sort(), ['omp', 'q7m2xp'])
  assert.equal(getTarget('ab12cd'), undefined)
  assert.notEqual(getTarget('q7m2xp'), undefined)

  // 降级语义：probe unreachable → 行保留、ready=false、failed 不动
  degradeMachine('k3f9')
  const degraded = listAgents().find((e) => e.key === 'q7m2xp')
  assert.equal(degraded.ready, false)
  assert.equal(degraded.failed, false)
  assert.equal(degraded.machine, 'k3f9')
  assert.equal(listAgents().find((e) => e.key === 'omp').ready, true, '本地行不降级')

  defederateMachine('k3f9')
  assert.equal(listAgents().find((e) => e.machine === 'k3f9'), undefined)
  assert.equal(getTarget('q7m2xp'), undefined)
  sweep()
})

test('pair 全链（wiring）：mesh-link 事件 → 联邦注册 → roster/targets/agentLinks 可见；cookieOf 读 jar', async () => {
  sweep()
  resetMachineStatus()
  const hub = await startRemoteHub({ machineId: 'k3f9', token: 'boot-tok' })
  const h = home()
  const stop = startMeshFederation({ home: h })
  try {
    const out = await pairMachine(h, { name: 'dev3', tokenUrl: `${hub.origin}/?token=boot-tok` })
    assert.equal(out.machineId, 'k3f9')
    assert.deepEqual(listAgents(), [{ key: 'q7m2xp', label: 'Codex · dev3', machine: 'k3f9', ready: true, failed: false }])
    assert.notEqual(getTarget('q7m2xp'), undefined)
    assert.ok(listRuntimeKeys().includes('q7m2xp'))

    const links = agentLinks(h)
    assert.equal(links.length, 2)
    assert.equal(links[0].key, 'native')
    const remote = links[1]
    assert.equal(remote.key, 'q7m2xp')
    assert.equal(remote.id, 'q7m2xp', 'a6 即行 id（owner-minted，原样采纳，不本地重铸）')
    assert.equal(remote.label, 'Codex · dev3')
    assert.equal(remote.machine, 'k3f9')
    assert.equal(remote.path, '/hub/?agent=q7m2xp')
    assert.equal(remote.ready, true)

    // gateway memo：federatedGatewayOf 命中且跨重复事件身份稳定
    const gw = federatedGatewayOf('q7m2xp')
    assert.notEqual(gw, undefined)
    await reprobeMachine(h, 'k3f9')
    assert.equal(federatedGatewayOf('q7m2xp'), gw)

    // cookie seam：jar 优先；未知机器 → ''
    assert.equal(cookieOf('k3f9'), out.row.cookie)
    assert.equal(cookieOf('zzzz', h), '')
    assert.equal(cookieOf('zzzz'), '')
  } finally {
    stop()
    sweep()
    rmSync(h, { recursive: true, force: true })
    await hub.close()
  }
})

test('reprobe 收敛：roster 变化 → stale 注销、变化行更新；unreachable → 行保留 ready=false；恢复 → ready 回升', async () => {
  sweep()
  resetMachineStatus()
  const hub = await startRemoteHub({
    machineId: 'k3f9', token: 'keep-tok',
    agents: [
      { id: 'q7m2xp', key: 'codex', label: 'Codex', ready: true, failed: false },
      { id: 'ab12cd', key: 'omp', label: 'OMP', ready: true, failed: false },
    ],
  })
  const h = home()
  const stop = startMeshFederation({ home: h })
  try {
    await pairMachine(h, { name: 'dev3', tokenUrl: `${hub.origin}/?token=keep-tok` })
    assert.equal(listAgents().length, 2)

    // 远端 roster 变化：omp 消失、codex ready 翻转
    hub.state.agents = [{ id: 'q7m2xp', key: 'codex', label: 'Codex', ready: false, failed: false }]
    const r1 = await reprobeMachine(h, 'k3f9')
    assert.equal(r1.ok, true)
    assert.deepEqual(listAgents(), [{ key: 'q7m2xp', label: 'Codex · dev3', machine: 'k3f9', ready: false, failed: false }])
    assert.equal(getTarget('ab12cd'), undefined)

    // 不可达：行保留、ready=false、failed=false（orchestra 降级语义）
    hub.state.probeStatus = 503
    const r2 = await reprobeMachine(h, 'k3f9')
    assert.equal(r2.ok, false)
    assert.equal(r2.status, 'unreachable')
    assert.deepEqual(listAgents(), [{ key: 'q7m2xp', label: 'Codex · dev3', machine: 'k3f9', ready: false, failed: false }])
    assert.notEqual(getTarget('q7m2xp'), undefined, '降级不注销 target')

    // 恢复：ready 回升
    hub.state.probeStatus = undefined
    hub.state.agents = [{ id: 'q7m2xp', key: 'codex', label: 'Codex', ready: true, failed: false }]
    const r3 = await reprobeMachine(h, 'k3f9')
    assert.equal(r3.ok, true)
    assert.equal(listAgents()[0].ready, true)
  } finally {
    stop()
    sweep()
    rmSync(h, { recursive: true, force: true })
    await hub.close()
  }
})

test('DELETE machine → 全注销（事件总线 → defederateMachine）', async () => {
  sweep()
  resetMachineStatus()
  const hub = await startRemoteHub({ machineId: 'k3f9', token: 'boot-tok' })
  const h = home()
  const stop = startMeshFederation({ home: h })
  try {
    await pairMachine(h, { name: 'dev3', tokenUrl: `${hub.origin}/?token=boot-tok` })
    assert.equal(listAgents().length, 1)
    const res = await handleMeshMachines(new Request(`http://x${MESH_API_BASE}?id=k3f9`, { method: 'DELETE' }), { home: h })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { removed: true })
    assert.deepEqual(listAgents(), [])
    assert.equal(getTarget('q7m2xp'), undefined)
    assert.equal(federatedGatewayOf('q7m2xp'), undefined, 'gateway memo 随机器注销清空')
    // 再删 → removed:false，无副作用
    const again = await handleMeshMachines(new Request(`http://x${MESH_API_BASE}?id=k3f9`, { method: 'DELETE' }), { home: h })
    assert.deepEqual(await again.json(), { removed: false })
  } finally {
    stop()
    sweep()
    rmSync(h, { recursive: true, force: true })
    await hub.close()
  }
})

test('双 demux：本地 label 与 a6 各命中正确 gateway；a6 经 wire 打到远端 runtime key', async () => {
  sweep()
  resetMachineStatus()
  const hub = await startRemoteHub({ machineId: 'k3f9', token: 'boot-tok' })
  const h = home()
  const stop = startMeshFederation({ home: h })
  const local = fakeGateway('local')
  registerForeignTarget({ key: 'codex', gateway: local })
  const real = fakeReal()
  const disposeRoute = registerHubRoute({ real, authorize: () => true, gatewayOf: demux })
  try {
    await pairMachine(h, { name: 'dev3', tokenUrl: `${hub.origin}/?token=boot-tok` })
    // 本地 label 别名 → 本地 world gateway；未注册 → undefined（不碰 wire）
    assert.equal(demux('codex'), local)
    assert.equal(demux('ghost'), undefined)
    // a6 → 联邦 gateway（wiring memo），经 /hub family 真 POST 打到 fixture 的 /hub/api?agent=codex
    const resA6 = fakeRes()
    await real.routes.get('prefix:/hub').handler(envelopeReq('/hub/api/session.list?agent=q7m2xp'), resA6)
    assert.equal(resA6.status, 200)
    assert.deepEqual(JSON.parse(resA6.body).result, { ok: true, value: 'wire:codex' }, 'a6 demux 经 wire 命中远端 RUNTIME key')

    const resLabel = fakeRes()
    await real.routes.get('prefix:/hub').handler(envelopeReq('/hub/api/session.list?agent=codex'), resLabel)
    assert.equal(resLabel.status, 200)
    assert.deepEqual(JSON.parse(resLabel.body).result, { ok: true, value: 'local' })
    assert.deepEqual(local.calls.map((c) => c.endpoint), ['session.list'])
  } finally {
    disposeRoute()
    stop()
    sweep()
    unregisterForeignTarget('codex')
    rmSync(h, { recursive: true, force: true })
    await hub.close()
  }
})

test('排序钉：native → local → 远端（机器 label 再 agent label）；机器 label 来自 machines.json', () => {
  sweep()
  const h = home()
  const dropMount = registerHostMount({ key: 'omp', labelPath: '/omp' })
  try {
    registerAgent({ key: 'omp', label: 'OMP', ready: true })
    upsertRemote(h, { id: 'zzzz', name: 'beta-machine', label: 'Beta Box', origin: 'http://b:1', enabled: true, addedAt: 1 })
    upsertRemote(h, { id: 'yyyy', name: 'alpha-machine', label: 'Alpha Box', origin: 'http://a:1', enabled: true, addedAt: 1 })
    federateAgents(
      { id: 'zzzz', name: 'beta-machine' },
      [
        { id: 'bet100', key: 'codex', label: 'Zed', ready: true, failed: false },
        { id: 'bet200', key: 'omp', label: 'Anna', ready: true, failed: false },
      ],
      () => fakeGateway('beta'),
    )
    federateAgents(
      { id: 'yyyy', name: 'alpha-machine' },
      [{ id: 'alp100', key: 'pi', label: 'Pi', ready: false, failed: false }],
      () => fakeGateway('alpha'),
    )
    const links = agentLinks(h)
    // 远端排序 = 机器 label（Alpha Box < Beta Box）→ agent label（Anna < Zed）
    assert.deepEqual(links.map((l) => l.key), ['native', 'omp', 'alp100', 'bet200', 'bet100'])
    assert.deepEqual(links.map((l) => l.machine), ['local', 'local', 'yyyy', 'zzzz', 'zzzz'])
  } finally {
    dropMount()
    sweep()
    rmSync(h, { recursive: true, force: true })
  }
})

test('peer 的 native 行：native face gateway 指向 peer /api（无 ?agent=）；foreign 行不变', async () => {
  sweep()
  resetMachineStatus()
  const hub = await startRemoteHub({
    machineId: 'k3f9', token: 'nat-tok',
    agents: [
      { id: 'n4t1ve', key: 'native', label: 'Native', ready: true, failed: false },
      { id: 'q7m2xp', key: 'codex', label: 'Codex', ready: true, failed: false },
    ],
  })
  const h = home()
  const stop = startMeshFederation({ home: h })
  try {
    await pairMachine(h, { name: 'dev3', tokenUrl: `${hub.origin}/?token=nat-tok` })
    // Both rows federated: the native row alongside the foreign one
    assert.deepEqual(listAgents().map((e) => e.key), ['n4t1ve', 'q7m2xp'])
    const nativeGw = federatedGatewayOf('n4t1ve')
    const foreignGw = federatedGatewayOf('q7m2xp')
    assert.notEqual(nativeGw, undefined)
    assert.notEqual(foreignGw, undefined)
    assert.notEqual(nativeGw, foreignGw)

    // Native face: the wire POST lands on /api with NO ?agent= (ctx0's own surface)
    const nativeResult = await nativeGw.dispatchRpc('session.list', {}, new AbortController().signal)
    assert.deepEqual(nativeResult, { ok: true, value: 'wire:native' })
    assert.equal(hub.state.posts.length, 1)
    assert.equal(hub.state.posts[0].url, '/api', 'no demux key on the native lane')
    assert.equal(hub.state.posts[0].agent, null)

    // Foreign face unchanged: the same call rides /hub/api?agent=codex
    const foreignResult = await foreignGw.dispatchRpc('session.list', {}, new AbortController().signal)
    assert.deepEqual(foreignResult, { ok: true, value: 'wire:codex' })
    assert.equal(hub.state.posts.length, 1, 'the foreign lane never touches /api')
  } finally {
    stop()
    sweep()
    rmSync(h, { recursive: true, force: true })
    await hub.close()
  }
})
