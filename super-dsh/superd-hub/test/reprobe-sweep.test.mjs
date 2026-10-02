// I1(a) periodic reprobe sweep (mesh P3 Task 5a, user mandate "状态更新走
// 单向 API + 5 分钟周期轮询"): the sweep body (`runReprobeSweep`) probes
// every ENABLED remote through the real reprobeMachine (so success converges
// federation and failure degrades — the existing hooks), and the timer
// wrapper (`startReprobeSweep`) enforces the discipline: interval default
// 5min floored at 60s, unref'd handle, no overlap (a tick while the previous
// sweep is in flight is skipped), per-machine errors never reject the sweep,
// and the disposer clears the timer (and kills late ticks). The fake clock
// is injected through the setInterval/clearInterval seams — no real timers
// run here; fetch is faked so no network leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startReprobeSweep,
  runReprobeSweep,
  machineStatus,
  resetMachineStatus,
  onMeshFederationEvent,
  REPROBE_SWEEP_DEFAULT_SEC,
  REPROBE_SWEEP_MIN_SEC,
} from '../dist/mesh-link.js'
import { upsertRemote } from '../dist/machines.js'

const home = () => mkdtempSync(join(tmpdir(), 'superd-reprobe-sweep-'))

function row(id, origin, enabled = true) {
  return { id, name: id, label: id, origin, enabled, addedAt: 1 }
}

/** Roster-answer fetch fixture: every call is recorded; origins starting
 *  with `dead` reject (network failure); everything else gets a 200 roster
 *  with a hub block. Deferred mode lets a test HOLD the sweep in flight. */
function sweepFetch(log, { deadPrefix = 'dead', defer = false } = {}) {
  const pending = []
  const fetchImpl = (input) => {
    const url = String(input)
    log.push(url)
    if (defer) return new Promise((resolve) => { pending.push({ url, resolve }) })
    if (url.startsWith(`http://${deadPrefix}`)) return Promise.reject(new Error('connection refused'))
    return Promise.resolve(new Response(
      JSON.stringify({ available: true, agents: [], hub: { machineId: 'k3f9', version: '0.1.0' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
  }
  fetchImpl.release = () => {
    for (const p of pending.splice(0)) p.resolve(new Response(
      JSON.stringify({ available: true, agents: [], hub: { machineId: 'k3f9', version: '0.1.0' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
  }
  return fetchImpl
}

test('runReprobeSweep：enabled 全探测、disabled 跳过、单机失败不炸整扫，事件走既有钩子', async () => {
  resetMachineStatus()
  const events = []
  const off = onMeshFederationEvent((e) => { events.push(e) })
  const h = home()
  const log = []
  try {
    upsertRemote(h, row('aaaa', 'http://ok1'))
    upsertRemote(h, row('bbbb', 'http://ok2'))
    upsertRemote(h, row('cccc', 'http://off', false))
    upsertRemote(h, row('dddd', 'http://dead1'))
    await runReprobeSweep({ home: h, fetchImpl: sweepFetch(log) })

    assert.ok(log.some((u) => u.startsWith('http://ok1')), 'enabled row 1 probed')
    assert.ok(log.some((u) => u.startsWith('http://ok2')), 'enabled row 2 probed')
    assert.ok(log.some((u) => u.startsWith('http://dead1')), 'the failing enabled row still got its attempt')
    assert.ok(!log.some((u) => u.startsWith('http://off')), 'the disabled row is skipped')

    const status = machineStatus()
    assert.equal(status.get('aaaa').status, 'reachable')
    assert.equal(status.get('bbbb').status, 'reachable')
    assert.equal(status.get('dddd').status, 'unreachable', 'the failed machine records its outcome (existing degrade)')
    assert.equal(status.get('cccc'), undefined, 'the disabled machine has no status entry')
    assert.ok(events.some((e) => e.type === 'federated' && e.machineId === 'aaaa'), 'success → federation converges (existing hook)')
    assert.ok(events.some((e) => e.type === 'degraded' && e.machineId === 'dddd'), 'failure → existing degrade')
  } finally {
    off()
    rmSync(h, { recursive: true, force: true })
    resetMachineStatus()
  }
})

test('startReprobeSweep：默认 5min、下限 60s、句柄 unref、无重叠、dispose 清理', async () => {
  resetMachineStatus()
  const h = home()
  upsertRemote(h, row('aaaa', 'http://ok1'))
  const seen = { intervals: [], cleared: [], unrefs: 0, log: [] }
  let tick = undefined
  const setIntervalFn = (fn, ms) => { tick = fn; seen.intervals.push(ms); return { unref: () => { seen.unrefs += 1 } } }
  const clearIntervalFn = (handle) => { seen.cleared.push(handle) }
  const fetchImpl = sweepFetch(seen.log, { defer: true })

  const dispose = startReprobeSweep({ home: h, fetchImpl, setIntervalFn, clearIntervalFn })
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
  try {
    assert.equal(seen.intervals.length, 1)
    assert.equal(seen.intervals[0], REPROBE_SWEEP_DEFAULT_SEC * 1000, 'default interval is the 5-minute mandate')
    assert.equal(REPROBE_SWEEP_DEFAULT_SEC, 300)
    assert.equal(seen.unrefs, 1, 'the timer handle is unref’d — a freshness sweep never holds the process open')

    tick() // first sweep starts; the deferred fetch holds it in flight
    await settle()
    assert.equal(seen.log.length, 1, 'one probe attempt in flight')
    tick() // overlap: previous sweep still running → skipped
    await settle()
    assert.equal(seen.log.length, 1, 'a tick while the previous sweep is in flight is skipped (no overlap)')

    fetchImpl.release()
    await settle()
    assert.equal(machineStatus().get('aaaa').status, 'reachable', 'the sweep settled through the real reprobe path')

    tick() // free again → a fresh sweep runs
    await settle()
    assert.equal(seen.log.length, 2, 'after settling, the next tick sweeps again')

    dispose()
    assert.equal(seen.cleared.length, 1, 'dispose clears the interval')
    tick() // a late tick after dispose must be inert
    await settle()
    assert.equal(seen.log.length, 2, 'no sweep after dispose')
    dispose() // idempotent
    assert.equal(seen.cleared.length, 1)
  } finally {
    dispose()
    rmSync(h, { recursive: true, force: true })
    resetMachineStatus()
  }
})

test('startReprobeSweep：immediate:true 启动即先跑一次（O1：免去重启后一个周期的 roster 空窗）', async () => {
  resetMachineStatus()
  const h = home()
  upsertRemote(h, row('aaaa', 'http://ok1'))
  const seen = { intervals: [], log: [] }
  const setIntervalFn = (fn, ms) => { seen.intervals.push(ms); return { unref: () => {} } }
  const clearIntervalFn = () => {}
  const fetchImpl = sweepFetch(seen.log, { defer: true })
  const dispose = startReprobeSweep({ home: h, fetchImpl, setIntervalFn, clearIntervalFn, immediate: true })
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
  try {
    await settle()
    assert.equal(seen.log.length, 1, 'the boot tick probed the paired machine WITHOUT waiting a full period')
    fetchImpl.release()
    await settle()
    assert.equal(machineStatus().get('aaaa').status, 'reachable', 'the roster is filled at boot')
  } finally {
    dispose()
    rmSync(h, { recursive: true, force: true })
    resetMachineStatus()
  }
})

test('startReprobeSweep：intervalSec 低于下限被钳到 60s（配置兜底，双层保险）', () => {
  const seen = { intervals: [], cleared: [], unrefs: 0 }
  const dispose = startReprobeSweep({
    home: home(),
    intervalSec: 1,
    setIntervalFn: (fn, ms) => { seen.intervals.push(ms); return { unref: () => { seen.unrefs += 1 } } },
    clearIntervalFn: (h2) => { seen.cleared.push(h2) },
  })
  try {
    assert.equal(REPROBE_SWEEP_MIN_SEC, 60)
    assert.equal(seen.intervals[0], 60_000, 'a configured interval below the floor is clamped to the 60s minimum')
  } finally {
    dispose()
  }
})
