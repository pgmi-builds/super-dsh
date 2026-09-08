import test from 'node:test'
import assert from 'node:assert/strict'
import MultiAgentRegistry from '../dist/index.js'

// ---------------------------------------------------------------------------
// Fake cordis Context: the minimal surface the Service + AgentRegistry
// constructor chain touches, plus what MultiAgentRegistry itself uses.
//
// Service base constructor:  ctx.reflect.provide(name, self, check)
// AgentRegistry constructor: ctx.inject(['typert'], cb), ctx.accessor(...),
//                            ctx.on('internal/status', cb), ctx.effect(genFn)
// MultiAgentRegistry:        ctx.effect(fn, label) (plain fn returning disposer)
//
// We never fire 'internal/status' and never iterate the constructor's
// generator effect, so hasLifecycleAncestor / disposeInitiators never run.
// ---------------------------------------------------------------------------
function makeFakeCtx() {
  const noop = () => {}
  const fakeTypert = {
    lookups: { register: noop },
    contexts: { registerHost: noop },
  }
  const ctx = {
    reflect: { provide: noop },
    // cordis inject returns a scoped context; the registry only reads
    // typeCtx.typert.*, so we hand the callback a ctx-like object carrying it.
    inject(deps, cb) {
      const scoped = Object.create(ctx)
      scoped.typert = fakeTypert
      const inner = cb(scoped)
      return { dispose: noop, ...inner }
    },
    accessor: noop,
    on: () => noop, // disposer
    effect(fn, _label) {
      const out = fn()
      return typeof out === 'function' ? out : noop
    },
  }
  return ctx
}

function makeRegistry() {
  return new MultiAgentRegistry(makeFakeCtx())
}

function makeNativeFactory() {
  const calls = []
  const factory = {
    createAgent(ctx, options) {
      calls.push({ method: 'createAgent', ctx, options })
      return { kind: 'agent', options }
    },
    resume(ctx, options) {
      calls.push({ method: 'resume', ctx, options })
      return { kind: 'agent', options }
    },
  }
  factory.calls = calls
  return factory
}

test('constructor succeeds against the minimal fake ctx surface', () => {
  assert.doesNotThrow(() => makeRegistry())
})

test('setFactory twice throws (same-key fail-loud)', () => {
  const reg = makeRegistry()
  const d1 = reg.setFactory(makeNativeFactory())
  assert.equal(typeof d1, 'function')
  assert.throws(
    () => reg.setFactory(makeNativeFactory()),
    /an agent factory is already registered for "native"/,
  )
})

test('appendFactory(key) coexists with setFactory (multi-slot)', () => {
  const reg = makeRegistry()
  const dn = reg.setFactory(makeNativeFactory())
  const df = reg.appendFactory('omp', makeNativeFactory())
  assert.equal(typeof df, 'function')
  // a second foreign factory under the SAME key still fails loud
  assert.throws(
    () => reg.appendFactory('omp', makeNativeFactory()),
    /an agent factory is already registered for "omp"/,
  )
  // distinct foreign keys are fine too
  assert.doesNotThrow(() => reg.appendFactory('pi', makeNativeFactory()))
})

test('disposer invocation removes the key (registration can be re-made)', () => {
  const reg = makeRegistry()
  const d = reg.setFactory(makeNativeFactory())
  d()
  // after disposal the slot is free again: re-registering must not throw…
  let dMid
  assert.doesNotThrow(() => { dMid = reg.setFactory(makeNativeFactory()) })
  dMid()
  // …and create now works again (fresh factory reachable through native slot)
  const f = makeNativeFactory()
  const d2 = reg.setFactory(f)
  reg.create({ sessionId: 's1', prompt: 'hi' })
  assert.equal(f.calls.length, 1)
  d2()
})

test('disposer removes exactly its own key (stale disposer is a no-op)', () => {
  const reg = makeRegistry()
  const f1 = makeNativeFactory()
  const d1 = reg.setFactory(f1)
  d1()
  const f2 = makeNativeFactory()
  reg.setFactory(f2)
  // d1's guarded teardown must NOT delete f2's registration
  d1() // idempotent / no throw
  reg.create({ sessionId: 's2' })
  assert.equal(f2.calls.length, 1)
})

test('create delegates to the native factory with options passed verbatim', async () => {
  const reg = makeRegistry()
  const f = makeNativeFactory()
  reg.setFactory(f)
  const options = { sessionId: 'sess-42', prompt: 'hello', tools: ['bash'] }
  const handle = await reg.create(options)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'createAgent')
  assert.strictEqual(f.calls[0].options, options) // verbatim, same reference
  assert.equal(handle.kind, 'agent')
  assert.strictEqual(handle.options, options)
})

test('resume delegates to the native factory with options passed verbatim', async () => {
  const reg = makeRegistry()
  const f = makeNativeFactory()
  reg.setFactory(f)
  const options = { resumeSessionId: 'sess-42' }
  await reg.resume(options)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'resume')
  assert.strictEqual(f.calls[0].options, options)
})

test('create with no factory registered throws', async () => {
  const reg = makeRegistry()
  await assert.rejects(
    () => reg.create({ sessionId: 's' }),
    /no agent factory registered/,
  )
})

test('M0 routing: resolve is always native even when foreign keys are registered', async () => {
  const reg = makeRegistry()
  const native = makeNativeFactory()
  const foreign = makeNativeFactory()
  reg.setFactory(native)
  reg.appendFactory('omp', foreign)
  await reg.create({ sessionId: 'any' })
  await reg.resume({ resumeSessionId: 'any' })
  assert.equal(native.calls.length, 2) // create + resume both hit native
  assert.equal(foreign.calls.length, 0) // foreign slot never consulted in M0
})
