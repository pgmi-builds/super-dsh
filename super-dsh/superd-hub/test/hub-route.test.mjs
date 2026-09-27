// The hub-owned `/hub` route family (native UI fusion Task 2): ONE prefix
// route + ONE upgrade route on ctx0's webServer, demuxed by `?agent=<label>`.
// The forwarding itself is the carrier kernel (shared with /<label>/api —
// carrier.test.mjs is its regression net); this suite pins the FAMILY's own
// semantics: registration shape, demux, gate ordering, silent degradation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHubRoute } from '../dist/hub-route.js'
import { publishWorldFetch } from '../dist/world-host.js'

function fakeReal() {
  return {
    routes: new Map(),
    upgrades: new Map(),
    fallback: undefined,
    register(route) {
      const id = `${route.kind}:${route.path}`
      if (this.routes.has(id)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      this.routes.set(id, route)
      return () => this.routes.delete(id)
    },
    registerUpgrade(route) { this.upgrades.set(route.path, route); return () => this.upgrades.delete(route.path) },
    registerFallback(handler) { this.fallback = handler; return () => { this.fallback = undefined } },
    tapIndex() { return () => { } },
    port: 4999,
    host: '127.0.0.1',
  }
}

function fakeRes() {
  return {
    status: 0,
    headers: undefined,
    body: undefined,
    chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers },
    write(chunk) { this.chunks.push(chunk); return true },
    end(body) { this.body = body },
  }
}

function reqWith(body, url = '/hub/api/session.list?agent=codex', method = 'POST') {
  return {
    url,
    method,
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  }
}

function worldGateway(result = { ok: true, value: 'v' }) {
  const calls = []
  return {
    calls,
    async dispatchRpc(endpoint, payload, signal) { calls.push({ endpoint, payload, aborted: signal.aborted }); return result },
    openWireStream() { return (async function* () { })() },
  }
}

function mountHub(real, overrides = {}) {
  const gateway = worldGateway()
  const dispose = registerHubRoute({
    real,
    authorize: () => true,
    gatewayOf: (label) => (label === 'codex' ? gateway : undefined),
    ...overrides,
  })
  return { gateway, dispose }
}

test('registers the /hub prefix and the /hub/api/remote.mux upgrade; the disposer releases both', () => {
  const real = fakeReal()
  const { dispose } = mountHub(real)
  assert.equal(real.routes.has('prefix:/hub'), true)
  assert.equal(real.upgrades.has('/hub/api/remote.mux'), true)
  dispose()
  assert.equal(real.routes.size, 0)
  assert.equal(real.upgrades.size, 0)
})

test('envelope POST with ?agent=codex dispatches the decoded payload and answers with the gateway result', async () => {
  const real = fakeReal()
  const { gateway, dispose } = mountHub(real)
  const res = fakeRes()
  await real.routes.get('prefix:/hub').handler(
    reqWith(JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: { a: 1 } })),
    res,
  )
  assert.deepEqual(gateway.calls, [{ endpoint: 'session.list', payload: { a: 1 }, aborted: false }])
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { type: 'server-response', rpcId: 'r1', result: { ok: true, value: 'v' } })
  dispose()
})

test('no agent param and agent=native answer 404 foreign-only and reach no gateway', async () => {
  const real = fakeReal()
  const { gateway, dispose } = mountHub(real)
  for (const url of ['/hub/api/session.list', '/hub/api/session.list?agent=native', '/hub?agent=']) {
    const res = fakeRes()
    await real.routes.get('prefix:/hub').handler(reqWith('not json', url), res)
    assert.equal(res.status, 404, url)
    const body = JSON.parse(res.body)
    assert.equal(body.error, 'foreign-only', url)
  }
  assert.deepEqual(gateway.calls, [], 'the family serves foreign traffic only')
  dispose()
})

test('unknown or unspawned label answers 404 {error: unknown-agent, label} (silent degradation)', async () => {
  const real = fakeReal()
  const { gateway, dispose } = mountHub(real)
  const res = fakeRes()
  await real.routes.get('prefix:/hub').handler(
    reqWith(JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'session.list', payload: {} }), '/hub/api/session.list?agent=ghost'),
    res,
  )
  assert.equal(res.status, 404)
  assert.deepEqual(JSON.parse(res.body), { error: 'unknown-agent', label: 'ghost' })
  assert.deepEqual(gateway.calls, [], 'a registered world is never consulted for another label')
  dispose()
})

test('authorize false answers by the authorizer and never touches the gateway', async () => {
  const real = fakeReal()
  const gateway = worldGateway()
  const dispose = registerHubRoute({
    real,
    authorize: (req, res) => { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('dsh web authentication required'); return false },
    gatewayOf: () => gateway,
  })
  const res = fakeRes()
  await real.routes.get('prefix:/hub').handler(
    reqWith(JSON.stringify({ type: 'client-request', rpcId: 'r3', method: 'session.list', payload: {} })),
    res,
  )
  assert.equal(res.status, 401)
  assert.equal(res.body, 'dsh web authentication required')
  assert.deepEqual(gateway.calls, [])
  dispose()
})

// ---- Non-envelope GET/HEAD: the world fetch handler with the demux key consumed.
import { worldFetchHandlerOf } from '../dist/world-host.js'

test('non-envelope GET forwards into the world fetch handler with /hub stripped and ?agent consumed', async () => {
  const real = fakeReal()
  const { gateway, dispose } = mountHub(real)
  const handler = {
    calls: [],
    requestBodyMode: () => 'buffered',
    async fetch(request) {
      this.calls.push({ url: String(request.url), method: request.method })
      return new Response('zip-bytes', { status: 200, headers: { 'content-type': 'application/zip' } })
    },
  }
  const drop = publishWorldFetch('codex', handler)
  assert.equal(worldFetchHandlerOf('codex'), handler)
  const res = fakeRes()
  await real.routes.get('prefix:/hub').handler(
    reqWith('', '/hub/api/session.export?agent=codex&sessionId=s1&includeDescendants=true', 'GET'),
    res,
  )
  assert.deepEqual(handler.calls, [{ url: 'http://dsh.internal/api/session.export?sessionId=s1&includeDescendants=true', method: 'GET' }])
  assert.equal(res.status, 200)
  assert.deepEqual(res.headers, { 'content-type': 'application/zip' })
  assert.equal(Buffer.concat(res.chunks).toString('utf8'), 'zip-bytes')
  assert.deepEqual(gateway.calls, [], 'no RPC dispatch for non-envelope traffic')
  drop()
  dispose()
})

// ---- WS upgrade: demux to the addressed world's mux (real wire handshake).
import { createServer } from 'node:http'
import WebSocket from 'ws'

test('the mux upgrade demuxes ?agent= to that world gateway with the canonical openWireStream wiring', async () => {
  const real = fakeReal()
  const opens = []
  const gateway = {
    async dispatchRpc() { return { ok: true, value: null } },
    openWireStream(endpoint, payload, uplink, peer, signal, control) {
      opens.push({ endpoint, payload, peer, hasUplink: typeof uplink?.[Symbol.asyncIterator] === 'function', hasControl: typeof control?.abort === 'function' })
      return (async function* () { yield { echo: payload } })()
    },
  }
  const dispose = registerHubRoute({ real, authorize: () => true, gatewayOf: (label) => (label === 'codex' ? gateway : undefined) })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { void real.upgrades.get('/hub/api/remote.mux').handler(req, socket, head) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const socket = new WebSocket(`ws://127.0.0.1:${port}/hub/api/remote.mux?agent=codex`)
  await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject) })
  const frames = new Promise((resolve, reject) => {
    const got = []
    const timer = setTimeout(() => reject(new Error(`timed out after ${got.length} frames`)), 3000)
    socket.on('message', (data) => { got.push(JSON.parse(String(data))); if (got.length >= 2) { clearTimeout(timer); resolve(got) } })
    socket.on('error', reject)
  })
  socket.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: '$events', payload: { x: 1 } }))
  assert.deepEqual(await frames, [
    { type: 'item', streamId: 's1', value: { echo: { x: 1 } } },
    { type: 'end', streamId: 's1' },
  ])
  assert.deepEqual(opens, [{
    endpoint: '$events',
    payload: { x: 1 },
    peer: undefined,
    hasUplink: true,
    hasControl: true,
  }])
  socket.close()
  dispose()
  await new Promise((resolve) => server.close(resolve))
})

function fakeSocket() {
  const writes = []
  return {
    writes,
    destroyed: false,
    write(chunk) { writes.push(String(chunk)); return true },
    destroy() { this.destroyed = true },
  }
}

async function upgrade(real, url, socket) {
  await real.upgrades.get('/hub/api/remote.mux').handler({ url, headers: {} }, socket, Buffer.alloc(0))
}

test('upgrade without or with an unknown agent is rejected 404 JSON on the raw socket', async () => {
  const real = fakeReal()
  const { gateway, dispose } = mountHub(real)
  const missing = fakeSocket()
  await upgrade(real, '/hub/api/remote.mux', missing)
  assert.match(missing.writes.join(''), /^HTTP\/1\.1 404 /)
  assert.deepEqual(JSON.parse(missing.writes.join('').split('\r\n\r\n')[1]), { error: 'foreign-only' })
  assert.equal(missing.destroyed, true)
  const ghost = fakeSocket()
  await upgrade(real, '/hub/api/remote.mux?agent=ghost', ghost)
  assert.match(ghost.writes.join(''), /^HTTP\/1\.1 404 /)
  assert.deepEqual(JSON.parse(ghost.writes.join('').split('\r\n\r\n')[1]), { error: 'unknown-agent', label: 'ghost' })
  assert.equal(ghost.destroyed, true)
  assert.deepEqual(gateway.calls, [])
  dispose()
})

test('upgrade with authorize false replays the authorizer answer on the raw socket', async () => {
  const real = fakeReal()
  const gateway = worldGateway()
  const dispose = registerHubRoute({
    real,
    authorize: (req, res) => { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('dsh web authentication required'); return false },
    gatewayOf: () => gateway,
  })
  const socket = fakeSocket()
  await upgrade(real, '/hub/api/remote.mux?agent=codex', socket)
  assert.match(socket.writes.join(''), /^HTTP\/1\.1 401 Unauthorized/)
  assert.match(socket.writes.join(''), /dsh web authentication required/)
  assert.equal(socket.destroyed, true)
  assert.deepEqual(gateway.calls, [])
  dispose()
})

// ---- Review round 1, finding 2: the family carries the SAME ctx0
// browser-trust fence (the connection's `isTrustedApiRequest` face) the
// sibling `/<label>/api` mounts run — auth (authorizeIndex) first, fence
// second, before ANY family answer. carrier.test.mjs pins this fence on the
// neighbor mounts with a constant `requestRejection: () => 401`; the same pin
// plus a header-shaped fence mirrors it here.

function trustFence(authorities, status = 403) {
  // isTrustedApiRequest-shaped: the Host must be a declared authority and a
  // cross-origin request (Origin header) is rejected. The face itself is
  // ctx0's (tested upstream); this suite pins that the family consults it
  // and honors its verdict.
  return (req) => {
    const headers = req.headers ?? {}
    if (authorities.includes(String(headers.host ?? '')) && headers.origin === undefined) return undefined
    return status
  }
}

const TRUSTED = ['test.pc.internal.test']

test('the requestRejection fence rejects untrusted Host/Origin before any family answer or dispatch', async () => {
  const real = fakeReal()
  const handler = {
    calls: [],
    requestBodyMode: () => 'buffered',
    async fetch(request) { this.calls.push(String(request.url)); return new Response('nope', { status: 404 }) },
  }
  const drop = publishWorldFetch('codex', handler)
  const { gateway, dispose } = mountHub(real, { requestRejection: () => 401 })
  const envelope = JSON.stringify({ type: 'client-request', rpcId: 'r9', method: 'session.list', payload: {} })
  // envelope POST to a registered label → fenced, gateway untouched
  const res = fakeRes()
  await real.routes.get('prefix:/hub').handler(reqWith(envelope, '/hub/api/session.list?agent=codex'), res)
  assert.equal(res.status, 401)
  assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' })
  // unknown label → fenced (NOT the 404 unknown-agent demux answer)
  const ghost = fakeRes()
  await real.routes.get('prefix:/hub').handler(reqWith(envelope, '/hub/api/session.list?agent=ghost'), ghost)
  assert.equal(ghost.status, 401)
  assert.deepEqual(JSON.parse(ghost.body), { error: 'unauthorized' })
  // no demux key → fenced (NOT the 404 foreign-only answer)
  const native = fakeRes()
  await real.routes.get('prefix:/hub').handler(reqWith(envelope, '/hub/api/session.list'), native)
  assert.equal(native.status, 401)
  assert.deepEqual(JSON.parse(native.body), { error: 'unauthorized' })
  // non-envelope GET passthrough → fenced, the world fetch handler untouched
  const get = fakeRes()
  await real.routes.get('prefix:/hub').handler(reqWith('', '/hub/api/session.export?agent=codex&sessionId=s1', 'GET'), get)
  assert.equal(get.status, 401)
  assert.deepEqual(JSON.parse(get.body), { error: 'unauthorized' })
  assert.deepEqual(handler.calls, [])
  assert.deepEqual(gateway.calls, [])
  drop()
  dispose()
})

test('a trusted Host/Origin still forwards: the fence only rejects untrusted traffic', async () => {
  const real = fakeReal()
  const { gateway, dispose } = mountHub(real, { requestRejection: trustFence(TRUSTED) })
  const trusted = reqWith(JSON.stringify({ type: 'client-request', rpcId: 'r10', method: 'session.list', payload: { a: 1 } }))
  trusted.headers = { host: 'test.pc.internal.test' }
  const res = fakeRes()
  await real.routes.get('prefix:/hub').handler(trusted, res)
  assert.equal(res.status, 200)
  assert.deepEqual(gateway.calls, [{ endpoint: 'session.list', payload: { a: 1 }, aborted: false }])
  const untrusted = reqWith(JSON.stringify({ type: 'client-request', rpcId: 'r11', method: 'session.list', payload: {} }))
  untrusted.headers = { host: 'evil.example', origin: 'https://evil.example' }
  const rejected = fakeRes()
  await real.routes.get('prefix:/hub').handler(untrusted, rejected)
  assert.equal(rejected.status, 403)
  assert.deepEqual(JSON.parse(rejected.body), { error: 'forbidden' })
  assert.equal(gateway.calls.length, 1, 'only the trusted request reached the gateway')
  dispose()
})

test('authorizeIndex still answers before the fence (auth first, then Host/Origin)', async () => {
  const real = fakeReal()
  let fenceCalls = 0
  const gateway = worldGateway()
  const dispose = registerHubRoute({
    real,
    authorize: (req, res) => { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('dsh web authentication required'); return false },
    requestRejection: () => { fenceCalls += 1; return 403 },
    gatewayOf: () => gateway,
  })
  const res = fakeRes()
  await real.routes.get('prefix:/hub').handler(
    reqWith(JSON.stringify({ type: 'client-request', rpcId: 'r12', method: 'session.list', payload: {} }), '/hub/api/session.list?agent=codex'),
    res,
  )
  assert.equal(res.status, 401)
  assert.equal(res.body, 'dsh web authentication required')
  assert.equal(fenceCalls, 0, 'the ctx0 auth gate precedes the fence')
  assert.deepEqual(gateway.calls, [])
  dispose()
})

test('the /hub mux upgrade is fenced before any socket handover; a trusted upgrade still hands over', async () => {
  const real = fakeReal()
  let opened = 0
  const gateway = {
    async dispatchRpc() { return { ok: true, value: null } },
    openWireStream() { opened += 1; return (async function* () { })() },
  }
  const authorities = [...TRUSTED]
  const dispose = registerHubRoute({
    real,
    authorize: () => true,
    requestRejection: trustFence(authorities),
    gatewayOf: (label) => (label === 'codex' ? gateway : undefined),
  })
  // untrusted Origin → the same raw rejection the sibling carrier mux writes
  const rejected = fakeSocket()
  await real.upgrades.get('/hub/api/remote.mux').handler(
    { url: '/hub/api/remote.mux?agent=codex', headers: { host: 'test.pc.internal.test', origin: 'https://evil.example' } },
    rejected,
    Buffer.alloc(0),
  )
  assert.match(rejected.writes.join(''), /^HTTP\/1\.1 403 Forbidden/)
  assert.deepEqual(JSON.parse(rejected.writes.join('').split('\r\n\r\n')[1]), { error: 'forbidden' })
  assert.equal(rejected.destroyed, true)
  // trusted (no Origin) → socket handover proceeds
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { void real.upgrades.get('/hub/api/remote.mux').handler(req, socket, head) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  authorities.push(`127.0.0.1:${port}`)
  let ws
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/hub/api/remote.mux?agent=codex`)
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
    ws.close()
    await new Promise((resolve) => ws.on('close', resolve))
  } finally {
    ws?.close()
    dispose()
    await new Promise((resolve) => server.close(resolve))
  }
  assert.equal(opened, 0, 'handover means ws ownership; openWireStream runs on the first stream frame')
})

// ---- Review round 1, finding 1: the per-connection mux must be CLOSED on
// socket close. world-mux starts a heartbeat interval on first client and
// clears it only in close() (which also closes the per-connection
// WebSocketServer) — without close-on-disconnect every reconnect leaks one
// 2s no-op timer plus the mux graph, forever. The test runs a real upgrade +
// a real TCP teardown and watches the process timers: the live-interval set
// must return to empty after every disconnect.

test('a client disconnect closes the per-connection mux (heartbeat cleared, no per-connection accumulation)', async () => {
  const real = fakeReal()
  const aborts = []
  const gateway = {
    async dispatchRpc() { return { ok: true, value: null } },
    openWireStream(endpoint, payload, uplink, peer, signal, control) {
      aborts.push(control.signal)
      // The page's $events shape: a stream that stays open until cancelled.
      return (async function* () {
        yield { hello: true }
        await new Promise((resolve) => {
          if (control.signal.aborted) return resolve()
          control.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      })()
    },
  }
  const dispose = registerHubRoute({ real, authorize: () => true, gatewayOf: (label) => (label === 'codex' ? gateway : undefined) })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { void real.upgrades.get('/hub/api/remote.mux').handler(req, socket, head) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  // Watch the process timers: the heartbeat interval is exactly the resource
  // the review flagged (world-mux startHeartbeat; clearInterval only in close()).
  const live = new Set()
  let started = 0
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (fn, ms, ...rest) => { started += 1; const handle = realSetInterval(fn, ms, ...rest); live.add(handle); return handle }
  globalThis.clearInterval = (handle, ...rest) => { live.delete(handle); return realClearInterval(handle, ...rest) }

  async function until(condition, message, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${message}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  try {
    for (let round = 0; round < 3; round++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/hub/api/remote.mux?agent=codex`)
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
      const first = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no stream item')), 3000)
        ws.on('message', () => { clearTimeout(timer); resolve() })
        ws.on('error', reject)
      })
      ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: '$events', payload: {} }))
      await first
      // Exactly ONE live heartbeat while this client is connected — previous
      // connections left nothing behind.
      assert.equal(live.size, 1, `round ${round}: exactly one live heartbeat while the client is connected`)
      // Real disconnect: tear the TCP socket down without the close handshake.
      ws.terminate()
      await until(() => aborts[round]?.aborted === true, `round ${round}: the mux noticed the disconnect (stream cancelled)`)
      // THE finding-1 pin: close() ran — the heartbeat interval is gone again.
      await until(() => live.size === 0, `round ${round}: the per-connection heartbeat was cleared on disconnect`)
    }
    assert.equal(started, 3, 'one heartbeat per connection — none left running')
    assert.equal(live.size, 0, 'no per-connection timer accumulation across reconnects')
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    dispose()
    await new Promise((resolve) => server.close(resolve))
  }
})
