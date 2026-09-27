// Roster semantics (S2): register/list/duplicate-throws, setReady notifies,
// unregister removes, unknown-key loud failure, unsubscribe stops delivery.
// Mesh P1: every agentLinks row — NATIVE included — carries a stable a6 id
// minted against the given home (tmpdir here; never the ambient DSH_HOME).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentLinks } from '../dist/agent-roster.js'
import { registerHostMount } from '../dist/world-host.js'
import { agentIdMap } from '../dist/agent-ids.js'
import {
  registerAgent, unregisterAgent, setReady, setFailed, listAgents, onRosterChanged,
} from '../dist/index.js'

test('roster: register / list / duplicate throws', () => {
  registerAgent({ key: 'omp', label: 'OMP', ready: false })
  assert.deepEqual(listAgents(), [{ key: "omp", label: "OMP", ready: false, failed: false }])
  assert.throws(() => registerAgent({ key: 'omp', label: 'x', ready: true }), /duplicate/)
})

test('roster: setReady notifies subscribers; unregister removes; unknown key throws', () => {
  const seen = []
  const off = onRosterChanged((entries) => seen.push(entries.map((e) => e.key + ':' + e.ready)))
  setReady('omp', true)
  assert.deepEqual(listAgents(), [{ key: "omp", label: "OMP", ready: true, failed: false }])
  assert.ok(seen.at(-1).includes('omp:true'))
  off()
  unregisterAgent('omp')
  assert.deepEqual(listAgents(), [])
  assert.throws(() => setReady('omp', false), /unknown agent/)
})

test('roster: failed flag defaults false, setFailed flips it independently of ready', () => {
  registerAgent({ key: 't-fail', label: 'TF', ready: true })
  assert.equal(listAgents().find((e) => e.key === 't-fail')?.failed, false)
  setFailed('t-fail', true)
  const row = listAgents().find((e) => e.key === 't-fail')
  assert.equal(row?.failed, true)
  assert.equal(row?.ready, true, 'failed does not touch ready')
  assert.throws(() => setFailed('nope', true), /unknown agent/)
  unregisterAgent('t-fail')
})

test('agentLinks: every row carries a stable a6 id — NATIVE included (tmpdir home)', () => {
  const h = mkdtempSync(join(tmpdir(), 'superd-agentlinks-'))
  registerAgent({ key: 'omp', label: 'OMP', ready: true })
  const drop = registerHostMount({ key: 'omp', labelPath: '/omp' })
  try {
    const links = agentLinks(h)
    assert.equal(links.length, 2)
    const ids = links.map((l) => l.id)
    for (const id of ids) assert.match(id, /^[a-z0-9]{6}$/)
    assert.equal(new Set(ids).size, ids.length, 'ids are deduped across rows')
    const native = links.find((l) => l.key === 'native')
    assert.match(native.id, /^[a-z0-9]{6}$/, 'NATIVE row carries an id too')
    // Stable across calls (persisted, not re-minted) and keyed by roster key.
    assert.deepEqual(agentLinks(h).map((l) => l.id), ids)
    assert.deepEqual(agentIdMap(h), { native: native.id, omp: links.find((l) => l.key === 'omp').id })
  } finally {
    drop()
    unregisterAgent('omp')
    rmSync(h, { recursive: true, force: true })
  }
})

test('roster: machine 字段加性——带 machine 行透传、不带行无该键（mesh P2 Task 3）', () => {
  registerAgent({ key: 'fed1', label: 'Codex · dev3', ready: true, failed: false, machine: 'k3f9' })
  registerAgent({ key: 'loc1', label: 'OMP', ready: true })
  try {
    const rows = Object.fromEntries(listAgents().filter((e) => e.key === 'fed1' || e.key === 'loc1').map((e) => [e.key, e]))
    assert.equal(rows.fed1.machine, 'k3f9')
    assert.equal('machine' in rows.loc1, false, '本地行不携带 machine 键（缺省 = local）')
  } finally {
    unregisterAgent('fed1')
    unregisterAgent('loc1')
  }
})

test('agentLinks: federated 行无需 host mount——machine 填充、a6 即 id、path 走 /hub demux；排序 native → local → remote（与注册顺序无关）', () => {
  const h = mkdtempSync(join(tmpdir(), 'superd-roster-fed-'))
  // federated 行先注册、local 行后注册：排序仍 native → local → remote
  registerAgent({ key: 'q7m2xp', label: 'Codex · dev3', ready: true, failed: false, machine: 'k3f9' })
  registerAgent({ key: 'z9remote', label: 'OMP · dev3', ready: false, failed: false, machine: 'k3f9' })
  registerAgent({ key: 'omp', label: 'OMP', ready: true })
  const drop = registerHostMount({ key: 'omp', labelPath: '/omp' })
  try {
    const links = agentLinks(h)
    assert.deepEqual(links.map((l) => l.key), ['native', 'omp', 'q7m2xp', 'z9remote'])
    const fed = links.find((l) => l.key === 'q7m2xp')
    assert.equal(fed.id, 'q7m2xp', 'a6 即行 id（采纳原值，不本地铸造）')
    assert.equal(fed.machine, 'k3f9')
    assert.equal(fed.path, '/hub/?agent=q7m2xp')
    assert.equal(fed.ready, true)
    assert.equal(links.find((l) => l.key === 'z9remote').ready, false)
    const local = links.find((l) => l.key === 'omp')
    assert.equal(local.machine, 'local')
    assert.equal(local.path, '/omp/')
  } finally {
    drop()
    unregisterAgent('q7m2xp')
    unregisterAgent('z9remote')
    unregisterAgent('omp')
    rmSync(h, { recursive: true, force: true })
  }
})
