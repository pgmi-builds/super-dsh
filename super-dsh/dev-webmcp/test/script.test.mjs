/**
 * Pins the injectable-script contract against the REAL exact-pinned
 * page-mcp dependency (build-then-test convention: imports `dist/`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pageMcpScriptText, assertInjectableScript } from '../dist/script.js'

test('page-mcp dist resolves from the dependency tree and injects cleanly', () => {
  const text = pageMcpScriptText()
  const direct = readFileSync(
    createRequire(import.meta.url).resolve('page-mcp/dist/page-mcp.js'),
    'utf8',
  )
  assert.equal(text, direct, 'cached text must be the dependency dist, byte-exact')
  assert.ok(text.includes('modelContext'), 'sanity: the WebMCP surface is in the bundle')
  assert.doesNotMatch(text, /<\/script/, 'no element-closing sequence (assertInjectableScript passed)')
})

test('assertInjectableScript rejects an element-closing script text', () => {
  assert.throws(
    () => assertInjectableScript('x = "</script"'),
    /close its own <script> element/,
  )
  assert.doesNotThrow(() => assertInjectableScript('x = "<\\/script"'), 'escaped form is fine')
})
