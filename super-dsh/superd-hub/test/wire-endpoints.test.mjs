// Session-plane wire vocabulary (mesh P3 Task 1). This is REFERENCE DATA:
// light structural assertions only — the load-bearing check is that every
// defined endpoint string is composed of segments the envelope parser (and
// therefore the native gateway) accepts, that undefined keys are exactly the
// documented no-upstream-counterpart set, and that the wire-arg wrapper
// matches the native gateway's expected `{ args: { <paramWire>: value } }`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ENDPOINT_SEGMENT_PATTERN } from '../dist/envelope.js'
import { WIRE, WIRE_SESSION_CLOSE, WIRE_ARGS, wireArgsOf } from '../dist/wire-endpoints.js'

/** Exactly the brief's seven keys, no more, no fewer. */
const EXPECTED_KEYS = [
  'sessionList', 'sessionCreate', 'sessionTitle', 'promptSubmit',
  'streamOpen', 'turnCancel', 'sessionClose',
]

test('WIRE exposes exactly the planned session-plane keys', () => {
  assert.deepEqual(Object.keys(WIRE).sort(), [...EXPECTED_KEYS].sort())
})

test('every defined WIRE key is a slash-joined endpoint of envelope-legal segments', () => {
  for (const [key, endpoint] of Object.entries(WIRE)) {
    if (endpoint === undefined) continue
    assert(typeof endpoint === 'string', `${key} must be string or undefined`)
    const segments = endpoint.split('/')
    assert.ok(segments.length >= 2, `${key}="${endpoint}" must be namespace/method`)
    for (const segment of segments) {
      assert.ok(
        ENDPOINT_SEGMENT_PATTERN.test(segment),
        `${key}="${endpoint}" has an illegal segment "${segment}"`,
      )
    }
  }
})

test('sessionClose is the only undefined key (no upstream counterpart)', () => {
  assert.equal(WIRE.sessionClose, undefined)
  assert.equal(WIRE_SESSION_CLOSE, undefined)
  const defined = Object.entries(WIRE).filter(([, v]) => v !== undefined)
  assert.equal(defined.length, EXPECTED_KEYS.length - 1)
})

test('defined endpoints carry the upstream session namespace', () => {
  for (const [key, endpoint] of Object.entries(WIRE)) {
    if (endpoint === undefined) continue
    assert.ok(endpoint.startsWith('session/'), `${key}="${endpoint}" must live on the session namespace`)
  }
})

test('WIRE_ARGS covers exactly the defined endpoints', () => {
  assert.deepEqual(
    [...Object.keys(WIRE_ARGS)].sort(),
    Object.values(WIRE).filter((v) => v !== undefined).sort(),
  )
})

test('wireArgsOf builds the native gateway args wrapper', () => {
  assert.deepEqual(wireArgsOf(WIRE.sessionList, {}), { args: { _request: {} } })
  assert.deepEqual(wireArgsOf(WIRE.sessionCreate, { cwd: '/tmp' }), { args: { request: { cwd: '/tmp' } } })
  assert.deepEqual(wireArgsOf(WIRE.promptSubmit, {}), { args: { request: {} } })
  assert.throws(() => wireArgsOf('session/nope', {}), /no wire-arg key/)
})

// Payload mirrors are documented reference shapes (Task 2 input); these
// minimal samples pin the wire-visible field names against the upstream
// interfaces cited in each JSDoc anchor (src/wire-endpoints.ts Mirror types).
// Samples are typed via JSDoc against the built mirrors; field-name fidelity
// is asserted on the wire below.

test('minimal mirror samples survive a JSON wire round-trip with upstream field names', () => {
  const list = /** @type {import('../dist/wire-endpoints.js').SessionListRequestMirror} */ ({})
  const create = /** @type {import('../dist/wire-endpoints.js').SessionCreateRequestMirror} */ ({ cwd: '/w', agentPreset: 'default' })
  const rename = /** @type {import('../dist/wire-endpoints.js').SessionRenameRequestMirror} */ ({ sessionId: 's1', title: 'T' })
  const prompt = /** @type {import('../dist/wire-endpoints.js').SessionPromptRequestMirror} */ ({
    requestId: 'r1',
    sessionId: 's1',
    mode: 'queue',
    content: [{ type: 'text', text: 'hi' }],
    clientTimeZone: 'UTC',
  })
  const follow = /** @type {import('../dist/wire-endpoints.js').SessionFollowRequestMirror} */ ({
    address: { kind: 'session', sessionId: 's1' },
    assistantStream: true,
  })
  const cancel = /** @type {import('../dist/wire-endpoints.js').SessionCancelRequestMirror} */ ({ sessionId: 's1' })

  const envelopes = {
    list: wireArgsOf(WIRE.sessionList, list),
    create: wireArgsOf(WIRE.sessionCreate, create),
    rename: wireArgsOf(WIRE.sessionTitle, rename),
    prompt: wireArgsOf(WIRE.promptSubmit, prompt),
    follow: wireArgsOf(WIRE.streamOpen, follow),
    cancel: wireArgsOf(WIRE.turnCancel, cancel),
  }

  // JSON round-trip (the wire is JSON) and spot the exact upstream field
  // names documented in the mirror interfaces.
  const onWire = JSON.parse(JSON.stringify(envelopes))
  assert.deepEqual(onWire.list, { args: { _request: {} } })
  assert.deepEqual(onWire.create.args.request, { cwd: '/w', agentPreset: 'default' })
  assert.deepEqual(onWire.rename.args.request, { sessionId: 's1', title: 'T' })
  assert.deepEqual(onWire.prompt.args.request, {
    requestId: 'r1', sessionId: 's1', mode: 'queue',
    content: [{ type: 'text', text: 'hi' }], clientTimeZone: 'UTC',
  })
  assert.deepEqual(onWire.follow.args.request, {
    address: { kind: 'session', sessionId: 's1' }, assistantStream: true,
  })
  assert.deepEqual(onWire.cancel.args.request, { sessionId: 's1' })

  // follow's address may also name a direct subagent child (types.ts:406).
  const subagentFollow = /** @type {import('../dist/wire-endpoints.js').SessionFollowRequestMirror} */ ({
    address: {
      kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'one-shot',
    },
  })
  assert.equal(
    JSON.parse(JSON.stringify(subagentFollow)).address.kind,
    'subagent',
  )
})
