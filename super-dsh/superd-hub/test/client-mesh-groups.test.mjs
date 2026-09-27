// Client mesh grouping (mesh P2 Task 4): the pure halves of the switch
// menu's machine sections — `groupByMachine` (local group first under the
// 'This machine' label, remote groups sorted by display label then key,
// members keeping roster order) and `machineLabelsFrom` (the machines API
// answer → the m4 → display-label map) — plus the roster coercion's
// `machine` passthrough. mesh-groups.ts and roster.ts are node-safe by
// construction (no DOM, no react, no @deepseek-ai imports) and the host tsc
// dual-emits both to dist/client/ exactly for this seam — the mesh-api
// precedent. `fetchRoster` runs here only against a stubbed global fetch;
// no network is touched.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LOCAL_MACHINE_KEY,
  LOCAL_MACHINE_LABEL,
  groupByMachine,
  machineLabelsFrom,
} from '../dist/client/mesh-groups.js'
import { fetchRoster, NATIVE_LINK, rosterFromGlobal } from '../dist/client/roster.js'

// ---- groupByMachine: the switch menu's machine sections --------------------

test('grouping: the local group is FIRST under the fixed "This machine" label; remotes sort by label then key', () => {
  // Appearance order deliberately hostile: remotes first, and the label
  // order (Dev 3 → Lab → Alpha) is NOT the wanted section order.
  const rows = [
    { key: 'native', label: 'DSH', path: '/', machine: 'local' },
    { key: 'codex', label: 'Codex · dev3', path: '/hub/?agent=codex', machine: 'k3f9' },
    { key: 'omp', label: 'OMP', path: '/omp/', machine: 'local' },
    { key: 'claude', label: 'Claude · lab', path: '/hub/?agent=claude', machine: 'zZ7q' },
    { key: 'pi', label: 'Pi · alpha', path: '/hub/?agent=pi', machine: 'm1a2' },
    { key: 'hermes', label: 'Hermes · alpha', path: '/hub/?agent=hermes', machine: 'm1a2' },
  ]
  const labels = { k3f9: 'Dev 3', zZ7q: 'Lab', m1a2: 'Alpha' }
  assert.deepEqual(groupByMachine(rows, labels), [
    { key: 'local', label: 'This machine', agents: [rows[0], rows[2]] },
    { key: 'm1a2', label: 'Alpha', agents: [rows[4], rows[5]] },
    { key: 'k3f9', label: 'Dev 3', agents: [rows[1]] },
    { key: 'zZ7q', label: 'Lab', agents: [rows[3]] },
  ])
})

test('grouping: members keep the roster order inside their group (no re-sort of agents)', () => {
  const rows = [
    { key: 'z-late', label: 'Zeta', path: '/hub/?agent=z-late', machine: 'k3f9' },
    { key: 'a-early', label: 'Alpha', path: '/hub/?agent=a-early', machine: 'k3f9' },
  ]
  const groups = groupByMachine(rows, { k3f9: 'Dev 3' })
  assert.equal(groups.length, 1, 'remote-only roster: one group, no empty local group')
  assert.deepEqual(groups[0].agents, [rows[0], rows[1]], 'given order kept — the wire order is the section order')
})

test('grouping: a label tie breaks by key (deterministic sections)', () => {
  const rows = [
    { key: 'omp', label: 'OMP', path: '/hub/?agent=omp', machine: 'b200' },
    { key: 'codex', label: 'Codex', path: '/hub/?agent=codex', machine: 'a100' },
  ]
  const groups = groupByMachine(rows, { b200: 'Lab', a100: 'Lab' })
  assert.deepEqual(groups.map((g) => g.key), ['a100', 'b200'])
  assert.deepEqual(groups.map((g) => g.label), ['Lab', 'Lab'])
})

test('grouping: machine absent or "local" both land in the local group (the parse boundary may drop unknowns)', () => {
  const rows = [
    { key: 'omp', label: 'OMP', path: '/omp/' },
    { key: 'native', label: 'DSH', path: '/', machine: 'local' },
    { key: 'codex', label: 'Codex', path: '/codex/', machine: undefined },
  ]
  assert.deepEqual(groupByMachine(rows, {}), [
    { key: 'local', label: 'This machine', agents: [rows[0], rows[1], rows[2]] },
  ])
})

test('grouping: an empty labels map (or empty-string entries) falls back to the raw m4 key', () => {
  const rows = [
    { key: 'codex', label: 'Codex · dev3', path: '/hub/?agent=codex', machine: 'k3f9' },
    { key: 'pi', label: 'Pi · lab', path: '/hub/?agent=pi', machine: 'zZ7q' },
  ]
  // No labels at all: every section keeps its raw m4, sections sorted by label.
  assert.deepEqual(groupByMachine(rows, {}).map((g) => g.label), ['k3f9', 'zZ7q'])
  // An empty-string entry is as good as none: k3f9 falls back to the raw
  // key, and 'Lab' (the known label) sorts before it.
  assert.deepEqual(groupByMachine(rows, { k3f9: '', zZ7q: 'Lab' }).map((g) => g.label), ['Lab', 'k3f9'])
})

test('grouping: degenerate inputs — empty roster is no groups; the all-local wire shape is ONE group', () => {
  assert.deepEqual(groupByMachine([], { k3f9: 'Dev 3' }), [])
  const localOnly = [
    { key: 'native', label: 'DSH', path: '/', machine: 'local' },
    { key: 'omp', label: 'OMP', path: '/omp/', machine: 'local' },
  ]
  assert.deepEqual(groupByMachine(localOnly, {}), [
    { key: 'local', label: 'This machine', agents: localOnly },
  ])
})

test('grouping: the constants are the wire spellings the UI and tests share', () => {
  assert.equal(LOCAL_MACHINE_KEY, 'local')
  assert.equal(LOCAL_MACHINE_LABEL, 'This machine')
})

// ---- machineLabelsFrom: the machines API answer → the label map -----------

test('labels map: every machine row maps id → label (label, name fallback already coerced), self rides along', () => {
  const list = {
    self: { id: 's3lf', label: 'this pc' },
    machines: [
      { id: 'k3f9', name: 'dev3', label: 'Dev 3', origin: 'https://dev3:4999', status: 'reachable', self: false },
      { id: 'zZ7q', name: 'lab2', label: 'lab2', origin: 'https://lab2:4999', status: 'pending', self: false },
    ],
  }
  assert.deepEqual(machineLabelsFrom(list), { k3f9: 'Dev 3', zZ7q: 'lab2', s3lf: 'this pc' })
})

test('labels map: an absent list is the empty map (the UI degrades to the flat roster)', () => {
  assert.deepEqual(machineLabelsFrom(undefined), {})
})

// ---- roster coercion: the machine field passthrough ------------------------

/** Seed + read the baked global, cleaning up so later tests see no stale roster. */
function readFromGlobal(agents) {
  globalThis.__DSH_AGENT_ROSTER__ = { agents }
  const links = rosterFromGlobal()
  delete globalThis.__DSH_AGENT_ROSTER__
  return links
}

test('coercion: a string machine passes through verbatim; the native base row stays local', () => {
  const links = readFromGlobal([
    { key: 'native', label: 'DSH', path: '/', machine: 'local' },
    { key: 'codex', label: 'Codex · dev3', path: '/hub/?agent=codex', machine: 'k3f9' },
  ])
  assert.equal(links[0].machine, 'local')
  assert.equal(links[1].machine, 'k3f9')
  assert.equal(NATIVE_LINK.machine, 'local')
})

test('coercion: unknown machine values are DROPPED to undefined (grouping treats absent as local)', () => {
  const links = readFromGlobal([
    { key: 'a', label: 'A', path: '/a/', machine: 42 },
    { key: 'b', label: 'B', path: '/b/', machine: null },
    { key: 'c', label: 'C', path: '/c/', machine: '' },
    { key: 'd', label: 'D', path: '/d/' },
  ])
  assert.deepEqual(links.map((l) => l.machine), [undefined, undefined, undefined, undefined])
  assert.equal('machine' in links[0], true, 'the key stays present with an undefined value — the shape is additive')
  // The dropped rows still group as local (the grouping contract above).
  assert.equal(groupByMachine(links, {}).length, 1)
  assert.equal(groupByMachine(links, {})[0].label, 'This machine')
})

test('coercion: fetchRoster keeps the passthrough end to end (stubbed fetch, agents shape)', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      agents: [
        { key: 'native', label: 'DSH', path: '/', machine: 'local' },
        { key: 'codex', label: 'Codex · dev3', path: '/hub/?agent=codex', machine: 'k3f9' },
        { key: 'omp', label: 'OMP', path: '/omp/' },
      ],
    }),
  })
  try {
    const roster = await fetchRoster()
    assert.deepEqual(roster.map((r) => r.machine), ['local', 'k3f9', undefined])
  } finally {
    globalThis.fetch = realFetch
  }
})
