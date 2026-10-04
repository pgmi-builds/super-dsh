import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { readProviderStore, writeProviderStore } from '../agent-codex/dist/codex-providers.js'

const script = fileURLToPath(new URL('./seed-codex-providers.mjs', import.meta.url))
function rig(t) {
  const home = mkdtempSync(join(tmpdir(), 'codex-seed-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const worldHome = join(home, 'agents/codex')
  const run = (key = '') => spawnSync(process.execPath, [script, worldHome], {
    env: { PATH: process.env.PATH, DSH_HOME: join(home, 'ignored'),
      DEEPSEEK_API_KEY: key, ZAI_PLAN_API_KEY: '' }, encoding: 'utf8',
  })
  return { home, worldHome, run }
}

test('seeds a usable DeepSeek responses route in the explicit world home without leaking the key', (t) => {
  const { home, worldHome, run } = rig(t)
  const result = run('test-only-key')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readProviderStore(worldHome).providers, [{
    id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'responses', auth: { kind: 'apiKey', value: 'test-only-key' },
    models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }], origin: 'user',
  }])
  assert.equal(statSync(join(worldHome, 'codex-providers.json')).mode & 0o777, 0o600)
  assert.equal(existsSync(join(home, 'ignored')), false)
  assert.equal((result.stdout + result.stderr).includes('test-only-key'), false)
})

test('rerunning preserves other providers and tombstones without duplicating the seed', (t) => {
  const { worldHome, run } = rig(t)
  const existing = { id: 'other', label: 'Other', baseUrl: 'https://other.invalid/v1',
    protocol: 'responses', auth: { kind: 'env', name: 'OTHER_API_KEY' },
    models: [{ id: 'other-model' }], origin: 'user' }
  writeProviderStore(worldHome, { version: 1, providers: [existing], removed: ['https://removed.invalid/v1'] })
  assert.equal(run('test-only-key').status, 0)
  const before = readFileSync(join(worldHome, 'codex-providers.json'), 'utf8')
  assert.equal(run('test-only-key').status, 0)
  assert.equal(readFileSync(join(worldHome, 'codex-providers.json'), 'utf8'), before)
  const store = readProviderStore(worldHome)
  assert.deepEqual(store.providers.filter(p => p.id === 'other'), [existing])
  assert.equal(store.providers.filter(p => p.id === 'deepseek').length, 1)
  assert.deepEqual(store.removed, ['https://removed.invalid/v1'])
})

test('a missing or blank key leaves an absent store absent', (t) => {
  const { worldHome, run } = rig(t)
  for (const key of ['', '   ']) {
    const result = run(key)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(worldHome), false)
  }
})

test('a keyless run leaves an existing store unchanged', (t) => {
  const { worldHome, run } = rig(t)
  writeProviderStore(worldHome, { version: 1, providers: [] })
  const before = readFileSync(join(worldHome, 'codex-providers.json'), 'utf8')
  assert.equal(run().status, 0)
  assert.equal(readFileSync(join(worldHome, 'codex-providers.json'), 'utf8'), before)
})

test('requires an explicit world home even with DSH_HOME set', () => {
  const result = spawnSync(process.execPath, [script], {
    env: { DSH_HOME: '/tmp/must-not-use-dsh-home', DEEPSEEK_API_KEY: 'test-only-key' }, encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /usage:/)
  assert.equal((result.stdout + result.stderr).includes('test-only-key'), false)
})
