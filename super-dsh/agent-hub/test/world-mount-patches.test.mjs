// World composition patches (AW-B Task 9 part 2): the three layers that turn a
// listener-owning world into a mounted one — pure data, no boot needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { worldMountPatches, WORLD_MOUNT_PLUGIN, WORLD_MOUNT_ROW_ID } from '../dist/index.js'

test('worldMountPatches disables the listener, makes modules wait, and inserts the world row', () => {
  const patches = worldMountPatches('omp')
  // 0.1.7: disabled AND pinned to an ephemeral loopback port — the live
  // world audit still saw the row bind 3080 with disabled alone.
  assert.deepEqual(patches[0], { id: 'webserver', disabled: true, config: { host: '127.0.0.1', port: 0 } })
  // 0.1.7: profileContext arms the profile hmr row in worlds; its reload
  // recomposes from the profile layers and drops spawn-time patches — keep
  // hmr off in world trees.
  assert.deepEqual(patches[1], { id: 'hmr', disabled: true })
  assert.deepEqual(patches[2], { id: 'modules', inject: ['webServer'] })
  const insert = patches[3]
  assert.equal(Array.isArray(insert.insert), true)
  assert.deepEqual(insert.insert[0], {
    id: WORLD_MOUNT_ROW_ID,
    name: WORLD_MOUNT_PLUGIN,
    config: { key: 'omp' },
  })
})

test('worldMountPatches keys the row with the runtime key and rejects malformed keys', () => {
  assert.equal(worldMountPatches('codex')[3].insert[0].config.key, 'codex')
  assert.throws(() => worldMountPatches(''), /invalid key/)
  assert.throws(() => worldMountPatches('a/b'), /invalid key/)
})
