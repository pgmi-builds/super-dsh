// a2a-wire (postoffice R1): the hub-to-hub envelope protocol v1 — pure types,
// strict shape guards, and the wire send/receive helpers (POST + outbox claim
// with the cookie riding along, transport failures mapped to the
// A2aAddressError classification). Contract: plan
// 2026-09-28-machine-mesh-postoffice-rework.md 契约要点 (wire v1 envelopes,
// endpoints, receipts), ADR 0011, spec machine-mesh-a2a D16–D19.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  A2A_WIRE_VERSION,
  A2A_TITLE_PLACEHOLDER,
  A2A_ENDPOINT_PATH,
  A2A_OUTBOX_PATH,
  A2A_NOTICE_SUMMARY_MAX,
  a2aWireFrameOf,
  isA2aEnvelope,
  isA2aWireFrame,
  decodeA2aWireFrame,
  normalizeA2aTitle,
  postA2aEnvelope,
  fetchA2aOutbox,
  A2aAddressError,
} from '../dist/a2a-wire.js'
// compat re-exports after the R1 moves (existing consumers keep compiling)
import { A2aAddressError as A2aAddressErrorViaService } from '../dist/a2a-service.js'
import { A2A_NOTICE_SUMMARY_MAX as NOTICE_MAXViaDelivery } from '../dist/a2a-delivery.js'

const TO = { machine: 'dev3', id: 'a1b2c3' }
const FROM = { machine: 'pc0', agent: 'f4g5h6', sessionId: 'session-11111111-2222-3333-4444-555555555555' }

const NEW_CONV = {
  kind: 'new-conversation',
  to: TO,
  conversationId: 'abc123',
  title: '[undefined]',
  message: 'hello peer',
  from: FROM,
  messageId: 'a2a-1',
}
const MESSAGE = {
  kind: 'message',
  to: TO,
  conversationId: 'abc123',
  message: 'hello again',
  from: FROM,
  messageId: 'a2a-2',
  delivery: 'steer',
}
const STOP = { kind: 'stop', to: TO, conversationId: 'abc123', scope: 'session' }
const REPLY = {
  kind: 'reply',
  to: FROM,
  conversation: 'abc123',
  text: 'here is the answer',
  messageId: 'a2a-relay-3',
}
const NOTICE = {
  kind: 'notice',
  to: FROM,
  conversation: 'abc123',
  summary: 'turn aborted, no reply',
  messageId: 'a2a-notice-4',
}

test('a2aWireFrameOf wraps any envelope in the v1 outer frame', () => {
  assert.equal(A2A_WIRE_VERSION, 1)
  const frame = a2aWireFrameOf(NEW_CONV)
  assert.deepEqual(frame, { v: 1, envelope: NEW_CONV })
})

test('isA2aWireFrame: v1 frame accepted; wrong version / missing envelope / junk rejected', () => {
  assert.equal(isA2aWireFrame(a2aWireFrameOf(MESSAGE)), true)
  assert.equal(isA2aWireFrame({ v: 2, envelope: MESSAGE }), false)
  assert.equal(isA2aWireFrame({ envelope: MESSAGE }), false)
  assert.equal(isA2aWireFrame({ v: 1 }), false)
  assert.equal(isA2aWireFrame(null), false)
  assert.equal(isA2aWireFrame('frame'), false)
  assert.equal(isA2aWireFrame({ v: 1, envelope: { kind: 'nonsense' } }), false)
})

test('isA2aEnvelope: all five v1 kinds accepted with their exact shapes', () => {
  for (const envelope of [NEW_CONV, MESSAGE, STOP, REPLY, NOTICE]) {
    assert.equal(isA2aEnvelope(envelope), true, JSON.stringify(envelope))
  }
  // optional delivery omitted vs present on new-conversation
  assert.equal(isA2aEnvelope({ ...NEW_CONV, delivery: 'queue' }), true)
})

test('isA2aEnvelope: unknown kind and non-object inputs rejected', () => {
  assert.equal(isA2aEnvelope({ ...MESSAGE, kind: 'ping' }), false)
  assert.equal(isA2aEnvelope(null), false)
  assert.equal(isA2aEnvelope(undefined), false)
  assert.equal(isA2aEnvelope(42), false)
  assert.equal(isA2aEnvelope([MESSAGE]), false)
  assert.equal(isA2aEnvelope('message'), false)
})

test('isA2aEnvelope: request kinds — missing required fields rejected', () => {
  for (const key of ['to', 'conversationId', 'title', 'message', 'from', 'messageId']) {
    const { [key]: _drop, ...rest } = NEW_CONV
    assert.equal(isA2aEnvelope(rest), false, `new-conversation without ${key}`)
  }
  for (const key of ['to', 'conversationId', 'message', 'from', 'messageId']) {
    const { [key]: _drop, ...rest } = MESSAGE
    assert.equal(isA2aEnvelope(rest), false, `message without ${key}`)
  }
  for (const key of ['to', 'conversationId', 'scope']) {
    const { [key]: _drop, ...rest } = STOP
    assert.equal(isA2aEnvelope(rest), false, `stop without ${key}`)
  }
})

test('isA2aEnvelope: strict key sets — foreign/extraneous fields rejected', () => {
  assert.equal(isA2aEnvelope({ ...MESSAGE, title: 'extra' }), false) // title is new-conversation-only
  assert.equal(isA2aEnvelope({ ...STOP, from: FROM }), false)
  assert.equal(isA2aEnvelope({ ...STOP, messageId: 'a2a-9' }), false)
  assert.equal(isA2aEnvelope({ ...REPLY, delivery: 'queue' }), false)
  assert.equal(isA2aEnvelope({ ...NEW_CONV, note: 'hi' }), false)
})

test('isA2aEnvelope: reply/notice use `conversation`, not `conversationId`', () => {
  assert.equal(isA2aEnvelope({ ...REPLY, conversationId: 'abc123', conversation: undefined }), false)
  const { conversation: _c, ...replyNoConv } = REPLY
  assert.equal(isA2aEnvelope(replyNoConv), false)
  const { conversation: _n, ...noticeNoConv } = NOTICE
  assert.equal(isA2aEnvelope(noticeNoConv), false)
})

test('isA2aEnvelope: empty strings rejected everywhere a string is required', () => {
  assert.equal(isA2aEnvelope({ ...MESSAGE, message: '' }), false)
  assert.equal(isA2aEnvelope({ ...MESSAGE, conversationId: '' }), false)
  assert.equal(isA2aEnvelope({ ...MESSAGE, messageId: '' }), false)
  assert.equal(isA2aEnvelope({ ...MESSAGE, to: { machine: '', id: 'a1b2c3' } }), false)
  assert.equal(isA2aEnvelope({ ...MESSAGE, to: { machine: 'dev3', id: '' } }), false)
  assert.equal(isA2aEnvelope({ ...MESSAGE, from: { ...FROM, sessionId: '' } }), false)
  assert.equal(isA2aEnvelope({ ...NEW_CONV, title: '' }), false)
  assert.equal(isA2aEnvelope({ ...REPLY, text: '' }), false)
  assert.equal(isA2aEnvelope({ ...NOTICE, summary: '' }), false)
})

test('isA2aEnvelope: wrong field types rejected', () => {
  assert.equal(isA2aEnvelope({ ...MESSAGE, to: ['dev3', 'a1b2c3'] }), false)
  assert.equal(isA2aEnvelope({ ...MESSAGE, to: null }), false)
  assert.equal(isA2aEnvelope({ ...MESSAGE, from: { ...FROM, sessionId: 7 } }), false)
  assert.equal(isA2aEnvelope({ ...MESSAGE, to: { ...TO, extra: 1 } }), false)
  assert.equal(isA2aEnvelope({ ...MESSAGE, delivery: 'urgent' }), false)
  assert.equal(isA2aEnvelope({ ...MESSAGE, delivery: 3 }), false)
  assert.equal(isA2aEnvelope({ ...STOP, scope: 'forever' }), false)
  assert.equal(isA2aEnvelope({ ...REPLY, conversation: 42 }), false)
})

test('isA2aEnvelope: notice summary bound is exactly ≤120 (A2A_NOTICE_SUMMARY_MAX)', () => {
  assert.equal(A2A_NOTICE_SUMMARY_MAX, 120)
  const atBound = 'x'.repeat(120)
  const overBound = 'x'.repeat(121)
  assert.equal(isA2aEnvelope({ ...NOTICE, summary: atBound }), true)
  assert.equal(isA2aEnvelope({ ...NOTICE, summary: overBound }), false)
})

test('normalizeA2aTitle: unspecified and empty become the [undefined] placeholder', () => {
  assert.equal(A2A_TITLE_PLACEHOLDER, '[undefined]')
  assert.equal(normalizeA2aTitle(undefined), '[undefined]')
  assert.equal(normalizeA2aTitle(''), '[undefined]')
  assert.equal(normalizeA2aTitle('real title'), 'real title')
})

test('decodeA2aWireFrame: ok carries the envelope; error carries a named reason', () => {
  const ok = decodeA2aWireFrame(a2aWireFrameOf(STOP))
  assert.equal(ok.ok, true)
  assert.equal(ok.ok === true && ok.envelope.kind, 'stop')
  const bad = decodeA2aWireFrame({ v: 2, envelope: STOP })
  assert.equal(bad.ok, false)
  assert.ok(bad.ok === false && bad.error.length > 0)
  assert.match(bad.ok === false ? bad.error : '', /version/)
})

// ------------------------------------------------------------------ wire io

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('postA2aEnvelope: POSTs the v1 frame with the cookie riding along and decodes the receipt', async () => {
  const seen = []
  const receipt = { outcome: 'injected', messageId: 'a2a-2', conversationId: 'abc123', sessionId: 'session-xyz' }
  const out = await postA2aEnvelope('http://peer:4999', MESSAGE, {
    cookie: 'dsh-auth-x=1',
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init })
      return jsonResponse(200, receipt)
    },
  })
  assert.deepEqual(out, receipt)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, `http://peer:4999${A2A_ENDPOINT_PATH}`)
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers['content-type'], 'application/json')
  assert.equal(seen[0].init.headers.cookie, 'dsh-auth-x=1')
  const sent = JSON.parse(seen[0].init.body)
  assert.deepEqual(sent, { v: 1, envelope: MESSAGE })
})

test('postA2aEnvelope: no cookie option → no Cookie header sent', async () => {
  const seen = []
  await postA2aEnvelope('http://peer:4999', MESSAGE, {
    fetchImpl: async (url, init) => {
      seen.push(init)
      return jsonResponse(200, { outcome: 'injected', messageId: 'a2a-2', conversationId: 'abc123', sessionId: 's' })
    },
  })
  assert.equal('cookie' in seen[0].headers, false)
})

test('postA2aEnvelope: stop envelopes decode a stop receipt', async () => {
  const receipt = { stopped: true, scope: 'turn-only', reason: 'no session-close endpoint upstream' }
  const out = await postA2aEnvelope('http://peer:4999', STOP, {
    fetchImpl: async () => jsonResponse(200, receipt),
  })
  assert.deepEqual(out, receipt)
})

test('postA2aEnvelope: 401 maps to A2aAddressError(unreachable) with the cause attached', async () => {
  await assert.rejects(
    postA2aEnvelope('http://peer:4999', MESSAGE, { fetchImpl: async () => jsonResponse(401, { error: 'auth' }) }),
    (err) => {
      assert.ok(err instanceof A2aAddressError)
      assert.equal(err.kind, 'unreachable')
      assert.equal(err.machine, 'dev3')
      assert.match(String(err.cause), /401/)
      return true
    },
  )
})

test('postA2aEnvelope: network failure maps to A2aAddressError(unreachable)', async () => {
  await assert.rejects(
    postA2aEnvelope('http://peer:4999', MESSAGE, {
      fetchImpl: async () => { throw new TypeError('fetch failed') },
    }),
    (err) => err instanceof A2aAddressError && err.kind === 'unreachable',
  )
})

test('postA2aEnvelope: non-2xx maps to A2aAddressError(unreachable); malformed 200 body is a loud protocol error', async () => {
  await assert.rejects(
    postA2aEnvelope('http://peer:4999', MESSAGE, { fetchImpl: async () => jsonResponse(503, {}) }),
    (err) => err instanceof A2aAddressError && err.kind === 'unreachable',
  )
  await assert.rejects(
    postA2aEnvelope('http://peer:4999', MESSAGE, { fetchImpl: async () => jsonResponse(200, { nonsense: true }) }),
    (err) => {
      assert.ok(!(err instanceof A2aAddressError))
      assert.match(err.message, /a2a-wire/)
      return true
    },
  )
  await assert.rejects(
    postA2aEnvelope('http://peer:4999', MESSAGE, { fetchImpl: async () => new Response('not json', { status: 200 }) }),
    (err) => !(err instanceof A2aAddressError) && /a2a-wire/.test(err.message),
  )
})

test('fetchA2aOutbox: GETs ?machine= with the cookie and returns validated envelopes', async () => {
  const seen = []
  const envelopes = await fetchA2aOutbox('http://peer:4999', 'pc0', {
    cookie: 'dsh-auth-x=1',
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init })
      return jsonResponse(200, { v: 1, envelopes: [REPLY, NOTICE] })
    },
  })
  assert.deepEqual(envelopes, [REPLY, NOTICE])
  assert.equal(seen[0].url, `http://peer:4999${A2A_OUTBOX_PATH}?machine=pc0`)
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(seen[0].init.headers.cookie, 'dsh-auth-x=1')
})

test('fetchA2aOutbox: empty claim is an empty list; malformed entries fail loud', async () => {
  const empty = await fetchA2aOutbox('http://peer:4999', 'pc0', {
    fetchImpl: async () => jsonResponse(200, { v: 1, envelopes: [] }),
  })
  assert.deepEqual(empty, [])
  await assert.rejects(
    fetchA2aOutbox('http://peer:4999', 'pc0', {
      fetchImpl: async () => jsonResponse(200, { v: 1, envelopes: [{ kind: 'reply' }] }),
    }),
    (err) => /a2a-wire/.test(err.message),
  )
  await assert.rejects(
    fetchA2aOutbox('http://peer:4999', 'pc0', {
      fetchImpl: async () => jsonResponse(200, { envelopes: [] }), // missing v
    }),
    (err) => /a2a-wire/.test(err.message),
  )
})

test('fetchA2aOutbox: 401 and network failure map to A2aAddressError(unreachable)', async () => {
  await assert.rejects(
    fetchA2aOutbox('http://peer:4999', 'pc0', { fetchImpl: async () => jsonResponse(401, {}) }),
    (err) => err instanceof A2aAddressError && err.kind === 'unreachable',
  )
  await assert.rejects(
    fetchA2aOutbox('http://peer:4999', 'pc0', { fetchImpl: async () => { throw new TypeError('fetch failed') } }),
    (err) => err instanceof A2aAddressError && err.kind === 'unreachable',
  )
})

test('fetchA2aOutbox: machine id must be a non-empty string', async () => {
  await assert.rejects(
    fetchA2aOutbox('http://peer:4999', '', { fetchImpl: async () => jsonResponse(200, { v: 1, envelopes: [] }) }),
    /machine/,
  )
})

test('R1 moves keep the old import surfaces: A2aAddressError via a2a-service, notice bound via a2a-delivery', () => {
  assert.equal(A2aAddressErrorViaService, A2aAddressError)
  assert.equal(NOTICE_MAXViaDelivery, 120)
})

// ---------------------------------------------------- return-sender (v1 additive)

test('return envelopes: optional sender accepted when well-formed, rejected when malformed', () => {
  const withSender = { ...REPLY, sender: { machine: 'dev3', agent: 'cd33x1' } }
  assert.equal(isA2aEnvelope(withSender), true)
  assert.equal(isA2aEnvelope({ ...NOTICE, sender: { machine: 'dev3', agent: 'cd33x1' } }), true)
  // absent stays valid (legacy peers)
  assert.equal(isA2aEnvelope(REPLY), true)
  // malformed shapes rejected: extra key inside sender, empty strings, non-object
  assert.equal(isA2aEnvelope({ ...REPLY, sender: { machine: 'dev3', agent: 'cd33x1', extra: 1 } }), false)
  assert.equal(isA2aEnvelope({ ...REPLY, sender: { machine: '', agent: 'cd33x1' } }), false)
  assert.equal(isA2aEnvelope({ ...REPLY, sender: 'dev3' }), false)
})

// D20: the additive transcribed flag — true is valid, anything else is not
test('reply envelope guard: transcribed true passes, junk values fail (additive v1)', () => {
  const base = {
    kind: 'reply',
    to: { machine: 'm1ab', agent: 'a2b3c4', sessionId: 'sess-1' },
    conversation: 'abc123',
    text: 'the turn-end words',
    messageId: 'a2a-relay-1',
  }
  assert.ok(isA2aEnvelope(base))
  assert.ok(isA2aEnvelope({ ...base, transcribed: true }))
  assert.ok(!isA2aEnvelope({ ...base, transcribed: false }))
  assert.ok(!isA2aEnvelope({ ...base, transcribed: 'yes' }))
  assert.ok(!isA2aEnvelope({ ...base, transcription: true }), 'unknown additive keys stay rejected (exact key sets)')
})
