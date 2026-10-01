// a2a-ingest (postoffice R3): the post-office's execution side — request
// envelopes resolved against the LOCAL session plane (create-or-resume with
// verbatim mirror-row adoption, teaching-envelope injection, local completion
// capture), return-envelope routing (self → in-process delivery / paired →
// wire POST / else the bounded persistent outbox), and the mesh-rpc endpoint
// handlers (POST /api/superd/a2a + GET .../outbox).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createA2aIngest } from '../dist/a2a-ingest.js'
import { loadConversations, saveConversations, renderA2aEnvelope, A2aAddressError } from '../dist/a2a-service.js'
import { WIRE } from '../dist/wire-endpoints.js'
import { handleA2aIngestPost, handleA2aOutboxGet } from '../dist/mesh-rpc.js'
import { ensureSelf, upsertRemote } from '../dist/machines.js'
import { A2A_ENDPOINT_PATH } from '../dist/a2a-wire.js'

// ---------------------------------------------------------------- fixtures

/** Scripted fake gateway (a2a-service.test.mjs's shape): rpc/stream queues + recorded calls. */
function fakeGateway() {
  const calls = []
  const rpcScript = []
  const streamScript = []
  const face = {
    async dispatchRpc(endpoint, payload, signal) {
      calls.push({ kind: 'rpc', endpoint, payload })
      const next = rpcScript.shift() ?? { result: { ok: true, value: {} } }
      if (next.throw) throw next.throw
      return next.result
    },
    openWireStream(endpoint, payload, signal) {
      calls.push({ kind: 'stream', endpoint, payload })
      const next = streamScript.shift() ?? { end: true }
      return (async function*() {
        if (next.throw) throw next.throw
        if (!next.end) for (const frame of next.frames ?? []) yield frame
        if (next.die) throw next.die
        await new Promise((_, reject) => {
          if (signal?.aborted) { reject(new Error('aborted')); return }
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      })()
    },
  }
  return {
    calls, face,
    rpc: (entry) => rpcScript.push(entry),
    stream: (entry) => streamScript.push(entry),
    rpcs: (endpoint) => calls.filter((c) => c.kind === 'rpc' && c.endpoint === endpoint),
    streams: (endpoint) => calls.filter((c) => c.kind === 'stream' && c.endpoint === endpoint),
  }
}

/** Fake delivery ctx: a live agent per registered sessionId; deliveries recorded. */
function fakeDelivery(liveSessions = new Set()) {
  const delivered = []
  const buffered = []
  const mkAgent = (sessionId) => ({
    status: 'idle',
    followup: (message) => delivered.push({ sessionId, how: 'followup', message }),
    steer: (message) => delivered.push({ sessionId, how: 'steer', message }),
    inject: (message) => delivered.push({ sessionId, how: 'inject', message }),
  })
  return {
    delivered, buffered,
    ctx: {
      agents: { get: (sessionId) => (liveSessions.has(sessionId) ? mkAgent(sessionId) : undefined) },
      buffer: (initiatorSessionId, message) => buffered.push({ initiatorSessionId, message }),
    },
  }
}

const ev = (type, data, seq) => ({ type: 'event', event: { type, seq, time: 1, data } })
const snap = (records) => ({ type: 'snapshot', header: { version: 1, id: 's' }, cursor: 0, records, hasMore: false, projections: {} })
const userMsg = (rpcId, seq) => ev('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: 'in' }], source: { kind: 'user', rpcId, clientTimeZone: 'UTC' } }, seq)
const asstMsg = (turn, text, seq) => ev('assistant/message', { turn, step: 0, interrupted: false, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text }] }, stream: [] }, seq)
const turnEnd = (turn, seq, kind = 'completed') => ev('turn/end', { turn, reason: { kind } }, seq)

const until = async (cond, ms = 2000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('timed out')
}

/** One ingest assembly over a tmpdir home + the fake gateway as the local leg. */
const mkIngest = (gw, opts = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const delivery = fakeDelivery(new Set([opts.liveSession ?? 'session-init-1'])).ctx ? fakeDeliveryWithHome(home, opts) : undefined
  return { home, ...assembly(home, gw, opts) }
}

// simpler: build the assembly inline per test (home + gatewayFor + delivery)
function assembly(home, gw, opts = {}) {
  const deliveryFake = fakeDelivery(new Set([opts.liveSession ?? 'session-init-1']))
  const ingest = createA2aIngest({
    home,
    gatewayFor: (addr) => {
      if (addr.id === 'gone777') throw new A2aAddressError('unknown-agent', addr)
      return gw.face
    },
    delivery: deliveryFake.ctx,
    fetchImpl: opts.fetchImpl,
    ...(opts.log === undefined ? {} : { log: opts.log }),
  })
  return { ingest, delivery: deliveryFake }
}

const LOCAL = { machine: '', id: 'q7m2xp' } // machine filled per-test (self m4)
const mkEnv = (selfM4, fromMachine) => ({
  kind: 'new-conversation',
  to: { machine: selfM4, id: 'q7m2xp' },
  conversationId: 'abc123',
  title: '[undefined]',
  message: 'hello local peer',
  from: { machine: fromMachine, agent: 'f4g5h6', sessionId: 'session-init-1' },
  messageId: 'a2a-msg-1',
})

test('new-conversation (local): create + inject + verbatim mirror row; teaching envelope initiator=from', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-aaaaaaaa-1111' } } }) // create
    gw.rpc({ result: { ok: true, value: { accepted: true } } })                 // prompt
    const { ingest } = assembly(home, gw)
    const env = mkEnv(self.id, self.id) // initiator on THIS machine (in-process short-circuit shape)
    const receipt = await ingest.ingest(env)
    assert.deepEqual(receipt, { outcome: 'delivered', messageId: 'a2a-msg-1', conversationId: 'abc123', sessionId: 'sess-aaaaaaaa-1111' })
    // create payload byte-exact; prompt mirror byte-exact with the teaching envelope
    assert.deepEqual(gw.rpcs(WIRE.sessionCreate).map((c) => c.payload), [{ args: { request: {} } }])
    const prompt = gw.rpcs(WIRE.promptSubmit)[0].payload.args.request
    assert.equal(prompt.requestId, 'a2a-msg-1')
    assert.equal(prompt.sessionId, 'sess-aaaaaaaa-1111')
    assert.equal(prompt.mode, 'queue')
    assert.deepEqual(prompt.content, [{
      type: 'text',
      text: renderA2aEnvelope({ machine: self.id, agent: 'f4g5h6', title: '[undefined]', shortId: 'abc123', message: 'hello local peer' }),
    }])
    // MIRROR ROW: points at the initiator; shortId + title adopted verbatim (D17)
    const rows = loadConversations(home).conversations
    assert.deepEqual(rows, [{
      shortId: 'abc123', machine: self.id, agent: 'f4g5h6',
      sessionId: 'sess-aaaaaaaa-1111', title: '[undefined]',
      hostAgent: 'q7m2xp', // R4 amendment: mirror rows carry the LOCAL hosting a6
      initiatorSession: 'session-init-1', // 0.1.7-i: the opener's session persists too (send-failed notice address)
      createdAt: rows[0].createdAt, lastActivityAt: rows[0].lastActivityAt,
    }])
    // the completion watcher armed on the envelope's messageId
    assert.equal(gw.streams(WIRE.streamOpen).length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('new-conversation re-delivery: same conversation → idempotent adoption + resume; collision → fail-loud', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-bbbbbbbb-2222' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    const { ingest } = assembly(home, gw)
    const env = mkEnv(self.id, self.id)
    await ingest.ingest(env)
    // same envelope again: the messageId is seen → dedupe re-ACK, ZERO
    // session-plane calls (the exactly-once wrapper short-circuits before
    // dispatch — the re-adoption path below stays for peers that re-mint)
    const again = await ingest.ingest(env)
    assert.equal(again.outcome, 'delivered')
    assert.equal(loadConversations(home).conversations.length, 1)
    assert.equal(gw.calls.length, 3) // leg 1's create + prompt + completion-watch stream — the re-POST consumed nothing
    // collision: a DIFFERENT envelope (fresh messageId — a real conflicting
    // claim always carries one) whose create answers a session another row owns
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-99999999-9999' } } })
    const conflict = await ingest.ingest({ ...env, messageId: 'a2a-1-conflict' })
    assert.equal(conflict.outcome, 'failed')
    assert.equal(conflict.error.code, 'gateway/uncaught')
    assert.match(conflict.error.message, /conversation-id conflict/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('message: resume the mirror row (no create); unknown conversation + initiator mismatch fail honestly', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-cccccccc-3333' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    const { ingest } = assembly(home, gw)
    await ingest.ingest(mkEnv(self.id, self.id))
    gw.rpc({ result: { ok: true, value: { accepted: true } } }) // resume prompt
    const resume = await ingest.ingest({
      kind: 'message',
      to: { machine: self.id, id: 'q7m2xp' },
      conversationId: 'abc123',
      message: 'second turn',
      from: { machine: self.id, agent: 'f4g5h6', sessionId: 'session-init-1' },
      messageId: 'a2a-msg-2',
    })
    assert.equal(resume.outcome, 'delivered')
    assert.equal(resume.conversationId, 'abc123')
    assert.equal(gw.rpcs(WIRE.sessionCreate).length, 1) // no second create
    assert.equal(gw.rpcs(WIRE.promptSubmit).length, 2)
    // unknown conversationId → failed receipt
    const unknown = await ingest.ingest({
      kind: 'message',
      to: { machine: self.id, id: 'q7m2xp' },
      conversationId: 'nope99',
      message: 'x',
      from: { machine: self.id, agent: 'f4g5h6', sessionId: 'session-init-1' },
      messageId: 'a2a-msg-3',
    })
    assert.equal(unknown.outcome, 'failed')
    assert.equal(unknown.error.code, 'a2a/conversation-not-found')
    // initiator mismatch → the mirror row belongs to another initiator
    const mismatch = await ingest.ingest({
      kind: 'message',
      to: { machine: self.id, id: 'q7m2xp' },
      conversationId: 'abc123',
      message: 'x',
      from: { machine: 'zzzz', agent: 'intruda', sessionId: 'session-init-1' },
      messageId: 'a2a-msg-4',
    })
    assert.equal(mismatch.outcome, 'failed')
    assert.equal(mismatch.error.code, 'a2a/conversation-machine-mismatch')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('unknown local agent → failed receipt with the typed a2a/unknown-agent code', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    const { ingest } = assembly(home, gw)
    const receipt = await ingest.ingest({
      kind: 'new-conversation',
      to: { machine: self.id, id: 'gone777' },
      conversationId: 'xyz789',
      title: '[undefined]',
      message: 'x',
      from: { machine: self.id, agent: 'f4g5h6', sessionId: 'session-init-1' },
      messageId: 'a2a-msg-5',
    })
    assert.equal(receipt.outcome, 'failed')
    assert.equal(receipt.error.code, 'a2a/unknown-agent')
    assert.match(receipt.error.message, /gone777/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('completion → in-process reply (self-routed): relay text + a2a-relay source into the initiator session', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-dddddddd-4444' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    gw.stream({
      frames: [
        snap([
          ev('turn/start', { turn: 1 }, 1),
          userMsg('a2a-msg-1', 2),
          asstMsg(1, 'the local answer', 3),
        ]),
        turnEnd(1, 4),
      ],
    })
    const { ingest, delivery } = assembly(home, gw)
    await ingest.ingest(mkEnv(self.id, self.id))
    await until(() => delivery.delivered.length > 0)
    const hit = delivery.delivered[0]
    assert.equal(hit.sessionId, 'session-init-1')
    assert.equal(hit.how, 'followup')
    assert.match(hit.message.content[0].text, new RegExp(`\\[superd-hub:a2a\\] kind=reply form=transcript conversation=abc123 from=${self.id}-q7m2xp message=`))
    assert.match(hit.message.content[0].text, /the local answer/)
    assert.equal(hit.message.source.kind, 'a2a-relay')
    assert.equal(hit.message.source.senderAgent, 'q7m2xp')
    assert.equal(hit.message.source.conversationId, 'abc123')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('completion aborted with NO text → bounded notice, never an empty relay (D3)', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-eeeeeeee-5555' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    gw.stream({
      frames: [
        snap([
          ev('turn/start', { turn: 1 }, 1),
          userMsg('a2a-msg-1', 2),
        ]),
        turnEnd(1, 3, 'aborted'),
      ],
    })
    const { ingest, delivery } = assembly(home, gw)
    await ingest.ingest(mkEnv(self.id, self.id))
    await until(() => delivery.delivered.length > 0)
    const hit = delivery.delivered[0]
    assert.equal(hit.message.source.kind, 'a2a-notice')
    assert.equal(hit.message.source.reason, 'peer') // D20: no abort taxonomy — the sendless-turn notice is reason-neutral
    assert.ok(hit.message.source.summary.length <= 120)
    assert.match(hit.message.content[0].text, /turn ended, no reply/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('completion → remote initiator with a machines row: reply POSTs on the wire with the cookie riding along', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  const posts = []
  const fetchImpl = async (url, init) => {
    posts.push({ url: String(url), init })
    return new Response(JSON.stringify({ delivered: 'followup' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    upsertRemote(home, { id: 'dev3', name: 'dev3', label: 'dev3', origin: 'http://dev3:4999', cookie: 'dsh-auth-dev3=1', enabled: true, addedAt: 1 })
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-ffffffff-6666' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    gw.stream({
      frames: [
        snap([
          ev('turn/start', { turn: 1 }, 1),
          userMsg('a2a-msg-1', 2),
          asstMsg(1, 'wire answer', 3),
        ]),
        turnEnd(1, 4),
      ],
    })
    const { ingest } = assembly(home, gw, { fetchImpl })
    const receipt = await ingest.ingest(mkEnv(self.id, 'dev3'))
    assert.equal(receipt.outcome, 'delivered')
    await until(() => posts.length > 0)
    assert.equal(posts[0].url, `http://dev3:4999${A2A_ENDPOINT_PATH}`)
    assert.equal(posts[0].init.method, 'POST')
    assert.equal(posts[0].init.headers.cookie, 'dsh-auth-dev3=1')
    const sent = JSON.parse(posts[0].init.body)
    assert.equal(sent.v, 1)
    assert.equal(sent.envelope.kind, 'reply')
    assert.equal(sent.envelope.conversation, 'abc123')
    assert.equal(sent.envelope.text, 'wire answer')
    assert.deepEqual(sent.envelope.to, { machine: 'dev3', agent: 'f4g5h6', sessionId: 'session-init-1' })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('completion → unpaired initiator: reply parks in the persistent outbox; claim takes & clears', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-12345678-9012' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    gw.stream({
      frames: [
        snap([
          ev('turn/start', { turn: 1 }, 1),
          userMsg('a2a-msg-1', 2),
          asstMsg(1, 'parked answer', 3),
        ]),
        turnEnd(1, 4),
      ],
    })
    const { ingest } = assembly(home, gw)
    await ingest.ingest(mkEnv(self.id, 'orphan')) // no self match, no machines row
    await until(() => readOutbox(home).envelopes.length > 0)
    const parked = readOutbox(home)
    assert.equal(parked.envelopes.length, 1)
    assert.equal(parked.envelopes[0].kind, 'reply')
    assert.equal(parked.envelopes[0].to.machine, 'orphan')
    // claim: take and clear
    const claimed = ingest.claimOutbox('orphan')
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].text, 'parked answer')
    assert.deepEqual(readOutbox(home).envelopes, [])
    assert.deepEqual(ingest.claimOutbox('orphan'), []) // second claim empty
    // another machine's mail is NOT taken by this claim
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('outbox bound: ≤32 total, oldest dropped (A2A_BUFFER_MAX discipline)', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    const { ingest } = assembly(home, gw)
    for (let i = 0; i < 35; i++) {
      await ingest.routeReturn({
        kind: 'reply',
        to: { machine: 'orphan', agent: 'a', sessionId: `session-${i}` },
        conversation: `conv${i}`,
        text: `t${i}`,
        messageId: `m${i}`,
      }, { responderAgent: 'q7m2xp' })
    }
    const file = readOutbox(home)
    assert.equal(file.envelopes.length, 32)
    assert.equal(file.envelopes[0].conversation, 'conv3') // oldest three dropped
    assert.equal(file.envelopes[31].conversation, 'conv34')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('stop envelope: cancels the local turn; session scope degrades to turn-only with the honest reason', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    // seed the mirror row via a new-conversation ingest
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-hhhhhhhh-8888' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    const { ingest } = assembly(home, gw)
    await ingest.ingest(mkEnv(self.id, 'dev3'))
    // stop: liveness snapshot (live turn) + cancel
    gw.stream({ frames: [snap([ev('turn/start', { turn: 1 }, 1)])] })
    gw.rpc({ result: { ok: true, value: { cancelled: true } } })
    const receipt = await ingest.ingest({
      kind: 'stop',
      to: { machine: self.id, id: 'q7m2xp' },
      conversationId: 'abc123',
      scope: 'session',
    })
    assert.deepEqual(receipt, { stopped: true, scope: 'turn-only', reason: 'no session-close endpoint upstream' })
    assert.equal(gw.rpcs(WIRE.turnCancel).length, 1)
    // unknown conversation → stopped:false with the reason
    const miss = await ingest.ingest({ kind: 'stop', to: { machine: self.id, id: 'q7m2xp' }, conversationId: 'nope', scope: 'turn' })
    assert.equal(miss.stopped, false)
    assert.equal(miss.scope, 'turn')
    assert.match(miss.reason, /not in the registry/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- endpoints

test('POST /api/superd/a2a handler: valid frame → 200 receipt; bad JSON/bad version → 400 with named error', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-77777777-7777' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    const { ingest } = assembly(home, gw)
    const ok = await handleA2aIngestPost(new Request('http://x/api/superd/a2a', {
      method: 'POST',
      body: JSON.stringify({ v: 1, envelope: mkEnv(self.id, self.id) }),
    }), ingest)
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { outcome: 'delivered', messageId: 'a2a-msg-1', conversationId: 'abc123', sessionId: 'sess-77777777-7777' })
    const badJson = await handleA2aIngestPost(new Request('http://x', { method: 'POST', body: 'nope{' }), ingest)
    assert.equal(badJson.status, 400)
    const badVersion = await handleA2aIngestPost(new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ v: 2, envelope: mkEnv(self.id, self.id) }),
    }), ingest)
    assert.equal(badVersion.status, 400)
    assert.match((await badVersion.json()).error, /version/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('GET /api/superd/a2a/outbox handler: ?machine= claim → {v:1, envelopes}; missing param → 400', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  try {
    const { ingest } = assembly(home, gw)
    await ingest.routeReturn({
      kind: 'reply',
      to: { machine: 'orphan', agent: 'a', sessionId: 'session-1' },
      conversation: 'conv1',
      text: 't',
      messageId: 'm1',
    }, { responderAgent: 'q7m2xp' })
    const res = handleA2aOutboxGet(new Request('http://x/api/superd/a2a/outbox?machine=orphan'), ingest)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.v, 1)
    assert.equal(body.envelopes.length, 1)
    assert.equal(body.envelopes[0].conversation, 'conv1')
    // cleared
    const again = await handleA2aOutboxGet(new Request('http://x/api/superd/a2a/outbox?machine=orphan'), ingest).json()
    assert.deepEqual(again.envelopes, [])
    const missing = handleA2aOutboxGet(new Request('http://x/api/superd/a2a/outbox'), ingest)
    assert.equal(missing.status, 400)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('inbound reply envelope (peer POSTed at us): envelope sender wins; absent sender falls back to the registry row', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-44444444-4444' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    const { ingest, delivery } = assembly(home, gw)
    await ingest.ingest(mkEnv(self.id, self.id))
    // (1) sender on the envelope — attribution is verbatim the producer
    const out = await ingest.ingest({
      kind: 'reply',
      to: { machine: self.id, agent: 'f4g5h6', sessionId: 'session-init-1' },
      conversation: 'abc123',
      text: 'a late reply',
      messageId: 'a2a-relay-late',
      sender: { machine: 'dev3', agent: 'cd33x1' },
    })
    assert.deepEqual(out, { outcome: 'delivered', messageId: 'a2a-relay-late', conversationId: 'abc123', sessionId: 'session-init-1' })
    assert.equal(delivery.delivered.length, 1)
    assert.match(delivery.delivered[0].message.content[0].text, /a late reply/)
    assert.equal(delivery.delivered[0].message.source.conversationId, 'abc123')
    assert.equal(delivery.delivered[0].message.source.senderMachine, 'dev3')
    assert.equal(delivery.delivered[0].message.source.senderAgent, 'cd33x1')
    assert.match(delivery.delivered[0].message.content[0].text, /\[superd-hub:a2a\] kind=reply form=relay conversation=abc123 from=dev3-cd33x1 message=a2a-relay-late/)
    // (2) legacy envelope without sender — the registry row supplies the
    // attribution. A PEER-hosted conversation (initiator row pointing at
    // dev3) proves the fallback names the PEER, never selfId().
    saveConversations(home, { conversations: [
      ...JSON.parse(readFileSync(join(home, 'superd', 'a2a-conversations.json'), 'utf8')).conversations,
      { shortId: 'xyz789', machine: 'dev3', agent: 'cd33x1', sessionId: 'sess-at-dev3', title: 'cross', createdAt: 1, lastActivityAt: 1 },
    ] })
    const out2 = await ingest.ingest({
      kind: 'reply',
      to: { machine: self.id, agent: 'f4g5h6', sessionId: 'session-init-1' },
      conversation: 'xyz789',
      text: 'an older reply',
      messageId: 'a2a-relay-legacy',
    })
    assert.deepEqual(out2, { outcome: 'delivered', messageId: 'a2a-relay-legacy', conversationId: 'xyz789', sessionId: 'session-init-1' })
    assert.equal(delivery.delivered.length, 2)
    assert.equal(delivery.delivered[1].message.source.senderMachine, 'dev3')
    assert.equal(delivery.delivered[1].message.source.senderAgent, 'cd33x1')
    assert.notEqual(delivery.delivered[1].message.source.senderMachine, self.id)
    // (3) exactly-once over the at-least-once transport: a re-POSTed envelope
    // (same messageId) is re-ACKed with its receipt and NEVER re-delivered.
    const out3 = await ingest.ingest({
      kind: 'reply',
      to: { machine: self.id, agent: 'f4g5h6', sessionId: 'session-init-1' },
      conversation: 'abc123',
      text: 'a late reply (again)',
      messageId: 'a2a-relay-late',
      sender: { machine: 'dev3', agent: 'cd33x1' },
    })
    assert.deepEqual(out3, { outcome: 'delivered', messageId: 'a2a-relay-late', conversationId: 'abc123', sessionId: 'session-init-1' })
    assert.equal(delivery.delivered.length, 2) // unchanged — the duplicate was dropped
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------- R4 amendments: row fields + peer write-back

test('registry accepts the additive row fields (hostAgent / initiatorSession) and rejects junk types', () => {
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  try {
    saveConversations(home, { conversations: [
      { shortId: 'mir001', machine: 'pc0', agent: 'f4g5h6', sessionId: 'sess-local-1', title: '[undefined]', hostAgent: 'q7m2xp', createdAt: 1, lastActivityAt: 1 },
      { shortId: 'ini002', machine: 'dev3', agent: 'cd33x1', sessionId: 'sess-remote-2', initiatorSession: 'session-init-9', createdAt: 1, lastActivityAt: 1 },
    ] })
    const rows = loadConversations(home).conversations
    assert.equal(rows.length, 2)
    assert.equal(rows[0].hostAgent, 'q7m2xp')
    assert.equal(rows[1].initiatorSession, 'session-init-9')
    // absent = existing semantics (pre-R4 rows load verbatim)
    saveConversations(home, { conversations: [
      { shortId: 'old003', machine: 'm', agent: 'a', sessionId: 'sess-3', createdAt: 1, lastActivityAt: 1 },
    ] })
    assert.deepEqual(loadConversations(home).conversations[0], { shortId: 'old003', machine: 'm', agent: 'a', sessionId: 'sess-3', createdAt: 1, lastActivityAt: 1 })
    // a non-string hostAgent is dropped by the row guard (corrupt-row discipline)
    writeFileSync(join(home, 'superd', 'a2a-conversations.json'), JSON.stringify({ conversations: [
      { shortId: 'bad004', machine: 'm', agent: 'a', sessionId: 's4', hostAgent: 7, createdAt: 1, lastActivityAt: 1 },
    ] }))
    assert.deepEqual(loadConversations(home).conversations, [])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('peer write-back: message envelope hitting an INITIATOR row delivers into initiatorSession — never injects', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    // seed the initiator row OUR side holds for a conversation at peer dev3
    saveConversations(home, { conversations: [{
      shortId: 'ini777', machine: 'dev3', agent: 'cd33x1', sessionId: 'sess-at-dev3',
      title: 'mesh review', initiatorSession: 'session-init-1', createdAt: 1, lastActivityAt: 1,
    }] })
    const { ingest, delivery } = assembly(home, gw)
    const out = await ingest.ingest({
      kind: 'message',
      to: { machine: self.id, id: 'q7m2xp' },
      conversationId: 'ini777',
      message: 'writing back asynchronously',
      from: { machine: 'dev3', agent: 'cd33x1', sessionId: 'session-at-dev3-side' },
      messageId: 'a2a-pwb-1',
    })
    assert.deepEqual(out, { outcome: 'delivered', messageId: 'a2a-pwb-1', conversationId: 'ini777', sessionId: 'session-init-1' })
    // delivered into the initiator's session with PEER attribution
    assert.equal(delivery.delivered.length, 1)
    const hit = delivery.delivered[0]
    assert.equal(hit.sessionId, 'session-init-1')
    assert.match(hit.message.content[0].text, /\[superd-hub:a2a\] kind=reply form=relay conversation=ini777 from=dev3-cd33x1 message=a2a-pwb-1/)
    assert.match(hit.message.content[0].text, /writing back asynchronously/)
    assert.equal(hit.message.source.kind, 'a2a-relay')
    assert.equal(hit.message.source.senderMachine, 'dev3')
    assert.equal(hit.message.source.senderAgent, 'cd33x1')
    // NEVER a session-plane call — the session lives at the peer
    assert.equal(gw.calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('peer write-back: initiator not live → bounded unread buffer; initiatorSession absent → honest failure', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    saveConversations(home, { conversations: [{
      shortId: 'ini888', machine: 'dev3', agent: 'cd33x1', sessionId: 'sess-at-dev3',
      initiatorSession: 'session-gone-away', createdAt: 1, lastActivityAt: 1,
    }] })
    // no live agent for 'session-gone-away' → the existing buffer machinery
    const { ingest, delivery } = assembly(home, gw, { liveSession: 'session-other' })
    const buffered = await ingest.ingest({
      kind: 'message',
      to: { machine: self.id, id: 'q7m2xp' },
      conversationId: 'ini888',
      message: 'buffered write-back',
      from: { machine: 'dev3', agent: 'cd33x1', sessionId: 'session-at-dev3-side' },
      messageId: 'a2a-pwb-2',
    })
    assert.deepEqual(buffered, { outcome: 'delivered', messageId: 'a2a-pwb-2', conversationId: 'ini888', sessionId: 'session-gone-away' })
    assert.equal(delivery.buffered.length, 1)
    assert.equal(delivery.buffered[0].initiatorSessionId, 'session-gone-away')
    assert.equal(delivery.buffered[0].message.conversationId, 'ini888')
    // initiatorSession never persisted → the write-back cannot be addressed
    saveConversations(home, { conversations: [{
      shortId: 'ini999', machine: 'dev3', agent: 'cd33x1', sessionId: 'sess-at-dev3', createdAt: 1, lastActivityAt: 1,
    }] })
    const failed = await ingest.ingest({
      kind: 'message',
      to: { machine: self.id, id: 'q7m2xp' },
      conversationId: 'ini999',
      message: 'x',
      from: { machine: 'dev3', agent: 'cd33x1', sessionId: 'session-at-dev3-side' },
      messageId: 'a2a-pwb-3',
    })
    assert.equal(failed.outcome, 'failed')
    assert.equal(failed.error.code, 'a2a/no-initiator-session')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// helper: read the raw outbox file (test-only view)
function readOutbox(home) {
  try {
    return JSON.parse(readFileSync(join(home, 'superd', 'a2a-outbox.json'), 'utf8'))
  } catch {
    return { envelopes: [] }
  }
}

// ------------------------------------------------------- D20 reply semantics v3

test('D20: latch set (channel used in an earlier turn) → turn end yields the plain notice, never a transcript', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    saveConversations(home, { conversations: [{
      shortId: 'abc123', machine: self.id, agent: 'f4g5h6', sessionId: 'sess-latch-1', title: '[undefined]',
      hostAgent: 'q7m2xp', channelUsed: true, lastSentAt: 100, createdAt: 1, lastActivityAt: 1,
    }] })
    gw.stream({
      frames: [
        snap([
          ev('turn/start', { turn: 2 }, 1),
          userMsg('a2a-msg-9', 2),
          asstMsg(2, 'words it wrote but never sent through the channel', 3),
        ]),
        turnEnd(2, 4),
      ],
    })
    const { ingest, delivery } = assembly(home, gw)
    await ingest.ingest({ ...mkEnv(self.id, self.id), kind: 'message', messageId: 'a2a-msg-9' })
    await until(() => delivery.delivered.length > 0)
    const hit = delivery.delivered[0]
    assert.equal(hit.message.source.kind, 'a2a-notice')
    assert.match(hit.message.content[0].text, /turn ended, no reply/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('0.1.7-h R2: a stop stamped on the row → the completion watch attributes the turn end to the initiator (stopped-by-initiator), never peer-silent', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-eeeeeeee-7777' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    // The stop stamp rides the registry before the watch arms. Production
    // writes it between arm and turn end (ingestStop, after a live cancel);
    // pre-staging it keeps the framed turnEnd deterministically ordered after
    // the stamp — the watch compares stamps against its arm watermark only.
    saveConversations(home, { conversations: [{
      shortId: 'abc123',
      machine: self.id,
      agent: 'f4g5h6',
      sessionId: 'sess-eeeeeeee-7777',
      title: '[undefined]',
      hostAgent: 'q7m2xp',
      initiatorSession: 'session-init-1',
      createdAt: 1,
      lastActivityAt: 1,
      stoppedAt: Date.now(),
    }] })
    gw.stream({
      frames: [
        snap([
          ev('turn/start', { turn: 1 }, 1),
          userMsg('a2a-msg-1', 2),
          asstMsg(1, 'the local answer', 3),
        ]),
        turnEnd(1, 4, 'aborted'),
      ],
    })
    const { ingest, delivery } = assembly(home, gw)
    await ingest.ingest(mkEnv(self.id, self.id))
    await until(() => delivery.delivered.length > 0)
    const hit = delivery.delivered[0]
    assert.equal(hit.message.source.kind, 'a2a-notice')
    assert.equal(hit.message.source.reason, 'stop')
    assert.equal(
      hit.message.content[0].text,
      `[superd-hub:a2a] kind=notice conversation=abc123 from=${self.id}-q7m2xp reason=stopped-by-initiator summary="conversation abc123: turn stopped by initiator request"`,
    )
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('D20: a channel send inside the armed window suppresses the artifact (the send WAS the reply)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  let release
  const gate = new Promise((r) => { release = r })
  const gw = {
    face: {
      async dispatchRpc(endpoint, payload) {
        if (endpoint === WIRE.sessionCreate) return { ok: true, value: { sessionId: 'sess-gated-1' } }
        return { ok: true, value: { accepted: true } }
      },
      openWireStream() {
        return (async function* () {
          yield snap([
            ev('turn/start', { turn: 1 }, 1),
            userMsg('a2a-msg-1', 2),
            asstMsg(1, 'late words', 3),
          ])
          await gate // hold the turn open: mid-turn the hosted peer sends via the channel
          yield turnEnd(1, 4)
        })()
      },
    },
  }
  const { ingest, delivery } = assembly(home, gw)
  try {
    await ingest.ingest(mkEnv(self.id, self.id))
    // mid-turn: the peer's channel send moves the latch + the watermark
    saveConversations(home, {
      conversations: loadConversations(home).conversations.map((r) => ({ ...r, channelUsed: true, lastSentAt: 999 })),
    })
    release()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(delivery.delivered.length, 0, 'the send was this turn\'s artifact — the watch must add nothing')
  } finally { release?.(); rmSync(home, { recursive: true, force: true }) }
})

test('D20: transcript reply envelope carries transcribed:true on the wire (remote initiator)', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  upsertRemote(home, { id: 'dev3', name: 'dev3', label: 'dev3', origin: 'http://dev3:4999', cookie: 'dsh-auth-dev3=1', enabled: true, addedAt: 1 })
  const posts = []
  const fetchImpl = async (url, init) => {
    posts.push({ url: String(url), init })
    return new Response(JSON.stringify({ outcome: 'delivered' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    saveConversations(home, { conversations: [{
      shortId: 'abc123', machine: 'dev3', agent: 'f4g5h6', sessionId: 'sess-wire-1', title: '[undefined]',
      hostAgent: 'q7m2xp', createdAt: 1, lastActivityAt: 1,
    }] })
    gw.stream({
      frames: [
        snap([
          ev('turn/start', { turn: 1 }, 1),
          userMsg('a2a-msg-5', 2),
          asstMsg(1, 'the turn-end words', 3),
        ]),
        turnEnd(1, 4),
      ],
    })
    const { ingest } = assembly(home, gw, { fetchImpl })
    await ingest.ingest({ ...mkEnv(self.id, 'dev3'), kind: 'message', messageId: 'a2a-msg-5' })
    await until(() => posts.length > 0)
    const frame = JSON.parse(posts[0].init.body)
    assert.equal(frame.v, 1)
    assert.equal(frame.envelope.kind, 'reply')
    assert.equal(frame.envelope.transcribed, true)
    assert.equal(frame.envelope.text, 'the turn-end words')
    assert.deepEqual(frame.envelope.sender, { machine: self.id, agent: 'q7m2xp' })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('D20: self-route write-back — the hosted peer sends (from=hostAgent) → delivered into initiatorSession, NEVER injected', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  try {
    saveConversations(home, { conversations: [{
      shortId: 'wb005', machine: self.id, agent: 'nativ1', sessionId: 'sess-host-9', title: 'self-route wb',
      hostAgent: 'q7m2xp', initiatorSession: 'session-init-9', createdAt: 1, lastActivityAt: 1,
    }] })
    const { ingest, delivery } = assembly(home, gw, { liveSession: 'session-init-9' })
    const out = await ingest.ingest({
      kind: 'message',
      to: { machine: self.id, id: 'nativ1' },
      conversationId: 'wb005',
      message: 'the result through the channel',
      from: { machine: self.id, agent: 'q7m2xp', sessionId: 'sess-host-9' },
      messageId: 'a2a-wb-1',
    })
    assert.deepEqual(out, { outcome: 'delivered', messageId: 'a2a-wb-1', conversationId: 'wb005', sessionId: 'session-init-9' })
    assert.equal(gw.rpcs(WIRE.promptSubmit).length, 0, 'write-back NEVER injects into the peer\'s own session')
    assert.equal(gw.streams(WIRE.streamOpen).length, 0)
    const hit = delivery.delivered[0]
    assert.equal(hit.sessionId, 'session-init-9')
    assert.equal(hit.message.source.kind, 'a2a-relay')
    assert.match(hit.message.content[0].text, /\[superd-hub:a2a\] kind=reply form=relay conversation=wb005 from=....-q7m2xp message=a2a-wb-1/)
    assert.match(hit.message.content[0].text, /the result through the channel/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ------------------------------------------------------- operational journal (0.1.7-b)

test('operational journal: the ingest lifecycle emits one greppable line per machine event', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-ingest-'))
  const self = ensureSelf(home, 'local')
  const lines = []
  const log = (level, event, fields = {}) => lines.push({ level, event, fields })
  try {
    saveConversations(home, { conversations: [{
      shortId: 'abc123', machine: self.id, agent: 'f4g5h6', sessionId: 'sess-jrnl-1', title: 'journal',
      hostAgent: 'q7m2xp', channelUsed: true, lastSentAt: 100, createdAt: 1, lastActivityAt: 1,
    }] })
    gw.stream({
      frames: [
        snap([
          ev('turn/start', { turn: 2 }, 1),
          userMsg('a2a-msg-j1', 2),
          asstMsg(2, 'unsent words', 3),
        ]),
        turnEnd(2, 4),
      ],
    })
    const { ingest, delivery } = assembly(home, gw, { log })
    await ingest.ingest({ ...mkEnv(self.id, self.id), kind: 'message', messageId: 'a2a-msg-j1' })
    await until(() => delivery.delivered.length > 0)
    const at = (event) => lines.findIndex((l) => l.event === event)
    const find = (event) => lines.find((l) => l.event === event)
    // request lifecycle
    const done = find('ingest.done')
    assert.ok(done, 'ingest.done present')
    assert.equal(done.fields.kind, 'message')
    assert.equal(done.fields.outcome, 'delivered')
    assert.equal(done.fields.conversation, 'abc123')
    assert.equal(done.level, 'info')
    // completion watch: armed before the artifact, latch branch → notice
    assert.ok(at('completion.armed') < at('completion.notice'), 'armed precedes the artifact line')
    assert.equal(find('completion.armed').fields.conversation, 'abc123')
    assert.equal(find('completion.notice').fields.conversation, 'abc123')
    // return routing: self-routed delivery, one line per hop
    assert.equal(find('route.deliver').fields.kind, 'notice')
    assert.equal(find('deliver.local').fields.kind, 'notice')
    assert.equal(find('deliver.local').fields.outcome, 'followup')
    // duplicate re-POST parks idempotently
    await ingest.ingest({ ...mkEnv(self.id, self.id), kind: 'message', messageId: 'a2a-msg-j1' })
    const park = find('ingest.park')
    assert.ok(park, 'ingest.park present')
    assert.equal(park.fields.message, 'a2a-msg-j1')
    assert.equal(park.fields.reason, 'duplicate')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
