// Icon asset pack (spec hub-roster-identity §2): the manifest is complete and
// honest — every mapped file exists, the generated module mirrors the
// manifest exactly, and the unified runtimeId convention (`runtimeIdOf`) is
// the key both halves agree on. Pure filesystem + generated-module reads;
// no network, no DOM.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeIdOf, NATIVE_RUNTIME_ID } from '../dist/roster.js'
import { RUNTIME_ICON_ASSETS } from '../dist/client/icon-assets.gen.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACK = join(HERE, '..', 'assets', 'icons')

/** The nine adapter runtimeIds this pack ships (world keys × main/SDK lines) + native. */
const EXPECTED_IDS = [
  'native',
  'agent-agy', 'agent-agy-sdk',
  'agent-claude',
  'agent-codex', 'agent-codex-sdk',
  'agent-hermes',
  'agent-omp', 'agent-omp-sdk',
  'agent-pi',
]

test('runtimeIdOf: the package-name convention (native reserved, agent-<key> otherwise)', () => {
  assert.equal(NATIVE_RUNTIME_ID, 'native')
  assert.equal(runtimeIdOf('native'), 'native')
  assert.equal(runtimeIdOf('omp'), 'agent-omp')
  assert.equal(runtimeIdOf('omp-sdk'), 'agent-omp-sdk')
  assert.equal(runtimeIdOf('agy'), 'agent-agy')
  assert.equal(runtimeIdOf('codex-sdk'), 'agent-codex-sdk')
  assert.equal(runtimeIdOf('hermes'), 'agent-hermes')
})

test('manifest: version 1, complete adapter coverage, every mapped file exists', () => {
  const manifest = JSON.parse(readFileSync(join(PACK, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, 1)
  assert.deepEqual(Object.keys(manifest.map).sort(), [...EXPECTED_IDS].sort())
  for (const file of Object.values(manifest.map)) {
    assert.equal(existsSync(join(PACK, file)), true, `${file} exists in the pack`)
  }
  // tiles reference real files only
  for (const file of Object.keys(manifest.tiles)) {
    assert.equal(existsSync(join(PACK, file)), true, `tile file ${file} exists`)
  }
})

test('generated module mirrors the manifest one-to-one (regenerate on manifest drift)', () => {
  const manifest = JSON.parse(readFileSync(join(PACK, 'manifest.json'), 'utf8'))
  assert.deepEqual(Object.keys(RUNTIME_ICON_ASSETS).sort(), Object.keys(manifest.map).sort())
  for (const [runtimeId, file] of Object.entries(manifest.map)) {
    const asset = RUNTIME_ICON_ASSETS[runtimeId]
    const bytes = readFileSync(join(PACK, file))
    assert.equal(asset.uri, `data:${file.endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${bytes.toString('base64')}`,
      `${runtimeId} inlines the exact bytes of ${file}`)
    assert.ok(asset.ratio > 0, `${runtimeId} carries a positive intrinsic ratio`)
    const expectedTile = manifest.tiles[file]
    assert.equal(asset.tile, expectedTile, `${runtimeId} tile matches the manifest`)
  }
})

test('SDK half-lines share the main line mark (one agent, one artwork)', () => {
  assert.equal(RUNTIME_ICON_ASSETS['agent-omp'].uri, RUNTIME_ICON_ASSETS['agent-omp-sdk'].uri)
  assert.equal(RUNTIME_ICON_ASSETS['agent-codex'].uri, RUNTIME_ICON_ASSETS['agent-codex-sdk'].uri)
  assert.equal(RUNTIME_ICON_ASSETS['agent-agy'].uri, RUNTIME_ICON_ASSETS['agent-agy-sdk'].uri)
})

test('the pack carries the full ORCA collection beyond the mapped marks', () => {
  // The assets directory is the COLLECTION, not just the bundle input:
  // ORCA's whole curated set is imported (38 marks) while the manifest maps
  // only the runtimes this product has — unmapped marks wait for future
  // runtimeIds and never reach the client bundle.
  const manifest = JSON.parse(readFileSync(join(PACK, 'manifest.json'), 'utf8'))
  const mapped = new Set(Object.values(manifest.map))
  const files = readdirSync(PACK).filter((f) => f.endsWith('.png'))
  assert.ok(files.length >= 38, `the ORCA png set is fully imported (found ${files.length})`)
  for (const orcaOnly of ['gemini.png', 'cursor.png', 'droid.png', 'dsh.png']) {
    assert.equal(existsSync(join(PACK, orcaOnly)), true, `${orcaOnly} collected`)
    assert.equal(mapped.has(orcaOnly), false, `${orcaOnly} stays unmapped (no such runtime)`)
  }
})
