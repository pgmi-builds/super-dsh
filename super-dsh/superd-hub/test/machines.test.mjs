import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mintShortId, ensureSelf, upsertRemote, removeRemote, listRemotes, loadMachines } from '../dist/machines.js'

const home = () => mkdtempSync(join(tmpdir(), 'superd-machines-'))

test('mintShortId: 长度、字符集、查重重铸', () => {
  const taken = new Set(['ab12'])
  const id = mintShortId(4, taken)
  assert.match(id, /^[a-z0-9]{4}$/)
  assert.notEqual(id, 'ab12')
  const a6 = mintShortId(6, [])
  assert.match(a6, /^[a-z0-9]{6}$/)
})

test('ensureSelf: 惰性铸造 + 持久 + 幂等', () => {
  const h = home()
  try {
    const first = ensureSelf(h, 'pc')
    assert.match(first.id, /^[a-z0-9]{4}$/)
    assert.equal(first.label, 'pc')
    const again = ensureSelf(h, 'changed')  // 已铸：不重铸不改 label
    assert.equal(again.id, first.id)
    assert.equal(again.label, 'pc')
    const raw = JSON.parse(readFileSync(join(h, 'superd', 'machines.json'), 'utf8'))
    assert.equal(raw.self.id, first.id)
    const mode = statSync(join(h, 'superd', 'machines.json')).mode & 0o777
    assert.equal(mode, 0o600)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('remotes CRUD 全量持久化；损坏文件降级为空', () => {
  const h = home()
  try {
    upsertRemote(h, { id: 'k3f9', name: 'dev3', origin: 'http://192.0.2.3:4999', token: 'x', enabled: true, addedAt: 1 })
    assert.equal(listRemotes(h).length, 1)
    upsertRemote(h, { id: 'k3f9', name: 'dev3b', origin: 'http://192.0.2.3:4999', enabled: true, addedAt: 1 }) // 同 id 覆盖
    assert.equal(listRemotes(h)[0].name, 'dev3b')
    assert.equal(removeRemote(h, 'k3f9'), true)
    assert.equal(removeRemote(h, 'k3f9'), false)
    assert.deepEqual(listRemotes(h), [])
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('旧注册表的 label 列容错读入、内存即弃、下次写盘消失（大写中间态退役）', () => {
  const h = home()
  try {
    mkdirSync(join(h, 'superd'), { recursive: true })
    // 旧形态：行带独立 label 字段（用户看到的 DEV3 中间态）。
    writeFileSync(join(h, 'superd', 'machines.json'), JSON.stringify({
      self: { id: 'egv8', label: 'local' },
      remotes: [{ id: 'k3f9', name: 'dev3', label: 'DEV3', origin: 'http://192.0.2.3:4999', enabled: true, addedAt: 1 }],
    }), 'utf8')
    const loaded = loadMachines(h)
    assert.equal(loaded.self.id, 'egv8')
    assert.deepEqual(loaded.remotes, [{ id: 'k3f9', name: 'dev3', origin: 'http://192.0.2.3:4999', enabled: true, addedAt: 1 }])
    // 下一次写盘：文件里不再有 label。
    upsertRemote(h, { id: 'k3f9', name: 'dev3', origin: 'http://192.0.2.3:4999', enabled: true, addedAt: 1 })
    const raw = JSON.parse(readFileSync(join(h, 'superd', 'machines.json'), 'utf8'))
    assert.equal(raw.remotes[0].label, undefined)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('loadMachines: 缺失与损坏都降级', () => {
  const h = home()
  try {
    assert.deepEqual(loadMachines(h), { self: { id: '', label: '' }, remotes: [] })
    mkdirSync(join(h, 'superd'), { recursive: true })
    writeFileSync(join(h, 'superd', 'machines.json'), '{corrupt', 'utf8')
    assert.deepEqual(loadMachines(h), { self: { id: '', label: '' }, remotes: [] })
  } finally { rmSync(h, { recursive: true, force: true }) }
})
