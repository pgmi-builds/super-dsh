// Agent short ids (mesh P1, spec §3.2): lazy a6 mint per roster key, deduped
// against every id already in the map, persisted 0600 atomic; corrupt or
// missing files degrade to {} and never throw. Every home here is a tmpdir —
// the suite env may carry the PROD DSH_HOME, so nothing relies on ambient env.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAgentId, agentIdMap } from '../dist/agent-ids.js'

const home = () => mkdtempSync(join(tmpdir(), 'superd-agentids-'))
const idsFile = (h) => join(h, 'superd', 'agent-ids.json')

test('ensureAgentId: a6 mint + idempotent + persisted', () => {
  const h = home()
  try {
    const a = ensureAgentId(h, 'omp')
    assert.match(a, /^[a-z0-9]{6}$/)
    assert.equal(ensureAgentId(h, 'omp'), a, 'already-minted label returns the same id')
    assert.deepEqual(agentIdMap(h), { omp: a })
    const raw = JSON.parse(readFileSync(idsFile(h), 'utf8'))
    assert.deepEqual(raw, { omp: a })
    assert.equal(statSync(idsFile(h)).mode & 0o777, 0o600, 'store is 0600')
    assert.equal(existsSync(`${idsFile(h)}.tmp`), false, 'no tmp leftover — atomic rename')
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('ensureAgentId: `native` gets an id like any other label', () => {
  const h = home()
  try {
    const id = ensureAgentId(h, 'native')
    assert.match(id, /^[a-z0-9]{6}$/)
    assert.deepEqual(agentIdMap(h), { native: id })
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('ensureAgentId: dedupes against every id already in the map', () => {
  const h = home()
  try {
    // Seed the map by hand with an id a fresh mint must not collide with.
    mkdirSync(join(h, 'superd'), { recursive: true })
    writeFileSync(idsFile(h), JSON.stringify({ seeded: 'zzzzzz' }), 'utf8')
    const minted = [ensureAgentId(h, 'a'), ensureAgentId(h, 'b'), ensureAgentId(h, 'native')]
    const all = [...Object.values(agentIdMap(h))]
    assert.equal(all.includes('zzzzzz'), true, 'seeded id survives')
    assert.equal(new Set(all).size, all.length, 'no id is reused across the map')
    for (const id of minted) assert.notEqual(id, 'zzzzzz')
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('agentIdMap: missing and corrupt files degrade to {} (never throws)', () => {
  const h = home()
  try {
    assert.deepEqual(agentIdMap(h), {})
    mkdirSync(join(h, 'superd'), { recursive: true })
    writeFileSync(idsFile(h), '{corrupt', 'utf8')
    assert.deepEqual(agentIdMap(h), {})
    // Corrupt degrade self-heals: the next mint rewrites a valid store.
    const id = ensureAgentId(h, 'omp')
    assert.match(id, /^[a-z0-9]{6}$/)
    assert.deepEqual(agentIdMap(h), { omp: id })
    // Non-object JSON also degrades (a bare list is not a label→id map).
    writeFileSync(idsFile(h), '["not", "a", "map"]', 'utf8')
    assert.deepEqual(agentIdMap(h), {})
  } finally { rmSync(h, { recursive: true, force: true }) }
})
