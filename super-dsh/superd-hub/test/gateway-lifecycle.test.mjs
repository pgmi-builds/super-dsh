/** Connection reloads must leave the native listener's route seats available. */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as Gateway from '../dist/gateway.js'
import { PAIRING_AUTH_PATH } from '../dist/pairing-auth.js'
import { PTY_EXEC_PATH } from '../dist/exec-pty-rpc.js'

const require = createRequire(new URL('../../../better-dsh/package.json', import.meta.url))
const load = spec => import(pathToFileURL(require.resolve(spec)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { WebServer } = await load('@deepseek-ai/dsh-host-webserver')
const NativeConnection = await load('@deepseek-ai/dsh-client-connection')

async function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'superd-gateway-lifecycle-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  let record
  ctx.provide('credentials', {
    async readRecord() { return record },
    async modifyRecord(_key, update) {
      const next = await update(record)
      if (next !== undefined) record = next
      return record
    },
  })
  t.after(async () => {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  const port = ctx.webServer.port
  const origin = `http://127.0.0.1:${port}`
  const connect = async () => {
    const fiber = ctx.plugin(NativeConnection)
    await fiber.await()
    return fiber
  }
  const pairing = async () => {
    const tokenUrl = new URL(ctx.connection.authenticatedUrl(origin))
    const response = await fetch(origin + PAIRING_AUTH_PATH + tokenUrl.search, { redirect: 'manual' })
    assert.equal(response.status, 303)
    assert.ok(response.headers.getSetCookie().some(cookie => cookie.startsWith('dsh-auth-')))
  }
  return { ctx, port, origin, connect, pairing }
}

const idle = () => new Promise(resolve => setImmediate(resolve))

// Break caught: parent-owned route disposers outlive a Connection injection.
test('native Connection replacement preserves pairing and hub routes on the same native listener', { timeout: 5000 }, async t => {
  const b = await bench(t)
  let connection = await b.connect()
  const hub = b.ctx.plugin(Gateway)
  await hub.await()
  await idle()
  await b.pairing()
  for (let round = 0; round < 2; round++) {
    await connection.dispose()
    // Connection-owned routes must vacate their seats before the next owner mounts.
    const releasePrefix = b.ctx.webServer.register({ kind: 'prefix', path: '/hub', handler() {} })
    releasePrefix()
    const releaseUpgrade = b.ctx.webServer.registerUpgrade({ path: '/hub/api/remote.mux', handler() {} })
    releaseUpgrade()
    const releasePty = b.ctx.webServer.registerUpgrade({ path: PTY_EXEC_PATH, handler() {} })
    releasePty()
    connection = await b.connect()
    await idle()
    await b.pairing()
    assert.equal(b.ctx.webServer.port, b.port)
    const response = await fetch(b.origin + '/hub/api/session.list?agent=missing', { method: 'POST' })
    assert.equal(response.status, 401, 'hub route uses the new Connection owner')
  }
})

// Break caught: async PTY setup completes after its injection begins disposal.
test('disposing Connection during asynchronous PTY registration removes the late upgrade route', { timeout: 5000 }, async t => {
  const b = await bench(t)
  const connection = await b.connect()
  const registered = Promise.withResolvers()
  const server = b.ctx.webServer
  const registerUpgrade = server.registerUpgrade.bind(server)
  let disposal
  const observation = mock.method(server, 'registerUpgrade', route => {
    const off = registerUpgrade(route)
    if (route.path === PTY_EXEC_PATH) {
      disposal = connection.dispose()
      registered.resolve()
    }
    return off
  })
  t.after(() => observation.mock.restore())
  const hub = b.ctx.plugin(Gateway)
  await hub.await()
  await registered.promise
  await disposal
  await idle()
  observation.mock.restore()
  const releasePty = b.ctx.webServer.registerUpgrade({ path: PTY_EXEC_PATH, handler() {} })
  releasePty()
})

test('Hub body provides remote transport and receives exec without model tool rows', { timeout: 5000 }, async t => {
  const b = await bench(t)
  await b.connect()
  const hub = b.ctx.plugin(Gateway)
  await hub.await()
  await idle()
  assert.equal(b.ctx.get('superdRemoteTransport')?.protocol, 1)
  assert.deepEqual(b.ctx.get('superdRemoteTransport').listTargets(), [])
  assert.equal(b.ctx.get('tools'), undefined)
  const url = new URL(b.ctx.connection.authenticatedUrl(b.origin))
  const response = await fetch(b.origin + PAIRING_AUTH_PATH + url.search, { redirect: 'manual' })
  const cookie = response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ')
  const exec = await fetch(b.origin + '/api/superd/exec', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'printf peer-local' }) })
  assert.equal(exec.status, 200)
  assert.equal((await exec.json()).stdout, 'peer-local')
  const { createRemoteFileEndpoint } = await import('../dist/remote-file-rpc.js')
  const { writeFile, readFile } = await import('node:fs/promises')
  const scratch = mkdtempSync(join(tmpdir(), 'gateway-file-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const source = join(scratch, 'source'), destination = join(scratch, 'destination')
  await writeFile(source, Buffer.from([0, 255, 128, 10]))
  const endpoint = createRemoteFileEndpoint(() => ({ origin: b.origin, cookie }))
  const signal = new AbortController().signal
  await endpoint.importTree(destination, await endpoint.exportTree(source, signal), { mkdir: true, signal })
  assert.deepEqual(await readFile(destination), Buffer.from([0, 255, 128, 10]))
  await hub.dispose()
  assert.equal(b.ctx.get('superdRemoteTransport'), undefined)
})

test('foreign WorldWebServer does not acquire a native provider or receiving exec route', async t => {
  const { WorldWebServer } = await import('../dist/world-web-server.js')
  const home = mkdtempSync(join(tmpdir(), 'superd-world-remote-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const routes = []
  ctx.provide('webServer', new WorldWebServer('/foreign'))
  ctx.provide('connection', { fetch: { register(route) { routes.push(route.path); return () => {} } } })
  try {
    const hub = ctx.plugin(Gateway)
    await hub.await()
    await idle()
    assert.equal(ctx.get('superdRemoteTransport'), undefined)
    assert.ok(!routes.includes('/api/superd/exec'))
  } finally {
    await ctx.fiber.dispose()
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    rmSync(home, { recursive: true, force: true })
  }
})
