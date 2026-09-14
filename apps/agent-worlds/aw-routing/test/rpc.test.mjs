// App-level selector RPC semantics (adapted from the shelved route's per-session face).
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerSelectorRpc } from '../dist/rpc.js'
import { readSelector, writeSelector } from '../dist/index.js'

function fakeCtx() {
  const routes = []
  return {
    routes,
    inject(_deps, cb) { cb(this) },
    effect(fn) { fn(); return () => {} },
    // expose connection on the context for Reflect.get
    connection: {
      fetch: {
        register(route) { routes.push(route); return async () => {} },
      },
    },
  }
}

test('GET returns the app-level selector and available roster', async () => {
  const ctx = fakeCtx()
  registerSelectorRpc(ctx, { listRuntimes: () => ['native', 'omp'] })
  assert.equal(ctx.routes.length, 1)
  const res = await ctx.routes[0].fetch(new Request('http://x/api/agent-runtime'))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { runtime: 'native', available: ['native', 'omp'] })
})

test('POST switches the one selector for the whole app (no sessionId)', async () => {
  const ctx = fakeCtx()
  registerSelectorRpc(ctx, { listRuntimes: () => ['native', 'omp'] })
  const res = await ctx.routes[0].fetch(new Request('http://x/api/agent-runtime', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtime: 'omp' }),
  }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { runtime: 'omp', available: ['native', 'omp'] })
  assert.equal(readSelector(), 'omp')
  writeSelector('native')
  assert.equal(readSelector(), 'native')
})

test('POST rejects an unknown runtime with the available roster', async () => {
  const ctx = fakeCtx()
  registerSelectorRpc(ctx, { listRuntimes: () => ['native', 'omp'] })
  const res = await ctx.routes[0].fetch(new Request('http://x/api/agent-runtime', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtime: 'codex' }),
  }))
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error, 'unknown runtime "codex"')
  assert.deepEqual(body.available, ['native', 'omp'])
  assert.equal(readSelector(), 'native')
})

test('POST rejects a missing/empty runtime and invalid JSON', async () => {
  const ctx = fakeCtx()
  registerSelectorRpc(ctx, { listRuntimes: () => ['native'] })
  const bad = await ctx.routes[0].fetch(new Request('http://x/api/agent-runtime', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  }))
  assert.equal(bad.status, 400)
  const notJson = await ctx.routes[0].fetch(new Request('http://x/api/agent-runtime', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
  }))
  assert.equal(notJson.status, 400)
})
