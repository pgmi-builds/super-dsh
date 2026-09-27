// Fusion transport (native-ui-fusion Task 3): the ctx0 page-level head script —
// the __SUPERD_UI_STATE__ atom plus five call-time patches (fetch / WS+ES+XHR /
// file-upload hook / download anchors / storage NS) that retarget same-origin
// /api requests to the hub's /hub family while a FOREIGN agent is active and
// pass everything through untouched in native mode.
//
// Script behavior runs in a node:vm sandbox exactly as a page would (the
// client-shim.test recipe). The injection face is tested against the same
// emission path web-trust uses (webserver/index-inject listeners), including
// the hard §3.4 ordering: the fusion row pushes AFTER the web-trust row.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { renderFusionTransport, deriveFusionFlag, Config, apply as applyFusion } from '../dist/fusion-transport.js'
import { apply as applyWebTrust } from '../dist/web-trust.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LINE = join(HERE, '..', '..') // super-dsh composite root

// ---- sandbox: a page-shaped global executed through node:vm ----

function page() {
  const calls = { fetch: [], ws: [], events: [], xhr: [], clicks: [] }
  const backing = new Map()
  class StorageLike {
    getItem(k) { return backing.has(String(k)) ? backing.get(String(k)) : null }
    setItem(k, v) { backing.set(String(k), String(v)) }
    removeItem(k) { backing.delete(String(k)) }
    clear() { backing.clear() }
    key(i) { return [...backing.keys()][i] ?? null }
    get length() { return backing.size }
  }
  class HTMLAnchorElement {
    constructor(href) { this.attrs = new Map(href === undefined ? [] : [['href', href]]) }
    hasAttribute(name) { return this.attrs.has(name) }
    getAttribute(name) { return this.attrs.get(name) ?? null }
    setAttribute(name, value) { this.attrs.set(name, String(value)) }
    click(...args) { calls.clicks.push({ href: this.getAttribute('href'), args }) }
  }
  const sandbox = {
    // WHATWG URL is a host global, not a vm-context builtin — a page has one.
    URL,
    location: { origin: 'http://host:4999', hostname: 'host' },
    fetch: async (input, init) => { calls.fetch.push({ input, init }); return { ok: true } },
    WebSocket: class {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
      constructor(url, protocols) { calls.ws.push({ url, protocols }) }
    },
    EventSource: class {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2
      constructor(url, options) { calls.events.push({ url, options }) }
    },
    XMLHttpRequest: class { open(method, url, ...rest) { calls.xhr.push({ method, url, rest }) } },
    localStorage: new StorageLike(),
    Storage: StorageLike,
    HTMLAnchorElement,
    calls, backing, StorageLike, HTMLAnchorElement,
  }
  return { sandbox, install: () => vm.runInContext(renderFusionTransport(), vm.createContext(sandbox), { filename: 'fusion-transport.head.js' }) }
}

test('the state atom: initial native, subscribe/unsubscribe, change-only notify', () => {
  const { sandbox, install } = page()
  install()
  const state = sandbox.__SUPERD_UI_STATE__
  assert.equal(state.activeAgent, 'native', 'initial value is native')
  assert.equal(typeof state.setAgent, 'function')
  assert.equal(typeof state.subscribe, 'function')
  const seen = []
  const off = state.subscribe((label) => seen.push(label))
  state.setAgent('codex')
  assert.equal(state.activeAgent, 'codex')
  state.setAgent('codex', 'unchanged set is silent')
  state.setAgent('omp')
  off()
  state.setAgent('native')
  assert.deepEqual(seen, ['codex', 'omp'], 'subscribers see every change until unsubscribe')
  assert.equal(state.activeAgent, 'native')
})

test('the state atom ignores invalid labels and isolates broken subscribers', () => {
  const { sandbox, install } = page()
  install()
  const state = sandbox.__SUPERD_UI_STATE__
  const seen = []
  state.subscribe(() => { throw new Error('broken subscriber') })
  state.subscribe((label) => seen.push(label))
  state.setAgent('') // invalid: ignored
  state.setAgent(42) // invalid: ignored
  assert.equal(state.activeAgent, 'native', 'invalid labels never move the atom')
  state.setAgent('codex') // the healthy subscriber still hears it
  assert.deepEqual(seen, ['codex'])
})

test('the atom is not persisted: installing writes nothing into storage', () => {
  const { sandbox, install } = page()
  install()
  sandbox.__SUPERD_UI_STATE__.setAgent('codex')
  assert.equal(sandbox.backing.size, 0, 'no localStorage key is written by the script or the atom')
})

// ---- native mode: zero behavioral interference ----

test('native: every request face passes through untouched', async () => {
  const { sandbox, install } = page()
  install()
  await sandbox.fetch('/api/session.list?a=1#h')
  assert.equal(sandbox.calls.fetch[0].input, '/api/session.list?a=1#h')
  const url = new URL('http://host:4999/api/session.export?x=1')
  await sandbox.fetch(url)
  assert.equal(sandbox.calls.fetch[1].input, url, 'even the URL object identity survives')
  await sandbox.fetch('http://host:4999/api/agent-runtime')
  assert.equal(sandbox.calls.fetch[2].input, 'http://host:4999/api/agent-runtime')
  new sandbox.WebSocket('ws://host:4999/api/remote.mux')
  assert.equal(sandbox.calls.ws[0].url, 'ws://host:4999/api/remote.mux')
  new sandbox.EventSource('/api/events')
  assert.equal(sandbox.calls.events[0].url, '/api/events')
  const xhr = new sandbox.XMLHttpRequest()
  xhr.open('POST', '/api/session/uploadFileBinary?sessionId=s1')
  assert.equal(sandbox.calls.xhr[0].url, '/api/session/uploadFileBinary?sessionId=s1')
  const anchor = new sandbox.HTMLAnchorElement('http://host:4999/api/session.export?x=1')
  anchor.setAttribute('download', 'log.zip')
  anchor.click()
  assert.equal(anchor.getAttribute('href'), 'http://host:4999/api/session.export?x=1')
  sandbox.localStorage.setItem('k', 'v')
  assert.equal(sandbox.backing.get('k'), 'v', 'native storage keys stay bare')
  assert.equal(sandbox.localStorage.getItem('k'), 'v')
  assert.equal(sandbox.localStorage.getItem('dsh.sessions.current'), null)
})

test('native: the intercepted constructors keep their statics', () => {
  const { sandbox, install } = page()
  install()
  assert.equal(sandbox.WebSocket.OPEN, 1)
  assert.equal(sandbox.EventSource.CLOSED, 2)
})

// ---- foreign mode: the single rewrite rule (/api → /hub/api + ?agent=) ----

test('foreign fetch: root-absolute /api strings rewrite, query and hash preserved', async () => {
  const { sandbox, install } = page()
  install()
  sandbox.__SUPERD_UI_STATE__.setAgent('codex')
  await sandbox.fetch('/api')
  assert.equal(sandbox.calls.fetch[0].input, '/hub/api?agent=codex')
  await sandbox.fetch('/api/session.list?a=1#h')
  assert.equal(sandbox.calls.fetch[1].input, '/hub/api/session.list?a=1&agent=codex#h')
  await sandbox.fetch('/api/session.list')
  assert.equal(sandbox.calls.fetch[2].input, '/hub/api/session.list?agent=codex', 'empty search gains a fresh ?')
  await sandbox.fetch('http://host:4999/api/x?y=1')
  assert.equal(sandbox.calls.fetch[3].input, 'http://host:4999/hub/api/x?y=1&agent=codex', 'same-origin absolute')
})

test('foreign fetch: URL objects rewrite without being mutated', async () => {
  const { sandbox, install } = page()
  install()
  sandbox.__SUPERD_UI_STATE__.setAgent('omp')
  const url = new URL('http://host:4999/api/session.export?sessionId=s1&includeDescendants=true#part')
  await sandbox.fetch(url)
  assert.equal(sandbox.calls.fetch[0].input, 'http://host:4999/hub/api/session.export?sessionId=s1&includeDescendants=true&agent=omp#part')
  assert.equal(url.pathname, '/api/session.export', 'the handed-in object stays virgin')
})

test('foreign fetch: cross-origin, non-/api, relative and protocol-relative pass through', async () => {
  const { sandbox, install } = page()
  install()
  sandbox.__SUPERD_UI_STATE__.setAgent('codex')
  await sandbox.fetch('http://other:1234/api/x')
  await sandbox.fetch('/plugins/thing')
  await sandbox.fetch('./assets/a.js')
  await sandbox.fetch('//cdn.example/api/x')
  await sandbox.fetch('/hub/api/already?agent=codex')
  assert.deepEqual(sandbox.calls.fetch.map((c) => String(c.input)), [
    'http://other:1234/api/x', '/plugins/thing', './assets/a.js', '//cdn.example/api/x', '/hub/api/already?agent=codex',
  ])
})

test('foreign fetch: the /api/agent-runtime control plane is NEVER rewritten', async () => {
  const { sandbox, install } = page()
  install()
  sandbox.__SUPERD_UI_STATE__.setAgent('codex')
  await sandbox.fetch('/api/agent-runtime')
  await sandbox.fetch('/api/agent-runtime/list')
  await sandbox.fetch(new URL('http://host:4999/api/agent-runtime'))
  assert.deepEqual(sandbox.calls.fetch.map((c) => String(c.input)), [
    '/api/agent-runtime', '/api/agent-runtime/list', 'http://host:4999/api/agent-runtime',
  ], 'the roster control plane always hits ctx0')
})

test('foreign: WebSocket, EventSource and XMLHttpRequest follow the same rule', () => {
  const { sandbox, install } = page()
  install()
  sandbox.__SUPERD_UI_STATE__.setAgent('codex')
  new sandbox.WebSocket('ws://host:4999/api/remote.mux')
  assert.equal(sandbox.calls.ws[0].url, 'ws://host:4999/hub/api/remote.mux?agent=codex', 'the mux WS lands on the hub family')
  new sandbox.WebSocket('/api/remote.mux')
  assert.equal(sandbox.calls.ws[1].url, '/hub/api/remote.mux?agent=codex')
  new sandbox.EventSource('/api/events?since=1')
  assert.equal(sandbox.calls.events[0].url, '/hub/api/events?since=1&agent=codex')
  new sandbox.EventSource('http://other:1234/api/events')
  assert.equal(sandbox.calls.events[1].url, 'http://other:1234/api/events', 'foreign authority untouched')
  const xhr = new sandbox.XMLHttpRequest()
  xhr.open('POST', '/api/session/uploadFileBinary?sessionId=s1')
  assert.equal(sandbox.calls.xhr[0].url, '/hub/api/session/uploadFileBinary?sessionId=s1&agent=codex')
  xhr.open('GET', '/api/agent-runtime')
  assert.equal(sandbox.calls.xhr[1].url, '/api/agent-runtime', 'control plane exempt on XHR too')
})

// ---- the demux key is UNIQUE: a pre-existing agent param is REPLACED ----

test('foreign fetch: a pre-existing agent key is replaced, never appended (single demux key)', async () => {
  const { sandbox, install } = page()
  install()
  const state = sandbox.__SUPERD_UI_STATE__
  state.setAgent('codex')
  // The page believes codex while the URL still carries agent=claude: an
  // appended duplicate would leave TWO agent params and the server demuxes
  // to the FIRST value (searchParams.get) — the wrong world with no trace.
  await sandbox.fetch('/api/x?agent=claude')
  const rewritten = String(sandbox.calls.fetch[0].input)
  assert.equal(rewritten, '/hub/api/x?agent=codex', 'exactly the active label survives')
  assert.equal(new URL(rewritten, 'http://host:4999').searchParams.get('agent'), 'codex', 'the server-side demux reads codex')
  // Doubled spellings collapse to the one fresh key too.
  await sandbox.fetch('/api/x?agent=claude&agent=omp')
  assert.equal(sandbox.calls.fetch[1].input, '/hub/api/x?agent=codex')
  // Bare-flag spelling (agent with no =) is still an agent key.
  await sandbox.fetch('/api/x?agent')
  assert.equal(sandbox.calls.fetch[2].input, '/hub/api/x?agent=codex')
  // A percent-encoded key spelling demuxes as agent=x server-side: stripped too.
  await sandbox.fetch('/api/x?%61gent=claude')
  assert.equal(new URL(String(sandbox.calls.fetch[3].input), 'http://host:4999').searchParams.get('agent'), 'codex')
})

test('foreign rewrite: non-agent query bytes keep their places, the demux key lands last', async () => {
  const { sandbox, install } = page()
  install()
  sandbox.__SUPERD_UI_STATE__.setAgent('omp')
  await sandbox.fetch('/api/x?a=1&agent=claude&b=2#h')
  assert.equal(sandbox.calls.fetch[0].input, '/hub/api/x?a=1&b=2&agent=omp#h')
  await sandbox.fetch('http://host:4999/api/x?agent=claude&y=1')
  assert.equal(sandbox.calls.fetch[1].input, 'http://host:4999/hub/api/x?y=1&agent=omp')
  // The companion deferred minor: a bare-'?' URL collapses into ONE fresh
  // question mark — the old '??' doubled form swallowed the demux key.
  await sandbox.fetch('/api/session.export?')
  assert.equal(sandbox.calls.fetch[2].input, '/hub/api/session.export?agent=omp')
  await sandbox.fetch('/api/session.export?#top')
  assert.equal(sandbox.calls.fetch[3].input, '/hub/api/session.export?agent=omp#top')
})

test('foreign: the demux-key surgery holds on the socket and XHR faces too', () => {
  const { sandbox, install } = page()
  install()
  sandbox.__SUPERD_UI_STATE__.setAgent('codex')
  new sandbox.WebSocket('/api/remote.mux?agent=claude')
  assert.equal(sandbox.calls.ws[0].url, '/hub/api/remote.mux?agent=codex')
  const xhr = new sandbox.XMLHttpRequest()
  xhr.open('GET', '/api/session/export?token=t&agent=claude')
  assert.equal(sandbox.calls.xhr[0].url, '/hub/api/session/export?token=t&agent=codex')
})

test('foreign: only download anchors with same-origin /api hrefs rewrite', () => {
  const { sandbox, install } = page()
  install()
  sandbox.__SUPERD_UI_STATE__.setAgent('codex')
  // The rewrite is transient (saved around the native click, restored after):
  // the BROWSER sees the rewritten href — asserted via the native click —
  // while the anchor keeps owning its original attribute afterwards.
  const download = new sandbox.HTMLAnchorElement('/api/session.export?x=1')
  download.setAttribute('download', 's.zip')
  download.click()
  assert.equal(sandbox.calls.clicks.at(-1).href, '/hub/api/session.export?x=1&agent=codex')
  assert.equal(download.getAttribute('href'), '/api/session.export?x=1', 'restored: the rewrite does not outlive the click')
  const absolute = new sandbox.HTMLAnchorElement('http://host:4999/api/session.export?x=1')
  absolute.setAttribute('download', 's.zip')
  absolute.click()
  assert.equal(sandbox.calls.clicks.at(-1).href, 'http://host:4999/hub/api/session.export?x=1&agent=codex')
  assert.equal(absolute.getAttribute('href'), 'http://host:4999/api/session.export?x=1', 'restored')
  const foreign = new sandbox.HTMLAnchorElement('http://other:1234/api/x')
  foreign.setAttribute('download', 's.zip')
  foreign.click()
  assert.equal(sandbox.calls.clicks.at(-1).href, 'http://other:1234/api/x')
  assert.equal(foreign.getAttribute('href'), 'http://other:1234/api/x')
  const selector = new sandbox.HTMLAnchorElement('/omp/') // navigation anchor: never touched
  selector.click()
  assert.equal(sandbox.calls.clicks.at(-1).href, '/omp/')
  assert.equal(selector.getAttribute('href'), '/omp/')
  const nav = new sandbox.HTMLAnchorElement('/api/session.export') // /api WITHOUT download: untouched
  nav.click()
  assert.equal(sandbox.calls.clicks.at(-1).href, '/api/session.export')
  assert.equal(nav.getAttribute('href'), '/api/session.export')
})

test('switch agents, click the SAME download anchor twice: each click rides the then-active agent', () => {
  const { sandbox, install } = page()
  install()
  const state = sandbox.__SUPERD_UI_STATE__
  const anchor = new sandbox.HTMLAnchorElement('/api/session.export?x=1')
  anchor.setAttribute('download', 's.zip')
  state.setAgent('codex')
  anchor.click()
  assert.deepEqual(sandbox.calls.clicks[0], { href: '/hub/api/session.export?x=1&agent=codex', args: [] },
    'first click lands on the then-active agent')
  assert.equal(anchor.getAttribute('href'), '/api/session.export?x=1', 'the rewrite does not outlive the click')
  state.setAgent('omp')
  anchor.click()
  assert.deepEqual(sandbox.calls.clicks[1], { href: '/hub/api/session.export?x=1&agent=omp', args: [] },
    'the SAME anchor re-targets after the switch (a persisted /hub/api href would skip the rewrite: isApiPath no longer matches)')
  state.setAgent('native')
  anchor.click()
  assert.deepEqual(sandbox.calls.clicks[2], { href: '/api/session.export?x=1', args: [] },
    'back to native the anchor behaves byte-identical again')
  assert.equal(anchor.getAttribute('href'), '/api/session.export?x=1', 'the original href is what the page keeps owning')
})

test('foreign: the file-upload hook rides the rewriting fetch', async () => {
  const { sandbox, install } = page()
  install()
  sandbox.__SUPERD_UI_STATE__.setAgent('codex')
  assert.equal(typeof sandbox.__DSH_FILE_UPLOAD__?.fetch, 'function', 'the hook is present before app boot')
  await sandbox.__DSH_FILE_UPLOAD__.fetch('/api/session/uploadFileBinary')
  assert.equal(sandbox.calls.fetch[0].input, '/hub/api/session/uploadFileBinary?agent=codex')
  assert.equal(sandbox.__DSH_FILE_UPLOAD__.fetch, sandbox.fetch, 'it is the same installed shim fetch')
})

// ---- call-time semantics: the atom is read at request time ----

test('setAgent retargets the SAME request expression to the new prefix', async () => {
  const { sandbox, install } = page()
  install()
  const state = sandbox.__SUPERD_UI_STATE__
  const send = () => sandbox.fetch('/api/session.list')
  state.setAgent('codex')
  await send()
  state.setAgent('omp')
  await send()
  state.setAgent('native')
  await send()
  assert.deepEqual(sandbox.calls.fetch.map((c) => String(c.input)), [
    '/hub/api/session.list?agent=codex',
    '/hub/api/session.list?agent=omp',
    '/api/session.list',
  ])
  const url = new URL('http://host:4999/api/x') // one object, two lives
  state.setAgent('codex')
  await sandbox.fetch(url)
  state.setAgent('omp')
  await sandbox.fetch(url)
  assert.equal(sandbox.calls.fetch[3].input, 'http://host:4999/hub/api/x?agent=codex')
  assert.equal(sandbox.calls.fetch[4].input, 'http://host:4999/hub/api/x?agent=omp')
})

test('NS switch: the same storage key reads its own value per namespace', () => {
  const { sandbox, install } = page()
  install()
  const state = sandbox.__SUPERD_UI_STATE__
  const key = 'dsh.sessions.current'
  state.setAgent('codex')
  sandbox.localStorage.setItem(key, 'codex-session')
  assert.equal(sandbox.backing.get('codex:dsh.sessions.current'), 'codex-session', 'physical key is prefixed')
  state.setAgent('omp')
  assert.equal(sandbox.localStorage.getItem(key), null, 'the omp namespace does not see the codex value')
  sandbox.localStorage.setItem(key, 'omp-session')
  assert.equal(sandbox.backing.get('omp:dsh.sessions.current'), 'omp-session')
  state.setAgent('codex')
  assert.equal(sandbox.localStorage.getItem(key), 'codex-session', 'switching back reads the codex tree')
  sandbox.localStorage.removeItem(key)
  assert.equal(sandbox.backing.has('codex:dsh.sessions.current'), false, 'remove deletes only the active NS key')
  assert.equal(sandbox.backing.get('omp:dsh.sessions.current'), 'omp-session')
  state.setAgent('native')
  assert.equal(sandbox.localStorage.getItem(key), null, 'native reads the bare (empty) tree')
  sandbox.localStorage.setItem(key, 'native-session')
  assert.equal(sandbox.backing.get(key), 'native-session', 'native writes bare keys')
})

// ---- idempotent install + best-effort contract ----

test('double install is harmless: no double wrapping, state and subscribers preserved', async () => {
  const { sandbox, install } = page()
  install()
  const state = sandbox.__SUPERD_UI_STATE__
  state.setAgent('codex')
  const wrappedFetch = sandbox.fetch
  const wrappedOpen = sandbox.XMLHttpRequest.prototype.open
  const wrappedClick = sandbox.HTMLAnchorElement.prototype.click
  const seen = []
  state.subscribe((label) => seen.push(label))
  install() // second execution against the same global
  assert.equal(sandbox.fetch, wrappedFetch, 'fetch not re-wrapped')
  assert.equal(sandbox.XMLHttpRequest.prototype.open, wrappedOpen)
  assert.equal(sandbox.HTMLAnchorElement.prototype.click, wrappedClick)
  assert.equal(sandbox.__SUPERD_UI_STATE__, state, 'the live atom is kept, not reset')
  assert.equal(state.activeAgent, 'codex', 'live state survives')
  await sandbox.fetch('/api/x')
  assert.equal(sandbox.calls.fetch[0].input, '/hub/api/x?agent=codex', 'rewritten exactly once')
  sandbox.localStorage.setItem('k', 'v')
  assert.equal(sandbox.backing.get('codex:k'), 'v')
  assert.equal(sandbox.backing.has('codex:codex:k'), false, 'no double prefix')
  state.setAgent('omp')
  assert.deepEqual(seen, ['omp'], 'no duplicated subscriber')
  new sandbox.WebSocket('/api/remote.mux')
  assert.equal(sandbox.calls.ws[0].url, '/hub/api/remote.mux?agent=omp', 'single rewrite through one Proxy layer')
})

test('the script installs cleanly on a bare global (nothing to patch)', () => {
  const sandbox = {}
  vm.runInContext(renderFusionTransport(), vm.createContext(sandbox), { filename: 'fusion-transport.head.js' })
  assert.equal(sandbox.__SUPERD_UI_STATE__.activeAgent, 'native', 'the atom always installs')
})

test('patched APIs used in odd ways never throw (best-effort)', async () => {
  const { sandbox, install } = page()
  install()
  sandbox.__SUPERD_UI_STATE__.setAgent('codex')
  await sandbox.fetch(undefined)
  await sandbox.fetch(null)
  await sandbox.fetch(123)
  await sandbox.fetch({})
  new sandbox.WebSocket(undefined)
  new sandbox.EventSource(123)
  const xhr = new sandbox.XMLHttpRequest()
  xhr.open('GET', undefined)
  xhr.open('GET', {})
  const odd = new sandbox.HTMLAnchorElement(123)
  odd.setAttribute('download', 'x')
  odd.click()
  sandbox.localStorage.getItem(123)
  sandbox.localStorage.setItem(undefined, 'v')
  assert.equal(sandbox.calls.fetch.length, 4, 'every odd call reached the native fetch')
})

// ---- the generated script itself: quoting discipline ----

test('the generated script carries no double quotes (single-quote discipline)', () => {
  const text = renderFusionTransport()
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 0)
  // Historical constraint (kept as discipline): the world-page mount pass used
  // to rewrite every DOUBLE-quoted root-absolute string in served HTML — T-D
  // retired that pass with the world pages, but the single-quote rule stays so
  // any future HTML-mutating pass can never silently rewrite this script.
  assert.ok(!text.includes('"'), 'the script keeps the single-quote discipline (no HTML pass may rewrite it)')
  assert.ok(!text.includes('</script'), 'an inline script row must never close its own element')
})

// T-D: the "rewrite survives the HTML pass" composition regression retired
// WITH the mount HTML pass itself — no world page is served, so no pass ever
// mutates the fusion script (git history keeps the test).

// ---- the injection face: row emitted after web-trust, flag-gated ----

/** The emission harness: inject/ordered-listener semantics of a cordis ctx. */
function harness() {
  const injectCbs = []
  const listeners = []
  return {
    inject(_deps, cb) { injectCbs.push(cb) },
    on(_event, fn) { listeners.push(fn) },
    materialize() { for (const cb of [...injectCbs]) cb() },
    emit(table) { for (const fn of [...listeners]) fn(table) },
  }
}

test('the fusion rows push AFTER the web-trust row (spec §3.4, hard)', () => {
  const ctx = harness()
  // Composite-patch order (super-dsh/cordis.patch.yml): hub, web-trust, fusion.
  applyWebTrust(ctx, { trustedPageAuthorities: ['test.pc.internal.test'] })
  applyFusion(ctx, { enabled: true })
  ctx.materialize()
  const table = []
  ctx.emit(table)
  // Task 4: the fusion listener pushes TWO rows — the transport script plus
  // the __SUPERD_UI_FUSION__ baked global (one gate, both halves).
  assert.equal(table.length, 3, 'trust script + fusion transport + fusion flag global')
  const [trustRow, fusionRow, flagRow] = table
  assert.equal(trustRow.kind, 'script')
  assert.equal(trustRow.placement, 'head')
  assert.ok(trustRow.text.includes('__DSH_TRANSPORT__'), 'the first row is the trust script')
  assert.equal(fusionRow.kind, 'script')
  assert.equal(fusionRow.placement, 'head')
  assert.ok(fusionRow.text.includes('__SUPERD_UI_STATE__'), 'the second row is the fusion transport')
  assert.deepEqual(flagRow, { kind: 'global', name: '__SUPERD_UI_FUSION__', value: true }, 'the third row is the baked flag global')
  assert.equal(table.indexOf(fusionRow) > table.indexOf(trustRow), true, 'the fusion script is evaluated after the trust verdict')
})

test('served in order, the trust verdict survives the fusion install', () => {
  const ctx = harness()
  applyWebTrust(ctx, { trustedPageAuthorities: ['test.pc.internal.test'] })
  applyFusion(ctx, { enabled: true })
  ctx.materialize()
  const table = []
  ctx.emit(table)
  const sandbox = { window: {}, location: { hostname: 'test.pc.internal.test', origin: 'http://test.pc.internal.test' }, URL }
  const context = vm.createContext(sandbox)
  for (const row of table) vm.runInContext(row.text, context, { filename: `${row.kind}.js` })
  assert.equal(sandbox.window.__DSH_TRANSPORT__?.ownsHost, true, 'ownsHost survives the fusion script on a trusted authority')
})

test('flag off: the component stays dormant — no listener, no row, no script', () => {
  const ctx = harness()
  applyFusion(ctx, { enabled: false })
  ctx.materialize()
  const table = []
  ctx.emit(table)
  assert.equal(table.length, 0, 'a disabled row injects nothing')
  assert.equal(renderFusionTransport(), renderFusionTransport(), 'the script is a constant — the flag gates only the row')
})

test('the composite patch orders the fusion row after web-trust', () => {
  const doc = yaml.load(readFileSync(join(LINE, 'cordis.patch.yml'), 'utf8'))
  const insert = doc.find((entry) => Array.isArray(entry.insert))?.insert
  assert.ok(Array.isArray(insert), 'the composite patch carries the insert list')
  const ids = insert.map((row) => row.id)
  const trust = ids.indexOf('superd-web-trust')
  const fusion = ids.indexOf('superd-fusion-transport')
  assert.ok(trust !== -1, 'web-trust row present')
  assert.ok(fusion !== -1, 'fusion row present')
  assert.ok(fusion > trust, `fusion must load after web-trust (saw ${JSON.stringify(ids)})`)
})

test('the flag gate: SUPERD_UI_FUSION, default off, explicit config wins', () => {
  for (const [env, want] of [
    [undefined, false], ['', false], ['0', false], ['false', false], ['off', false], ['no', false],
    ['1', true], ['true', true], ['TRUE', true], ['yes', true], ['on', true], [' 1 ', true],
  ]) {
    assert.equal(deriveFusionFlag(env), want, `SUPERD_UI_FUSION=${JSON.stringify(env)}`)
  }
  // The schema default reads the env at load; an explicit row config always wins.
  assert.equal(Config({}).enabled, deriveFusionFlag(process.env.SUPERD_UI_FUSION))
  assert.equal(Config({ enabled: true }).enabled, true)
  assert.equal(Config({ enabled: false }).enabled, false)
})
