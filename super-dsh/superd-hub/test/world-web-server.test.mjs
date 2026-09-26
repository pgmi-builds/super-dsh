// Virtual per-world webServer (AW-B DL3; silent since path-separation T-C):
// any route a world plugin declares is accepted and SWALLOWED — no
// /<label>/… route lands on ctx0's real webServer (the /hub family is the
// sole entry), while the world-local index face (taps, injections, mount
// shim) keeps rendering inside the world tree.
import test from 'node:test'
import assert from 'node:assert/strict'
import { WorldWebServer } from '../dist/world-web-server.js'

function req(url) { return { url } }

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

test('index taps and injections stay world-local and render through the mount', () => {
  const rows = []
  const world = new WorldWebServer('/omp', { onIndexInject: (table) => table.push({ kind: 'script', placement: 'head', text: 'x' }) })
  world.tapIndex((html) => html.replace('</head>', '<meta name="tapped"></head>'))
  world.registerFallback(() => { })
  const out = world.renderIndex('<head></head>')
  assert.match(out, /<meta name="tapped">/)
  assert.match(out, /<script>x<\/script>/)
})

test('dispose releases the world-local index state (taps cleared)', () => {
  const world = new WorldWebServer('/omp')
  world.tapIndex((html) => html.replace('</head>', '<meta name="tapped"></head>'))
  world.dispose()
  assert.equal(world.renderIndex('<head></head>').includes('<meta name="tapped">'), false, 'taps do not survive dispose')
  world.dispose() // idempotent
})

test('labelPath must be a rooted segment', () => {
  assert.throws(() => new WorldWebServer('omp'), /labelPath must start with/)
})

test('renderIndex emits a mount-ready page (base pinned, root-absolute strings re-rooted)', () => {
  const world = new WorldWebServer('/omp', { onIndexInject: (table) => table.push({ kind: 'script', placement: 'head', text: 'x' }) })
  const out = world.renderIndex('<head><base href="/"></head><script>globalThis.__DSH_BOOT__={"batches":[{"url":"/plugins/??a/client.js"}]}</script>')
  assert.match(out, /<base href="\/omp\/">/)
  assert.match(out, /"url":"\/omp\/plugins\/\?\?a\/client\.js"/)
  assert.match(out, /<script>x<\/script>/)
})

test('renderIndex runs index-inject rows before the client mount shim', () => {
  const world = new WorldWebServer('/omp', { onIndexInject: (table) => table.push({ kind: 'script', placement: 'head', text: 'INJECTED_SENTINEL' }) })
  const out = world.renderIndex('<head></head>')
  // Injection rows own the transport global first (the page-trust component
  // guards on absence); the shim MERGES into the existing object afterwards
  // (`globalThis.__DSH_TRANSPORT__ = globalThis.__DSH_TRANSPORT__ || {}`) —
  // shim-first would create the object and silently eat the ownsHost verdict.
  assert.ok(out.indexOf('INJECTED_SENTINEL') < out.indexOf('__DSH_TRANSPORT__'), 'injections precede the shim')
  assert.match(out, /__DSH_TRANSPORT__/)
  assert.match(out, /__DSH_FILE_UPLOAD__/)
  assert.ok(out.indexOf('__DSH_TRANSPORT__') < out.indexOf('</head>'), 'shim runs before the app entry')
})
