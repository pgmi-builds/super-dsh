import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
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
// 0.2.2: AgentRegistry waits for the session-projections owner — mount it or
// the registry stays pending and `ctx.agents` reads undefined.
const { default: SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection')
const { WebServer } = await load('@deepseek-ai/dsh-host-webserver')
async function fixture(t, Hmr = NativeHmr) {
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

test('the native listener stays outside management transactions and can serve repeated mutations', { timeout: 5000 }, async t => {
  const { ctx, hmr } = await fixture(t)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const listener = ctx.webServer
  let changes = 0
  ctx.effect(() => listener.register({ kind: 'exact', path: '/mutate', async handler(_request, response) {
    try {
      const result = await hmr.runExclusive(async () => {
        const component = ctx.plugin({ apply() {} })
        await component.await()
        await component.dispose()
        return ++changes
      })
      response.end(String(result))
    } catch (error) { response.statusCode = 500; response.end(error.stack) }
  } }))
  const url = `http://127.0.0.1:${listener.port}/mutate`
  for (const expected of [1, 2, 3]) {
    const response = await fetch(url, { headers: { connection: 'close' } })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), String(expected))
    assert.equal(ctx.webServer.port, listener.port)
  }
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

test('native management preserves caller ALS and AgentRegistry self-disposal lineage', { timeout: 5000 }, async t => {
  const { ctx, hmr } = await fixture(t)
  await ctx.plugin(SessionProjectionRegistry)
  const scope = await ctx.plugin(AgentRegistry)
  const agents = ctx.agents
  const agent = { id: 'hmr-initiator' }
  const request = new AsyncLocalStorage()
  await request.run({ id: 'current-request' }, () => agents.withInitiator(agent, () =>
    hmr.runExclusive(async () => {
      assert.equal(request.getStore().id, 'current-request')
      assert.equal(agents.currentInitiator(), agent)
      await scope.dispose()
    })))
  assert.throws(() => agents.currentInitiator(), /initiator scope is disposed/)
})
