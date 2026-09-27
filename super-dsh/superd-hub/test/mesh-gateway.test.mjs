// RemoteGatewayFace (machine-mesh P2 Task 2): the wire-form GatewayFace —
// envelope POSTs for dispatchRpc, ONE shared lazy mux WS (T1 MuxClient over
// the ws adapter) for streams — exercised against a REAL local hub fixture:
// node:http for the /hub/api POST lane, and the worktree's own WorldMuxServer
// for the upgrade lane, so the fixture IS the production protocol half.
//
// Pins (brief): dispatchRpc round-trip + verbatim Result; envelope byte
// fidelity (unicode/nested payload, exact key set, rpcId self-increment);
// 401 → gateway/auth-expired (the machine-level classifiable error); non-200
// → gateway/unreachable; 200-unparsable → gateway/bad-response; abort →
// gateway/aborted; mux stream round-trip WITH uplink items (carrier shape);
// GatewayFace shape half-closes the uplink + undefined payload coerces to
// null on the wire; concurrent streams share one connection; socket kill →
// in-flight streams throw gateway/socket-closed and the next call reconnects;
// idle-close fires with real timers (short injectable idleCloseMs) and a
// later call redials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WorldMuxServer } from '../dist/world-mux.js'
import { parseClientRequest, serverResult, serverError } from '../dist/envelope.js'
import { createRemoteGateway } from '../dist/mesh-gateway.js'

const COOKIE = 'dsh-auth-fixture=mesh-cookie'
const AGENT_KEY = 'a6-fixture'

/** One local "remote hub": the /hub/api POST lane + the REAL mux upgrade lane. */
async function startHub(options = {}) {
  const requests = [] // { url, raw, parsed, contentType, cookie }
  const upgrades = [] // { url, cookie }
  const closes = [] // raw-socket closes seen after an accepted upgrade
  const sockets = new Set()
  const open = options.open ?? (async () => [])
  const muxOptions = options.muxHeartbeatMs === undefined ? {} : { heartbeatIntervalMs: options.muxHeartbeatMs }
  const mux = new WorldMuxServer(open, muxOptions)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.local')
    if (url.pathname !== '/hub/api') {
      res.writeHead(404)
      res.end()
      return
    }
    const raw = await readBody(req)
    const mode = options.post ?? 'echo'
    if (mode === 'unauthorized') {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('cookie required')
      return
    }
    if (mode === 'unavailable') {
      res.writeHead(503)
      res.end()
      return
    }
    if (mode === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('<not json')
      return
    }
    if (mode === 'slow') {
      res.on('error', () => { })
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(serverResult('late', { ok: true, value: 1 }))
      }, 400)
      return
    }
    // The byte-faithful authority: the body must survive the REAL envelope parser.
    const parsed = parseClientRequest(raw)
    requests.push({ url: req.url ?? '', raw, parsed, contentType: req.headers['content-type'] ?? '', cookie: req.headers.cookie ?? '' })
    res.writeHead(200, { 'content-type': 'application/json' })
    if (mode === 'result-error') {
      res.end(serverError(parsed.rpcId, { code: 'world/expired', message: 'the world restarted' }))
      return
    }
    res.end(serverResult(parsed.rpcId, { ok: true, value: { echoed: parsed.payload, method: parsed.method } }))
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://fixture.local')
    if (url.pathname !== '/hub/api/remote.mux') {
      socket.destroy()
      return
    }
    sockets.add(socket)
    upgrades.push({ url: req.url ?? '', cookie: req.headers.cookie ?? '' })
    socket.once('close', () => {
      sockets.delete(socket)
      closes.push(1)
    })
    void mux.handleUpgrade(req, socket, head)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    upgrades,
    killSockets: () => { for (const socket of sockets) socket.destroy() },
    upgradeCount: () => upgrades.length,
    closeCount: () => closes.length,
    async stop() {
      // mux.close() can hang on never-settling fixture open handlers; the
      // terminates it issues are synchronous, which is all the sockets need.
      void mux.close().catch(() => { })
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function gateway(hub, options = {}) {
  return createRemoteGateway({ origin: hub.origin, agentKey: AGENT_KEY, cookie: () => COOKIE, ...options })
}

const freshSignal = () => new AbortController().signal

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Drain an iterable under a deadline, so a hung stream fails the test fast. */
async function collect(iterable, ms = 5000) {
  const values = []
  const worker = (async () => { for await (const value of iterable) values.push(value) })()
  const deadline = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('collect timed out')), ms)
    timer.unref()
  })
  await Promise.race([worker, deadline])
  return values
}

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected the promise to reject')
}

async function waitFor(check, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await delay(20)
  }
  assert.fail(`condition not reached within ${ms}ms`)
}

test('dispatchRpc POSTs a client-request envelope and returns the Result verbatim', async () => {
  const hub = await startHub()
  const gw = gateway(hub)
  const result = await gw.dispatchRpc('sessions/list', { page: 2 }, freshSignal())
  assert.deepEqual(result, { ok: true, value: { echoed: { page: 2 }, method: 'sessions/list' } },
    'the envelope result field comes back VERBATIM — no unwrapping')
  const request = hub.requests[0]
  assert.equal(request.url, `/hub/api?agent=${AGENT_KEY}`, 'the demux key rides the query')
  assert.equal(request.contentType, 'application/json')
  assert.equal(request.cookie, COOKIE, 'the pairing cookie rides the POST')
  assert.deepEqual(JSON.parse(request.raw), { type: 'client-request', rpcId: '1', method: 'sessions/list', payload: { page: 2 } },
    'exact envelope key set, rpcId self-incrementing from 1')
  await hub.stop()
})

test('envelope bytes are byte-faithful for unicode/nested payloads and the rpcId increments', async () => {
  const hub = await startHub()
  const gw = gateway(hub)
  const UNICODE = {
    '机器': '并行·Ⅵ',
    emoji: '🛰️',
    nested: { deep: [1, '≤2', null, true], 'キー': '値' },
  }
  const first = await gw.dispatchRpc('u/one', UNICODE, freshSignal())
  const second = await gw.dispatchRpc('u/two', UNICODE, freshSignal())
  await gw.dispatchRpc('u/three', undefined, freshSignal())
  assert.deepEqual(first, { ok: true, value: { echoed: UNICODE, method: 'u/one' } }, 'the payload survives the round trip intact')
  assert.deepEqual(second.value.echoed, UNICODE)
  assert.equal(JSON.parse(hub.requests[0].raw).rpcId, '1')
  assert.equal(JSON.parse(hub.requests[1].raw).rpcId, '2', 'rpcId is a per-gateway counter')
  assert.strictEqual(JSON.parse(hub.requests[2].raw).payload, null, 'an undefined payload is coerced to null on the wire')
  await hub.stop()
})

test('a server-error Result is returned verbatim, not thrown', async () => {
  const hub = await startHub({ post: 'result-error' })
  const gw = gateway(hub)
  const result = await gw.dispatchRpc('sessions/list', {}, freshSignal())
  assert.deepEqual(result, { ok: false, error: { code: 'world/expired', message: 'the world restarted' } },
    'a failing Result is DATA, not an exception — the caller classifies')
  await hub.stop()
})

test('401 maps to gateway/auth-expired (machine-level classification)', async () => {
  const hub = await startHub({ post: 'unauthorized' })
  const gw = gateway(hub)
  const error = await rejection(gw.dispatchRpc('sessions/list', {}, freshSignal()))
  assert.equal(error.code, 'gateway/auth-expired', 'the documented 401 carve-out: roster downgrade material, not unreachable')
  assert.match(error.message, /401/)
  await hub.stop()
})

test('a non-200 answer maps to gateway/unreachable with the status in the message', async () => {
  const hub = await startHub({ post: 'unavailable' })
  const gw = gateway(hub)
  const error = await rejection(gw.dispatchRpc('sessions/list', {}, freshSignal()))
  assert.equal(error.code, 'gateway/unreachable')
  assert.match(error.message, /503/)
  await hub.stop()
})

test('a 200 with an unparsable body maps to gateway/bad-response', async () => {
  const hub = await startHub({ post: 'garbage' })
  const gw = gateway(hub)
  const error = await rejection(gw.dispatchRpc('sessions/list', {}, freshSignal()))
  assert.equal(error.code, 'gateway/bad-response')
  await hub.stop()
})

test('an aborted signal maps to gateway/aborted', async () => {
  const hub = await startHub({ post: 'slow' })
  const gw = gateway(hub)
  const controller = new AbortController()
  const pending = gw.dispatchRpc('sessions/list', {}, controller.signal)
  void delay(30).then(() => controller.abort())
  const error = await rejection(pending)
  assert.equal(error.code, 'gateway/aborted')
  await hub.stop()
})

test('a mux stream round-trips with uplink items (carrier shape) over the real server half', async () => {
  const opened = []
  const hub = await startHub({
    open: async (endpoint, payload, uplink) => {
      const received = []
      for await (const value of uplink) received.push(value)
      opened.push({ endpoint, payload, received })
      return (async function*() { yield { endpoint, count: received.length, payload } })()
    },
  })
  const gw = gateway(hub)
  const uplink = ['u-one', { two: 2 }, 'ⅲ号']
  const stream = gw.openWireStream('agent/hermes/$events', { since: 5 }, uplink, undefined, freshSignal(), new AbortController())
  const items = await collect(stream)
  assert.deepEqual(items, [{ endpoint: 'agent/hermes/$events', count: 3, payload: { since: 5 } }])
  assert.deepEqual(opened[0].received, uplink, 'every uplink item crossed the wire')
  assert.equal(hub.upgrades[0].cookie, COOKIE, 'the pairing cookie rode the upgrade')
  assert.equal(hub.upgrades[0].url, `/hub/api/remote.mux?agent=${AGENT_KEY}`)
  assert.equal(hub.upgradeCount(), 1)
  gw.dispose()
  await hub.stop()
})

test('the GatewayFace shape half-closes the uplink, coerces undefined payload to null, and survives ws-level pings', async () => {
  const hub = await startHub({
    // 50ms heartbeat: the fixture hammers the connection with REAL ws pings
    // while the stream is open — they must never surface as text (else the
    // client would 1008-close and the stream would die).
    muxHeartbeatMs: 50,
    open: async (endpoint, payload, uplink) => {
      const received = []
      const read = (async () => {
        for await (const value of uplink) received.push(value)
        return 'ended'
      })()
      const outcome = await Promise.race([read, delay(600).then(() => 'hung')])
      await delay(250) // several ws ping periods under the open stream
      return (async function*() {
        yield { payload, uplinkOutcome: outcome, uplinkItems: received.length }
      })()
    },
  })
  const gw = gateway(hub)
  const items = await collect(gw.openWireStream('agent/omp/sessions', undefined, freshSignal()))
  assert.deepEqual(items, [{ payload: null, uplinkOutcome: 'ended', uplinkItems: 0 }],
    'undefined payload shows as null on the wire; the no-uplink face half-closes immediately')
  gw.dispose()
  await hub.stop()
})

test('concurrent streams share one connection; a socket kill fails them with gateway/socket-closed and the next call reconnects', async () => {
  let mode = 'hang'
  const hub = await startHub({
    open: () => (mode === 'hang'
      ? new Promise(() => { }) // never settles: an in-flight stream at kill time
      : (async function*() { yield 'reconnected' })()),
  })
  const gw = gateway(hub)
  const one = rejection(collect(gw.openWireStream('hang/one', null, freshSignal())))
  const two = rejection(collect(gw.openWireStream('hang/two', null, freshSignal())))
  await delay(150) // both open frames cross on the SAME connection
  assert.equal(hub.upgradeCount(), 1, 'concurrent streams multiplex one ws connection')
  hub.killSockets()
  assert.equal((await one).code, 'gateway/socket-closed', 'in-flight stream 1 fails with the wire-cut code')
  assert.equal((await two).code, 'gateway/socket-closed', 'in-flight stream 2 fails with the wire-cut code')
  mode = 'settle'
  assert.deepEqual(await collect(gw.openWireStream('after/kill', null, freshSignal())), ['reconnected'],
    'the call after the kill dials a fresh connection')
  assert.equal(hub.upgradeCount(), 2)
  gw.dispose()
  await hub.stop()
})

test('the idle timer closes the connection after the last stream retires, and a later call redials', async () => {
  const hub = await startHub({ open: async function*() { yield 'quick' } })
  const gw = gateway(hub, { idleCloseMs: 120 })
  assert.deepEqual(await collect(gw.openWireStream('one/echo', null, freshSignal())), ['quick'])
  await waitFor(() => hub.closeCount() === 1, 3000)
  assert.equal(hub.upgradeCount(), 1, 'still exactly one dialed connection')
  assert.deepEqual(await collect(gw.openWireStream('two/echo', null, freshSignal())), ['quick'],
    'a call after the idle close reconnects')
  assert.equal(hub.upgradeCount(), 2)
  gw.dispose()
  await hub.stop()
})
