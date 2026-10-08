import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { listAgents, unregisterAgent } from '../dist/roster.js'
import { getTarget, unregisterForeignTarget } from '../dist/targets.js'
import { takeHostMount, registerHostMount } from '../dist/world-host.js'

// Keep Cordis and the registries real. Replace only sibling-root boot and
// profile provisioning, which otherwise start complete runtime compositions.
const hooks = registerHooks({
  load(url, context, next) {
    if (url.endsWith('/superd-hub/dist/spawn-world.js')) return {
      format: 'module', shortCircuit: true,
      source: 'export function spawnWorld(options) { return globalThis.lifecycleBoot(options) }',
    }
    if (url.endsWith('/superd-hub/dist/world-provision.js')) return {
      format: 'module', shortCircuit: true,
      source: 'export function provisionWorldProfile() {} export function resolveInstallAnchor() { return "test-anchor" }',
    }
    return next(url, context)
  },
})
const keys = ['codex', 'codex-sdk', 'pi', 'hermes', 'agy', 'agy-sdk', 'omp', 'omp-sdk', 'claude']
const plugins = new Map()
for (const key of keys) plugins.set(key, await import(key === 'claude'
  ? '../dist/world-join.js'
  : `../../agent-${key}/dist/world-plugin.js`))
hooks.deregister()
const home = mkdtempSync(join(tmpdir(), 'superd-lifecycle-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function world(resourceRelease = Promise.resolve()) {
  const ctx = new Context()
  const resource = { live: true }
  ctx.effect(() => async () => { await resourceRelease; resource.live = false })
  const gateway = { async dispatchRpc() { return 'live' }, async *openWireStream() {} }
  ctx.provide('typertGateway', gateway)
  return { ctx, resource, gateway }
}
async function enable(key) {
  const host = new Context()
  await host.plugin(plugins.get(key), key === 'claude' ? { key, label: 'Claude' } : {})
  return host
}
function row(key) { return listAgents().find(entry => entry.key === key) }
function assertAbsent(key) {
  assert.equal(row(key), undefined, 'disposed row must leave roster')
  assert.equal(getTarget(key), undefined, 'disposed world must not remain dispatchable')
  assert.equal(takeHostMount(key), undefined, 'disposed row must leave host mount')
}
function cleanup(key) {
  unregisterAgent(key)
  unregisterForeignTarget(key)
  registerHostMount({ key, labelPath: `/${key}` })()
}
test.after(() => {
  for (const key of keys) cleanup(key)
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  delete globalThis.lifecycleBoot
  rmSync(home, { recursive: true, force: true })
})
for (const key of keys) {
  test(`${key}: repeated off/on removes roster, target, mount and world resources`, async () => {
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        const spawned = world()
        globalThis.lifecycleBoot = () => Promise.resolve(spawned.ctx)
        const host = await enable(key)
        assert.equal(await host.get(`superd.world.${key}`), spawned.ctx)
        assert.equal(row(key)?.ready, true)
        assert.equal(getTarget(key)?.gateway, spawned.gateway)
        assert.ok(takeHostMount(key))
        await host.fiber.dispose()
        assertAbsent(key)
        assert.equal(spawned.resource.live, false, 'world resources must be released')
      }
    } finally { cleanup(key) }
  })
  test(`${key}: cancelled pending spawn cannot publish over its replacement`, async () => {
    const pending = deferred()
    const obsolete = world()
    let oldHost, newHost
    try {
      globalThis.lifecycleBoot = () => pending.promise
      oldHost = await enable(key)
      const oldWorld = oldHost.get(`superd.world.${key}`)
      const stopping = oldHost.fiber.dispose()
      await tick()
      assertAbsent(key)
      const replacement = world()
      globalThis.lifecycleBoot = () => Promise.resolve(replacement.ctx)
      newHost = await enable(key)
      await newHost.get(`superd.world.${key}`)
      pending.resolve(obsolete.ctx)
      assert.equal(await oldWorld, null)
      await stopping
      assert.equal(obsolete.resource.live, false, 'late world must be disposed')
      assert.equal(row(key)?.ready, true)
      assert.equal(row(key)?.failed, false)
      assert.equal(getTarget(key)?.gateway, replacement.gateway)
      assert.ok(takeHostMount(key), 'old teardown must preserve replacement mount')
      assert.equal(replacement.resource.live, true)
    } finally {
      pending.resolve(obsolete.ctx)
      await Promise.all([oldHost?.fiber.dispose(), newHost?.fiber.dispose()])
      cleanup(key)
    }
  })
}
test('world teardown is awaited by native plugin disposal', async () => {
  const release = deferred()
  const spawned = world(release.promise)
  let host
  try {
    globalThis.lifecycleBoot = () => Promise.resolve(spawned.ctx)
    host = await enable('codex')
    await host.get('superd.world.codex')
    let finished = false
    const stopping = host.fiber.dispose().then(() => { finished = true })
    await tick()
    assertAbsent('codex')
    assert.equal(finished, false, 'plugin must await world transport cleanup')
    release.resolve()
    await stopping
    assert.equal(spawned.resource.live, false)
  } finally { release.resolve(); await host?.fiber.dispose(); cleanup('codex') }
})
test('failed cancelled join cannot mark its replacement failed', async () => {
  const pending = deferred()
  let oldHost, newHost
  try {
    globalThis.lifecycleBoot = () => pending.promise
    oldHost = await enable('claude')
    const stopping = oldHost.fiber.dispose()
    await tick()
    assertAbsent('claude')
    const replacement = world()
    globalThis.lifecycleBoot = () => Promise.resolve(replacement.ctx)
    newHost = await enable('claude')
    await newHost.get('superd.world.claude')
    pending.reject(new Error('obsolete boot failed'))
    await stopping
    assert.equal(row('claude')?.failed, false)
    assert.equal(row('claude')?.ready, true)
    assert.equal(getTarget('claude')?.gateway, replacement.gateway)
  } finally {
    pending.resolve(world().ctx)
    await Promise.all([oldHost?.fiber.dispose(), newHost?.fiber.dispose()])
    cleanup('claude')
  }
})
test('independently disposed world stops routing and clears readiness', async () => {
  const spawned = world()
  let host
  try {
    globalThis.lifecycleBoot = () => Promise.resolve(spawned.ctx)
    host = await enable('codex')
    await host.get('superd.world.codex')
    await spawned.ctx.fiber.dispose()
    assert.equal(getTarget('codex'), undefined, 'a disposed sibling root cannot be addressed')
    assert.equal(takeHostMount('codex'), undefined)
    assert.equal(row('codex')?.ready, false, 'loaded owner must project world unavailability')
    await host.fiber.dispose()
    assertAbsent('codex')
  } finally { await host?.fiber.dispose(); cleanup('codex') }
})

const worldEntry = await import('../dist/world-entry.js')
const { worldFetchHandlerOf } = await import('../dist/world-host.js')
const { ownWorld } = await import('../dist/world-lifecycle.js')
async function mountBootWorld(spawned, options, label) {
  spawned.ctx.provide('connection', {
    createSharedFetchHandler() {
      return {
        requestBodyMode() { return 'buffered' },
        async fetch(request) {
          return new Response(request.method === 'HEAD' ? null : label, {
            headers: { 'x-world': label },
          })
        },
      }
    },
  })
  const config = options.extraPatches.flatMap(patch => patch.insert ?? [])
    .find(entry => entry.id === 'superd-world-mount').config
  await spawned.ctx.plugin(worldEntry, config)
  return spawned.ctx
}
async function assertReplacementFetch() {
  const handler = worldFetchHandlerOf('codex')
  assert.ok(handler, 'replacement must retain its GET/HEAD route handler')
  for (const method of ['GET', 'HEAD']) {
    const response = await handler.fetch(new Request('http://localhost/api/export', { method }))
    assert.equal(response.headers.get('x-world'), 'replacement')
    assert.equal(await response.text(), method === 'HEAD' ? '' : 'replacement')
  }
}
test('late obsolete world entry cannot replace or remove replacement GET/HEAD routes', async () => {
  const pending = deferred()
  const obsolete = world()
  let oldHost, newHost, oldOptions
  try {
    globalThis.lifecycleBoot = options => { oldOptions = options; return pending.promise }
    oldHost = await enable('codex')
    const stopping = oldHost.fiber.dispose()
    await tick()
    const replacement = world()
    globalThis.lifecycleBoot = options => mountBootWorld(replacement, options, 'replacement')
    newHost = await enable('codex')
    await newHost.get('superd.world.codex')
    await assertReplacementFetch()
    pending.resolve(await mountBootWorld(obsolete, oldOptions, 'obsolete'))
    await stopping
    await assertReplacementFetch()
  } finally {
    pending.resolve(obsolete.ctx)
    await Promise.all([oldHost?.fiber.dispose(), newHost?.fiber.dispose()])
    cleanup('codex')
  }
})
test('delayed connection publication from an old mount preserves replacement routes', async () => {
  const pending = deferred()
  let oldHost, newHost
  const obsolete = world()
  try {
    globalThis.lifecycleBoot = async options => {
      const config = options.extraPatches.flatMap(patch => patch.insert ?? [])
        .find(entry => entry.id === 'superd-world-mount').config
      await obsolete.ctx.plugin(worldEntry, config)
      return pending.promise
    }
    oldHost = await enable('codex')
    await tick()
    const stopping = oldHost.fiber.dispose()
    await tick()
    const replacement = world()
    globalThis.lifecycleBoot = options => mountBootWorld(replacement, options, 'replacement')
    newHost = await enable('codex')
    await newHost.get('superd.world.codex')
    obsolete.ctx.provide('connection', {
      createSharedFetchHandler: () => ({
        requestBodyMode: () => 'buffered',
        fetch: async () => new Response('obsolete'),
      }),
    })
    await tick()
    await assertReplacementFetch()
    pending.resolve(obsolete.ctx)
    await stopping
    await assertReplacementFetch()
  } finally {
    pending.resolve(obsolete.ctx)
    await Promise.all([oldHost?.fiber.dispose(), newHost?.fiber.dispose()])
    cleanup('codex')
  }
})
test('cancelled late world disposal rejection remains observable to its owner', async () => {
  const pending = deferred()
  let dispose
  const owner = { effect(callback) { dispose = callback() } }
  const fault = new Error('transport teardown failed')
  const started = ownWorld(owner, { key: 'codex', label: 'Codex' }, () => pending.promise, () => {})
  const worldFailure = assert.rejects(started, fault)
  const ownerFailure = assert.rejects(dispose(), fault)
  pending.resolve({ get() {}, effect() {}, fiber: { dispose: async () => { throw fault } } })
  await Promise.all([worldFailure, ownerFailure])
  assertAbsent('codex')
})
