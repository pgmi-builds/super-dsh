// Control-plane RPC semantics after DL7 (no server-side selection):
// the face answers ONLY `available`; world ownership is per-request and
// travels on the mount path (`/<label>/...`), never through a global switch.
//
// Mesh P1 additive contract: the GET body gains `hub: {machineId, label,
// version}` and every agents row gains `id` (a6); `available` and all
// pre-existing agents fields are byte-identical, so old clients ignore the
// new fields. Every home is an explicit tmpdir — the suite env may carry the
// PROD DSH_HOME, so no path relies on ambient env.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAgentRuntime, registerSelectorRpc } from '../dist/rpc.js'
import { registerAgent, setFailed, unregisterAgent } from '../dist/index.js'
import { registerHostMount } from '../dist/world-host.js'
import { agentRosterRow } from '../dist/agent-roster.js'

const tmpHome = () => mkdtempSync(join(tmpdir(), 'superd-rpc-'))
const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

function fakeCtx() {
  const routes = []
  return {
    routes,
    inject(_deps, cb) { cb(this) },
    effect(fn) { fn(); return () => { } },
    connection: {
      fetch: {
        register(route) { routes.push(route); return async () => { } },
      },
    },
  }
}

test('GET exposes the available worlds AND the roster paths the selector navigates', async () => {
  const h = tmpHome()
  try {
    const source = { listRuntimes: () => ['native', 'omp'] }
    const res = await handleAgentRuntime(new Request('http://x/api/agent-runtime'), source, { home: h })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.available, ['native', 'omp'])
    // `agents` is the roster: native always, plus every key that currently owns a
    // host mount (none in this unit test), so the selector has a path per entry.
    // Additive shape: the old fields exactly as before, `id` the only addition.
    assert.deepEqual(Object.keys(body.agents[0]).sort(), ['failed', 'id', 'key', 'label', 'machine', 'path', 'ready'])
    const { id, ...native } = body.agents[0]
    assert.match(id, /^[a-z0-9]{6}$/)
    assert.deepEqual(native, { key: 'native', label: 'DSH', path: '/', machine: 'local', ready: true, failed: false })
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('GET adds the hub block additively: machineId + label + version, old fields untouched', async () => {
  const h = tmpHome()
  try {
    const source = { listRuntimes: () => ['native', 'omp'] }
    const res = await handleAgentRuntime(new Request('http://x/api/agent-runtime'), source, { home: h })
    const body = await res.json()
    // Additive proof: `available` is byte-identical to the pre-mesh wire.
    assert.equal(JSON.stringify(body.available), JSON.stringify(['native', 'omp']))
    // The hub block: this machine's lazily-minted m4 identity + hub version.
    assert.match(body.hub.machineId, /^[a-z0-9]{4}$/)
    assert.equal(body.hub.label, 'local')
    assert.equal(body.hub.version, pkgVersion)
    // Identity is idempotent: a second GET on the same home keeps the machineId
    // and the row ids (both persisted, never re-minted).
    const again = await (await handleAgentRuntime(new Request('http://x/api/agent-runtime'), source, { home: h })).json()
    assert.equal(again.hub.machineId, body.hub.machineId)
    assert.equal(again.agents[0].id, body.agents[0].id)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('POST carries NO switch: selection is per-request (mount path)', async () => {
  const source = { listRuntimes: () => ['native', 'omp'] }
  const res = await handleAgentRuntime(
    new Request('http://x/api/agent-runtime', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'omp' }),
    }),
    source,
  )
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error, 'selection is per-request (mount path); no server-side switch')
  assert.deepEqual(body.available, ['native', 'omp'])
})

test('registerSelectorRpc mounts the control face on the shared /api channel (default home pinned)', async () => {
  const ctx = fakeCtx()
  registerSelectorRpc(ctx, { listRuntimes: () => ['native'] })
  assert.equal(ctx.routes.length, 1)
  // The registered route uses the DEFAULT home (registerSelectorRpc passes no
  // deps through); the suite env may carry the PROD DSH_HOME, so pin env to a
  // tmpdir for this call — resolveDshHome() reads it at call time.
  const h = tmpHome()
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = h
  try {
    const res = await ctx.routes[0].fetch(new Request('http://x/api/agent-runtime'))
    const body = await res.json()
    assert.deepEqual(body.available, ['native'])
    assert.match(body.agents[0].id, /^[a-z0-9]{6}$/)
    assert.match(body.hub.machineId, /^[a-z0-9]{4}$/)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    rmSync(h, { recursive: true, force: true })
  }
})

test('the roster wire carries machine on native AND adapter rows (local constant)', async () => {
  const h = tmpHome()
  registerAgent({ key: 'omp', label: 'OMP', ready: true })
  const disposeMount = registerHostMount({ key: 'omp', labelPath: '/omp' })
  try {
    const res = await handleAgentRuntime(new Request('http://x/api/agent-runtime'), {
      listRuntimes: () => ['native', 'omp'],
    }, { home: h })
    const body = await res.json()
    const [nativeId, ompId] = body.agents.map((a) => a.id)
    assert.match(nativeId, /^[a-z0-9]{6}$/)
    assert.match(ompId, /^[a-z0-9]{6}$/)
    assert.notEqual(nativeId, ompId, 'ids are deduped across rows')
    assert.deepEqual(
      body.agents.map(({ id, ...rest }) => rest),
      [
        { key: 'native', label: 'DSH', path: '/', machine: 'local', ready: true, failed: false },
        { key: 'omp', label: 'OMP', path: '/omp/', machine: 'local', ready: true, failed: false },
      ],
    )
    // The baked-index emitter (gateway's `webserver/index-inject` global,
    // seeding the first paint) projects the same rows — one wire shape. Same
    // home in, so the minted ids line up too.
    assert.deepEqual(agentRosterRow(h).value.agents, body.agents)
  } finally {
    disposeMount()
    unregisterAgent('omp')
    rmSync(h, { recursive: true, force: true })
  }
})

test('agent-runtime rows carry ready and failed for the switch pre-flight', async () => {
  const h = tmpHome()
  registerAgent({ key: 't-flags', label: 'TF', ready: false })
  setFailed('t-flags', true)
  const drop = registerHostMount({ key: 't-flags', labelPath: '/t-flags/' })
  try {
    const source = { listRuntimes: () => ['native', 't-flags'] }
    const res = await handleAgentRuntime(new Request('http://x/api/agent-runtime'), source, { home: h })
    const row = (await res.json()).agents.find((a) => a.key === 't-flags')
    assert.equal(row.ready, false)
    assert.equal(row.failed, true)
  } finally {
    drop()
    unregisterAgent('t-flags')
    rmSync(h, { recursive: true, force: true })
  }
})
