// Machine-mesh management API (mesh P1 Task 3): the add-machine face behind
// connection.fetch. Hard red line (D1, Task 2 review deferred finding): the
// wire NEVER carries `token` or `cookie` — GET/POST responses project rows to
// the public shape only. Reprobe folds into POST body-dispatch
// ({op:'reprobe', id}); DELETE removes by ?id=.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleMeshMachines, handleA2aIngestPost, handleA2aOutboxGet, registerMeshRpc, MESH_API_BASE } from '../dist/mesh-rpc.js'
import { A2A_OUTBOX_PATH } from '../dist/a2a-wire.js'
import { machineStatus, resetMachineStatus, onMeshFederationEvent } from '../dist/mesh-link.js'
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
    version: opts.version ?? '0.1.6',
    token: opts.token ?? 'ok',
    agents: opts.agents ?? [{ id: 'q7m2xp', key: 'codex', runtimeId: 'agent-codex', label: 'Codex', ready: true, failed: false }],
    validCookies: new Set(),
    mintCount: 0,
  }
  let seq = 0
  const server = createServer((req_, res) => {
    const url = new URL(req_.url, 'http://127.0.0.1')
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
      res.end(JSON.stringify({ available: true, agents: state.agents, hub: { machineId: state.machineId, version: state.version } }))
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
  id: 'k3f9', name: 'dev3', origin: 'http://127.0.0.1:9',
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
    assert.deepEqual(Object.keys(m).sort(), ['addedAt', 'enabled', 'id', 'name', 'origin', 'status'])
    assert.equal(m.status, 'pending') // 从未探测 → 缺省
    const raw = JSON.stringify(body)
    assert.ok(!raw.includes('SECRET-TOKEN'), 'token leaked into GET')
    assert.ok(!raw.includes('SECRET-COOKIE'), 'cookie leaked into GET')
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('GET self.tokenPreview：有 mint face → 10 字符预览 + 省略号；无 face → 键不存在；永不携带完整 token', async () => {
  const h = home()
  try {
    const full = 'd_3txYKhc_GUfMlSjg0qwgUQDgVVAwC7I7V9XZeWt30'
    const res = await handleMeshMachines(req('GET'), { home: h, tokenUrlOf: (origin) => `${origin}/?token=${full}` })
    const body = await res.json()
    assert.equal(body.self.tokenPreview, `${full.slice(0, 10)}…`, 'first 10 chars + ellipsis — enough to SEE it is a token')
    assert.ok(!JSON.stringify(body).includes(full), 'the FULL token never rides the GET answer')
    const bare = await handleMeshMachines(req('GET'), { home: h })
    assert.equal('tokenPreview' in (await bare.json()).self, false, 'no mint face → no preview key')
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
      req('POST', { name: 'dev3', tokenUrl: `${hub.origin}/?token=boot-tok` }),
      { home: h, fetchImpl },
    )
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(body.machine.id, 'k3f9')
    assert.equal(body.machine.name, 'dev3')
    assert.equal(body.machine.origin, hub.origin)
    assert.deepEqual(Object.keys(body.machine).sort(), ['addedAt', 'enabled', 'id', 'lastProbeAt', 'name', 'origin', 'status'])
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

test('POST pair（user 形态）携带反向 offer；mutual:true 的 offer 不再反向（递归止于构造）', async () => {
  resetMachineStatus()
  const hub = await startRemoteHub({ machineId: 'k3f9', token: 'boot-tok' })
  const h = home()
  const hits = []
  const fetchImpl = (...args) => {
    const url = String(args[0])
    if (url.includes('/api/superd/machines')) hits.push(url)
    return globalThis.fetch(...args)
  }
  const deps = { home: h, fetchImpl, tokenUrlOf: (origin) => `${origin}/?token=req-tok` }
  const reqWithHost = (body) => new Request(`http://x${MESH_API_BASE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '192.0.2.130:4993' },
    body: JSON.stringify(body),
  })
  try {
    // user 形态：不带 mutual → 反向 offer 打到 peer（fixture 无 machines 路由 → 404 → ok:false 仍 201）
    const res = await handleMeshMachines(
      reqWithHost({ name: 'dev3', tokenUrl: `${hub.origin}/?token=boot-tok` }),
      deps,
    )
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(body.mutual.ok, false, 'the fixture answers no machines route — the offer outcome is honest')
    assert.match(body.mutual.error, /404/)
    assert.equal(hits.length, 1, 'exactly one reverse offer')
    assert.equal(hits[0], `${hub.origin}/api/superd/machines`)

    // offer 形态：mutual:true → 配对成功但不再反向（删掉首对，重配新行验证）
    await handleMeshMachines(new Request(`http://x${MESH_API_BASE}?id=k3f9`, { method: 'DELETE' }), deps)
    const res2 = await handleMeshMachines(
      reqWithHost({ name: 'again', tokenUrl: `${hub.origin}/?token=boot-tok`, mutual: true }),
      deps,
    )
    assert.equal(res2.status, 201)
    const body2 = await res2.json()
    assert.equal('mutual' in body2, false, 'an offer with mutual:true answers no mutual outcome — it fires no reverse leg')
    assert.equal(hits.length, 1, 'the mutual offer fired NO second reverse leg')
  } finally { rmSync(h, { recursive: true, force: true }); await hub.close() }
})

test('POST {op:"tokenUrl"}：face 的 authenticatedUrl 令牌化 origin → {tokenUrl}；GET 永不带 token', async () => {
  const h = home()
  try {
    const minted = []
    const res = await handleMeshMachines(
      req('POST', { op: 'tokenUrl', origin: 'https://test.pc.internal.test' }),
      { home: h, tokenUrlOf: (origin) => { minted.push(origin); return `${origin}/?token=LIVE-TOKEN` } },
    )
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { tokenUrl: 'https://test.pc.internal.test/?token=LIVE-TOKEN' })
    assert.deepEqual(minted, ['https://test.pc.internal.test'])
    // GET 投影永不携带完整 token —— 它只调用 face 取 10 字符预览（key tokenPreview），
    // 且 face 抛错时静默降级为无预览，绝不拖垮 machines GET。
    const get = await handleMeshMachines(req('GET'), { home: h, tokenUrlOf: (origin) => `${origin}/?token=<redacted>` })
    const getBody = await get.json()
    assert.equal(getBody.self.tokenPreview, `${'LIVE-TOKEN-0123456789'.slice(0, 10)}…`)
    assert.ok(!JSON.stringify(getBody).includes('LIVE-TOKEN-0123456789'), 'the full token never rides the GET')
    const grumpy = await handleMeshMachines(req('GET'), { home: h, tokenUrlOf: () => { throw new Error('mint face is having a day') } })
    const grumpyBody = await grumpy.json()
    assert.equal(grumpy.status, 200, 'a throwing preview never fails the list')
    assert.equal('tokenPreview' in grumpyBody.self, false, 'degraded: no preview key')
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('POST {op:"tokenUrl"}：坏 origin / 无 face → 400，错误不回显 token', async () => {
  const h = home()
  try {
    const cases = [
      [{ op: 'tokenUrl' }, /non-empty origin/],
      [{ op: 'tokenUrl', origin: 'not a url' }, /not a parseable absolute URL/],
      [{ op: 'tokenUrl', origin: 'ftp://x' }, /must be http\(s\)/],
      [{ op: 'tokenUrl', origin: 'https://x.app/hub' }, /bare origin/],
      [{ op: 'tokenUrl', origin: 'https://x.app/?a=1' }, /bare origin/],
      [{ op: 'tokenUrl', origin: 'https://user:pw@x.app' }, /must not carry credentials/],
    ]
    for (const [body, pattern] of cases) {
      const res = await handleMeshMachines(req('POST', body), { home: h, tokenUrlOf: () => 'https://x/?token=T' })
      assert.equal(res.status, 400, JSON.stringify(body))
      assert.match((await res.json()).error, pattern)
    }
    // 老宿主：connection face 无 authenticatedUrl → 明确 400
    const noFace = await handleMeshMachines(req('POST', { op: 'tokenUrl', origin: 'https://x.app' }), { home: h })
    assert.equal(noFace.status, 400)
    assert.match((await noFace.json()).error, /authenticatedUrl/)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('registerMeshRpc：connection face 的 authenticatedUrl 接进 tokenUrl op（绑定 receiver——真实现读 this 上的进程 token）', async () => {
  const h = home()
  try {
    const ctx = fakeCtx()
    ctx.connection.launchToken = 'MINTED'
    ctx.connection.authenticatedUrl = function (base) { return `${base}/?token=${this.launchToken}` }
    registerMeshRpc(ctx, { home: h })
    const route = ctx.routes[0]
    const res = await route.fetch(new Request(`http://x${MESH_API_BASE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'tokenUrl', origin: 'http://192.0.2.130:4999' }),
    }))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { tokenUrl: 'http://192.0.2.130:4999/?token=MINTED' })
  } finally { rmSync(h, { recursive: true, force: true }) }
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
  const events = []
  const off = onMeshFederationEvent((e) => { events.push(e) })
  try {
    upsertRemote(h, row({ id: 'm4xx' }))
    const res = await handleMeshMachines(new Request(`http://x${MESH_API_BASE}?id=m4xx`, { method: 'DELETE' }), { home: h })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { removed: true })
    assert.deepEqual(listRemotes(h), [])

    const again = await handleMeshMachines(new Request(`http://x${MESH_API_BASE}?id=m4xx`, { method: 'DELETE' }), { home: h })
    assert.equal(again.status, 200)
    assert.deepEqual(await again.json(), { removed: false })
    // mesh P2 Task 3：删除成功 → 联邦总线收到 defederated；再删（removed:false）不重复发
    assert.deepEqual(events, [{ type: 'defederated', machineId: 'm4xx' }])

    const miss = await handleMeshMachines(new Request(`http://x${MESH_API_BASE}`, { method: 'DELETE' }), { home: h })
    assert.equal(miss.status, 400)
    assert.match((await miss.json()).error, /id/)
  } finally {
    off()
    rmSync(h, { recursive: true, force: true })
  }
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
    assert.deepEqual(route.methods, ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD'], 'unknown methods route into the handler\'s 405 (2026-09-29 finding: PUT answered a fall-through 404)')
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

// ---- I2: versionWarning projection (additive) -------------------------------

test('I2 投影加性：跨 minor 对端 → GET 行携带 versionWarning；同 minor/未探测 → 键不存在', async () => {
  resetMachineStatus()
  // ours is the hub package version: derive diff-minor and same-minor peer
  // spellings so the assertion survives version bumps.
  const ours = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  const [maj, min] = ours.split('.').map(Number)
  const peerDiff = `${maj}.${min + 1}.0`
  const hub = await startRemoteHub({ machineId: 'w2c4', token: 'i2-tok', version: peerDiff })
  const h = home()
  try {
    await handleMeshMachines(req('POST', { name: 'future', tokenUrl: `${hub.origin}/?token=i2-tok` }), { home: h })
    const res = await handleMeshMachines(req('GET'), { home: h })
    const body = await res.json()
    const warned = body.machines.find((m) => m.id === 'w2c4')
    assert.equal(typeof warned.versionWarning, 'string', 'a diff-minor peer carries the warning on the wire')
    assert.ok(warned.versionWarning.includes(peerDiff))
    assert.ok(!JSON.stringify(body).includes('SECRET-TOKEN'), 'token still never rides the wire')

    // Same-minor peer: fresh reprobe recomputes → warning absent, key and all
    hub.state.version = `${maj}.${min}.9`
    await handleMeshMachines(req('POST', { op: 'reprobe', id: 'w2c4' }), { home: h })
    const after = await (await handleMeshMachines(req('GET'), { home: h })).json()
    const clean = after.machines.find((m) => m.id === 'w2c4')
    assert.equal('versionWarning' in clean, false, 'a same-minor peer carries NO versionWarning key (projection stays additive)')
  } finally {
    rmSync(h, { recursive: true, force: true })
    await hub.close()
    resetMachineStatus()
  }
})

test('unknown methods on a KNOWN path answer the honest 405, not a fall-through 404 (2026-09-29 field finding)', async () => {
  const h = mkdtempSync(join(tmpdir(), 'superd-mesh-'))
  try {
    const put = await handleMeshMachines(req('PUT', {}), { home: h })
    assert.equal(put.status, 405)
    assert.match(String((await put.json()).error), /PUT is not supported/)
    const post = await handleA2aIngestPost(req('POST', { v: 1, envelope: null }), undefined)
    assert.equal(post.status, 400, 'POST stays the a2a endpoint\'s method (malformed frame → 400, never 405)')
    const get = await handleA2aIngestPost(req('GET'), undefined)
    assert.equal(get.status, 405)
    const del = await handleA2aOutboxGet(new Request(`http://x${A2A_OUTBOX_PATH}?machine=zz`, { method: 'DELETE' }), undefined)
    assert.equal(del.status, 405)
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})
