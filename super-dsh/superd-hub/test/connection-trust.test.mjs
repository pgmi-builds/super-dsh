import { Context } from '@deepseek-ai/cordis'
import * as nativeConnection from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../../upstream/deepseek-harness/vendor/loader/package.json', import.meta.url))
const { load } = require('js-yaml')
import { apply as applyTrust } from '../dist/web-trust.js'

const roots = []
afterEach(async () => {
  mock.restoreAll()
  for (const root of roots.splice(0)) await root.fiber.dispose()
})

async function mounted() {
  const root = new Context()
  roots.push(root)
  const records = new Map()
  root.provide('credentials', {
    readRecord: async (key) => records.get(key),
    modifyRecord: async (key, mutate) => {
      const current = records.get(key)
      const next = await mutate(current)
      if (next !== undefined) records.set(key, next)
      return next ?? current
    },
  })
  const native = root.plugin(nativeConnection, { trustedHosts: [], cookieMaxAgeDays: 1 })
  await native.await()
  return { root, connection: root.connection }
}

function cookieFor(connection, host) {
  const url = new URL(connection.authenticatedUrl(`http://${host}/`))
  let cookie
  connection.authorizeIndex({ headers: { host }, method: 'GET', url: `${url.pathname}${url.search}` }, {
    writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';', 1)[0] },
    end() {},
  })
  if (cookie === undefined) throw new Error('native token exchange did not mint a cookie')
  return cookie
}

describe('authentication-only connection admission', () => {
  it('accepts authenticated hosts and origins absent from the native allowlist, and restores the fence on unload', async () => {
    const { root, connection } = await mounted()
    const host = 'unlisted.example:4999'
    const headers = { host, cookie: cookieFor(connection, host), origin: 'https://other.example', 'sec-fetch-site': 'cross-site' }
    assert.equal(connection.requestRejection({ headers }), 403)
    const trust = root.plugin({ apply: applyTrust }, { trustAllHosts: true })
    await trust.await()
    assert.ok(connection.admit({ headers }).peer)
    assert.equal(connection.requestRejection({ headers: new Headers(headers) }), undefined)
    await trust.dispose()
    assert.equal(connection.requestRejection({ headers }), 403)
  })

  it('still rejects missing, invalid, wrong-authority and expired cookies using the native lifetime', async () => {
    const { root, connection } = await mounted()
    const host = '192.0.2.130:4999'
    const cookie = cookieFor(connection, host)
    const trust = root.plugin({ apply: applyTrust }, { trustAllHosts: true })
    await trust.await()
    assert.equal(connection.requestRejection({ headers: { host, cookie } }), undefined)
    assert.equal(connection.requestRejection({ headers: { host } }), 401)
    assert.equal(connection.requestRejection({ headers: { host, cookie: cookie + 'tampered' } }), 401)
    assert.equal(connection.requestRejection({ headers: { host: 'other.example:4999', cookie } }), 401)
    const now = Date.now()
    mock.method(Date, 'now', () => now + 2 * 24 * 60 * 60 * 1000)
    assert.equal(connection.requestRejection({ headers: { host, cookie } }), 401)
  })

  it('the shipped bundle admits any authenticated serving authority without a deployment override', async () => {
    const patch = load(readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'))
    const row = patch.flatMap(entry => entry.insert ?? []).find(entry => entry.id === 'superd-web-trust')
    const { root, connection } = await mounted()
    const host = 'new-production-authority.example:3080'
    const trust = root.plugin({ apply: applyTrust }, row.config ?? {})
    await trust.await()
    assert.equal(connection.requestRejection({ headers: {
      host, cookie: cookieFor(connection, host), origin: 'https://unlisted-page.example',
    } }), undefined)
    assert.equal(connection.requestRejection({ headers: { host } }), 401)
  })

  it('keeps native admission when the mode is not enabled', async () => {
    const { root, connection } = await mounted()
    const host = 'unlisted.example:4999'
    const trust = root.plugin({ apply: applyTrust }, {})
    await trust.await()
    assert.equal(connection.requestRejection({ headers: { host, cookie: cookieFor(connection, host) } }), 403)
  })
})
