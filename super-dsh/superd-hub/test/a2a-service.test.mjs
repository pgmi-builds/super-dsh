// A2A conversation service (mesh P3 Task 2): registry persistence, send
// receipts, completion capture over the session/follow stream, stop scopes,
// and the bounded unread buffer — all against a scripted fake gateway whose
// recorded calls are asserted byte-exactly against the wire-endpoints mirrors.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createA2aService, A2A_MESSAGE_TEMPLATE, renderA2aEnvelope, A2A_BUFFER_MAX, loadConversations, saveConversations, shortIdFor, isDegenerateShortId, A2aAddressError } from '../dist/a2a-service.js'
import { createA2aIngest } from '../dist/a2a-ingest.js'
import { ensureSelf, upsertRemote } from '../dist/machines.js'
import { WIRE } from '../dist/wire-endpoints.js'
import { EnvelopeError } from '../dist/envelope.js'

// ---------------------------------------------------------------- fixtures

/** Scripted fake gateway: a queue of rpc results / streams; every call recorded. */
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
        // stay open like a live follow stream until disposed/aborted
        await new Promise((_, reject) => {
          if (signal?.aborted) { reject(new Error('aborted')); return }
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      })()
    },
  }
  return {
    calls,
    rpc: (entry) => rpcScript.push(entry),
    stream: (entry) => streamScript.push(entry),
    face,
    streamOpens: () => calls.filter((c) => c.kind === 'stream').length,
    rpcs: (endpoint) => calls.filter((c) => c.kind === 'rpc' && c.endpoint === endpoint),
  }
}

/**
 * R4 assembly fixture: service + the SHARED ingest (the self-routing leg),
 * exactly like a2a-row wires it. opts: gatewayFor override, noIngest,
 * fetchImpl (remote wire fixture), delivery ctx.
 */
const mkService = (gw, opts = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  const gatewayFor = opts.gatewayFor ?? ((addr) => (addr.machine === 'nowhere' ? undefined : gw.face))
  const delivery = opts.delivery ?? {
    agents: { get: () => undefined },
    buffer: () => { /* in-memory only; tests needing the buffer inject their own */ },
  }
  let ingestRef
  const svc = createA2aService({
    home,
    gatewayFor,
    ...(opts.noIngest ? {} : { ingest: () => ingestRef }),
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    ...(opts.log === undefined ? {} : { log: opts.log }),
    now: () => 1234500,
  })
  ingestRef = opts.noIngest ? undefined : createA2aIngest({ home, gatewayFor, delivery, now: () => 1234500, ...(opts.log === undefined ? {} : { log: opts.log }) })
  return { home, svc, selfM4 }
}

/** A local initiator identity (the from of self-routed envelopes). */
const localInitiator = (selfM4) => ({ machine: selfM4, agent: INITIATOR.agent, sessionId: INITIATOR.sessionId })

/** Pair a remote machine row (remote-route tests) + a recording fetch fixture. */
const mkRemote = (home, opts = {}) => {
  upsertRemote(home, { id: 'k3f9', name: 'k3f9', label: 'k3f9', origin: 'http://k3f9:4999', cookie: 'dsh-auth-k3f9=1', enabled: true, addedAt: 1 })
  const posts = []
  const fetchImpl = opts.fetchImpl ?? (async (url, init) => {
    posts.push({ url: String(url), init })
    return new Response(JSON.stringify(opts.receipt ?? { outcome: 'delivered', messageId: 'x', conversationId: 'rem001', sessionId: 'sess-at-k3f9' }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return { posts, fetchImpl }
}

const ADDR = { machine: 'k3f9', id: 'q7m2xp' }
const INITIATOR = { machine: 'm1ab', agent: 'a2b3c4', sessionId: 'sess-init-1' }
const teaching = (i, title, shortId, message) =>
  `A2A message from ${i.machine}-${i.agent} (conversation "${title}"):\n\n${message}\n\nThis conversation is initiated through superd-hub by the sender. The sender sees only what arrives through this conversation.\n\nAs superd-hub hosts various kinds of agent runtimes, integration into each runtime and superd-hub tool availability in each runtime session might differ.\n\nTo reply, send a message back: with a superd-hub tool, if available, {action:"send", agent:"${i.machine}-${i.agent}", conversationId:"${shortId}", message:"…"}. You can send at any point, more than once — sending does not end your turn.\n\nIf the hub receive no hub message from you (intentionally or whatever situation prevents so), your last output at this turn's end is delivered to the sender as your reply.`

const seedConversation = (gw, sessionId = 'sess-gggggggg-7777') => {
  gw.rpc({ result: { ok: true, value: { sessionId } } })
}

// follow-stream frame builders (upstream SessionFollowFrame vocabulary)
const ev = (type, data, seq) => ({ type: 'event', event: { type, seq, time: 1, data } })
const snap = (records) => ({ type: 'snapshot', header: { version: 1, id: 's' }, cursor: 0, records, hasMore: false, projections: {} })
const userMsg = (rpcId, seq) => ev('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: 'in' }], source: { kind: 'user', rpcId, clientTimeZone: 'UTC' } }, seq)
const asstMsg = (turn, text, seq) => ev('assistant/message', { turn, step: 0, interrupted: false, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text }] }, stream: [] }, seq)
const turnEnd = (turn, seq, kind = 'completed') => ev('turn/end', { turn, reason: { kind } }, seq)

/** Poll until cond() is truthy (small steps, bounded wait). */
const until = async (cond, ms = 2000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('timed out')
}
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms))

/** A restarted service over the SAME home (fresh ingest sharing the persisted registry). */
const mkRestartedService = (home, gw) => {
  let ingestRef
  const svc = createA2aService({ home, gatewayFor: () => gw.face, ingest: () => ingestRef, now: () => 1234999 })
  ingestRef = createA2aIngest({ home, gatewayFor: () => gw.face, delivery: { agents: { get: () => undefined }, buffer: () => {} }, now: () => 1234999 })
  return svc
}

// ---------------------------------------------------------------- send (the single A2A door: create-or-resume)

test('send create-path (self-hosted): byte-exact prompt + MIRROR row 0600; title verbatim, ZERO rename calls', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-aaaaaaaa-1111' } } }) // create
  gw.rpc({ result: { ok: true, value: { accepted: true } } })                   // prompt
  const { home, svc, selfM4 } = mkService(gw)
  try {
    const out = await svc.send({ to: { machine: selfM4, id: 'q7m2xp' }, title: 'Bug triage', message: 'do the triage' }, localInitiator(selfM4))
    assert.equal(out.outcome, 'delivered')
    assert.match(out.conversationId, /^[a-z0-9]{6}$/, 'initiator-minted random 6')
    assert.equal(out.sessionId, 'sess-aaaaaaaa-1111')
    assert.deepEqual(gw.rpcs(WIRE.sessionCreate).map((c) => c.payload), [{ args: { request: {} } }])
    // D17 (postoffice R2): the title is hub-owned registry state — the A2A
    // path NEVER writes through to the upstream runtime session title.
    assert.equal(gw.rpcs(WIRE.sessionTitle).length, 0)
    // the opening turn is the teaching envelope wrapping the first message
    const prompt = gw.rpcs(WIRE.promptSubmit)[0].payload.args.request
    assert.equal(prompt.sessionId, 'sess-aaaaaaaa-1111')
    assert.deepEqual(prompt.content, [{ type: 'text', text: teaching(localInitiator(selfM4), 'Bug triage', out.conversationId, 'do the triage') }])
    // MIRROR row (self-hosted): points at the initiator, carries hostAgent
    const rows = loadConversations(home).conversations
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], {
      shortId: out.conversationId, machine: selfM4, agent: INITIATOR.agent,
      sessionId: 'sess-aaaaaaaa-1111', title: 'Bug triage', hostAgent: 'q7m2xp',
      // D20: self-route mirror rows backfill the initiator session (the
      // hosted peer's write-back delivery address)
      initiatorSession: INITIATOR.sessionId,
      createdAt: rows[0].createdAt, lastActivityAt: rows[0].lastActivityAt,
    })
    assert.equal(statSync(join(home, 'superd', 'a2a-conversations.json')).mode & 0o777, 0o600)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('send create-path: no title → [undefined] placeholder; unpaired machine → typed unknown-machine; a title NEVER renames upstream (D17)', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-bbbbbbbb-2222' } } }) // create
  gw.rpc({ result: { ok: true, value: { accepted: true } } })                    // prompt
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    const out = await svc.send({ to: local, message: 'no title here' }, localInitiator(selfM4))
    assert.equal(out.outcome, 'delivered')
    assert.match(out.conversationId, /^[a-z0-9]{6}$/)
    // D17: unspecified → the '[undefined]' placeholder, stored at mint
    assert.equal(loadConversations(home).conversations[0].title, '[undefined]')
    assert.equal(gw.rpcs(WIRE.sessionTitle).length, 0)
    // R4: an UNPAIRED machine is a typed failure receipt (send never throws)
    const bad = await svc.send({ to: { machine: 'nowhere', id: 'zzzzzz' }, message: 'x' }, localInitiator(selfM4))
    assert.equal(bad.outcome, 'failed')
    assert.equal(bad.error.code, 'a2a/unknown-machine')
    // a specified title lands in the registry verbatim — still zero rename calls
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-cccccccc-3333' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    const titled = await svc.send({ to: local, title: 'x', message: 'y' }, localInitiator(selfM4))
    assert.equal(titled.sessionId, 'sess-cccccccc-3333')
    assert.equal(loadConversations(home).conversations.find((r) => r.sessionId === 'sess-cccccccc-3333').title, 'x')
    assert.equal(gw.rpcs(WIRE.sessionTitle).length, 0)
    // fresh mints never collide (the registry is the taken-set)
    assert.notEqual(out.conversationId, titled.conversationId)
  } finally { rmSync(home, { recursive: true, force: true }) }
})


test('send create-path: title lands in the registry (no rename); prompt still goes out; injected receipt', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-ffffffff-6666' } } }) // create
  gw.rpc({ result: { ok: true, value: { accepted: true } } })                   // prompt
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    const receipt = await svc.send({ to: local, title: 'Nope', message: 'never sent' }, localInitiator(selfM4))
    assert.equal(receipt.outcome, 'delivered')
    assert.equal(receipt.sessionId, 'sess-ffffffff-6666')
    assert.match(receipt.conversationId, /^[a-z0-9]{6}$/)
    assert.equal(receipt.error, undefined)
    assert.equal(gw.rpcs(WIRE.sessionTitle).length, 0)
    assert.equal(gw.rpcs(WIRE.promptSubmit).length, 1)
    const rows = loadConversations(home).conversations
    assert.equal(rows.find((r) => r.sessionId === 'sess-ffffffff-6666').title, 'Nope')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- send

test('F1/D28 rollout tolerance: a legacy `injected` receipt from an older peer is accepted as delivered', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  try {
    const remote = mkRemote(home, { receipt: { outcome: 'injected', messageId: 'x', conversationId: 'leg001', sessionId: 'sess-old-peer' } })
    const svc = createA2aService({ home, gatewayFor: () => gw.face, fetchImpl: remote.fetchImpl, now: () => 5 })
    const r = await svc.send({ to: ADDR, title: 'legacy', message: 'hi' }, localInitiator(selfM4))
    assert.equal(r.outcome, 'delivered') // the legacy word normalizes — no throw, no false `failed`
    assert.equal(r.conversationId, 'leg001')
    // and the initiator row IS recorded (the pre-fix failure dropped the peer's reply)
    assert.ok(loadConversations(home).conversations.some((row) => row.shortId === 'leg001'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// T5/D28: hub-to-hub is a synchronous POST — no poll surface. The sender gets a
// receipt within the sync window; if the wire has not settled by then it answers
// `accepted` and the SAME in-flight request finishes into a delivered/undelivered
// notice.
test('T5/D28: a wire missing the sync window returns accepted, then settles into a delivered notice', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  const notices = []
  try {
    upsertRemote(home, { id: 'k3f9', name: 'k3f9', label: 'k3f9', origin: 'http://k3f9:4999', cookie: 'dsh-auth-k3f9=1', enabled: true, addedAt: 1 })
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body)
      await new Promise((r) => setTimeout(r, 40))
      return new Response(JSON.stringify({ outcome: 'delivered', messageId: body.envelope.messageId, conversationId: body.envelope.conversationId, sessionId: 'sess-slow-1' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const ingestRef = { ingest: async (env) => { notices.push(env); return { outcome: 'delivered', messageId: env.messageId, conversationId: env.conversation, sessionId: 'sess-self-1' } } }
    const svc = createA2aService({ home, gatewayFor: () => gw.face, ingest: () => ingestRef, fetchImpl, now: () => 5, syncReceiptMs: 5 })
    const r = await svc.send({ to: ADDR, message: 'slow one' }, localInitiator(selfM4))
    assert.equal(r.outcome, 'accepted')
    assert.match(r.conversationId, /^[a-z0-9]{6}$/)
    assert.match(r.note, /keeps running/)
    await until(() => notices.length > 0)
    const n = notices[0]
    assert.equal(n.kind, 'notice')
    assert.equal(n.reason, 'delivered')
    assert.equal(n.conversation, r.conversationId)
    assert.match(n.summary, /delivered/)
    assert.deepEqual(n.to, { machine: selfM4, agent: INITIATOR.agent, sessionId: INITIATOR.sessionId })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('T5/D28: a wire that FAILS after the sync window settles into an undelivered notice', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  const notices = []
  try {
    upsertRemote(home, { id: 'k3f9', name: 'k3f9', label: 'k3f9', origin: 'http://k3f9:4999', cookie: 'dsh-auth-k3f9=1', enabled: true, addedAt: 1 })
    const fetchImpl = async () => {
      await new Promise((r) => setTimeout(r, 40))
      return new Response('nope', { status: 500 })
    }
    const ingestRef = { ingest: async (env) => { notices.push(env); return { outcome: 'delivered', messageId: env.messageId, conversationId: env.conversation, sessionId: 'sess-self-1' } } }
    const svc = createA2aService({ home, gatewayFor: () => gw.face, ingest: () => ingestRef, fetchImpl, now: () => 5, syncReceiptMs: 5 })
    const r = await svc.send({ to: ADDR, message: 'doomed' }, localInitiator(selfM4))
    assert.equal(r.outcome, 'accepted')
    await until(() => notices.length > 0)
    assert.equal(notices[0].reason, 'undelivered')
    assert.match(notices[0].summary, /undelivered/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('send without conversationId: create path — create(+rename) then prompt; injected receipt; row persisted', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-dddddddd-4444' } } }) // create
  // D17/R2: no rename call anymore — create goes straight to prompt
  gw.rpc({ result: { ok: true, value: { accepted: true } } })                  // prompt
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    const receipt = await svc.send({ to: local, title: 'Sync review', message: 'check the build' }, localInitiator(selfM4))
    assert.equal(receipt.outcome, 'delivered')
    assert.match(receipt.messageId, /^a2a-/)
    assert.match(receipt.conversationId, /^[a-z0-9]{6}$/)
    assert.equal(receipt.sessionId, 'sess-dddddddd-4444')
    assert.equal(receipt.error, undefined)
    // prompt payload: the mirror shape with the teaching envelope as text part
    const prompt = gw.rpcs(WIRE.promptSubmit)[0].payload
    assert.deepEqual(prompt, {
      args: {
        request: {
          requestId: receipt.messageId,
          sessionId: 'sess-dddddddd-4444',
          mode: 'queue',
          content: [{ type: 'text', text: teaching(localInitiator(selfM4), 'Sync review', receipt.conversationId, 'check the build') }],
        },
      },
    })
    const rows = loadConversations(home).conversations
    assert.equal(rows.length, 1)
    assert.equal(rows[0].title, 'Sync review')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('send with conversationId: no create call; stored sessionId; lastActivityAt bump; shortId stable across service restart', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-eeeeeeee-5555' } } })
  gw.rpc({ result: { ok: true, value: { accepted: true } } })
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    const first = await svc.send({ to: local, message: 'one' }, localInitiator(selfM4))
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    // fresh service over the same home = restart; conversationId still resolves
    const svc2 = mkRestartedService(home, gw)
    const second = await svc2.send({ to: local, conversationId: first.conversationId, message: 'two', delivery: 'steer' }, localInitiator(selfM4))
    assert.equal(second.outcome, 'delivered')
    assert.equal(second.conversationId, first.conversationId)
    assert.equal(second.sessionId, 'sess-eeeeeeee-5555')
    assert.equal(gw.rpcs(WIRE.sessionCreate).length, 1) // no second create
    assert.deepEqual(gw.rpcs(WIRE.promptSubmit)[1].payload.args.request, {
      requestId: second.messageId,
      sessionId: 'sess-eeeeeeee-5555',
      mode: 'steer',
      content: [{ type: 'text', text: teaching(localInitiator(selfM4), '(untitled)', first.conversationId, 'two') }],
    })
    const rows = loadConversations(home).conversations
    assert.equal(rows[0].lastActivityAt, 1234999)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('send failure taxonomy: gateway throw → failed verbatim; business {ok:false} → failed verbatim; unknown id → failed', async () => {
  const gw = fakeGateway()
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    // transport throw before inject — error verbatim (code + message)
    gw.rpc({ throw: new EnvelopeError({ code: 'gateway/unreachable', message: 'mesh-gateway: POST failed — ECONNREFUSED' }) })
    const r1 = await svc.send({ to: local, message: 'x' }, localInitiator(selfM4))
    assert.equal(r1.outcome, 'failed')
    assert.equal(r1.sessionId, '')
    assert.deepEqual(r1.error, { code: 'gateway/unreachable', message: 'mesh-gateway: POST failed — ECONNREFUSED' })
    // business rejection — error body verbatim incl. details
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-ffffffff-6666' } } })
    gw.rpc({ result: { ok: false, error: { code: 'session/agent-busy', message: 'busy', details: { sessionId: 'sess-ffffffff-6666' } } } })
    const r2 = await svc.send({ to: local, message: 'x' }, localInitiator(selfM4))
    assert.equal(r2.outcome, 'failed')
    assert.equal(r2.sessionId, 'sess-ffffffff-6666')
    assert.deepEqual(r2.error, { code: 'session/agent-busy', message: 'busy', details: { sessionId: 'sess-ffffffff-6666' } })
    // unknown conversation id → failed with actionable next step
    const r3 = await svc.send({ to: local, conversationId: 'nope1234', message: 'x' }, localInitiator(selfM4))
    assert.equal(r3.outcome, 'failed')
    assert.equal(r3.error.code, 'a2a/conversation-not-found')
    assert.match(r3.error.message, /without conversationId/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('teaching template: ONE exported constant; renderer fills initiator identity; untitled fallback', () => {
  assert.equal(
    A2A_MESSAGE_TEMPLATE,
    'A2A message from {machine}-{agent} (conversation "{title}"):\n\n{message}\n\nThis conversation is initiated through superd-hub by the sender. The sender sees only what arrives through this conversation.\n\nAs superd-hub hosts various kinds of agent runtimes, integration into each runtime and superd-hub tool availability in each runtime session might differ.\n\nTo reply, send a message back: with a superd-hub tool, if available, {action:"send", agent:"{machine}-{agent}", conversationId:"{shortId}", message:"…"}. You can send at any point, more than once — sending does not end your turn.\n\nIf the hub receive no hub message from you (intentionally or whatever situation prevents so), your last output at this turn\'s end is delivered to the sender as your reply.',
  )
  assert.equal(
    renderA2aEnvelope({ machine: 'm1ab', agent: 'a2b3c4', title: 'T', shortId: 'sess-ddd', message: 'hi' }),
    'A2A message from m1ab-a2b3c4 (conversation "T"):\n\nhi\n\nThis conversation is initiated through superd-hub by the sender. The sender sees only what arrives through this conversation.\n\nAs superd-hub hosts various kinds of agent runtimes, integration into each runtime and superd-hub tool availability in each runtime session might differ.\n\nTo reply, send a message back: with a superd-hub tool, if available, {action:"send", agent:"m1ab-a2b3c4", conversationId:"sess-ddd", message:"…"}. You can send at any point, more than once — sending does not end your turn.\n\nIf the hub receive no hub message from you (intentionally or whatever situation prevents so), your last output at this turn\'s end is delivered to the sender as your reply.',
  )
  assert.ok(renderA2aEnvelope({ machine: 'm', agent: 'a', shortId: 's', message: 'x' }).includes('"(untitled)"'))
  // D17: the '[undefined]' registry placeholder renders as the friendly untitled display
  assert.ok(renderA2aEnvelope({ machine: 'm', agent: 'a', title: '[undefined]', shortId: 's', message: 'x' }).includes('"(untitled)"'))
})

test('title immutability (D17): a later send never rewrites the stored title, whatever title it carries', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-titl222-9001' } } }) // create (titled)
  gw.rpc({ result: { ok: true, value: { accepted: true } } })                   // prompt
  gw.rpc({ result: { ok: true, value: { accepted: true } } })                   // prompt (resume)
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    const first = await svc.send({ to: local, title: 'Original', message: 'one' }, localInitiator(selfM4))
    assert.equal(first.outcome, 'delivered')
    // resume with a DIFFERENT title: the create-time title is immutable — the
    // send's title field is simply not a write path for existing rows
    const second = await svc.send({ to: local, conversationId: first.conversationId, title: 'Intruder', message: 'two' }, localInitiator(selfM4))
    assert.equal(second.outcome, 'delivered')
    const rows = loadConversations(home).conversations
    assert.equal(rows.length, 1)
    assert.equal(rows[0].title, 'Original')
    assert.equal(gw.rpcs(WIRE.sessionTitle).length, 0)
    // and the teaching envelope for the resume still carries the stored title
    const prompt = gw.rpcs(WIRE.promptSubmit)[1].payload.args.request
    assert.ok(prompt.content[0].text.includes('conversation "Original"'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- subscribeCompletion

test('subscribeCompletion armed by requestId: cb exactly once with final assistant text; auto-dispose', async () => {
  const gw = fakeGateway()
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    saveConversations(home, { conversations: [{ shortId: 'conv999', machine: selfM4, agent: 'q7m2xp', sessionId: 'sess-gggggggg-7777', createdAt: 1, lastActivityAt: 1 }] })
    const conversationId = 'conv999'
    const fired = []
    gw.stream({
      frames: [
        snap([
          ev('turn/start', { turn: 1 }, 1),
          userMsg('a2a-mine', 2),
          asstMsg(1, 'first attempt', 3),
          asstMsg(1, 'final answer text', 4), // LAST assistant/message of turn 1 wins
        ]),
        turnEnd(1, 5),
        ev('turn/start', { turn: 2 }, 6), // later traffic must not re-fire
        asstMsg(2, 'next turn', 7),
        turnEnd(2, 8),
      ],
      die: new Error('cut'),
    })
    const dispose = svc.subscribeCompletion(
      { to: local, conversationId },
      (c) => fired.push(c),
      { requestId: 'a2a-mine' },
    )
    await until(() => fired.length === 1)
    await settle()
    assert.equal(fired.length, 1)
    assert.deepEqual(fired[0], {
      conversationId, sessionId: 'sess-gggggggg-7777', turn: 1, reason: 'completed', text: 'final answer text',
    })
    dispose()
    await settle()
    assert.equal(gw.streamOpens(), 1) // armed fire auto-disposed; no resubscribe for the scripted death
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('subscribeCompletion unarmed: one cb per observed turn completion; interrupted attempts excluded', async () => {
  const gw = fakeGateway()
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    saveConversations(home, { conversations: [{ shortId: 'conv999', machine: selfM4, agent: 'q7m2xp', sessionId: 'sess-gggggggg-7777', createdAt: 1, lastActivityAt: 1 }] })
    const conversationId = 'conv999'
    const fired = []
    gw.stream({
      frames: [
        ev('turn/start', { turn: 1 }, 1),
        asstMsg(1, 'a1', 2),
        turnEnd(1, 3),
        ev('turn/start', { turn: 2 }, 4),
        asstMsg(2, 'interrupted partial', 5), // replaced attempt — not final
        ev('assistant/message', { turn: 2, step: 0, interrupted: true, message: { role: 'assistant', content: [{ type: 'text', text: 'interrupted partial' }] }, stream: [] }, 6),
        asstMsg(2, 'real answer', 7),
        turnEnd(2, 8, 'aborted'),
      ],
    })
    const dispose = svc.subscribeCompletion({ to: local, conversationId }, (c) => fired.push(c))
    await until(() => fired.length === 2)
    dispose()
    // follow payload: the mirror shape, address + assistantStream exactly as the UI passes it
    const streamCall = gw.calls.find((c) => c.kind === 'stream')
    assert.deepEqual(streamCall.payload, {
      args: { request: { address: { kind: 'session', sessionId: 'sess-gggggggg-7777' }, assistantStream: true } },
    })
    assert.equal(fired.length, 2)
    assert.deepEqual(fired.map((f) => [f.turn, f.text, f.reason]), [[1, 'a1', 'completed'], [2, 'real answer', 'aborted']])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('subscribeCompletion armed race: snapshot already carries the whole turn → cb fires from history', async () => {
  const gw = fakeGateway()
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    saveConversations(home, { conversations: [{ shortId: 'conv999', machine: selfM4, agent: 'q7m2xp', sessionId: 'sess-gggggggg-7777', createdAt: 1, lastActivityAt: 1 }] })
    const conversationId = 'conv999'
    const fired = []
    gw.stream({
      frames: [snap([
        ev('turn/start', { turn: 1 }, 1),
        userMsg('a2a-late', 2),
        asstMsg(1, 'already answered', 3),
        turnEnd(1, 4),
      ])],
    })
    svc.subscribeCompletion({ to: local, conversationId }, (c) => fired.push(c), { requestId: 'a2a-late' })
    await until(() => fired.length === 1)
    assert.equal(fired[0].text, 'already answered')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('subscribeCompletion stream death: exactly one resubscribe; second death → onError, never a third open', async () => {
  const gw = fakeGateway()
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    saveConversations(home, { conversations: [{ shortId: 'conv999', machine: selfM4, agent: 'q7m2xp', sessionId: 'sess-gggggggg-7777', createdAt: 1, lastActivityAt: 1 }] })
    const conversationId = 'conv999'
    const fired = []
    const errors = []
    gw.stream({ die: new Error('socket cut') })                              // first death
    gw.stream({ frames: [turnEnd(1, 9)], die: new Error('second cut') })      // resubscribe fires, then dies again
    const dispose = svc.subscribeCompletion({ to: local, conversationId }, (c) => fired.push(c), {
      onError: (e) => errors.push(e),
    })
    await until(() => fired.length === 1 && errors.length === 1)
    assert.equal(gw.streamOpens(), 2)
    assert.equal(errors[0].code, 'a2a/stream-dead')
    assert.match(errors[0].message, /second cut/)
    await settle()
    assert.equal(gw.streamOpens(), 2) // no third dial
    dispose()
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('subscribeCompletion armed history: terminal reason passes through verbatim (aborted turn in snapshot)', async () => {
  const gw = fakeGateway()
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    saveConversations(home, { conversations: [{ shortId: 'conv999', machine: selfM4, agent: 'q7m2xp', sessionId: 'sess-gggggggg-7777', createdAt: 1, lastActivityAt: 1 }] })
    const conversationId = 'conv999'
    const fired = []
    gw.stream({
      frames: [snap([
        ev('turn/start', { turn: 1 }, 1),
        userMsg('a2a-stop', 2),
        asstMsg(1, 'partial work', 3),
        turnEnd(1, 4, 'aborted'), // the turn ended ABORTED inside the snapshot
      ])],
    })
    svc.subscribeCompletion({ to: local, conversationId }, (c) => fired.push(c), { requestId: 'a2a-stop' })
    await until(() => fired.length === 1)
    assert.equal(fired[0].reason, 'aborted') // NOT the hardcoded 'completed'
    assert.equal(fired[0].text, 'partial work')
    await settle()
    assert.equal(fired.length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('subscribeCompletion: duplicate turn/end frame delivery fires the cb exactly once', async () => {
  const gw = fakeGateway()
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    saveConversations(home, { conversations: [{ shortId: 'conv999', machine: selfM4, agent: 'q7m2xp', sessionId: 'sess-gggggggg-7777', createdAt: 1, lastActivityAt: 1 }] })
    const conversationId = 'conv999'
    const fired = []
    gw.stream({
      frames: [
        ev('turn/start', { turn: 1 }, 1),
        asstMsg(1, 'once only', 2),
        turnEnd(1, 3),
        turnEnd(1, 3), // duplicate frame (replay/retry) — must not re-fire
        ev('turn/start', { turn: 2 }, 4),
        asstMsg(2, 'second turn', 5),
        turnEnd(2, 6),
      ],
    })
    const dispose = svc.subscribeCompletion({ to: local, conversationId }, (c) => fired.push(c))
    await until(() => fired.length === 2) // both turns complete...
    await settle()
    assert.equal(fired.length, 2) // ...and turn 1 fired exactly once despite the duplicate
    assert.deepEqual(fired.map((f) => [f.turn, f.text]), [[1, 'once only'], [2, 'second turn']])
    dispose()
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- stop

test('stop: turn scope → session/cancel mirror payload; session scope → turn-only degradation with typed reason', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-hhhhhhhh-8888' } } }) // create
  gw.rpc({ result: { ok: true, value: { accepted: true } } }) // prompt
  gw.rpc({ result: { ok: true, value: { accepted: true } } }) // cancel 1
  gw.rpc({ result: { ok: true, value: { accepted: true } } }) // cancel 2
  // the seeding send arms the INGEST's completion watcher — two dead stream
  // opens absorb it (open(0) + the one resubscribe) before the D5 scripts
  gw.stream({ die: new Error('watcher absorber 1') })
  gw.stream({ die: new Error('watcher absorber 2') })
  // D5: each stop first reads turn liveness over a follow snapshot — first
  // stop sees a LIVE turn, second sees idle (turn 1 already ended)
  gw.stream({ frames: [snap([ev('turn/start', { turn: 1 }, 1)])] })
  gw.stream({ frames: [snap([ev('turn/start', { turn: 1 }, 1), turnEnd(1, 2)])] })
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    const { conversationId } = await svc.send({ to: local, message: 'x' }, localInitiator(selfM4))
    await settle() // let the ingest watcher's two dead opens settle before the D5 liveness scripts
    const turn = await svc.stop({ to: local, conversationId }, 'turn')
    assert.deepEqual(turn, { scope: 'turn', cancelled: true })
    const session = await svc.stop({ to: local, conversationId }, 'session')
    assert.deepEqual(session, { scope: 'turn-only', cancelled: false, note: 'no turn was active', reason: 'no session-close endpoint upstream' })
    // both scopes dialed the cancel endpoint with the mirror payload
    assert.deepEqual(gw.rpcs(WIRE.turnCancel).map((c) => c.payload), [
      { args: { request: { sessionId: 'sess-hhhhhhhh-8888' } } },
      { args: { request: { sessionId: 'sess-hhhhhhhh-8888' } } },
    ])
    await assert.rejects(
      () => svc.stop({ to: local, conversationId: 'missing00' }, 'turn'),
      (e) => e instanceof EnvelopeError && e.wire.code === 'a2a/conversation-not-found',
    )
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- buffer + read

test('read: per-initiator sweep; bounded at 32 (oldest dropped)', () => {
  const gw = fakeGateway()
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    for (let i = 0; i < A2A_BUFFER_MAX + 2; i++) {
      svc.buffer('sess-init-1', { messageId: `m${i}`, from: ADDR, conversationId: 'sess-ddd', text: `msg ${i}` })
    }
    svc.buffer('sess-init-2', { messageId: 'other', from: ADDR, conversationId: 'sess-ddd', text: 'other' })
    // targeted read sweeps exactly that initiator
    const only = svc.read('sess-init-2')
    assert.equal(only.length, 1)
    assert.equal(only[0].text, 'other')
    assert.equal(svc.read('sess-init-2').length, 0)
    // bounded: 34 pushed → 32 kept, oldest dropped
    const all = svc.read()
    assert.equal(all.length, A2A_BUFFER_MAX)
    assert.equal(all[0].text, `msg 2`)
    assert.equal(all[all.length - 1].text, `msg ${A2A_BUFFER_MAX + 1}`)
    assert.ok(all.every((m) => m.initiatorSessionId === 'sess-init-1'))
    assert.equal(svc.read().length, 0) // swept
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- registry

test('registry: mint never collides with the taken-set; corrupt file reads empty and accepts fresh writes', async () => {
  const gw = fakeGateway()
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-aaaaaaaa-0001' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    const a = await svc.send({ to: local, message: 'seed' }, localInitiator(selfM4))
    assert.match(a.conversationId, /^[a-z0-9]{6}$/)
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-aaaaaaaab002' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    const b = await svc.send({ to: local, message: 'seed' }, localInitiator(selfM4))
    // R4: the initiator mints RANDOM ids — the registry is the taken-set, so
    // fresh mints never collide (the session-derived lengthening moved to
    // shortIdFor's unit surface; the wire mint is random by design)
    assert.match(b.conversationId, /^[a-z0-9]{6}$/)
    assert.notEqual(a.conversationId, b.conversationId)
    // corrupt file → empty shape, never throws
    writeFileSync(join(home, 'superd', 'a2a-conversations.json'), '{corrupt', 'utf8')
    assert.deepEqual(loadConversations(home), { conversations: [] })
    assert.deepEqual(svc.listConversations(), [])
    // and the service keeps working (fresh write replaces the corruption)
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-zzzzzzzz-0003' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    const c = await svc.send({ to: local, message: 'seed' }, localInitiator(selfM4))
    assert.equal(loadConversations(home).conversations.length, 1)
    assert.match(c.conversationId, /^[a-z0-9]{6}$/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('send guards: conversation registered under a different machine → typed mismatch receipt', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-mmmmmmmm-9999' } } })
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    const { conversationId } = await svc.send({ to: local, message: 'x' }, localInitiator(selfM4))
    const r = await svc.send({ to: { machine: 'other', id: 'q7m2xp' }, conversationId, message: 'x' }, localInitiator(selfM4))
    assert.equal(r.outcome, 'failed')
    assert.equal(r.error.code, 'a2a/conversation-machine-mismatch')
    assert.equal(gw.rpcs(WIRE.promptSubmit).length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- D2 shortId mint

test('shortIdFor (D2): strips the session- prefix, mints 6 of the uuid, lengthens 6→8→10 (step 2)', () => {
  const row = (shortId, sessionId) => ({ shortId, machine: 'm', agent: 'a', sessionId, createdAt: 1, lastActivityAt: 1 })
  // prefix-strip + mint: first 6 chars of the uuid — never the constant 'session-'
  assert.equal(shortIdFor('session-3138ea83-1778-4abc-9def-0123456789ab', []), '3138ea')
  // no prefix → the whole id is the base (older/foreign spellings)
  assert.equal(shortIdFor('abc123def456', []), 'abc123')
  // collision-lengthen 6→8→10
  const r1 = row('3138ea', 'session-aaaaaaaa-0001')
  assert.equal(shortIdFor('session-3138ea83-7777-1', [r1]), '3138ea83', '6 collides → 8')
  const r2 = row('3138ea83', 'session-aaaaaaaa-0002')
  assert.equal(shortIdFor('session-3138ea83-7777-1', [r1, r2]), '3138ea83-7', '8 collides → 10')
  // a legacy shortId stays reserved as taken: a new mint lengthens past it
  const legacy = row('4ce3e1', 'session-bbbbbbbb-0003')
  assert.equal(shortIdFor('session-4ce3e180-cccc', [legacy]), '4ce3e180')
  // re-seen sessionId keeps its row's shortId whatever it looks like
  assert.equal(shortIdFor('session-bbbbbbbb-0003', [legacy]), '4ce3e1')
})

test('registry (D2): legacy rows untouched and load verbatim; fresh mints keep clear of them (R4 random mint)', async () => {
  const gw = fakeGateway()
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    saveConversations(home, { conversations: [
      { shortId: '4ce3e1', machine: local.machine, agent: local.id, sessionId: 'session-4ce3e180-aaaa', createdAt: 1, lastActivityAt: 1 },
      { shortId: 'zzz999', machine: local.machine, agent: local.id, sessionId: 'session-zzz99900-bbbb', createdAt: 1, lastActivityAt: 1 },
    ] })
    // R4: new conversations mint RANDOM ids; legacy rows are never reminted
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-fresh001-0001' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    const fresh = await svc.send({ to: local, message: 'seed' }, localInitiator(selfM4))
    assert.match(fresh.conversationId, /^[a-z0-9]{6}$/)
    assert.notEqual(fresh.conversationId, '4ce3e1')
    assert.notEqual(fresh.conversationId, 'zzz999')
    // the legacy rows are untouched
    const rows = loadConversations(home).conversations
    assert.deepEqual(
      rows.filter((r) => ['session-4ce3e180-aaaa', 'session-zzz99900-bbbb'].includes(r.sessionId)).map((r) => r.shortId),
      ['4ce3e1', 'zzz999'],
    )
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- D5 honest stop

test('stop honesty (D5): idle snapshot → cancelled:false + note on BOTH scopes; the cancel still fires', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-nnnnnnnn-0000' } } }) // create
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    const { conversationId } = await svc.send({ to: local, message: 'x' }, localInitiator(selfM4))
    await settle() // ingest watcher settled; the D5 scripts below are consumed by the liveness reads
    gw.rpc({ result: { ok: true, value: { accepted: true } } })                       // cancel 1
    gw.stream({ frames: [snap([ev('turn/start', { turn: 2 }, 1), turnEnd(2, 2)])] }) // idle: turn ended
    const idleTurn = await svc.stop({ to: local, conversationId }, 'turn')
    assert.deepEqual(idleTurn, { scope: 'turn', cancelled: false, note: 'no turn was active' })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })          // cancel 2
    gw.stream({ frames: [snap([turnEnd(1, 3)])] })                       // idle: no turn/start at all
    const idleSession = await svc.stop({ to: local, conversationId }, 'session')
    assert.deepEqual(idleSession, { scope: 'turn-only', cancelled: false, note: 'no turn was active', reason: 'no session-close endpoint upstream' })
    // today's wire behavior is unchanged: both idle stops still fired the cancel
    assert.equal(gw.rpcs(WIRE.turnCancel).length, 2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('stop honesty (D5): undeterminable liveness (stream death) stays conservative — today\'s shape', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-nnnnnnnn-0001' } } })
  const { home, svc, selfM4 } = mkService(gw)
  const local = { machine: selfM4, id: 'q7m2xp' }
  try {
    const { conversationId } = await svc.send({ to: local, message: 'x' }, localInitiator(selfM4))
    gw.rpc({ result: { ok: true, value: { accepted: true } } })        // cancel
    gw.stream({ throw: new Error('plane gone before any snapshot') })  // liveness undeterminable
    const blind = await svc.stop({ to: local, conversationId }, 'turn')
    assert.deepEqual(blind, { scope: 'turn', cancelled: true })
    assert.equal(gw.rpcs(WIRE.turnCancel).length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- D7 gateway misses

test('gateway misses (D7): unknown-agent / unknown-machine / unreachable — typed errors and failed receipts (R4 routing)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  const missFor = new Map()
  const gatewayFor = (addr) => {
    const kind = missFor.get(addr.id)
    if (kind !== undefined) throw new A2aAddressError(kind, addr)
    return {}
  }
  // R4: the resolver runs INSIDE the ingest for self-addressed envelopes —
  // the service + ingest share it, exactly like a2a-row's assembly
  let ingestRef
  const svc = createA2aService({
    home,
    gatewayFor,
    ingest: () => ingestRef,
    now: () => 1,
  })
  ingestRef = createA2aIngest({ home, gatewayFor, delivery: { agents: { get: () => undefined }, buffer: () => {} }, now: () => 1 })
  try {
    // unknown-agent: the INGEST's resolver throws; the failed receipt carries it back
    missFor.set('zzzzzz', 'unknown-agent')
    const ua = await svc.send({ to: { machine: selfM4, id: 'zzzzzz' }, message: 'x' }, localInitiator(selfM4))
    assert.equal(ua.outcome, 'failed')
    assert.deepEqual(ua.error, { code: 'a2a/unknown-agent', message: `a2a: unknown-agent ${selfM4}-zzzzzz (no such agent on machine ${selfM4})` })
    // unknown-machine: the ROUTER owns it now — an unpaired remote machine
    missFor.set('zzzzzz', 'unknown-machine')
    const um = await svc.send({ to: { machine: 'k3f9', id: 'zzzzzz' }, message: 'x' }, localInitiator(selfM4))
    assert.equal(um.outcome, 'failed')
    assert.deepEqual(um.error, { code: 'a2a/unknown-machine', message: 'a2a: unknown-machine "k3f9" — address "k3f9-zzzzzz" is not a paired machine (addresses are "<m4>-<a6>")' })
    // send: typed failures land as failed receipts (send never throws)
    missFor.set('zzzzzz', 'unknown-agent')
    const r = await svc.send({ to: { machine: selfM4, id: 'zzzzzz' }, message: 'x' }, localInitiator(selfM4))
    assert.equal(r.outcome, 'failed')
    assert.deepEqual(r.error, { code: 'a2a/unknown-agent', message: `a2a: unknown-agent ${selfM4}-zzzzzz (no such agent on machine ${selfM4})` })
    // unreachable keeps today's code and message
    missFor.set('zzzzzz', 'unreachable')
    const ur = await svc.send({ to: { machine: selfM4, id: 'zzzzzz' }, message: 'x' }, localInitiator(selfM4))
    assert.equal(ur.outcome, 'failed')
    assert.deepEqual(ur.error, { code: 'a2a/gateway-unavailable', message: `a2a: no gateway for ${selfM4}-zzzzzz — machine unreachable or not paired` })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- amendment round (2026-09-28 review)

test('renderA2aEnvelope (injection fix): title containing {shortId}/{message} literals lands verbatim, single-pass', () => {
  const out = renderA2aEnvelope({ machine: 'm1ab', agent: 'a2b3c4', title: 'evil {shortId} {message} {machine} title', shortId: '4ce3e1', message: 'body text' })
  // the title's placeholder-looking literals are NOT expanded
  assert.ok(out.includes('evil {shortId} {message} {machine} title'))
  // each real placeholder expanded exactly once — no double expansion via user values
  assert.equal(out.match(/4ce3e1/g)?.length, 1)
  assert.equal(out.match(/body text/g)?.length, 1)
  assert.equal(out.match(/m1ab/g)?.length, 2) // header + the tool clause (D20 v3 template carries the address twice)
})

test('registry migration (D2 amended): degenerate shortIds re-minted and written back; non-degenerate untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  try {
    saveConversations(home, { conversations: [
      { shortId: 'session-', machine: 'k3f9', agent: 'q7m2xp', sessionId: 'session-33333333-0000', createdAt: 1, lastActivityAt: 1 },
      { shortId: 'session-4', machine: 'k3f9', agent: 'q7m2xp', sessionId: 'session-4ce3e180-bbbb', createdAt: 1, lastActivityAt: 1 },
      { shortId: '4ce3e1', machine: 'k3f9', agent: 'q7m2xp', sessionId: 'session-4ce3e180-aaaa', createdAt: 1, lastActivityAt: 1 },
    ] })
    assert.ok(isDegenerateShortId('session-') && isDegenerateShortId('session-4c2'))
    assert.ok(!isDegenerateShortId('4ce3e1') && !isDegenerateShortId('session-4ce3e180'))
    // service assembly runs the migration once
    createA2aService({ home, gatewayFor: () => undefined })
    const bySession = new Map(loadConversations(home).conversations.map((r) => [r.sessionId, r.shortId]))
    assert.equal(bySession.get('session-33333333-0000'), '333333', 're-minted from the uuid')
    assert.equal(bySession.get('session-4ce3e180-bbbb'), '4ce3e180', 're-minted, lengthening past the legacy 6')
    assert.equal(bySession.get('session-4ce3e180-aaaa'), '4ce3e1', 'non-degenerate legacy row untouched')
    // machine/agent/createdAt survive verbatim — only shortId changes
    const row = loadConversations(home).conversations.find((r) => r.sessionId === 'session-33333333-0000')
    assert.deepEqual([row.machine, row.agent, row.createdAt], ['k3f9', 'q7m2xp', 1])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('registry migration (D2 amended): a migrated shortId addresses its row — via the WIRE (remote initiator row)', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  void selfM4
  const remote = mkRemote(home, { receipt: { outcome: 'delivered', messageId: 'peer-1', conversationId: '333333', sessionId: 'session-33333333-0000' } })
  const svc = createA2aService({ home, gatewayFor: () => gw.face, fetchImpl: remote.fetchImpl, now: () => 5 })
  try {
    saveConversations(home, { conversations: [
      { shortId: 'session-3', machine: 'k3f9', agent: 'q7m2xp', sessionId: 'session-33333333-0000', createdAt: 1, lastActivityAt: 1 },
    ] })
    // fresh service over the same home picks up the migration, then the
    // migrated shortId addresses its row — the row is an INITIATOR row at
    // k3f9, so the message envelope rides the WIRE (R4 continuation routing)
    const svc2 = createA2aService({ home, gatewayFor: () => gw.face, fetchImpl: remote.fetchImpl, now: () => 5 })
    const receipt = await svc2.send({ to: { machine: 'k3f9', id: 'q7m2xp' }, conversationId: '333333', message: 'x' }, INITIATOR)
    assert.equal(receipt.outcome, 'delivered')
    assert.equal(receipt.sessionId, 'session-33333333-0000')
    assert.equal(receipt.conversationId, '333333')
    // the wire envelope carried the migrated conversationId verbatim
    assert.equal(remote.posts.length, 1)
    const sent = JSON.parse(remote.posts[0].init.body)
    assert.equal(sent.v, 1)
    assert.equal(sent.envelope.kind, 'message')
    assert.equal(sent.envelope.conversationId, '333333')
    assert.deepEqual(sent.envelope.to, { machine: 'k3f9', id: 'q7m2xp' })
    assert.equal(remote.posts[0].init.headers.cookie, 'dsh-auth-k3f9=1')
    // the activity stamp moved (the local session plane was never dialed)
    assert.equal(gw.rpcs(WIRE.promptSubmit).length, 0)
    void svc
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- R4: envelope routing

test('R4 protocol identity: the self-routed envelope and the wire envelope differ ONLY in to.machine', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  try {
    upsertRemote(home, { id: 'k3f9', name: 'k3f9', label: 'k3f9', origin: 'http://k3f9:4999', cookie: 'dsh-auth-k3f9=1', enabled: true, addedAt: 1 })
    const remote = mkRemote(home, { receipt: { outcome: 'delivered', messageId: 'r', conversationId: 'wire01', sessionId: 'sess-wire' } })
    const seen = []
    let ingestRef
    const svc = createA2aService({
      home,
      gatewayFor: () => gw.face,
      ingest: () => ({ ingest: async (envelope) => { seen.push(envelope); return { outcome: 'delivered', messageId: envelope.messageId, conversationId: envelope.conversationId, sessionId: 'sess-local' } } }),
      fetchImpl: remote.fetchImpl,
      now: () => 7,
    })
    void ingestRef
    // the SAME logical new-conversation, one to self, one to the paired remote
    await svc.send({ to: { machine: selfM4, id: 'q7m2xp' }, title: 'T', message: 'M' }, localInitiator(selfM4))
    await svc.send({ to: { machine: 'k3f9', id: 'q7m2xp' }, title: 'T', message: 'M' }, localInitiator(selfM4))
    assert.equal(seen.length, 1)
    assert.equal(remote.posts.length, 1)
    const local = seen[0]
    const wire = JSON.parse(remote.posts[0].init.body).envelope
    // protocol-identical: same kind, same payload semantics, only the target
    // machine differs (conversationId/messageId are per-send mints — randoms)
    for (const key of ['kind', 'title', 'message', 'from']) {
      assert.deepEqual(local[key], wire[key], key)
    }
    assert.deepEqual(local.to, { machine: selfM4, id: 'q7m2xp' })
    assert.deepEqual(wire.to, { machine: 'k3f9', id: 'q7m2xp' })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('R4 remote wire: receipts mapped verbatim; failed receipts keep addressable rows; typed transport failures', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  void selfM4
  try {
    // injected: the initiator row records the peer session + our initiatorSession
    const ok = mkRemote(home, { receipt: { outcome: 'delivered', messageId: 'w1', conversationId: 'wire02', sessionId: 'sess-at-k3f9' } })
    const svc = createA2aService({ home, gatewayFor: () => gw.face, fetchImpl: ok.fetchImpl, now: () => 9 })
    const r1 = await svc.send({ to: { machine: 'k3f9', id: 'q7m2xp' }, title: 'wire talk', message: 'over there' }, INITIATOR)
    assert.deepEqual(r1, { outcome: 'delivered', messageId: r1.messageId, conversationId: 'wire02', sessionId: 'sess-at-k3f9' })
    const rows = loadConversations(home).conversations
    assert.deepEqual(rows, [{
      shortId: 'wire02', machine: 'k3f9', agent: 'q7m2xp', sessionId: 'sess-at-k3f9',
      title: 'wire talk', initiatorSession: 'sess-init-1',
      createdAt: rows[0].createdAt, lastActivityAt: rows[0].lastActivityAt,
    }])
    // failed WITH ids → the row stays addressable for retries (D1)
    const fail = mkRemote(home, { receipt: { outcome: 'failed', messageId: 'w2', conversationId: 'wire03', sessionId: 'sess-busy', error: { code: 'session/agent-busy', message: 'busy' } } })
    const svc2 = createA2aService({ home, gatewayFor: () => gw.face, fetchImpl: fail.fetchImpl, now: () => 9 })
    const r2 = await svc2.send({ to: { machine: 'k3f9', id: 'q7m2xp' }, message: 'x' }, INITIATOR)
    assert.equal(r2.outcome, 'failed')
    assert.deepEqual(r2.error, { code: 'session/agent-busy', message: 'busy' })
    assert.equal(loadConversations(home).conversations.find((r) => r.shortId === 'wire03').sessionId, 'sess-busy')
    // transport failure (peer down) → failed receipt with the typed unreachable body
    const down = mkRemote(home, { fetchImpl: async () => { throw new TypeError('fetch failed') } })
    const svc3 = createA2aService({ home, gatewayFor: () => gw.face, fetchImpl: down.fetchImpl, now: () => 9 })
    const r3 = await svc3.send({ to: { machine: 'k3f9', id: 'q7m2xp' }, conversationId: 'wire02', message: 'x' }, INITIATOR)
    assert.equal(r3.outcome, 'failed')
    assert.equal(r3.error.code, 'a2a/gateway-unavailable')
    // unpaired machine → the router's typed unknown-machine receipt
    const svc4 = createA2aService({ home, gatewayFor: () => gw.face, now: () => 9 })
    const r4 = await svc4.send({ to: { machine: 'nopaired', id: 'q7m2xp' }, message: 'x' }, INITIATOR)
    assert.equal(r4.outcome, 'failed')
    assert.equal(r4.error.code, 'a2a/unknown-machine')
    // the local session plane was never dialed for any of it
    assert.equal(gw.calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('R4 stop over the wire: stop envelope POSTed; turn-only degradation mapped back onto the typed result', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  try {
    const remote = mkRemote(home, { receipt: { stopped: true, scope: 'turn-only', reason: 'no session-close endpoint upstream' } })
    upsertRemote(home, { id: 'k3f9', name: 'k3f9', label: 'k3f9', origin: 'http://k3f9:4999', cookie: 'dsh-auth-k3f9=1', enabled: true, addedAt: 1 })
    // overwrite the fetch fixture with the stop receipt (mkRemote's default answers send receipts)
    const posts = []
    const fetchImpl = async (url, init) => {
      posts.push({ url: String(url), init })
      return new Response(JSON.stringify({ stopped: true, scope: 'turn-only', reason: 'no session-close endpoint upstream' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    saveConversations(home, { conversations: [
      { shortId: 'wire04', machine: 'k3f9', agent: 'q7m2xp', sessionId: 'sess-at-k3f9', createdAt: 1, lastActivityAt: 1 },
    ] })
    const svc = createA2aService({ home, gatewayFor: () => gw.face, fetchImpl, now: () => 11 })
    void remote
    const out = await svc.stop({ to: { machine: 'k3f9', id: 'q7m2xp' }, conversationId: 'wire04' }, 'session')
    assert.deepEqual(out, { scope: 'turn-only', cancelled: true, reason: 'no session-close endpoint upstream' })
    // the stop envelope went over the wire with the peer cookie
    assert.equal(posts.length, 1)
    const sent = JSON.parse(posts[0].init.body)
    assert.deepEqual(sent, { v: 1, envelope: { kind: 'stop', to: { machine: 'k3f9', id: 'q7m2xp' }, conversationId: 'wire04', scope: 'session' } })
    assert.equal(posts[0].init.headers.cookie, 'dsh-auth-k3f9=1')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('R4 continuation routing: mirror rows (hostAgent) → OWN ingest; initiator rows → the peer machine', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  try {
    upsertRemote(home, { id: 'k3f9', name: 'k3f9', label: 'k3f9', origin: 'http://k3f9:4999', cookie: 'dsh-auth-k3f9=1', enabled: true, addedAt: 1 })
    const remote = mkRemote(home, { receipt: { outcome: 'delivered', messageId: 'w', conversationId: 'init01', sessionId: 'sess-at-k3f9' } })
    const seen = []
    let ingestRef
    const svc = createA2aService({
      home,
      gatewayFor: () => gw.face,
      ingest: () => ({ ingest: async (envelope) => {
        seen.push(envelope)
        return { outcome: 'delivered', messageId: envelope.messageId, conversationId: envelope.conversationId, sessionId: 'sess-local-hosted' }
      } }),
      fetchImpl: remote.fetchImpl,
      now: () => 13,
    })
    void ingestRef
    // a MIRROR row: the conversation is hosted HERE (hostAgent present)
    saveConversations(home, { conversations: [
      { shortId: 'mir001', machine: 'dev3', agent: 'cd33x1', sessionId: 'sess-local-hosted', hostAgent: 'q7m2xp', createdAt: 1, lastActivityAt: 1 },
    ] })
    const local = await svc.send({ to: { machine: selfM4, id: 'q7m2xp' }, conversationId: 'mir001', message: 'into the hosted one' }, localInitiator(selfM4))
    assert.equal(local.outcome, 'delivered')
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].to, { machine: selfM4, id: 'q7m2xp' }) // OWN ingest, hostAgent address
    assert.equal(seen[0].conversationId, 'mir001')
    // an INITIATOR row: the conversation lives at the peer (read-modify-write — mir001 stays)
    saveConversations(home, { conversations: [
      ...loadConversations(home).conversations,
      { shortId: 'init01', machine: 'k3f9', agent: 'q7m2xp', sessionId: 'sess-at-k3f9', createdAt: 1, lastActivityAt: 1 },
    ] })
    const wire = await svc.send({ to: { machine: 'k3f9', id: 'q7m2xp' }, conversationId: 'init01', message: 'to the peer' }, localInitiator(selfM4))
    assert.equal(wire.outcome, 'delivered')
    assert.equal(seen.length, 1) // no second self-route
    const sent = JSON.parse(remote.posts[0].init.body).envelope
    assert.equal(sent.kind, 'message')
    assert.deepEqual(sent.to, { machine: 'k3f9', id: 'q7m2xp' })
    assert.equal(sent.conversationId, 'init01')
    // the initiator row's activity moved AND initiatorSession backfilled (absent before)
    const row = loadConversations(home).conversations.find((r) => r.shortId === 'init01')
    assert.equal(row.initiatorSession, 'sess-init-1')
    // a mirror row addressed with the WRONG (peer) address → typed mismatch
    const wrong = await svc.send({ to: { machine: 'k3f9', id: 'q7m2xp' }, conversationId: 'mir001', message: 'x' }, localInitiator(selfM4))
    assert.equal(wrong.outcome, 'failed')
    assert.equal(wrong.error.code, 'a2a/conversation-machine-mismatch')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('T3/D24: a continuation with NO `agent` derives the route from the row + caller session', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  try {
    upsertRemote(home, { id: 'k3f9', name: 'k3f9', label: 'k3f9', origin: 'http://k3f9:4999', cookie: 'dsh-auth-k3f9=1', enabled: true, addedAt: 1 })
    const remote = mkRemote(home, { receipt: { outcome: 'delivered', messageId: 'w', conversationId: 'mir001', sessionId: 'sess-init-at-k3f9' } })
    const seen = []
    const svc = createA2aService({
      home,
      gatewayFor: () => gw.face,
      ingest: () => ({ ingest: async (envelope) => {
        seen.push(envelope)
        return { outcome: 'delivered', messageId: envelope.messageId, conversationId: envelope.conversationId, sessionId: 'sess-local-hosted' }
      } }),
      fetchImpl: remote.fetchImpl,
      now: () => 13,
    })
    const mirror = () => saveConversations(home, { conversations: [
      { shortId: 'mir001', machine: 'k3f9', agent: 'a2b3c4', sessionId: 'sess-local-hosted', hostAgent: 'q7m2xp', initiatorSession: 'sess-opener', createdAt: 1, lastActivityAt: 1 },
    ] })
    // (a) the HOSTED peer (caller == row.sessionId) replies with NO `agent` → write-back to the initiator over the wire + latch
    mirror()
    const wb = await svc.send({ conversationId: 'mir001', message: 'reply' }, { machine: selfM4, agent: 'q7m2xp', sessionId: 'sess-local-hosted' })
    assert.equal(wb.outcome, 'delivered')
    assert.equal(seen.length, 0)
    assert.equal(remote.posts.length, 1)
    assert.deepEqual(JSON.parse(remote.posts[0].init.body).envelope.to, { machine: 'k3f9', id: 'a2b3c4' })
    assert.equal(loadConversations(home).conversations[0].channelUsed, true)
    // (b) the OPENER (caller == row.initiatorSession) continues with NO `agent` → self-route into the hosted session
    mirror()
    const sr = await svc.send({ conversationId: 'mir001', message: 'continue' }, { machine: selfM4, agent: 'zzzzzz', sessionId: 'sess-opener' })
    assert.equal(sr.outcome, 'delivered')
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].to, { machine: selfM4, id: 'q7m2xp' })
    // (c) a THIRD party (neither initiator nor host) with NO `agent` → refused
    mirror()
    const third = await svc.send({ conversationId: 'mir001', message: 'x' }, { machine: selfM4, agent: 'zzzzzz', sessionId: 'sess-other' })
    assert.equal(third.outcome, 'failed')
    assert.equal(third.error.code, 'a2a/not-a-party')
    // (d) an INITIATOR row with NO `agent` → the peer machine
    saveConversations(home, { conversations: [
      ...loadConversations(home).conversations,
      { shortId: 'init02', machine: 'k3f9', agent: 'a2b3c4', sessionId: 'sess-init-at-k3f9', createdAt: 1, lastActivityAt: 1 },
    ] })
    const toPeer = await svc.send({ conversationId: 'init02', message: 'peer' }, { machine: selfM4, agent: 'zzzzzz', sessionId: 'sess-init-1' })
    assert.equal(toPeer.outcome, 'delivered')
    assert.equal(remote.posts.length, 2)
    assert.deepEqual(JSON.parse(remote.posts[1].init.body).envelope.to, { machine: 'k3f9', id: 'a2b3c4' })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ------------------------------------------------------- D20/D21 reply semantics v3

test('F2 (0.1.8-c): a self-addressed continuation does NOT take the write-back branch', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  const seen = []
  try {
    // self-addressed mirror row: row.agent === row.hostAgent (the target IS the caller)
    saveConversations(home, { conversations: [{
      shortId: 'selfsr', machine: selfM4, agent: 'aa11bb', sessionId: 'sess-host-self',
      hostAgent: 'aa11bb', initiatorSession: 'sess-init-self', createdAt: 1, lastActivityAt: 1,
    }] })
    const svc = createA2aService({
      home,
      gatewayFor: () => gw.face,
      ingest: () => ({ ingest: async (env) => { seen.push(env); return { outcome: 'delivered', messageId: env.messageId, conversationId: env.conversationId, sessionId: 'sess-host-self' } } }),
      now: () => 5,
    })
    const r = await svc.send({ conversationId: 'selfsr', message: 'my continuation' }, { machine: selfM4, agent: 'aa11bb', sessionId: 'sess-init-self' })
    assert.equal(r.outcome, 'delivered')
    assert.equal(seen.length, 1, 'self-routed into OUR ingest (the hosted session)')
    assert.deepEqual(seen[0].to, { machine: selfM4, id: 'aa11bb' })
    assert.equal(loadConversations(home).conversations[0].channelUsed, undefined, 'the initiator is NOT the peer — no latch')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('D20 write-back send leg: mirror row + addressing the initiator → envelope to the peer hub + latch set', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  const remote = mkRemote(home, { receipt: { outcome: 'delivered', messageId: 'x', conversationId: 'wb001', sessionId: 'sess-init-at-k3f9' } })
  saveConversations(home, { conversations: [{
    shortId: 'wb001', machine: 'k3f9', agent: 'a2b3c4', sessionId: 'sess-host-1', title: 'wb',
    hostAgent: 'q7m2xp', createdAt: 1, lastActivityAt: 1,
  }] })
  const svc = createA2aService({ home, gatewayFor: () => gw.face, fetchImpl: remote.fetchImpl, now: () => 7 })
  const r = await svc.send(
    { to: { machine: 'k3f9', id: 'a2b3c4' }, conversationId: 'wb001', message: 'result through the channel' },
    { machine: selfM4, agent: 'q7m2xp', sessionId: 'sess-host-1' },
  )
  assert.equal(r.outcome, 'delivered')
  assert.equal(r.conversationId, 'wb001')
  // the envelope POSTed to the INITIATOR's hub: to = the initiator, from = the hosted peer itself
  assert.equal(remote.posts.length, 1)
  const frame = JSON.parse(remote.posts[0].init.body)
  assert.equal(frame.v, 1)
  assert.equal(frame.envelope.kind, 'message')
  assert.deepEqual(frame.envelope.to, { machine: 'k3f9', id: 'a2b3c4' })
  assert.deepEqual(frame.envelope.from, { machine: selfM4, agent: 'q7m2xp', sessionId: 'sess-host-1' })
  assert.equal(frame.envelope.message, 'result through the channel')
  // the latch: monotonic channelUsed + the send watermark
  const row = loadConversations(home).conversations.find((x) => x.shortId === 'wb001')
  assert.equal(row.channelUsed, true)
  assert.equal(row.lastSentAt, 7)
  // and the write-back NEVER touched the local session plane
  assert.equal(gw.calls.length, 0)
})

test('D20 write-back guard: a mirror-row send addressing the HOSTED agent still routes to our own ingest (continuation, no latch)', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  const local = { machine: selfM4, id: 'q7m2xp' }
  // a local↔local conversation: ONE mirror row (hostAgent set, initiator local)
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-hh-1111' } } })
  gw.rpc({ result: { ok: true, value: { accepted: true } } })
  let ingestRef
  const svc = createA2aService({ home, gatewayFor: () => gw.face, ingest: () => ingestRef, now: () => 5 })
  ingestRef = createA2aIngest({ home, gatewayFor: () => gw.face, delivery: { agents: { get: () => undefined }, buffer: () => {} }, now: () => 5 })
  try {
    const created = await svc.send({ to: local, title: 'T', message: 'open' }, localInitiator(selfM4))
    // a third party continuing the conversation addresses the HOSTED agent — allowed, no latch
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    const r = await svc.send({ to: local, conversationId: created.conversationId, message: 'continue' }, localInitiator(selfM4))
    assert.equal(r.outcome, 'delivered')
    const row = loadConversations(home).conversations.find((x) => x.shortId === created.conversationId)
    assert.equal(row.channelUsed, undefined, 'an initiator-side continuation is NOT a channel reply — no latch')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('D21: a message-bearing create folds opening + content into ONE injected turn', async () => {
  const gw = fakeGateway()
  gw.rpc({ result: { ok: true, value: { sessionId: 'sess-m1-1111' } } }) // create
  gw.rpc({ result: { ok: true, value: { accepted: true } } })           // prompt
  const { home, svc, selfM4 } = mkService(gw)
  try {
    const out = await svc.send({ to: { machine: selfM4, id: 'q7m2xp' }, title: 'Task', message: 'the actual task in the opening turn' }, localInitiator(selfM4))
    const prompts = gw.rpcs(WIRE.promptSubmit)
    assert.equal(prompts.length, 1, 'ONE turn — not a bare opening followed by the content')
    assert.deepEqual(prompts[0].payload.args.request.content, [{
      type: 'text',
      text: teaching(localInitiator(selfM4), 'Task', out.conversationId, 'the actual task in the opening turn'),
    }])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ------------------------------------------------------- operational journal (0.1.7-b)

test('operational journal: new/send/write-back each leave one line (conversation.new, conversation.adopt, send.channel, send.ok)', async () => {
  const gw = fakeGateway()
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  const remote = mkRemote(home, { receipt: { outcome: 'delivered', messageId: 'x', conversationId: 'jrnl02', sessionId: 'sess-init-at-k3f9' } })
  saveConversations(home, { conversations: [{
    shortId: 'jrnl02', machine: 'k3f9', agent: 'a2b3c4', sessionId: 'sess-host-2', title: 'jrnl',
    hostAgent: 'q7m2xp', createdAt: 1, lastActivityAt: 1,
  }] })
  const lines = []
  const log = (level, event, fields = {}) => lines.push({ level, event, fields })
  let ingestRef
  const svc = createA2aService({ home, gatewayFor: () => gw.face, fetchImpl: remote.fetchImpl, now: () => 7, log, ingest: () => ingestRef })
  ingestRef = createA2aIngest({ home, gatewayFor: () => gw.face, delivery: { agents: { get: () => undefined }, buffer: () => {} }, now: () => 7, log })
  const find = (event) => lines.find((l) => l.event === event)
  try {
    // the channel write-back: one line for the latch, one for the routed send
    const r = await svc.send(
      { to: { machine: 'k3f9', id: 'a2b3c4' }, conversationId: 'jrnl02', message: 'channel reply' },
      { machine: selfM4, agent: 'q7m2xp', sessionId: 'sess-host-2' },
    )
    assert.equal(r.outcome, 'delivered')
    const latch = find('send.channel')
    assert.ok(latch, 'send.channel present')
    assert.equal(latch.fields.conversation, 'jrnl02')
    assert.equal(latch.fields.latch, true)
    assert.equal(latch.fields.from, `${selfM4}-q7m2xp`)
    const ok = find('send.ok')
    assert.ok(ok, 'send.ok present')
    assert.equal(ok.fields.conversation, 'jrnl02')
    assert.equal(ok.fields.to, 'k3f9-a2b3c4')
    // a local create: the initiator line plus the peer-side adoption line
    gw.rpc({ result: { ok: true, value: { sessionId: 'sess-jrnl-9' } } })
    gw.rpc({ result: { ok: true, value: { accepted: true } } })
    const created = await svc.send({ to: { machine: selfM4, id: 'q7m2xp' }, title: 'J', message: 'opening' }, { machine: selfM4, agent: 'zz1y2', sessionId: 'sess-jrnl-init' })
    const created_line = lines.find((l) => l.event === 'conversation.new' && l.fields.conversation === created.conversationId)
    assert.ok(created_line, 'conversation.new present')
    assert.equal(created_line.fields.peer, `${selfM4}-q7m2xp`)
    assert.equal(created_line.fields.initiator, `${selfM4}-zz1y2`)
    const adopt = lines.find((l) => l.event === 'conversation.adopt' && l.fields.conversation === created.conversationId)
    assert.ok(adopt, 'conversation.adopt present (self-hosted create adopts the mirror row)')
    assert.equal(adopt.fields.hostAgent, 'q7m2xp')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('0.1.7-h R2: a FAILED write-back notifies the original initiator (send-failed) — the turn artifact is never silently lost', async () => {
  const home = mkdtempSync(join(tmpdir(), 'superd-a2a-'))
  const selfM4 = ensureSelf(home, 'local').id
  upsertRemote(home, { id: 'w3ef', name: 'peer', label: 'peer', origin: 'http://127.0.0.1:9', enabled: true, addedAt: 1 })
  // mirror row: the conversation is hosted HERE (hostAgent set); the original
  // initiator lives at w3ef-na1ive with its persisted session on record
  saveConversations(home, { conversations: [{
    shortId: 'sf1red',
    machine: 'w3ef',
    agent: 'na1ive',
    sessionId: 'session-eeeeeeee-9999',
    title: '[undefined]',
    hostAgent: 'h0stag',
    initiatorSession: 'session-init-7777',
    createdAt: 1,
    lastActivityAt: 1,
  }] })
  const posts = []
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    posts.push(body)
    return new Response(JSON.stringify({
      outcome: 'failed',
      messageId: body.envelope.messageId,
      conversationId: 'sf1red',
      sessionId: '',
      error: { code: 'a2a/conversation-not-found', message: 'a2a: conversation "sf1red" is not in the registry' },
    }), { status: 200 })
  }
  const svc = createA2aService({
    home,
    gatewayFor: () => { throw new A2aAddressError('unknown-machine', { machine: 'w3ef', id: 'na1ive' }) },
    ingest: () => undefined,
    fetchImpl,
    now: () => 1,
  })
  try {
    const receipt = await svc.send(
      { to: { machine: 'w3ef', id: 'na1ive' }, conversationId: 'sf1red', message: 'the reply text' },
      // the caller IS the hosted session (the protocol invariant the F2 fix keys on:
      // the hosted peer's own session id is the row's sessionId)
      { machine: selfM4, agent: 'h0stag', sessionId: 'session-eeeeeeee-9999' },
    )
    assert.equal(receipt.outcome, 'failed')
    assert.equal(receipt.error.code, 'a2a/conversation-not-found')
    // the fire-and-forget notice route gets a beat
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(posts.length, 2, 'the send-failed notice must ride the wire to the original initiator')
    const notice = posts[1].envelope
    assert.equal(notice.kind, 'notice')
    assert.equal(notice.reason, 'send-failed')
    assert.equal(notice.conversation, 'sf1red')
    assert.equal(notice.to.machine, 'w3ef')
    assert.equal(notice.to.agent, 'na1ive')
    assert.equal(notice.to.sessionId, 'session-init-7777')
    assert.match(notice.summary, /could not be delivered/)
    // the receiving side's strict guard 400s over-max summaries — the mint
    // must pre-bound (0.1.7-l live finding)
    assert.ok(notice.summary.length <= 120, `summary must be bounded, got ${notice.summary.length}`)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
