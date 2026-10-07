import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const better = join(repo, 'better-dsh')
const require = createRequire(join(repo, 'upstream/deepseek-harness/apps/cli/package.json'))
const { composeEntries, loadOverlayPatches } = require('@deepseek-ai/dsh-app-boot')
const manifest = path => JSON.parse(readFileSync(path, 'utf8'))

test('Super Dash pins the local Better Dash package version', () => {
  const a = manifest(join(repo, 'super-dsh/package.json'))
  const b = manifest(join(better, 'package.json'))
  assert.equal(b.name, 'better-dsh')
  assert.equal(a.dependencies['better-dsh'], b.version)
})

test('native composition retains Better Dash components with a single active WebTrust', () => {
  const warnings = []
  const bundle = name => {
    const packageDir = dirname(require.resolve(`${name}/package.json`))
    const patch = manifest(join(packageDir, 'package.json')).dsh.bundle.patch
    return [patch].flat().flatMap(file => loadOverlayPatches('test', join(packageDir, file)))
  }
  const rows = composeEntries([
    bundle('@deepseek-ai/dsh-base'), bundle('@deepseek-ai/dsh-web-app'),
    loadOverlayPatches('test', join(better, 'cordis.patch.yml')),
    loadOverlayPatches('test', join(repo, 'super-dsh/cordis.patch.yml')),
  ], warning => warnings.push(warning))
  assert.deepEqual(warnings, [])
  for (const id of ['dashr-repl', 'dashr-url-schemes', 'dashr-failover', 'dashr-compaction-tuning', 'dashr-mobile', 'dashr-remote', 'dashr-web-password', 'dashr-welcome-notice', 'superd-hub']) {
    const matches = rows.filter(row => row.id === id)
    assert.equal(matches.length, 1, `${id} must have one row`)
    assert.notEqual(matches[0].disabled, true, `${id} must remain enabled`)
  }
  assert.equal(rows.find(row => row.id === 'superd-web-trust'), undefined)
  assert.equal(rows.find(row => row.id === 'webserver').disabled, true)
  assert.ok(rows.findIndex(row => row.id === 'dashr-web-trust') < rows.findIndex(row => row.id === 'superd-fusion-transport'))
  const trust = rows.find(row => row.id === 'dashr-web-trust')
  assert.notEqual(trust.disabled, true)
  assert.equal(trust.config.trustAllHosts, true)
  const { interpolate } = require('@deepseek-ai/cordis-plugin-loader')
  const config = interpolate({ webStartup: {} }, rows.find(row => row.id === 'dashr-webserver').config)
  assert.equal(config.host, '0.0.0.0')
  assert.equal(config.port, 3080)
  assert.equal(config.compression, 'gzip')
  assert.equal(rows.find(row => row.id === 'ui-settings-models').config.credentialOnboarding, false)
})
