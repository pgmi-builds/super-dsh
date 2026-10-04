// World composition patches (AW-B Task 9 part 2 → path-separation T-D): the
// layers that turn a listener-owning world into a mounted, webui-less DATA
// PLANE — pure data, no boot needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  worldMountPatches,
  WORLD_WAVE1_DISABLED_ROWS,
  WORLD_WAVE2_DISABLED_ROWS,
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
  // The modules row stays PARKED on the never-provided webServer (its
  // activation fails in world trees; wave-2 rig evidence) — not disabled.
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
  // No web-trust row, no fusion row; the tail beyond the insert layer is
  // the wave-1 + wave-2 disable blocks (asserted in their own tests).
  assert.equal('insert' in patches[5], true)
})

test('wave-1: dead native-agent rows are disabled in every world composition', () => {
  const patches = worldMountPatches('omp')
  assert.equal(patches.length, 6 + WORLD_WAVE1_DISABLED_ROWS.length + WORLD_WAVE2_DISABLED_ROWS.length)
  const disabled = new Set(patches.filter((p) => 'id' in p && p.disabled === true).map((p) => p.id))
  for (const id of WORLD_WAVE1_DISABLED_ROWS) assert.equal(disabled.has(id), true, id + ' must be disabled')
  // KEEP invariants (spec): adapters inject agents/sessions/llm/agentDefaultModel/settings/agentPresets
  for (const keep of ['agent', 'agent-default-model', 'settings', 'agent-preset-registry']) {
    assert.equal(disabled.has(keep), false, keep + ' must stay enabled')
  }
  assert.equal(WORLD_WAVE1_DISABLED_ROWS.length, 24, 'wave-1 is exactly the 24 dependency-cleared rows')
})

test('worldMountPatches keys the row with the runtime key and rejects malformed keys', () => {
  assert.equal(worldMountPatches("codex")[5].insert[0].config.key, "codex")
  assert.throws(() => worldMountPatches(''), /invalid key/)
  assert.throws(() => worldMountPatches('a/b'), /invalid key/)
})

test('superdTrustedHosts is the single SUPERD_TRUSTED_HOSTS derivation (spawnWorld + world-entry parity)', () => {
  assert.deepEqual(superdTrustedHosts(undefined), [])
  assert.deepEqual(superdTrustedHosts(''), [])
  assert.deepEqual(superdTrustedHosts('a b,c  d'), ['a', 'b', 'c', 'd'])
})

test('wave-2: the client lane is stripped (native-ui-only completion)', () => {
  const patches = worldMountPatches('omp')
  const disabled = new Set(patches.filter((p) => 'id' in p && p.disabled === true).map((p) => p.id))
  for (const id of WORLD_WAVE2_DISABLED_ROWS) assert.equal(disabled.has(id), true, id + ' must be disabled')
  // Client-lane KEEPs: the gateway injects `connection`; sessionController
  // injects `fileUploads`; `modules` is parked (inject-on-webServer).
  assert.equal(disabled.has('connection'), false, 'connection stays (gateway inject)')
  assert.equal(disabled.has('modules'), false, 'modules stays parked, not disabled')
  assert.equal(disabled.has('file-upload'), false, 'file-upload stays (sessionController injects fileUploads)')
  // KEEP invariants still enabled.
  for (const keep of ['agent', 'agent-default-model', 'settings', 'agent-preset-registry']) {
    assert.equal(disabled.has(keep), false, keep + ' must stay enabled')
  }
  assert.equal(WORLD_WAVE2_DISABLED_ROWS.length, 45, 'wave-2 = 44 dsh-client-* rows + cordis-client-runner (modules parked, connection and file-upload kept)')
})
