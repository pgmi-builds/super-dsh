import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { receivePairing, reprobeMachine, resetMachineStatus, machineStatus, pairMachine, emitMachineRemoved, cookieOf, onMeshFederationEvent } from '../dist/mesh-link.js'
import { ensureSelf, listRemotes, upsertRemote, removeRemote } from '../dist/machines.js'
import { handleMeshMachines } from '../dist/mesh-rpc.js'

const makeHome = () => mkdtempSync(join(tmpdir(), 'superd-reciprocal-'))
const offer = (over = {}) => ({ machineId: 'r123', name: 'sender', tokenUrl: 'http://127.0.0.1:4997/?token=SECRET', ...over })
function carrier() {
  const state = { reachable: false, machineId: 'r123', calls: 0 }
  state.fetch = async (input) => {
    state.calls++
    if (!state.reachable) throw new Error('offline')
    if (String(input).includes('?token=')) return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-test=valid; Path=/' } })
    return new Response(JSON.stringify({ hub: { machineId: state.machineId, version: '0.3.0-e' }, agents: [] }), { headers: { 'content-type': 'application/json' } })
  }
  return state
}

test('UID self guard runs before any dial, including a custom-scheme address', async () => {
  const home = makeHome()
  try {
    const self = ensureSelf(home, 'receiver')
    const fetchImpl = () => { assert.fail('self must not dial') }
    const out = await receivePairing(home, offer({ machineId: self.id, tokenUrl: 'dsh-app://app/?token=SECRET' }), { fetchImpl })
    assert.equal(out.skipped, 'self')
    assert.equal(listRemotes(home).length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('failed inbound connection persists by offered UID, survives restart, and recovers', async () => {
  resetMachineStatus()
  const home = makeHome(), state = carrier()
  try {
    const out = await receivePairing(home, offer(), { fetchImpl: state.fetch })
    assert.equal(out.ok, false)
    assert.equal(listRemotes(home)[0].id, 'r123')
    assert.equal(listRemotes(home)[0].incoming, true)
    assert.equal(machineStatus().get('r123').status, 'unreachable')
    resetMachineStatus()
    const view = await (await handleMeshMachines(new Request('http://receiver/api/superd/machines'), { home })).json()
    assert.equal(view.machines[0].status, 'unreachable')
    assert.ok(!JSON.stringify(view).includes('SECRET'))
    state.reachable = true
    const probe = await reprobeMachine(home, 'r123', { fetchImpl: state.fetch })
    assert.equal(probe.ok, true)
    assert.equal(machineStatus().get('r123').status, 'reachable')
    assert.equal(listRemotes(home).length, 1)
    assert.equal(listRemotes(home)[0].cookie, 'dsh-auth-test=valid')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('custom-scheme offers are retained instead of being rejected before registration', async () => {
  const home = makeHome()
  try {
    const out = await receivePairing(home, offer({ tokenUrl: 'dsh-app://app/?token=SECRET' }))
    assert.equal(out.ok, false)
    assert.equal(listRemotes(home)[0].origin, 'dsh-app://app')
    assert.equal(listRemotes(home)[0].token, 'SECRET')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('another loopback instance is allowed, but its authenticated UID must match', async () => {
  resetMachineStatus()
  const home = makeHome(), state = carrier()
  state.reachable = true
  try {
    state.machineId = 'wrong'
    assert.equal((await receivePairing(home, offer(), { fetchImpl: state.fetch })).ok, false)
    assert.equal(listRemotes(home)[0].cookie, undefined)
    assert.equal((await reprobeMachine(home, 'r123', { fetchImpl: state.fetch })).ok, false)
    assert.equal(machineStatus().get('r123').status, 'unreachable')
    state.machineId = 'r123'
    assert.equal((await reprobeMachine(home, 'r123', { fetchImpl: state.fetch })).ok, true)
    assert.equal(listRemotes(home).length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('duplicate UID reuses its verified endpoint and preserves user switches', async () => {
  const home = makeHome()
  try {
    upsertRemote(home, { id: 'r123', name: 'chosen-name', origin: 'http://healthy', cookie: 'dsh-auth-x=ok', enabled: false, execEnabled: false, addedAt: 1 })
    const out = await receivePairing(home, offer(), { fetchImpl: async (url, init) => {
      assert.ok(String(url).startsWith('http://healthy/')); assert.equal(init.headers.cookie, 'dsh-auth-x=ok')
      return new Response(JSON.stringify({ hub: { machineId: 'r123' }, agents: [] }))
    } })
    assert.equal(out.ok, true)
    assert.equal(out.skipped, 'already-paired')
    assert.equal(listRemotes(home)[0].name, 'chosen-name')
    assert.equal(listRemotes(home)[0].enabled, false)
    assert.equal(listRemotes(home)[0].execEnabled, false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('API receives UID offer, returns explicit reverse outcome and never offers back', async () => {
  resetMachineStatus()
  const home = makeHome(), state = carrier()
  try {
    const res = await handleMeshMachines(new Request('http://receiver/api/superd/machines', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...offer(), mutual: true }) }), { home, fetchImpl: state.fetch })
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(body.reciprocal.ok, false)
    assert.equal(body.machine.status, 'unreachable')
    assert.equal(body.mutual, undefined)
  } finally { rmSync(home, { recursive: true, force: true }) }
})


test('a removed UID never lends its previous cookie to a newly offered address', async () => {
  resetMachineStatus()
  const home = makeHome(), state = carrier(); state.reachable = true
  try {
    await receivePairing(home, offer(), { fetchImpl: state.fetch })
    removeRemote(home, 'r123'); emitMachineRemoved('r123')
    assert.equal(cookieOf('r123', home), '')
    const calls = []
    await receivePairing(home, offer({ tokenUrl: 'http://new-address/?token=NEW' }), { fetchImpl: async (url, init) => {
      calls.push({ url: String(url), cookie: init?.headers?.cookie }); return state.fetch(url, init)
    } })
    assert.ok(calls[0].url.startsWith('http://new-address/?token='))
    assert.equal(calls[0].cookie, undefined)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a stale failed offer cannot degrade a newer verified pairing', async () => {
  resetMachineStatus()
  const home = makeHome(), state = carrier(); state.reachable = true
  let reject
  const events = [], off = onMeshFederationEvent(e => events.push(e))
  try {
    const older = receivePairing(home, offer({ tokenUrl: 'http://old/?token=OLD' }), { fetchImpl: () => new Promise((_, r) => { reject = r }) })
    assert.equal((await receivePairing(home, offer(), { fetchImpl: state.fetch })).ok, true)
    reject(new Error('old offline')); assert.equal((await older).ok, false)
    assert.equal(machineStatus().get('r123').status, 'reachable')
    assert.equal(listRemotes(home)[0].origin, 'http://127.0.0.1:4997')
    assert.ok(!events.some(e => e.type === 'degraded'))
  } finally { off(); rmSync(home, { recursive: true, force: true }) }
})

test('tokenless incoming offers stay gray even if an anonymous roster matches', async () => {
  resetMachineStatus()
  const home = makeHome(), state = carrier(); state.reachable = true
  const events = [], off = onMeshFederationEvent(e => events.push(e))
  try {
    assert.equal((await receivePairing(home, offer({ tokenUrl: 'http://public/' }), { fetchImpl: state.fetch })).ok, false)
    assert.equal(listRemotes(home)[0].cookie, undefined)
    assert.equal(machineStatus().get('r123').status, 'unreachable')
    assert.ok(!events.some(e => e.type === 'federated'))
  } finally { off(); rmSync(home, { recursive: true, force: true }) }
})

test('generic successful HTTP responses never prove mutual pairing', async () => {
  for (const response of [() => new Response(''), () => new Response('{}'), () => new Response('{"reciprocal":{"ok":"yes"}}')]) {
    const home = makeHome(), state = carrier(); state.reachable = true
    try {
      const out = await pairMachine(home, { ...offer(), mutual: { selfName: 'own', selfTokenUrl: 'dsh-app://app/?token=OWN' } }, {
        fetchImpl: (url, init) => String(url).endsWith('/machines') ? response() : state.fetch(url, init),
      })
      assert.equal(out.mutual.ok, false)
      assert.equal(listRemotes(home).length, 1)
    } finally { rmSync(home, { recursive: true, force: true }) }
  }
})


test('manual promotion cannot resurrect an incoming row removed during dialing', async () => {
  resetMachineStatus()
  const home = makeHome(), state = carrier(); state.reachable = true
  try {
    await receivePairing(home, offer(), { fetchImpl: async () => { throw new Error('offline') } })
    let release
    const pending = pairMachine(home, offer(), { fetchImpl: async (url, init) => {
      if (String(url).includes('?token=')) await new Promise(resolve => { release = resolve })
      return state.fetch(url, init)
    } })
    removeRemote(home, 'r123'); emitMachineRemoved('r123'); release()
    await assert.rejects(pending, /removed during pairing/)
    assert.equal(listRemotes(home).length, 0)
    assert.equal(machineStatus().get('r123'), undefined)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('an unverified incoming auth failure remains gray', async () => {
  resetMachineStatus()
  const home = makeHome()
  try {
    const out = await receivePairing(home, offer(), { fetchImpl: async url => String(url).includes('?token=')
      ? new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-x=invalid' } })
      : new Response(null, { status: 401 }) })
    assert.equal(out.ok, false)
    assert.equal(listRemotes(home)[0].cookie, undefined)
    assert.equal(machineStatus().get('r123').status, 'unreachable')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
