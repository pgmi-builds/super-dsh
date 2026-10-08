import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../better-dsh/package.json', import.meta.url))
const load = spec => import(pathToFileURL(require.resolve(spec)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
const { default: Timer } = await load('@deepseek-ai/cordis-plugin-timer')
const { default: NativeHmr } = await load('@deepseek-ai/dsh-hmr')
const { default: AgentRegistry } = await load('@deepseek-ai/dsh-agent')
// The same HTTP regression runs against native HMR before the implementation exists.
const BetterHmr = process.env.HMR_NATIVE_RED === '1'
  ? NativeHmr : (await import('../better-dsh/src/hmr.ts')).default

async function fixture(t, Hmr = BetterHmr) {
  const dir = mkdtempSync(join(tmpdir(), 'better-hmr-context-'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  t.after(async () => { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }) })
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  const provider = await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0,
    awaitWriteFinish: { stabilityThreshold: 25, pollInterval: 5 } })
  return { ctx, dir, provider, hmr: ctx.hmr }
}

async function httpMutation(t, hmr, operation = async () => 'applied') {
  let server
  await hmr.runExclusive(async () => {
    server = createServer(async (_request, response) => {
      try { response.end(await hmr.runExclusive(operation)) }
      catch (error) { response.statusCode = 500; response.end(error.message) }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  })
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, { headers: { connection: 'close' } })
  return { status: response.status, body: await response.text() }
}

test('native HMR reproduces stale transaction context in an HTTP server', { timeout: 5000 }, async t => {
  const { hmr } = await fixture(t, NativeHmr)
  const result = await httpMutation(t, hmr)
  assert.equal(result.status, 500)
  assert.match(result.body, /HMR transactions cannot be nested/)
})

test('HTTP callbacks created during a completed transaction can mutate again', { timeout: 5000 }, async t => {
  const { hmr } = await fixture(t)
  assert.deepEqual(await httpMutation(t, hmr), { status: 200, body: 'applied' })
})

test('native queue serializes operations, rejects actual nesting and recovers after failure', { timeout: 5000 }, async t => {
  const { hmr } = await fixture(t)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const order = []
  const first = hmr.runExclusive(async () => {
    order.push('first'); entered.resolve(); await release.promise
    throw new Error('operation failed')
  })
  const rejected = assert.rejects(first, /operation failed/)
  await entered.promise
  const second = hmr.runExclusive(async () => {
    order.push('second')
    await assert.rejects(hmr.runExclusive(async () => {}), /HMR transactions cannot be nested/)
  })
  assert.deepEqual(order, ['first'])
  release.resolve(); await rejected; await second
  assert.deepEqual(order, ['first', 'second'])
  assert.equal(await hmr.runExclusive(async () => 42), 42)
})

test('native exact watcher can dispose its own HMR during its refresh', { timeout: 5000 }, async t => {
  const { dir, provider, hmr } = await fixture(t)
  const refreshed = Promise.withResolvers()
  const filename = join(dir, 'watch.yml')
  await hmr.watchConfig(filename, async () => {
    try { await provider.dispose(); refreshed.resolve() }
    catch (error) { refreshed.reject(error) }
  })
  writeFileSync(filename, 'changed\n')
  await refreshed.promise
  await assert.rejects(hmr.runExclusive(async () => {}), /HMR is disposed/)
})

test('native HMR disposal drains an active operation before completing', { timeout: 5000 }, async t => {
  const { provider, hmr } = await fixture(t)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const active = hmr.runExclusive(async () => { entered.resolve(); await release.promise })
  await entered.promise
  let disposed = false
  const disposal = provider.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  release.resolve(); await active; await disposal
  await assert.rejects(hmr.runExclusive(async () => {}), /HMR is disposed/)
})

test('selective reset preserves caller ALS and real AgentRegistry self-disposal lineage', { timeout: 5000 }, async t => {
  const { ctx, hmr } = await fixture(t)
  const scope = await ctx.plugin(AgentRegistry)
  const agents = ctx.agents
  const agent = { id: 'hmr-initiator' }
  const request = new AsyncLocalStorage()
  // Capture a stale native HTTP-like resource, then establish a fresh caller identity inside it.
  let stale
  await hmr.runExclusive(async () => { stale = AsyncLocalStorage.snapshot() })
  await stale(() => request.run({ id: 'current-request' }, () => agents.withInitiator(agent, () =>
    hmr.runExclusive(async () => {
      assert.equal(request.getStore().id, 'current-request')
      assert.equal(agents.currentInitiator(), agent)
      await scope.dispose()
    }))))
  assert.throws(() => agents.currentInitiator(), /initiator scope is disposed/)
})
