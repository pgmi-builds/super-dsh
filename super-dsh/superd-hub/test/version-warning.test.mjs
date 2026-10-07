// I2 version-mismatch (mesh P3 Task 5a): the pure comparator + its landing
// in the mesh-link status table. probeMachine already parses `hub.version`;
// the pair/reprobe paths now compute a warning when the peer's superd
// version differs from OURS by more than patch (diff major/minor → warn,
// same core → clean, unparsable → warn 'unknown'). Unit cases run against
// versionWarningFor directly with an explicit `ours`; the integration cases
// run the real pairMachine/reprobeMachine against a loopback hub fixture and
// read the module status table — the comparator's production `ours` is the
// super-dsh PACK version (D6: the hub subpackage's constant 0.1.0 made the
// comparator dead; OWN_VERSION is exported to pin it to the real manifest).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { versionWarningFor, pairMachine, reprobeMachine, machineStatus, resetMachineStatus, OWN_VERSION } from '../dist/mesh-link.js'
import { upsertRemote } from '../dist/machines.js'

const home = () => mkdtempSync(join(tmpdir(), 'superd-version-warn-'))

/** The hub package's own version — the comparator's production `ours`. */
const OURS = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

// ---- the production input (D6) ----------------------------------------------

test('OWN_VERSION (D6): the comparator\'s production `ours` IS the pack manifest version', () => {
  assert.equal(OWN_VERSION, OURS, 'OWN_VERSION must track super-dsh/package.json, not the hub subpackage constant')
  assert.notEqual(OWN_VERSION, '0.1.0', 'the dead constant would silence every real mismatch')
})

// ---- the pure comparator ----------------------------------------------------

test('versionWarningFor：same / same-patch → undefined（干净）', () => {
  assert.equal(versionWarningFor('0.1.0', '0.1.0'), undefined)
  assert.equal(versionWarningFor('0.1.9', '0.1.0'), undefined, 'same major+minor, patch diff = clean')
  assert.equal(versionWarningFor('v1.2.3', '1.2.0'), undefined, 'leading v tolerated, patch ignored')
  assert.equal(versionWarningFor('1.2.3-rc.1', '1.2.0'), undefined, 'prerelease suffix tolerated')
  assert.equal(versionWarningFor('1.2', '1.2.4'), undefined, 'missing patch segment tolerated')
})

test('versionWarningFor：diff-minor / diff-major → warning naming both versions', () => {
  const minor = versionWarningFor('0.2.0', '0.1.0')
  assert.ok(typeof minor === 'string' && minor !== '', 'diff minor warns')
  assert.ok(minor.includes('0.2.0') && minor.includes('0.1.0'), 'the warning names both sides')
  const major = versionWarningFor('1.0.0', '0.9.7')
  assert.ok(typeof major === 'string' && major.includes('1.0.0') && major.includes('0.9.7'))
})

test('versionWarningFor：unparsable / missing → unknown warning', () => {
  const garbage = versionWarningFor('garbage', '0.1.0')
  assert.ok(typeof garbage === 'string' && /unknown/i.test(garbage), 'garbage peer → warn unknown')
  const missing = versionWarningFor(undefined, '0.1.0')
  assert.ok(typeof missing === 'string' && /unknown/i.test(missing), 'peer carrying no version → warn unknown')
  const oursBad = versionWarningFor('0.1.0', 'not-semver')
  assert.ok(typeof oursBad === 'string' && /unknown/i.test(oursBad), 'defensive: unparsable ours → warn unknown')
})

// ---- the status-table landing (pair/reprobe record the warning) -------------

/** Minimal remote-hub fixture: mint answers 303 + Set-Cookie; the roster
 *  leg answers 200 with a configurable `hub.version` for ANY caller (the
 *  cookie path is already pinned in mesh-link.test.mjs — here only the
 *  version rides). `state.version` is mutable so one fixture can serve
 *  diff-minor then same-minor answers. */
function startVersionHub(version) {
  const state = { version }
  let seq = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      if (url.searchParams.get('token') !== 'ok') { res.statusCode = 403; res.end(); return }
      seq += 1
      res.statusCode = 303
      res.setHeader('Location', './')
      res.setHeader('Set-Cookie', `dsh-auth-v=${seq}; Path=/; HttpOnly; SameSite=Lax`)
      res.end()
      return
    }
    if (url.pathname === '/api/agent-runtime') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ available: true, agents: [], hub: { machineId: 'v9h2', version: state.version } }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        state,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(done) }),
      })
    })
  })
}

test('pairMachine：跨 minor 对端 → status 表带 versionWarning；警告含对端版本', async () => {
  resetMachineStatus()
  const [maj, min] = OURS.split('.').map(Number)
  const peerDiff = `${maj}.${min + 1}.0`
  const hub = await startVersionHub(peerDiff)
  const h = home()
  try {
    await pairMachine(h, { name: 'future', tokenUrl: `${hub.origin}/?token=ok` })
    const entry = machineStatus().get('v9h2')
    assert.ok(entry !== undefined)
    assert.equal(entry.status, 'reachable')
    assert.ok(typeof entry.versionWarning === 'string', 'diff-major/minor peer → warning lands in the status table')
    assert.ok(entry.versionWarning.includes(peerDiff))
  } finally {
    rmSync(h, { recursive: true, force: true })
    await hub.close()
    resetMachineStatus()
  }
})

test('reprobeMachine：警告是每次探测的现算值——回落同 minor 即清空', async () => {
  resetMachineStatus()
  const [maj, min] = OURS.split('.').map(Number)
  const peerDiff = `${maj}.${min + 1}.0`
  const peerSame = `${maj}.${min}.7`
  const hub = await startVersionHub(peerDiff)
  const h = home()
  upsertRemote(h, { id: 'v9h2', name: 'peer', label: 'peer', origin: hub.origin, enabled: true, addedAt: 1 })
  try {
    await reprobeMachine(h, 'v9h2')
    assert.ok(machineStatus().get('v9h2').versionWarning?.includes(peerDiff), 'diff-minor peer warns')

    hub.state.version = peerSame // roster answers the same-minor spelling from now on
    await reprobeMachine(h, 'v9h2')
    const entry = machineStatus().get('v9h2')
    assert.equal(entry.status, 'reachable')
    assert.equal(entry.versionWarning, undefined, 'same-minor peer on a later probe clears the warning (fresh computation per probe)')
  } finally {
    rmSync(h, { recursive: true, force: true })
    await hub.close()
    resetMachineStatus()
  }
})
