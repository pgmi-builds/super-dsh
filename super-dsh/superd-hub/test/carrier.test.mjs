// The carrier forwarding kernel (path-separation T-C, 2026-09-26): the
// per-label URL family is RETIRED from ctx0 — `/hub` (hub-route.ts) is the
// sole foreign entry and consumes the kernel directly (forwardApiCall /
// forwardWorldFetch / worldMuxOf). The kernel tests below drive the exact
// functions the /hub family calls. T-D: the retired `mountWorld` no-op is
// GONE from the module (the adapter call sites swept with it).
import test from 'node:test'
import assert from 'node:assert/strict'
import * as carrierModule from '../dist/carrier.js'
import { forwardApiCall, forwardWorldFetch } from '../dist/carrier.js'

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

function reqWith(body, url = '/omp/api/session.list') {
  return {
    url,
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  }
}

function worldGateway(result = { ok: true, value: 'v' }) {
  const calls = []
  return {
    calls,
    async dispatchRpc(endpoint, payload, signal) { calls.push({ endpoint, payload, aborted: signal.aborted }); return result },
  }
}

function kernelOf(gateway, over = {}) {
  return { gateway, label: 'omp', mountPath: '/omp', ...over }
}

async function callKernel(kernel, body, url = '/omp/api/session.list') {
  const res = fakeRes()
  await forwardApiCall(kernel, reqWith(body, url), res)
  return res
}

test('unary decodes the envelope, dispatches to the world instance, answers one server-response', async () => {
  const gateway = worldGateway()
  const res = await callKernel(kernelOf(gateway), JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: { a: 1 } }))
  assert.deepEqual(gateway.calls, [{ endpoint: 'session.list', payload: { a: 1 }, aborted: false }])
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { type: 'server-response', rpcId: 'r1', result: { ok: true, value: 'v' } })
})

test('invalid envelopes answer 400 and never reach the world', async () => {
  const gateway = worldGateway()
  const bad = await callKernel(kernelOf(gateway), 'not json')
  assert.equal(bad.status, 400)
  const body = JSON.parse(bad.body)
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'gateway/bad-request')
  const wrongType = await callKernel(kernelOf(gateway), JSON.stringify({ type: 'nope', rpcId: 'x', method: 'm' }))
  assert.equal(wrongType.status, 400)
  assert.equal(gateway.calls.length, 0, 'no cross-world wire call on a malformed request')
})

test('a dispatch failure is a 200 server-response carrying the error', async () => {
  const gateway = {
    async dispatchRpc() {
      return { ok: false, error: { code: 'session/not-found', message: 'no such session' } }
    },
  }
  const res = await callKernel(kernelOf(gateway), JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'session.list', payload: {} }))
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body).result, { ok: false, error: { code: 'session/not-found', message: 'no such session' } })
})

test('a thrown error becomes an error result on 200 (business failure, not transport failure)', async () => {
  const gateway = {
    async dispatchRpc() { throw Object.assign(new Error('boom'), { code: 'gateway/invocation-unavailable' }) },
  }
  const res = await callKernel(kernelOf(gateway), JSON.stringify({ type: 'client-request', rpcId: 'r3', method: 'session.list', payload: {} }))
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.rpcId, 'r3')
  assert.equal(body.result.error.code, 'gateway/invocation-unavailable')
})

test('the browser-trust fence runs before any dispatch', async () => {
  const gateway = worldGateway()
  const res = await callKernel(kernelOf(gateway, { requestRejection: () => 401 }), JSON.stringify({ type: 'client-request', rpcId: 'r4', method: 'session.list', payload: {} }))
  assert.equal(res.status, 401)
  assert.equal(gateway.calls.length, 0)
})

// ---- Carrier fetch passthrough (2026-09-17 H1, the /hub lane since T-C):
// non-envelope GET/HEAD forwards into the owning world's registered exact
// Fetch routes through the world connection's shared `/api` handler,
// published via the cross-root world-host registry (world-entry does this in
// production; the /hub family fences before the kernel runs).
import { publishWorldFetch } from '../dist/world-host.js'

function worldFetchHandler(responder) {
  const calls = []
  return {
    calls,
    requestBodyMode: () => 'buffered',
    async fetch(request) {
      calls.push({ url: String(request.url), method: request.method })
      return responder !== undefined ? responder(request) : new Response('not found', { status: 404 })
    },
  }
}

function getReq(url, method = 'GET', headers = {}) {
  return { url, method, headers }
}

async function callKernelReq(kernel, req) {
  const res = fakeRes()
  await forwardApiCall(kernel, req, res)
  return res
}

test('non-envelope GET forwards into the world route with the label stripped and query kept', async () => {
  const gateway = worldGateway()
  const handler = worldFetchHandler(() => new Response('zip-bytes', {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="dsh-session-s1.zip"' },
  }))
  const drop = publishWorldFetch('omp', handler)
  const res = await callKernelReq(kernelOf(gateway), getReq('/omp/api/session.export?sessionId=s1&includeDescendants=true'))
  assert.deepEqual(handler.calls, [{ url: 'http://dsh.internal/api/session.export?sessionId=s1&includeDescendants=true', method: 'GET' }])
  assert.equal(res.status, 200)
  assert.deepEqual(res.headers, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="dsh-session-s1.zip"' })
  assert.equal(Buffer.concat(res.chunks).toString('utf8'), 'zip-bytes')

  assert.equal(gateway.calls.length, 0, 'no RPC dispatch for non-envelope traffic')
  drop()
})

test('non-envelope HEAD forwards and ends without a body (ZIP probe shape)', async () => {
  const handler = worldFetchHandler(() => new Response(null, {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="dsh-session-s1.zip"' },
  }))
  const drop = publishWorldFetch('omp', handler)
  const res = await callKernelReq(kernelOf(worldGateway()), getReq('/omp/api/session.export?sessionId=s1&includeDescendants=true', 'HEAD'))
  assert.deepEqual(handler.calls, [{ url: 'http://dsh.internal/api/session.export?sessionId=s1&includeDescendants=true', method: 'HEAD' }])
  assert.equal(res.status, 200)
  assert.equal(res.body, undefined, 'HEAD answer carries no body')
  assert.equal(res.headers['content-disposition'], 'attachment; filename="dsh-session-s1.zip"')
  drop()
})

test('forwardWorldFetch strips the label on its own (the direct kernel entry)', async () => {
  const handler = worldFetchHandler(() => new Response('direct', { status: 200 }))
  const drop = publishWorldFetch('omp', handler)
  const res = fakeRes()
  await forwardWorldFetch({ label: 'omp', mountPath: '/omp' }, getReq('/omp/api/session.export?sessionId=s1'), res)
  assert.deepEqual(handler.calls, [{ url: 'http://dsh.internal/api/session.export?sessionId=s1', method: 'GET' }])
  assert.equal(res.status, 200)
  assert.equal(Buffer.concat(res.chunks).toString('utf8'), 'direct')
  drop()
})

test('envelope RPC dispatch is unchanged while the passthrough is mounted', async () => {
  const gateway = worldGateway()
  const handler = worldFetchHandler()
  const drop = publishWorldFetch('omp', handler)
  const res = await callKernelReq(kernelOf(gateway), reqWith(JSON.stringify({ type: 'client-request', rpcId: 'r9', method: 'session.list', payload: {} })))
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { type: 'server-response', rpcId: 'r9', result: { ok: true, value: 'v' } })
  assert.deepEqual(gateway.calls, [{ endpoint: 'session.list', payload: {}, aborted: false }])
  assert.equal(handler.calls.length, 0, 'the world fetch handler is never consulted for envelopes')
  drop()
})

test('non-envelope POST still answers the transport-level 400', async () => {
  const gateway = worldGateway()
  const handler = worldFetchHandler()
  const drop = publishWorldFetch('omp', handler)
  const res = await callKernelReq(kernelOf(gateway), reqWith('not json'))
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).result.error.code, 'gateway/bad-request')
  assert.equal(handler.calls.length, 0)
  assert.equal(gateway.calls.length, 0)
  drop()
})

test('the passthrough runs behind the same ctx0 browser-trust fence', async () => {
  const handler = worldFetchHandler()
  const drop = publishWorldFetch('omp', handler)
  const res = await callKernelReq(kernelOf(worldGateway(), { requestRejection: () => 401 }), getReq('/omp/api/session.export?sessionId=s1'))
  assert.equal(res.status, 401)
  assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' })
  assert.equal(handler.calls.length, 0, 'an unauthenticated request never reaches the world')
  drop()
})

test('unknown world routes answer 404 from the world handler', async () => {
  const handler = worldFetchHandler() // default responder: 404 not found
  const drop = publishWorldFetch('omp', handler)
  const res = await callKernelReq(kernelOf(worldGateway()), getReq('/omp/api/nope?x=1'))
  assert.equal(res.status, 404)
  assert.equal(Buffer.concat(res.chunks).toString('utf8'), 'not found', 'the world handler 404 body streams through')

  drop()
})

test('a world without a published fetch handler answers 404 (no route can answer)', async () => {
  const res = await callKernelReq(kernelOf(worldGateway(), { label: 'codex', mountPath: '/codex' }), getReq('/codex/api/session.export?sessionId=s1'))
  assert.equal(res.status, 404)
})

test('a world fetch handler fault answers 500 without leaking an envelope', async () => {
  const handler = worldFetchHandler(() => { throw new Error('world route exploded') })
  const drop = publishWorldFetch('omp', handler)
  const res = await callKernelReq(kernelOf(worldGateway()), getReq('/omp/api/session.export?sessionId=s1'))
  assert.equal(res.status, 500)
  assert.match(String(res.body), /carrier fetch bridge failure/)
  drop()
})

// ---- T-D negative probe: the retired `mountWorld` no-op is gone entirely —
// the vestige sweep removed it together with the adapter call sites that fed
// it (git history keeps both).

test('mountWorld no longer exists on the carrier module (vestige swept, T-D)', () => {
  assert.equal(carrierModule.mountWorld, undefined)
  assert.equal(carrierModule.rewriteIndexHtml, undefined, 'the mount HTML pass retired with the world pages')
})
