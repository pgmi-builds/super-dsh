// Web page trust component (ported from better-dsh web-trust, authorities
// leg): the browser-side twin of the server-side trustedHosts fence. Pure
// script-builder tests — the script is evaluated exactly as a page would.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTrustScript, Config, deriveDefaultPageAuthorities } from '../dist/web-trust.js'

/** Evaluate the built script exactly as a page would (head inline script). */
function runScript(text, sandbox) {
  const window = sandbox.window
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'location', text)
  fn(window, sandbox.location)
  return window
}

test('injects nothing when no authorities are configured', () => {
  assert.equal(buildTrustScript([]), undefined)
  assert.equal(buildTrustScript(undefined), undefined)
})

test('emits the ownsHost transport flag only for declared authorities', () => {
  const text = buildTrustScript(['test.pc.internal.test'])
  const matching = runScript(text, {
    window: {},
    location: { hostname: 'test.pc.internal.test' },
  })
  assert.deepEqual(matching.__DSH_TRANSPORT__, { ownsHost: true })

  const other = runScript(text, {
    window: {},
    location: { hostname: 'evil.example' },
  })
  assert.equal(other.__DSH_TRANSPORT__, undefined)
})

test('never overwrites an existing transport (a worker shell owns one)', () => {
  const text = buildTrustScript(['a.example'])
  const existing = { fetch: () => Promise.resolve() }
  const window = runScript(text, {
    window: { __DSH_TRANSPORT__: existing },
    location: { hostname: 'a.example' },
  })
  assert.equal(window.__DSH_TRANSPORT__, existing)
})

test('sets only ownsHost — no fetch/openStream ride along', () => {
  const text = buildTrustScript(['a.example'])
  const window = runScript(text, { window: {}, location: { hostname: 'a.example' } })
  assert.deepEqual(Object.keys(window.__DSH_TRANSPORT__), ['ownsHost'])
})

test('escapes hostile authority strings (JSON embed, no code splicing)', () => {
  const text = buildTrustScript(['a"b.example'])
  assert.ok(!text.includes('a"b.example"'))
  const window = runScript(text, { window: {}, location: { hostname: 'a"b.example' } })
  assert.deepEqual(window.__DSH_TRANSPORT__, { ownsHost: true })
})

test('refuses malformed authorities loudly (port/path/empty)', () => {
  for (const bad of ['', 'a.example:3080', 'a.example/path', '//a.example']) {
    assert.throws(() => buildTrustScript([bad]), /bare hostname/)
  }
})

test('default derivation: bare hostnames only, comma or whitespace separated', () => {
  assert.deepEqual(deriveDefaultPageAuthorities(undefined), [])
  assert.deepEqual(
    deriveDefaultPageAuthorities('test.pc.internal.test 192.0.2.130:4999, 192.0.2.130'),
    ['test.pc.internal.test', '192.0.2.130'],
    'portful entries drop; comma and whitespace both separate',
  )
})

test('schema default derives from the trusted-hosts env single source', () => {
  const resolve = Config
  const resolved = resolve({})
  assert.deepEqual(
    resolved.trustedPageAuthorities,
    deriveDefaultPageAuthorities(process.env.DSH_TRUSTED_HOSTS ?? process.env.AW_TRUSTED_HOSTS),
  )
  // An explicit configured value always wins over the derived default.
  assert.deepEqual(resolve({ trustedPageAuthorities: ['x.example'] }).trustedPageAuthorities, ['x.example'])
})
