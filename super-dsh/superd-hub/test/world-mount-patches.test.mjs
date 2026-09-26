// World composition patches (AW-B Task 9 part 2 → path-separation T-D): the
// layers that turn a listener-owning world into a mounted, webui-less DATA
// PLANE — pure data, no boot needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  worldMountPatches,
  superdTrustedHosts,
  WORLD_MOUNT_PLUGIN,
  WORLD_MOUNT_ROW_ID,
  WORLD_HUB_PLUGIN,
  WORLD_HUB_ROW_ID,
} from '../dist/index.js'

test('worldMountPatches disables the listener AND the webui rows, keeps modules waiting, inserts mount+hub', () => {
  const patches = worldMountPatches('omp')
  // 0.1.7: disabled AND pinned to an ephemeral loopback port — the live
  // world audit still saw the row bind 3080 with disabled alone.
  assert.deepEqual(patches[0], { id: 'webserver', disabled: true, config: { host: '127.0.0.1', port: 0 } })
  // 0.1.7: profileContext arms the profile hmr row in worlds; its reload
  // recomposes from the profile layers and drops spawn-time patches — keep
  // hmr off in world trees.
  assert.deepEqual(patches[1], { id: 'hmr', disabled: true })
  // T-D: the world webui rows off — no frontend-static mount, no URL line,
  // no browser handoff, no client reload chain. Zero webui composition.
  assert.deepEqual(patches[2], { id: 'web-runtime', disabled: true })
  assert.deepEqual(patches[3], { id: 'client-hmr', disabled: true })
  // The virtual webServer stays the binding target for rows that inject it.
  assert.deepEqual(patches[4], { id: 'modules', inject: ['webServer'] })
  const insert = patches[5]
  assert.equal(Array.isArray(insert.insert), true)
  // T-D: the world page-trust row is GONE — its only consumer was the world
  // page. The insert list is exactly mount + hub.
  assert.deepEqual(insert.insert, [
    {
      id: WORLD_MOUNT_ROW_ID,
      name: WORLD_MOUNT_PLUGIN,
      config: { key: 'omp' },
    },
    { id: WORLD_HUB_ROW_ID, name: WORLD_HUB_PLUGIN },
  ])
  assert.equal(worldMountPatches('omp').length, 6, 'no web-trust row, no fusion row — six layers exactly')
})

test('worldMountPatches keys the row with the runtime key and rejects malformed keys', () => {
  assert.equal(worldMountPatches('codex')[5].insert[0].config.key, 'codex')
  assert.throws(() => worldMountPatches(''), /invalid key/)
  assert.throws(() => worldMountPatches('a/b'), /invalid key/)
})

test('superdTrustedHosts is the single SUPERD_TRUSTED_HOSTS derivation (spawnWorld + world-entry parity)', () => {
  assert.deepEqual(superdTrustedHosts(undefined), [])
  assert.deepEqual(superdTrustedHosts(''), [])
  assert.deepEqual(superdTrustedHosts('a b,c  d'), ['a', 'b', 'c', 'd'])
})
