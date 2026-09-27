// Machine-mesh management API (mesh P1 Task 3): the add-machine face behind
// connection.fetch. Hard red line (D1, Task 2 review deferred finding): the
// wire NEVER carries `token` or `cookie` — GET/POST responses project rows to
// the public shape only. Reprobe folds into POST body-dispatch
// ({op:'reprobe', id}); DELETE removes by ?id=.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleMeshMachines, registerMeshRpc, MESH_API_BASE } from '../dist/mesh-rpc.js'
import { machineStatus, resetMachineStatus } from '../dist/mesh-link.js'
import { listRemotes, upsertRemote } from '../dist/machines.js'

const home = () => mkdtempSync(join(tmpdir(), 'superd-mesh-rpc-'))

function req(method, body, url = `http://x${MESH_API_BASE}`) {
  return new Request(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Minimal "remote hub" fixture (mesh-link.test.mjs 同款): GET /?token=<t>
 *  mints a dsh-auth cookie (303 + Set-Cookie); GET /api/agent-runtime answers
 *  the roster JSON only for cookie values this server minted. */
function startRemoteHub(opts = {}) {
  const state = {
    machineId: opts.machineId ?? 'k3f9',
    token: opts.token ?? 'ok',
    agents: opts.agents ?? [{ id: 'q7m2xp', key: 'codex', label: 'Codex', ready: true, failed: false }],
    validCookies: new Set(),
    gateValid: new Set(),
    mintCount: 0,
  }
  let seq = 0
  const server = createServer((req_, res) => {
    const url = new URL(req_.url, 'http://127.0.0.1')
    if (opts.gate === true && url.pathname === '/gate-gtok') {
      state.gateValid.add('g1')
      res.statusCode = 302
      res.setHeader('Location', '/')
      res.setHeader('Set-Cookie', 'dshgate=g1; Path=/; HttpOnly')
      res.end()
      return
    }
    if (opts.gate === true) {
      const gateOk = (req_.headers.cookie ?? '').split(';').map((s) => s.trim()).some((p) => p.startsWith('dshgate=') && state.gateValid.has(p.slice('dshgate='.length)))
      if (!gateOk) { res.statusCode = 403; res.end('gate'); return }
    }
    if (url.pathname === '/') {
      state.mintCount += 1
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
      const values = (req_.headers.cookie ?? '').split(';').map((s) => s.trim()).filter(Boolean).map((p) => p.slice(p.indexOf('=') + 1))
      if (!values.some((v) => state.validCookies.has(v))) { res.statusCode = 401; res.end('auth required'); return }
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ available: true, agents: state.agents, hub: { machineId: state.machineId, version: '0.1.6' } }))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        state,
        origin: `http://127.0.0.1:${port}`,
        gateUrl: `http://127.0.0.1:${port}/gate-gtok`,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(done) }),
      })
    })
  })
}

/** Grab a loopback port and release it — an origin that refuses connections. */
async function closedOrigin() {
  const srv = createServer(() => { })
  const port = await new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)))
  await new Promise((done) => srv.close(done))
  return `http://127.0.0.1:${port}`
}

/** rpc.test.mjs 同款 fake ctx: captures connection.fetch.register routes. */
function fakeCtx() {
  const routes = []
  return {
    routes,
    inject(_deps, cb) { cb(this) },
    effect(fn) { fn(); return () => { } },
    connection: {
      fetch: {
        register(route) { routes.push(route); return async () => { } },
      },
    },
  }
}

const row = (over = {}) => ({
  id: 'k3f9', name: 'dev3', label: 'DEV3', origin: 'http://127.0.0.1:9',
  token: 'SECRET-TOKEN', cookie: 'dsh-auth-x=SECRET-COOKIE', enabled: true, addedAt: 123, ...over,
})

test('GET：self + 投影行；token/cookie 永不上线；status 缺省 pending', async () => {
  resetMachineStatus()
  const h = home()
  try {
    upsertRemote(h, row())
    const res = await handleMeshMachines(req('GET'), { home: h })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.match(body.self.id, /^[a-z0-9]{4}$/) // ensureSelf 惰性铸造
    assert.equal(typeof body.self.label, 'string')
    assert.equal(body.machines.length, 1)
    const m = body.machines[0]
    // 投影 = 白名单字段，一寸不多（无 token、无 cookie、无 lastProbeAt/error）
    assert.deepEqual(Object.keys(m).sort(), ['addedAt', 'enabled', 'id', 'label', 'name', 'origin', 'status'])
    assert.equal(m.status, 'pending') // 从未探测 → 缺省
    const raw = JSON.stringify(body)
    assert.ok(!raw.includes('SECRET-TOKEN'), 'token leaked into GET')
    assert.ok(!raw.includes('SECRET-COOKIE'), 'cookie leaked into GET')
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('POST pair：fixture 远端真往返 → 201；行持久化（含机密）；响应行无机密；status=reachable', async () => {
  resetMachineStatus()
  const hub = await startRemoteHub({ machineId: 'k3f9', token: 'boot-tok' })
  const h = home()
  let fetchCalls = 0
  const fetchImpl = (...args) => { fetchCalls += 1; return globalThis.fetch(...args) }
  try {
    const res = await handleMeshMachines(
      req('POST', { name: 'dev3', label: 'DEV3', tokenUrl: `${hub.origin}/?token=boot-tok` }),
      { home: h, fetchImpl },
    )
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(body.machine.id, 'k3f9')
    assert.equal(body.machine.name, 'dev3')
    assert.equal(body.machine.origin, hub.origin)
    assert.deepEqual(Object.keys(body.machine).sort(), ['addedAt', 'enabled', 'id', 'label', 'lastProbeAt', 'name', 'origin', 'status'])
    assert.equal(body.machine.status, 'reachable')
    assert.ok(!JSON.stringify(body).includes('boot-tok'), 'token leaked into POST response')
    assert.ok(!JSON.stringify(body).includes('dsh-auth'), 'cookie leaked into POST response')
    assert.equal(fetchCalls, 2) // mint + probe 都走注入的 fetchImpl

    const rows = listRemotes(h) // 落盘行仍带机密（0600 文件），只是永不上线
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'k3f9')
    assert.equal(rows[0].token, 'boot-tok')
    assert.equal(rows[0].cookie, 'dsh-auth-x=v1')

    assert.equal(machineStatus().get('k3f9').status, 'reachable')
    const get = await (await handleMeshMachines(req('GET'), { home: h })).json()
    assert.equal(get.machines[0].status, 'reachable')
    assert.equal(typeof get.machines[0].lastProbeAt, 'number')
  } finally {
    rmSync(h, { recursive: true, force: true })
    await hub.close()
  }
})

test('POST pair 失败分支：坏 URL / 不可达对端 / 坏形状 / 非 JSON → 400 {error}，不落行', async () => {
  const h = home()
  const dead = await closedOrigin()
  try {
    const bad = await handleMeshMachines(req('POST', { name: 'x', tokenUrl: 'not a url' }), { home: h })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /invalid token url/)

    const unreachable = await handleMeshMachines(req('POST', { name: 'x', tokenUrl: `${dead}/?token=ok` }), { home: h })
    assert.equal(unreachable.status, 400)
    assert.match((await unreachable.json()).error, /mesh-link: token mint/)

    const shape = await handleMeshMachines(req('POST', { tokenUrl: 'http://h:1/?token=t' }), { home: h }) // 缺 name
    assert.equal(shape.status, 400)
    assert.match((await shape.json()).error, /mesh-api/)

    const raw = new Request(`http://x${MESH_API_BASE}`, { method: 'POST', body: '{not json' })
    const notJson = await handleMeshMachines(raw, { home: h })
    assert.equal(notJson.status, 400)
    assert.match((await notJson.json()).error, /not valid JSON/)

    assert.deepEqual(listRemotes(h), [])
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('POST {op:"reprobe"}：走 reprobeMachine → {probe}；unknown id → 400；未知 op → 400', async () => {
  resetMachineStatus()
  const hub = await startRemoteHub({ machineId: 'r7p2', token: 'keep-tok' })
  const h = home()
  const deps = { home: h, fetchImpl: globalThis.fetch }
  try {
    const pair = await handleMeshMachines(req('POST', { name: 'dev3', tokenUrl: `${hub.origin}/?token=keep-tok` }), deps)
    assert.equal(pair.status, 201)

    hub.state.validCookies.clear() // 服务端轮换：存量 cookie 全失效 → reprobe 内部 401 → 重铸一次
    const res = await handleMeshMachines(req('POST', { op: 'reprobe', id: 'r7p2' }), deps)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.probe.ok, true)
    assert.equal(body.probe.machineId, 'r7p2')
    assert.equal(hub.state.mintCount, 2) // pair 1 次 + reprobe 重铸 1 次
    assert.equal(machineStatus().get('r7p2').status, 'reachable')

    const miss = await handleMeshMachines(req('POST', { op: 'reprobe', id: 'zzzz' }), deps)
    assert.equal(miss.status, 400)
    assert.match((await miss.json()).error, /unknown machine id/)

    const badOp = await handleMeshMachines(req('POST', { op: 'explode', id: 'r7p2' }), deps)
    assert.equal(badOp.status, 400)
    assert.match((await badOp.json()).error, /unknown op/)

    const noId = await handleMeshMachines(req('POST', { op: 'reprobe' }), deps)
    assert.equal(noId.status, 400)
    assert.match((await noId.json()).error, /mesh-api/)
  } finally {
    rmSync(h, { recursive: true, force: true })
    await hub.close()
  }
})

test('reprobe 不可达结局仍是 200 {probe}（探测有答案 ≠ 操作失败）', async () => {
  resetMachineStatus()
  const dead = await closedOrigin()
  const h = home()
  try {
    upsertRemote(h, row({ id: 'd4e5', origin: dead, token: 'ok', cookie: undefined }))
    const res = await handleMeshMachines(req('POST', { op: 'reprobe', id: 'd4e5' }), { home: h })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.probe.ok, false)
    assert.equal(body.probe.status, 'unreachable')
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('DELETE ?id=：删行 {removed:true}；再删 {removed:false}；缺 ?id → 400', async () => {
  const h = home()
  try {
    upsertRemote(h, row({ id: 'm4xx' }))
    const res = await handleMeshMachines(new Request(`http://x${MESH_API_BASE}?id=m4xx`, { method: 'DELETE' }), { home: h })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { removed: true })
    assert.deepEqual(listRemotes(h), [])

    const again = await handleMeshMachines(new Request(`http://x${MESH_API_BASE}?id=m4xx`, { method: 'DELETE' }), { home: h })
    assert.equal(again.status, 200)
    assert.deepEqual(await again.json(), { removed: false })

    const miss = await handleMeshMachines(new Request(`http://x${MESH_API_BASE}`, { method: 'DELETE' }), { home: h })
    assert.equal(miss.status, 400)
    assert.match((await miss.json()).error, /id/)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('registerMeshRpc：fake ctx 上注册唯一精确路由（GET/POST/DELETE、buffered），fetch 闭包带 deps', async () => {
  const h = home()
  try {
    const ctx = fakeCtx()
    registerMeshRpc(ctx, { home: h })
    assert.equal(ctx.routes.length, 1)
    const route = ctx.routes[0]
    assert.equal(route.path, MESH_API_BASE)
    assert.equal(route.path, '/api/superd/machines')
    assert.deepEqual(route.methods, ['GET', 'POST', 'DELETE'])
    assert.equal(route.requestBody, 'buffered')
    const res = await route.fetch(new Request(`http://x${MESH_API_BASE}`))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).machines.length, 0)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('未注册方法（PUT/HEAD）→ 直连 handler 应答 405', async () => {
  const h = home()
  try {
    const put = await handleMeshMachines(req('PUT', { x: 1 }), { home: h })
    assert.equal(put.status, 405)
    assert.match((await put.json()).error, /method/)
    const head = await handleMeshMachines(new Request(`http://x${MESH_API_BASE}`, { method: 'HEAD' }), { home: h })
    assert.equal(head.status, 405)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('POST pair with gateUrl 透传：gated fixture 真往返 → 201；行持久化 gateUrl+整 jar；wire 投影仍无机密', async () => {
  resetMachineStatus()
  const hub = await startRemoteHub({ gate: true, machineId: 'g5e6', token: 'boot' })
  const h = home()
  try {
    const res = await handleMeshMachines(req('POST', { name: 'dev3', tokenUrl: `${hub.origin}/?token=boot`, gateUrl: hub.gateUrl }), { home: h })
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(body.machine.id, 'g5e6')
    assert.equal(body.machine.status, 'reachable')
    assert.equal('gateUrl' in body.machine, false) // 投影白名单：gateUrl 不上线
    assert.equal('token' in body.machine, false)
    assert.equal('cookie' in body.machine, false)
    const rows = listRemotes(h)
    assert.equal(rows[0].gateUrl, hub.gateUrl)
    assert.equal(rows[0].cookie, 'dshgate=g1; dsh-auth-x=v1')
    const listed = await handleMeshMachines(req('GET'), { home: h })
    const lb = await listed.json()
    assert.equal(lb.machines[0].id, 'g5e6')
    assert.equal('gateUrl' in lb.machines[0], false)
    assert.equal('cookie' in lb.machines[0], false)
  } finally { rmSync(h, { recursive: true, force: true }); await hub.close() }
})

test('POST pair：gateUrl 空串视为缺省（无 gate fixture 照常 201）', async () => {
  const hub = await startRemoteHub({ machineId: 'k3f9', token: 'boot' })
  const h = home()
  try {
    const res = await handleMeshMachines(req('POST', { name: 'dev3', tokenUrl: `${hub.origin}/?token=boot`, gateUrl: '' }), { home: h })
    assert.equal(res.status, 201)
    assert.equal(listRemotes(h)[0].gateUrl, undefined)
  } finally { rmSync(h, { recursive: true, force: true }); await hub.close() }
})
