// Instance-delegation semantics of the Runtime Routing Gateway wrapper:
// the selector picks which context's typertGateway INSTANCE each of the two
// methods lands on. Native → upstream verbatim; foreign → target instance
// with identical arguments; no target → typed failure (dispatch) / loud
// stream death (purity over availability); reload re-run does not stack.
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../dist/gateway.js'
import { writeSelector } from '../dist/selector.js'
import { registerForeignTarget, unregisterForeignTarget } from '../dist/targets.js'

const NEVER = new AbortController().signal

function fakeGateway(name) {
  const dispatchCalls = []
  const streamCalls = []
  return {
    name, dispatchCalls, streamCalls,
    dispatchRpc: async (endpoint, payload, signal) => {
      dispatchCalls.push({ endpoint, payload, signal })
      return { ok: true, value: `${name}:${endpoint}` }
    },
    openWireStream: async function* (endpoint, payload, signal) {
      streamCalls.push({ endpoint, payload, signal })
      yield { from: name, endpoint }
    },
  }
}

function fakeCtx(gateway) {
  let gatewayCb
  return {
    ctx: {
      inject(_deps, cb) { gatewayCb = cb; cb(this) },
      effect(fn) { fn(); return () => {} },
      get(key) { return key === 'typertGateway' ? gateway : undefined },
      typertGateway: gateway,
      connection: undefined,
    },
    reload() { gatewayCb?.(this.ctx) },
  }
}

test('dispatch: native → upstream instance verbatim', async () => {
  const up = fakeGateway('upstream')
  apply(fakeCtx(up).ctx)
  writeSelector('native')
  const result = await up.dispatchRpc('session/list', { args: { _request: {} } }, NEVER)
  assert.deepEqual(result, { ok: true, value: 'upstream:session/list' })
  assert.equal(up.dispatchCalls.length, 1)
  assert.equal(up.dispatchCalls[0].payload.args._request !== undefined, true)
})

test('dispatch: foreign → the TARGET instance executes (args identical, upstream untouched)', async () => {
  const up = fakeGateway('upstream')
  const foreign = fakeGateway('ctx1')
  apply(fakeCtx(up).ctx)
  registerForeignTarget({ key: 'omp', gateway: foreign })
  try {
    writeSelector('omp')
    const result = await up.dispatchRpc('session/list', { args: { _request: {} } }, NEVER)
    assert.deepEqual(result, { ok: true, value: 'ctx1:session/list' })
    assert.equal(foreign.dispatchCalls.length, 1, 'target instance ran')
    assert.equal(up.dispatchCalls.length, 0, 'upstream untouched in foreign world')
    assert.equal(foreign.dispatchCalls[0].signal, NEVER, 'signal passed through')
  } finally {
    unregisterForeignTarget('omp')
    writeSelector('native')
  }
})

test('dispatch: no target → typed ok:false, never native fallback', async () => {
  const up = fakeGateway('upstream')
  apply(fakeCtx(up).ctx)
  writeSelector('omp')
  const result = await up.dispatchRpc('session/list', { args: {} }, NEVER)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'gateway/routing-target-unavailable')
  assert.equal(up.dispatchCalls.length, 0, 'purity: no native fallback')
  writeSelector('native')
})

test('stream: foreign → the TARGET instance yields the frames', async () => {
  const up = fakeGateway('upstream')
  const foreign = fakeGateway('ctx1')
  apply(fakeCtx(up).ctx)
  registerForeignTarget({ key: 'omp', gateway: foreign })
  try {
    writeSelector('omp')
    const frames = []
    for await (const frame of up.openWireStream('$events', { args: {} }, NEVER)) frames.push(frame)
    assert.deepEqual(frames, [{ from: 'ctx1', endpoint: '$events' }])
    assert.equal(foreign.streamCalls.length, 1)
    assert.equal(up.streamCalls.length, 0)
  } finally {
    unregisterForeignTarget('omp')
    writeSelector('native')
  }
})

test('stream: no target → dies loudly, never the wrong world', async () => {
  const up = fakeGateway('upstream')
  apply(fakeCtx(up).ctx)
  writeSelector('omp')
  await assert.rejects(async () => {
    for await (const _frame of up.openWireStream('$events', { args: {} }, NEVER)) void _frame
  }, /no target is registered/)
  assert.equal(up.streamCalls.length, 0)
  writeSelector('native')
})

test('gateway service reload re-run does not stack wrappers', async () => {
  const up = fakeGateway('upstream')
  const h = fakeCtx(up)
  apply(h.ctx)
  h.reload()
  h.reload()
  writeSelector('native')
  await up.dispatchRpc('session/list', { args: {} }, NEVER)
  await up.dispatchRpc('session/list', { args: {} }, NEVER)
  assert.equal(up.dispatchCalls.length, 2, 'each call hits upstream exactly once')
})
