// Client mesh view (mesh P1 Task 5): the pure halves of mesh-api.ts —
// wire-body → row-view coercion, the token-URL pre-check, and the import-time
// inertness contract. mesh-api.ts is node-safe by construction (no DOM, no
// react, no @deepseek-ai imports) and the host tsc emits it to
// dist/client/mesh-api.js precisely so this file can mirror the
// client-switch precedent: pure functions under `node --test`, no jsdom, and
// the fetch wrappers stay the browser's business (no network here).
import test from 'node:test'
import assert from 'node:assert/strict'

// Import-time network trap: loading the module must not touch fetch. The
// dynamic import below is the FIRST load of the module in this process, so
// the trap genuinely guards module-evaluation time.
const fetchCalls = []
const realFetch = globalThis.fetch
globalThis.fetch = (...args) => { fetchCalls.push(args); return realFetch(...args) }
const mesh = await import('../dist/client/mesh-api.js')
globalThis.fetch = realFetch

test('import is inert — no fetch happens at module load', () => {
  assert.equal(fetchCalls.length, 0)
  for (const name of ['fetchMachines', 'addMachine', 'removeMachine', 'reprobeMachine']) {
    assert.equal(typeof mesh[name], 'function', `${name} is exported as a function`)
  }
})

// ---- coerceMachineList: the wire answer → panel rows ------------------------

const FULL_BODY = {
  self: { id: 'a1b2', label: 'local' },
  machines: [
    {
      id: 'm4x9', name: 'dev3', label: 'Dev 3', origin: 'http://192.0.2.130:4999',
      enabled: true, addedAt: 123, status: 'reachable', lastProbeAt: 456,
    },
    {
      id: 'm7q1', name: 'lab2', label: '', origin: 'https://lab2.example.com:4999',
      enabled: true, addedAt: 234, status: 'auth-expired',
    },
  ],
}

test('coercion: a complete body maps to rows; self rides alongside, never per-row', () => {
  const view = mesh.coerceMachineList(FULL_BODY)
  assert.deepEqual(view.self, { id: 'a1b2', label: 'local' })
  assert.equal(view.machines.length, 2)
  assert.deepEqual(view.machines[0], {
    id: 'm4x9', name: 'dev3', label: 'Dev 3', origin: 'http://192.0.2.130:4999',
    status: 'reachable', lastProbeAt: 456, self: false,
  })
  // every status of the union survives the coercion untouched
  assert.equal(view.machines[1].status, 'auth-expired')
})

test('coercion: an empty label collapses to the name (the optional-label contract)', () => {
  const view = mesh.coerceMachineList(FULL_BODY)
  assert.equal(view.machines[1].label, 'lab2', 'label omitted/blank on the wire → the row name')
  assert.equal('lastProbeAt' in view.machines[1], false, 'an absent lastProbeAt stays absent')
})

test('coercion: self is DERIVED — a machines row whose id is the self id flags true', () => {
  const view = mesh.coerceMachineList({
    self: { id: 'a1b2', label: 'local' },
    machines: [{ id: 'a1b2', name: 'me', label: 'me', origin: 'http://here', status: 'reachable' }],
  })
  assert.equal(view.machines[0].self, true)
  // and the self flag never leaks from the raw row shape itself
  const view2 = mesh.coerceMachineList({ machines: [{ id: 'a1b2', name: 'x', origin: 'http://x', self: true }] })
  assert.equal(view2.machines[0].self, false, 'no self block on the wire → self:false even if the row claims otherwise')
})

test('coercion: missing required fields drop the row; missing status means pending', () => {
  const view = mesh.coerceMachineList({
    machines: [
      { name: 'no-id', origin: 'http://x' },
      { id: 'm1', origin: 'http://x' },
      { id: 'm2', name: 'no-origin' },
      { id: '', name: 'empty-id', origin: 'http://x' },
      { id: 'm3', name: 'ok', origin: 'http://x' },
      { id: 'm4', name: 'bogus-status', label: 'b', origin: 'http://x', status: 'on-fire' },
      { id: 'm5', name: 'bad-probe', label: 'b', origin: 'http://x', status: 'reachable', lastProbeAt: 'yesterday' },
    ],
  })
  assert.deepEqual(view.machines.map((m) => m.id), ['m3', 'm4', 'm5'])
  assert.equal(view.machines.find((m) => m.id === 'm3').status, 'pending', 'no status on the wire → pending')
  assert.equal(view.machines.find((m) => m.id === 'm4').status, 'pending', 'unknown status string → pending, row kept')
  assert.equal('lastProbeAt' in view.machines.find((m) => m.id === 'm5'), false, 'non-number lastProbeAt dropped')
  assert.equal(view.self, undefined, 'no usable self block → self omitted, rows still render')
})

test('coercion: bad types degrade — never a crash, never a partial row', () => {
  for (const raw of [null, undefined, 42, 'nope', [], [{ id: 'm1', name: 'x', origin: 'http://x' }], true]) {
    assert.deepEqual(mesh.coerceMachineList(raw), { machines: [] }, `raw ${JSON.stringify(raw)} → the empty list`)
  }
  // object shapes with a broken machines field
  assert.deepEqual(mesh.coerceMachineList({}), { machines: [] })
  assert.deepEqual(mesh.coerceMachineList({ machines: 'nope' }), { machines: [] })
  assert.deepEqual(mesh.coerceMachineList({ machines: {} }), { machines: [] })
  // entries that are not objects are skipped, valid siblings survive
  const mixed = mesh.coerceMachineList({ machines: [42, null, 'x', FULL_BODY.machines[0]] })
  assert.equal(mixed.machines.length, 1)
  assert.equal(mixed.machines[0].id, 'm4x9')
})

test('coercion: a broken self block is dropped while machines still coerce', () => {
  for (const bad of ['self', 42, {}, { id: 'a1b2' }, { id: '', label: 'local' }, { id: 7, label: 'local' }, []]) {
    const view = mesh.coerceMachineList({ self: bad, machines: FULL_BODY.machines })
    assert.equal(view.self, undefined, `self ${JSON.stringify(bad)} → omitted`)
    assert.equal(view.machines.length, 2)
    assert.equal(view.machines.every((m) => m.self === false), true)
  }
})

test('coercion: the legitimate empty body — self present, machines empty', () => {
  assert.deepEqual(mesh.coerceMachineList({ self: { id: 'a1b2', label: 'local' }, machines: [] }), {
    self: { id: 'a1b2', label: 'local' },
    machines: [],
  })
})

// ---- validTokenUrl: the client-side pre-check -------------------------------

test('validTokenUrl: absolute http(s) URLs with a non-empty token param pass', () => {
  for (const good of [
    'http://192.0.2.130:4999/?token=abc123',
    'https://test.pc.internal.test/?token=xyz',
    'https://host.example.com/hub/?token=t&other=1',
    'http://user:pw@h:4999/?token=zzz',
  ]) {
    assert.equal(mesh.validTokenUrl(good), true, good)
  }
})

test('validTokenUrl: everything else is rejected before the wire', () => {
  for (const bad of [
    '',                                   // empty
    'not a url',                         // junk
    '/relative?token=1',                 // relative — no authority
    'relative?token=1',                  // relative
    'localhost:4999/?token=1',           // parses, but scheme 'localhost:' not http(s)
    'ftp://h/?token=1',                  // wrong scheme
    'mailto:a@b?token=1',                // wrong scheme
    'http://',                           // no authority at all
    'https://host:4999/',                // no token param
    'https://host:4999/?TOKEN=x',        // param name is case-sensitive
    'https://host:4999/?token',          // bare param → empty value
    'https://host:4999/?token=',         // empty value
  ]) {
    assert.equal(mesh.validTokenUrl(bad), false, bad)
  }
})

// ---- addMachine request body: the gateUrl field rides only when set -------

test('addMachine body: gateUrl included when set, absent otherwise (label contract unchanged)', async () => {
  const bodies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => { bodies.push(init); return new Response('{}', { status: 201 }) }
  try {
    await mesh.addMachine({ name: 'dev3', tokenUrl: 'http://h:1/?token=abc', label: 'DEV3', gateUrl: 'https://h/gate-x' })
    await mesh.addMachine({ name: 'dev3', tokenUrl: 'http://h:1/?token=abc' })
  } finally {
    globalThis.fetch = realFetch
  }
  const withGate = JSON.parse(bodies[0].body)
  const bare = JSON.parse(bodies[1].body)
  assert.equal(withGate.gateUrl, 'https://h/gate-x')
  assert.equal(withGate.label, 'DEV3')
  assert.equal('gateUrl' in bare, false)
  assert.equal(bare.name, 'dev3')
  assert.equal(bare.tokenUrl, 'http://h:1/?token=abc')
})
