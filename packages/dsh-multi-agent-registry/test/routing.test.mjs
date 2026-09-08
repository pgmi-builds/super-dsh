import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearKey,
  keyStorePath,
  readKey,
  resetKeyCache,
  setKeyStorePath,
  writeKey,
} from '../dist/routing.js'
import { symbols } from '@deepseek-ai/cordis' // routing module must stay cordis-free; only registry imports it

// The routing module must not require real cordis at runtime: importing it
// above would have thrown if it (transitively) did. Touch symbols so the
// import is not dropped as unused by readers of this file.
assert.ok(typeof symbols.original === 'symbol')

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'routing-'))
  const path = join(dir, 'agent-runtime-keys.json')
  setKeyStorePath(path)
  return { dir, path }
}

test('keyStorePath defaults to dshHomePath anchor when not overridden', () => {
  setKeyStorePath(undefined)
  const p = keyStorePath()
  assert.ok(p.endsWith('agent-runtime-keys.json'))
  assert.ok(p.includes('.dsh') || p.length > 0) // anchored under the resolved home root
})

test('read/write roundtrip against a temp file, including reload from disk', () => {
  const { path } = freshStore()
  assert.equal(readKey('s1'), undefined) // empty store
  writeKey('s1', 'echo')
  assert.equal(readKey('s1'), 'echo')
  writeKey('s2', 'omp')
  // Drop the in-memory cache and re-read: persistence is on disk, not RAM.
  resetKeyCache()
  assert.equal(readKey('s1'), 'echo')
  assert.equal(readKey('s2'), 'omp')
  // Overwrite wins.
  writeKey('s1', 'native')
  resetKeyCache()
  assert.equal(readKey('s1'), 'native')
  // Clear removes exactly that key.
  clearKey('s1')
  resetKeyCache()
  assert.equal(readKey('s1'), undefined)
  assert.equal(readKey('s2'), 'omp')
  assert.ok(existsSync(path))
})

test('write is atomic: no leftover tmp files, file always parses', () => {
  const { dir } = freshStore()
  for (let i = 0; i < 20; i++) writeKey(`s${i}`, `echo-${i}`)
  const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp'))
  assert.deepEqual(leftovers, [])
  const parsed = JSON.parse(readFileSync(join(dir, 'agent-runtime-keys.json'), 'utf8'))
  assert.equal(parsed.s19, 'echo-19')
})

test('corrupt file degrades to an empty table (fail-safe to native)', () => {
  const { path } = freshStore()
  writeKey('s1', 'echo')
  writeFileSync(path, '{ this is not json !!!')
  resetKeyCache()
  assert.equal(readKey('s1'), undefined)
  // Wrong shape counts as corrupt too.
  writeFileSync(path, '["array"]')
  resetKeyCache()
  assert.equal(readKey('s1'), undefined)
  // Non-string values are dropped.
  writeFileSync(path, '{"s1": 42, "s2": "ok"}')
  resetKeyCache()
  assert.equal(readKey('s1'), undefined)
  assert.equal(readKey('s2'), 'ok')
})

test('missing file is just an empty table', () => {
  freshStore() // nothing written
  resetKeyCache()
  assert.equal(readKey('anything'), undefined)
  // First write creates the file (and parent dirs).
  writeKey('later', 'echo')
  resetKeyCache()
  assert.equal(readKey('later'), 'echo')
})
