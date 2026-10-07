// Virtual per-world webServer (AW-B DL3; silent since T-C, index-face-less
// since T-D): any route a world plugin declares is accepted and SWALLOWED —
// no /<label>/… route lands on ctx0's real webServer (the /hub family is the
// sole entry) and, with the world webui rows disabled (T-D), nothing ever
// renders a world page: the index face (renderIndex/taps/shim) is retired.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as worldWebServerModule from '../dist/world-web-server.js'
import { WorldWebServer } from '../dist/world-web-server.js'

test('register swallows any declared prefix (T-C: pages have no road to ctx0)', () => {
  const world = new WorldWebServer('/omp')
  const handler = (r) => r.url
  const dispose = world.register({ kind: 'prefix', path: '/fuck-you-name-i-like', handler })
  assert.equal(typeof dispose, 'function', 'the world plugin gets a disposer (tree boots unchanged)')
  dispose()
  // Two worlds may both own `/api`-style names: nothing is stored, nothing collides.
  const second = new WorldWebServer('/codex')
  const secondDispose = second.register({ kind: 'prefix', path: '/fuck-you-name-i-like', handler })
  secondDispose()
})

test('registerUpgrade and registerFallback swallow too (the fallback seat was always native-only)', () => {
  const world = new WorldWebServer('/omp')
  const upgradeDispose = world.registerUpgrade({ path: '/rpc/stream', handler: () => {} })
  const fallbackDispose = world.registerFallback(() => {})
  assert.equal(typeof upgradeDispose, 'function')
  assert.equal(typeof fallbackDispose, 'function')
  upgradeDispose()
  fallbackDispose()
})

test('port/host keep the neutral no-socket defaults (the read-through retired with the mount)', () => {
  const world = new WorldWebServer('/omp')
  assert.equal(world.port, 0)
  assert.equal(world.host, '127.0.0.1')
})

test('labelPath must be a rooted segment', () => {
  assert.throws(() => new WorldWebServer('omp'), /labelPath must start with/)
})

test('T-D: the world index face is retired (no renderIndex, no taps, no shim baking)', () => {
  assert.equal(WorldWebServer.prototype.renderIndex, undefined, 'no world page is rendered anywhere')
  assert.equal(WorldWebServer.prototype.tapIndex, undefined, 'no world-local index taps')
  assert.equal(WorldWebServer.prototype.applyIndexTaps, undefined)
  assert.equal(WorldWebServer.prototype.collectIndexInjections, undefined)
  assert.equal(WorldWebServer.prototype.dispose, undefined, 'nothing world-local to release')
  // The mount shim source is gone from the package surface (git history keeps it).
  assert.equal(worldWebServerModule.renderClientShim, undefined)
})
