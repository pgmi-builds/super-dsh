import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTokenUrl, mintCookie, probeMachine, pairMachine, reprobeMachine, machineStatus, resetMachineStatus } from '../dist/mesh-link.js'
import { ensureSelf, listRemotes, upsertRemote } from '../dist/machines.js'

const home = () => mkdtempSync(join(tmpdir(), 'superd-mesh-link-'))

/** Minimal "remote hub" fixture: GET /?token=<t> mints a dsh-auth cookie (303 + Set-Cookie);
 *  GET /api/agent-runtime answers the roster JSON only for cookie values the server minted. */
function startRemoteHub(opts = {}) {
  const state = {
    machineId: opts.machineId ?? 'k3f9',
    version: opts.version ?? '0.1.6',
    token: opts.token ?? 'ok',
    cookieName: opts.cookieName ?? 'dsh-auth-x',
    mintStatus: opts.mintStatus ?? 303,
    includeHub: opts.includeHub !== false,
    agents: opts.agents ?? [{ id: 'q7m2xp', key: 'codex', label: 'Codex', ready: true, failed: false }],
    validCookies: new Set(),
    mintCount: 0,
    probeCount: 0,
    lastCookie: null,
  }
  let seq = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      state.mintCount += 1
      if (url.searchParams.get('token') !== state.token) { res.statusCode = 403; res.end('bad token'); return }
      if (state.mintStatus !== 303 && !(state.mintStatus >= 200 && state.mintStatus < 300)) {
        res.statusCode = state.mintStatus
        res.end('mint broken')
        return
      }
      const value = `v${++seq}`
      state.validCookies.add(value)
      res.statusCode = 303
      res.setHeader('Location', './')
      res.setHeader('Set-Cookie', `${state.cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax`)
      res.end()
      return
    }
    if (url.pathname === '/api/agent-runtime') {
      state.probeCount += 1
      const cookie = req.headers.cookie ?? ''
      state.lastCookie = cookie
      const values = cookie.split(';').map((s) => s.trim()).filter(Boolean).map((p) => p.slice(p.indexOf('=') + 1))
      if (!values.some((v) => state.validCookies.has(v))) { res.statusCode = 401; res.end('auth required'); return }
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      const body = { available: true, agents: state.agents }
      if (state.includeHub) body.hub = { machineId: state.machineId, version: state.version }
      res.end(JSON.stringify(body))
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

/** Grab a loopback port and release it — an origin that refuses connections. */
async function closedOrigin() {
  const srv = createServer(() => { })
  const port = await new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)))
  await new Promise((done) => srv.close(done))
  return `http://127.0.0.1:${port}`
}

test('parseTokenUrl 校验与提取；错误信息不回显 token', () => {
  assert.deepEqual(parseTokenUrl('http://h:1/?token=abc'), { origin: 'http://h:1', token: 'abc' })
  assert.deepEqual(parseTokenUrl('https://dev3.example:4999/?token=t%20k'), { origin: 'https://dev3.example:4999', token: 't k' })
  assert.throws(() => parseTokenUrl('http://h:1/'), /invalid token url/)
  assert.throws(() => parseTokenUrl('http://h:1/?notoken=1'), /invalid token url/)
  assert.throws(() => parseTokenUrl('http://h:1/?token='), /invalid token url/)
  assert.throws(() => parseTokenUrl('ftp://h:1/?token=abc'), /invalid token url/)
  assert.throws(() => parseTokenUrl('not a url'), /invalid token url/)
  // 红线：贴错的 token URL 可能带着活 token——错误文案不得回显 query
  const assertRedacted = (fn, marker) => {
    try {
      fn()
    } catch (err) {
      assert.match(err.message, /invalid token url/)
      assert.ok(!err.message.includes(marker), `error leaked token substring "${marker}": ${err.message}`)
      return
    }
    assert.fail('expected throw')
  }
  assertRedacted(() => parseTokenUrl('http://h:notaport/?token=S3CRET'), 'S3CRET') // 坏端口：URL 不可解析
  assertRedacted(() => parseTokenUrl('ftp://h:1/?token=S3CRET'), 'S3CRET') // 错 scheme
  assertRedacted(() => parseTokenUrl('http://h:1/?tok=S3CRET'), 'S3CRET') // 无 token 参数但 query 带敏感值
})

test('mintCookie 拿到 dsh-auth cookie（只取 name=value 对）', async () => {
  const hub = await startRemoteHub()
  try {
    const cookie = await mintCookie(hub.origin, 'ok')
    assert.match(cookie, /^dsh-auth-/)
    assert.equal(cookie, 'dsh-auth-x=v1') // 无属性尾巴
  } finally { await hub.close() }
})

test('mintCookie 失败分支：非 303/2xx throw 附状态码；无 dsh-auth cookie throw', async () => {
  const broken = await startRemoteHub({ mintStatus: 500 })
  try {
    await assert.rejects(() => mintCookie(broken.origin, 'ok'), /mesh-link: token mint failed.*500/)
  } finally { await broken.close() }
  const foreign = await startRemoteHub({ cookieName: 'other-session' })
  try {
    await assert.rejects(() => mintCookie(foreign.origin, 'ok'), /no dsh-auth/)
  } finally { await foreign.close() }
})

test('probeMachine：200 → ok + agents；401 → auth-expired；拒连 → unreachable', async () => {
  const hub = await startRemoteHub()
  try {
    const cookie = await mintCookie(hub.origin, 'ok')
    const ok = await probeMachine(hub.origin, cookie)
    assert.equal(ok.ok, true)
    assert.equal(ok.machineId, 'k3f9')
    assert.equal(ok.version, '0.1.6')
    assert.deepEqual(ok.agents, [{ id: 'q7m2xp', key: 'codex', label: 'Codex', ready: true, failed: false }])

    const expired = await probeMachine(hub.origin, 'dsh-auth-x=unknown')
    assert.equal(expired.ok, false)
    assert.equal(expired.status, 'auth-expired')
    assert.ok(typeof expired.error === 'string' && expired.error.length > 0)
  } finally { await hub.close() }
  const dead = await closedOrigin()
  const unreachable = await probeMachine(dead, 'dsh-auth-x=v1')
  assert.equal(unreachable.ok, false)
  assert.equal(unreachable.status, 'unreachable')
  assert.ok(typeof unreachable.error === 'string' && unreachable.error.length > 0)
})

test('probeMachine：缺 hub block → 非 superdsh 0.1.6+ 对端', async () => {
  const hub = await startRemoteHub({ includeHub: false })
  try {
    const cookie = await mintCookie(hub.origin, 'ok')
    const r = await probeMachine(hub.origin, cookie)
    assert.equal(r.ok, false)
    assert.equal(r.status, 'unreachable')
    assert.equal(r.error, 'peer roster has no hub block')
  } finally { await hub.close() }
})

test('pairMachine 全链：mint→probe→持久化→采纳 k3f9；重复 id 碰撞 throw', async () => {
  resetMachineStatus()
  assert.equal(machineStatus().size, 0)
  const hub = await startRemoteHub({ machineId: 'k3f9', token: 'boot-tok' })
  const h = home()
  let fetchCalls = 0
  const fetchImpl = (...args) => { fetchCalls += 1; return globalThis.fetch(...args) }
  try {
    const out = await pairMachine(h, { name: 'dev3', label: 'DEV3', tokenUrl: `${hub.origin}/?token=boot-tok` }, { fetchImpl })
    assert.equal(out.machineId, 'k3f9')
    assert.equal(out.probe.ok, true)
    assert.equal(out.row.id, 'k3f9')
    assert.equal(out.row.name, 'dev3')
    assert.equal(out.row.label, 'DEV3')
    assert.equal(out.row.origin, hub.origin)
    assert.equal(out.row.token, 'boot-tok')
    assert.equal(out.row.cookie, 'dsh-auth-x=v1') // mint 出的 cookie 随行持久化
    assert.equal(out.row.enabled, true)
    assert.equal(fetchCalls, 2) // mint + probe 都走注入的 fetchImpl

    const rows = listRemotes(h)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'k3f9')
    assert.equal(rows[0].token, 'boot-tok')
    assert.equal(rows[0].cookie, 'dsh-auth-x=v1') // 落盘后读回仍有 cookie

    const st = machineStatus().get('k3f9')
    assert.equal(st.status, 'reachable')
    assert.equal(typeof st.lastProbeAt, 'number')

    // 快照副本：改副本不感染内部表
    const snap = machineStatus()
    snap.set('zzzz', { status: 'x', lastProbeAt: 0 })
    assert.equal(machineStatus().has('zzzz'), false)

    // 重复 id：再 pair 同一远端 → duplicate-machine-id，且不新增行
    await assert.rejects(() => pairMachine(h, { name: 'dev3b', tokenUrl: `${hub.origin}/?token=boot-tok` }), /duplicate-machine-id/)
    assert.equal(listRemotes(h).length, 1)
  } finally {
    rmSync(h, { recursive: true, force: true })
    await hub.close()
  }
})

test('pairMachine：machineId 撞 self id → duplicate-machine-id；探不到 → throw 不落行', async () => {
  const h = home()
  const selfId = ensureSelf(h, 'pc').id
  const twin = await startRemoteHub({ machineId: selfId })
  try {
    await assert.rejects(() => pairMachine(h, { name: 'evil-twin', tokenUrl: `${twin.origin}/?token=ok` }), /duplicate-machine-id/)
    assert.deepEqual(listRemotes(h), [])
  } finally {
    await twin.close()
  }
  const dead = await closedOrigin()
  try {
    await assert.rejects(() => pairMachine(h, { name: 'x', tokenUrl: `${dead}/?token=ok` }), /mesh-link: token mint to .* failed/)
    assert.deepEqual(listRemotes(h), [])
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('reprobeMachine：401 → 存量 token 自动重铸一次；成功回写新 cookie', async () => {
  resetMachineStatus()
  const hub = await startRemoteHub({ machineId: 'r7p2', token: 'keep-tok' })
  const h = home()
  try {
    await pairMachine(h, { name: 'dev3', tokenUrl: `${hub.origin}/?token=keep-tok` })
    assert.equal(hub.state.mintCount, 1)

    // 服务端轮换：存量 cookie 全部失效 → reprobe 应 401 → 重铸 → 成功
    hub.state.validCookies.clear()
    const expired = await reprobeMachine(h, 'r7p2')
    assert.equal(expired.ok, true)
    assert.equal(hub.state.mintCount, 2)
    assert.equal(listRemotes(h)[0].cookie, 'dsh-auth-x=v2') // 新 cookie 回写进行
    assert.equal(machineStatus().get('r7p2').status, 'reachable')

    // 回写验证：jar 里必须是 v2（而非 v1）——再失效一轮，重铸出来的是 v3
    hub.state.validCookies.clear()
    const again = await reprobeMachine(h, 'r7p2')
    assert.equal(again.ok, true)
    assert.equal(hub.state.mintCount, 3)
    assert.equal(hub.state.lastCookie, 'dsh-auth-x=v3')
    assert.equal(listRemotes(h)[0].cookie, 'dsh-auth-x=v3') // 再轮回写仍是最新值
  } finally {
    rmSync(h, { recursive: true, force: true })
    await hub.close()
  }
})



test('reprobeMachine：持久化 cookie 跨进程可用（jar 冷启动 → 用行内 cookie，不重铸）', async () => {
  const hub = await startRemoteHub({ machineId: 'p1q2', token: 'keep-tok' })
  const h = home()
  try {
    hub.state.validCookies.add('v9') // 服务端已签发的存量 cookie（模拟另一进程/上次会话铸的）
    upsertRemote(h, { id: 'p1q2', name: 'dev3', label: 'DEV3', origin: hub.origin, token: 'keep-tok', cookie: 'dsh-auth-x=v9', enabled: true, addedAt: 1 })
    const r = await reprobeMachine(h, 'p1q2') // 本进程从未 pair 过 p1q2：jar 空，只能吃行内 cookie
    assert.equal(r.ok, true)
    assert.equal(hub.state.mintCount, 0) // 存量 cookie 仍有效：不重铸
    assert.equal(hub.state.lastCookie, 'dsh-auth-x=v9') // probe 看到的正是行内持久化 cookie
    assert.equal(machineStatus().get('p1q2').status, 'reachable')
  } finally {
    rmSync(h, { recursive: true, force: true })
    await hub.close()
  }
})
test('reprobeMachine：cookie 失效且行内无 token → auth-expired 停机（不重铸）', async () => {
  resetMachineStatus()
  const hub = await startRemoteHub({ machineId: 'a1b2', token: 'gone' })
  const h = home()
  try {
    await pairMachine(h, { name: 'dev3', tokenUrl: `${hub.origin}/?token=gone` })
    const row = listRemotes(h)[0]
    upsertRemote(h, { ...row, token: undefined }) // 抹掉行内 token
    hub.state.validCookies.clear()
    const r = await reprobeMachine(h, 'a1b2')
    assert.equal(r.ok, false)
    assert.equal(r.status, 'auth-expired')
    assert.equal(hub.state.mintCount, 1) // 无 token：不重铸
    const st = machineStatus().get('a1b2')
    assert.equal(st.status, 'auth-expired')
    assert.ok(st.error)
  } finally {
    rmSync(h, { recursive: true, force: true })
    await hub.close()
  }
})

test('reprobeMachine：重铸失败（token 已废）→ auth-expired 带重铸错误', async () => {
  const hub = await startRemoteHub({ machineId: 'b3c4', token: 'stale' })
  const h = home()
  try {
    await pairMachine(h, { name: 'dev3', tokenUrl: `${hub.origin}/?token=stale` })
    hub.state.validCookies.clear()
    hub.state.token = 'rotated' // 远端已轮换 token：重铸必 403
    const r = await reprobeMachine(h, 'b3c4')
    assert.equal(r.ok, false)
    assert.equal(r.status, 'auth-expired')
    assert.match(r.error, /re-mint/)
    assert.equal(machineStatus().get('b3c4').status, 'auth-expired')
  } finally {
    rmSync(h, { recursive: true, force: true })
    await hub.close()
  }
})

test('reprobeMachine：不可达 → unreachable；未知 id throw', async () => {
  resetMachineStatus()
  const h = home()
  try {
    const dead = await closedOrigin()
    upsertRemote(h, { id: 'd4e5', name: 'dev3', label: 'DEV3', origin: dead, token: 'ok', enabled: true, addedAt: 1 })
    const r = await reprobeMachine(h, 'd4e5')
    assert.equal(r.ok, false)
    assert.equal(r.status, 'unreachable')
    assert.ok(r.error)
    const st = machineStatus().get('d4e5')
    assert.equal(st.status, 'unreachable')
    assert.ok(st.error)
    await assert.rejects(() => reprobeMachine(h, 'zzzz'), /unknown machine id/)
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})
