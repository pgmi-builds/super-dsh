/**
 * A2A ingest — the post-office's execution side (postoffice R3; ADR 0011,
 * spec D16–D19, plan 2026-09-28-machine-mesh-postoffice-rework 契约要点).
 *
 * WHERE THE WORK LIVES (D16 ruling): when a request envelope (new-conversation
 * / message / stop) arrives — over the wire via `POST /api/superd/a2a`
 * (mesh-rpc) or short-circuited in-process by the initiator's own hub (R4)
 * — the session-plane business logic runs HERE, on the machine that owns the
 * session: resolve the LOCAL target (a2a-host's local leg), create-or-resume
 * the mirror registry row, inject the teaching envelope (renderA2aEnvelope,
 * initiator = envelope.from), and capture the completion on the LOCAL follow
 * stream (subscribeSessionCompletion — same machinery as the initiator-side
 * service; zero cross-machine session-plane calls anywhere).
 *
 * REGISTRY (双侧同形): the mirror row points AT THE INITIATOR —
 * {machine: from.machine, agent: from.agent, sessionId: LOCAL session} — the
 * symmetric dual of the initiator's row. The conversationId is
 * INITIATOR-MINTED, carried on the envelope, and adopted VERBATIM; a
 * collision (the shortId already bound to a different conversation) is
 * rejected fail-loud. The title lands verbatim from the envelope (D17:
 * mirror rows adopt verbatim; titles are immutable on both sides).
 *
 * RETURN ROUTING (D16): a captured completion becomes a reply envelope
 * (aborted-with-no-text → a bounded notice envelope, D3) routed to the
 * initiator: from.machine === self → in-process delivery (a2a-delivery);
 * a machines.json row exists → wire POST (cookie 随行); otherwise the
 * bounded persistent outbox (`<home>/superd/a2a-outbox.json`, ≤32, oldest
 * dropped) until a route appears or the sweep pulls it (R5).
 *
 * Inbound RETURN envelopes (reply/notice POSTed at us, or pulled from a
 * peer's outbox by R5's sweep) deliver into the local initiator session
 * through the same a2a-delivery face; the receipt for those POSTs is the
 * delivery outcome (additive to the contract's new/message/stop receipts).
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  A2A_BUFFER_MAX,
  A2A_NO_SESSION_CLOSE_REASON,
  A2A_NO_TURN_ACTIVE_NOTE,
  addressErrorBody,
  renderA2aEnvelope,
  sessionRpc,
  subscribeSessionCompletion,
  turnLivenessOf,
  type A2aAddress,
  type A2aCompletion,
  type A2aGateway,
  type A2aStopResult,
  type ConversationRow,
  loadConversations,
  saveConversations,
} from './a2a-service.js'
import { EnvelopeError } from './envelope.js'
import { WIRE, type SessionCreateRequestMirror, type SessionPromptRequestMirror, wireArgsOf } from './wire-endpoints.js'
import { boundNoticeSummary, deliverNotice, deliverReply } from './a2a-delivery.js'
import type { A2aDeliveryCtx, A2aDeliveryOutcome, A2aNoticeReason } from './a2a-delivery.js'
import {
  A2aAddressError,
  isA2aEnvelope,
  postA2aEnvelope,
  type A2aEnvelope,
  type A2aMessageEnvelope,
  type A2aNewConversationEnvelope,
  type A2aNoticeEnvelope,
  type A2aReplyEnvelope,
  type A2aStopEnvelope,
  type A2aStopReceipt,
  type A2aWireOrigin,
  type A2aWireReceipt,
} from './a2a-wire.js'
import { ensureSelf, listRemotes } from './machines.js'
import { cookieOf } from './mesh-link.js'
import type { A2aLogFn } from './a2a-log.js'

/** Ingest assembly inputs: hub home + the LOCAL resolver + the in-process delivery face. */
export interface A2aIngestDeps {
  home: string
  /** The local leg of a2a-host's resolver: an address on THIS machine → its session-plane gateway. */
  gatewayFor(addr: A2aAddress): A2aGateway
  /** The initiator-side delivery face (live agents + the bounded unread buffer). */
  delivery: A2aDeliveryCtx
  fetchImpl?: typeof fetch
  /** Operational journal (0.1.7-b): one greppable line per machine event; the cordis host wires it onto ctx.logger, tests inject a collector. */
  log?: A2aLogFn
  now?(): number
}

/** Where one return envelope landed (R5's sweep and tests observe this). */
export type A2aReturnRoute = 'delivered' | 'posted' | 'outbox'

/** The full ingest surface. */
export interface A2aIngest {
  /** Handle one envelope (request kinds execute; return kinds deliver locally). */
  ingest(envelope: A2aEnvelope): Promise<A2aWireReceipt | A2aDeliveryOutcome>
  /** Claim & clear the outbox entries addressed to `machine` (the GET ?machine= leg). */
  claimOutbox(machine: string): A2aEnvelope[]
  /** Route one return envelope now (self / wire / outbox) — the completion watcher's leg. */
  routeReturn(envelope: A2aReplyEnvelope | A2aNoticeEnvelope, meta: { responderAgent: string; noticeReason?: A2aNoticeReason }): Promise<A2aReturnRoute>
}

// ---------------------------------------------------------------- outbox

interface OutboxFile {
  envelopes: A2aEnvelope[]
}

function outboxPath(home: string): string {
  return join(home, 'superd', 'a2a-outbox.json')
}

function loadOutbox(home: string): OutboxFile {
  let raw: string
  try {
    raw = readFileSync(outboxPath(home), 'utf8')
  } catch {
    return { envelopes: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { envelopes: [] }
  }
  const list = (parsed as { envelopes?: unknown }).envelopes
  if (!Array.isArray(list)) return { envelopes: [] }
  // entries validated on load — corrupt rows drop, never crash the hub
  return { envelopes: list.filter((e): e is A2aEnvelope => isA2aEnvelope(e)) }
}

function saveOutbox(home: string, file: OutboxFile): void {
  const dir = join(home, 'superd')
  mkdirSync(dir, { recursive: true })
  const target = outboxPath(home)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, target)
}

// ---------------- inbound exactly-once (0.1.6-j double-delivery fix)

/** Bounded inbound-messageId seen-set: an envelope the sender re-POSTs (parked after a transport glitch, re-pulled by the sweep) is re-ACKed, never re-executed. */
const SEEN_MESSAGE_IDS_MAX = 128

function seenIdsPath(home: string): string {
  return join(home, 'superd', 'a2a-seen.json')
}

function seenMessageIds(home: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(seenIdsPath(home), 'utf8'))
    const ids = typeof parsed === 'object' && parsed !== null ? (parsed as { ids?: unknown }).ids : undefined
    return new Set(Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function rememberMessageId(home: string, messageId: string): void {
  const ids = [...seenMessageIds(home)]
  if (!ids.includes(messageId)) ids.push(messageId)
  while (ids.length > SEEN_MESSAGE_IDS_MAX) ids.shift()
  mkdirSync(join(home, 'superd'), { recursive: true })
  const target = seenIdsPath(home)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify({ ids }, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, target)
}

// ---------------------------------------------------------------- helpers

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Receipt error body of any thrown failure — an EnvelopeError's wire body passes verbatim. */
function receiptErrorOf(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof EnvelopeError) return { ...error.wire }
  if (error instanceof Error) return { code: 'gateway/uncaught', message: error.message }
  return { code: 'gateway/uncaught', message: String(error) }
}

// ---------------------------------------------------------------- service

export function createA2aIngest(deps: A2aIngestDeps): A2aIngest {
  const now = deps.now ?? Date.now
  const alog = deps.log
  const selfId = (): string => ensureSelf(deps.home, 'local').id

  // ---------------- registry (mirror rows)

  const mirrorRowOf = (conversationId: string): ConversationRow | undefined => {
    const rows = loadConversations(deps.home).conversations
    return rows.find((r) => r.shortId === conversationId || r.sessionId === conversationId)
  }

  /**
   * Adopt the initiator-minted conversationId verbatim (fail-loud on
   * collision); an exact re-delivery of the same conversation is an
   * idempotent adoption (resume). @returns the row.
   */
  const adoptMirrorRow = (env: A2aNewConversationEnvelope | A2aMessageEnvelope, sessionId: string, title: string): ConversationRow => {
    const file = loadConversations(deps.home)
    const rows = file.conversations
    const existing = rows.find((r) => r.shortId === env.conversationId || r.sessionId === sessionId)
    if (existing !== undefined) {
      const sameConversation = existing.shortId === env.conversationId &&
        existing.sessionId === sessionId &&
        existing.machine === env.from.machine && existing.agent === env.from.agent &&
        existing.hostAgent === env.to.id
      if (sameConversation) return existing
      throw new Error(`a2a: conversation-id conflict — "${env.conversationId}" is already bound to ${existing.machine}-${existing.agent}/${existing.sessionId} (claimed by ${env.from.machine}-${env.from.agent}/${sessionId})`)
    }
    const row: ConversationRow = {
      shortId: env.conversationId,
      machine: env.from.machine,
      agent: env.from.agent,
      sessionId,
      title,
      // R4 amendment: mirror rows carry the LOCAL a6 hosting the session —
      // presence is the locally-hosted marker continuation routing keys on.
      hostAgent: env.to.id,
      // 0.1.7-i: the OPENER's session persists on mirror rows too — the
      // initiatorSession field's R4 "initiator rows only" contract predates
      // the send-failed notice (a failed write-back must address the original
      // initiator even when this hub has never seen their send path) and the
      // self-route write-back branch already expects it here. Additive; the
      // initiator-row detection keys on hostAgent absence, never this field.
      initiatorSession: env.from.sessionId,
      createdAt: now(),
      lastActivityAt: now(),
    }
    rows.push(row)
    saveConversations(deps.home, { conversations: rows })
    alog?.('info', 'conversation.adopt', { conversation: row.shortId, session: row.sessionId, peer: `${env.from.machine}-${env.from.agent}`, hostAgent: env.to.id })
    return row
  }

  const touchMirror = (row: ConversationRow): void => {
    const rows = loadConversations(deps.home).conversations
    const idx = rows.findIndex((r) => r.sessionId === row.sessionId)
    if (idx === -1) return
    rows[idx] = { ...rows[idx], lastActivityAt: now() }
    saveConversations(deps.home, { conversations: rows })
  }

  // ---------------- return routing

  /** Deliver one return envelope into the LOCAL initiator session (self-routed or inbound). */
  const deliverLocal = (envelope: A2aReplyEnvelope | A2aNoticeEnvelope, sender: { machine: string, agent: string }, noticeReason: A2aNoticeReason = 'peer'): A2aDeliveryOutcome => {
    const initiator = { machine: envelope.to.machine, agent: envelope.to.agent, sessionId: envelope.to.sessionId }
    const row = mirrorRowOf(envelope.conversation)
    if (envelope.kind === 'reply') {
      const outcome = deliverReply(deps.delivery, initiator, envelope.text, {
        senderMachine: sender.machine,
        senderAgent: sender.agent,
        conversationId: envelope.conversation,
        messageId: envelope.messageId,
        title: row?.title,
        // D20: the provenance flag rides the wire additively — the delivering
        // side renders the "transcribed, never sent via channel" prefix from
        // it; absent = the peer chose to send this through the channel.
        transcribed: envelope.transcribed === true,
      })
      alog?.('info', 'deliver.local', { conversation: envelope.conversation, kind: envelope.kind, outcome: outcome.delivered, from: `${sender.machine}-${sender.agent}` })
      return outcome
    }
    const outcome = deliverNotice(deps.delivery, initiator, envelope.summary, {
      senderMachine: sender.machine,
      senderAgent: sender.agent,
      conversationId: envelope.conversation,
      // 0.1.7-h R2: the peer's own reason rides the wire (additive); the
      // fallback covers self-routed notices and pre-0.1.7-h peers.
      reason: envelope.reason ?? noticeReason,
    })
    alog?.('info', 'deliver.local', { conversation: envelope.conversation, kind: envelope.kind, outcome: outcome.delivered, from: `${sender.machine}-${sender.agent}` })
    return outcome
  }

  const parkInOutbox = (envelope: A2aReplyEnvelope | A2aNoticeEnvelope): void => {
    const file = loadOutbox(deps.home)
    file.envelopes.push(envelope)
    while (file.envelopes.length > A2A_BUFFER_MAX) file.envelopes.shift()
    saveOutbox(deps.home, file)
  }

  const routeReturn: A2aIngest['routeReturn'] = async (envelope, meta) => {
    if (envelope.to.machine === selfId()) {
      deliverLocal(envelope, { machine: selfId(), agent: meta.responderAgent }, meta.noticeReason)
      alog?.('info', 'route.deliver', { conversation: envelope.conversation, kind: envelope.kind })
      return 'delivered'
    }
    const machine = listRemotes(deps.home).find((r) => r.id === envelope.to.machine)
    if (machine !== undefined) {
      try {
        await postA2aEnvelope(machine.origin, envelope, {
          cookie: cookieOf(machine.id, deps.home),
          fetchImpl: deps.fetchImpl,
        })
        alog?.('info', 'route.post', { conversation: envelope.conversation, kind: envelope.kind, to: envelope.to.machine })
        return 'posted'
      } catch {
        // peer briefly down — park for the next contact (sweep pull / next send)
        parkInOutbox(envelope)
        alog?.('warn', 'route.park', { conversation: envelope.conversation, kind: envelope.kind, to: envelope.to.machine, reason: 'peer-unreachable' })
        return 'outbox'
      }
    }
    parkInOutbox(envelope)
    alog?.('warn', 'route.park', { conversation: envelope.conversation, kind: envelope.kind, to: envelope.to.machine, reason: 'unknown-machine' })
    return 'outbox'
  }

  /** The completion watcher behind every successful inject (D16 → D20 v3). */
  const watchCompletion = (gateway: A2aGateway, row: ConversationRow, env: A2aNewConversationEnvelope | A2aMessageEnvelope): void => {
    const to: A2aWireOrigin = { machine: env.from.machine, agent: env.from.agent, sessionId: env.from.sessionId }
    // D20: arm-time watermark — a channel send with lastSentAt ABOVE this
    // happened inside this armed turn's window, i.e. the peer's send WAS
    // this turn's artifact and the watch must not add a second one.
    const armedSentAt = row.lastSentAt ?? 0
    const noticeOf = (summary: string, reason: A2aNoticeReason = 'peer'): A2aNoticeEnvelope => ({
      kind: 'notice',
      to,
      conversation: row.shortId,
      summary: boundNoticeSummary(summary),
      messageId: `a2a-notice-${randomUUID()}`,
      sender: { machine: selfId(), agent: env.to.id },
      // 0.1.7-h R2: the cause rides the wire (additive) so the receiving side
      // renders reason= into the model-facing notice line.
      reason,
    })
    subscribeSessionCompletion(
      { gateway, sessionId: row.sessionId, conversationId: row.shortId },
      (completion: A2aCompletion) => {
        // D20 v3 — the channel consumes exactly two machine facts (turn
        // boundary + last output) and NOTHING from the settlement
        // taxonomy: no abort/complete adjectives, no reason branches. A
        // turn end yields at most ONE artifact:
        //   initiator stop stamped inside the window → stopped-by-initiator
        //     notice (0.1.7-h R2 — the initiator's own stop must not read
        //     as the peer going silent)
        //   send inside the window → the send(s) were it (watch stays quiet)
        //   latch set (channel used in an earlier turn) → plain notice
        //   latch clear + non-empty last output → TRANSCRIBED reply
        //   latch clear + empty output → plain notice (reason=peer-silent)
        // Hallucinated/irrelevant content is content-layer business —
        // transcribe verbatim and let the sender judge.
        const fresh = mirrorRowOf(row.shortId)
        if ((fresh?.stoppedAt ?? 0) > armedSentAt) {
          alog?.('info', 'completion.stopped', { conversation: row.shortId })
          const stopped = noticeOf(`conversation ${row.shortId}: turn stopped by initiator request`, 'stop')
          void routeReturn(stopped, { responderAgent: env.to.id, noticeReason: 'stop' }).catch(() => parkInOutbox(stopped))
          return
        }
        if ((fresh?.lastSentAt ?? 0) > armedSentAt) {
          alog?.('info', 'completion.quiet', { conversation: row.shortId, reason: 'channel-send-in-window' })
          return
        }
        const envelope: A2aReplyEnvelope | A2aNoticeEnvelope = fresh?.channelUsed === undefined && completion.text !== ''
          ? {
            kind: 'reply',
            to,
            conversation: row.shortId,
            text: completion.text,
            messageId: `a2a-relay-${randomUUID()}`,
            sender: { machine: selfId(), agent: env.to.id },
            transcribed: true,
          }
          : noticeOf(`conversation ${row.shortId}: turn ended, no reply`, 'peer')
        alog?.('info', envelope.kind === 'reply' ? 'completion.transcript' : 'completion.notice', {
          conversation: row.shortId,
          ...(envelope.kind === 'reply' ? { bytes: completion.text.length } : {}),
        })
        void routeReturn(envelope, { responderAgent: env.to.id }).catch(() => parkInOutbox(envelope))
      },
      {
        requestId: env.messageId,
        onError: (error) => {
          alog?.('warn', 'completion.error', { conversation: row.shortId, error: error.message })
          const notice = noticeOf(`A2A completion stream for conversation ${row.shortId} failed: ${error.message}`, 'stream-dead')
          void routeReturn(notice, { responderAgent: env.to.id, noticeReason: 'stream-dead' }).catch(() => parkInOutbox(notice))
        },
      },
    )
    alog?.('info', 'completion.armed', { conversation: row.shortId, session: row.sessionId, watermark: armedSentAt })
  }

  // ---------------- request kinds

  const ingestRequest = async (env: A2aNewConversationEnvelope | A2aMessageEnvelope): Promise<A2aWireReceipt | A2aDeliveryOutcome> => {
    const fail = (error: { code: string; message: string; details?: unknown }, sessionId = '', conversationId?: string): A2aWireReceipt => {
      alog?.('warn', 'ingest.fail', { code: error.code, conversation: conversationId, message: env.messageId })
      return {
        outcome: 'failed',
        messageId: env.messageId,
        ...(conversationId === undefined ? {} : { conversationId }),
        sessionId,
        error,
      }
    }

    //
    // MESSAGE envelopes resolve the registry row FIRST: a peer write-back
    // (an initiator row, no hostAgent) delivers without ever touching the
    // local session plane — the plane is only resolved when THIS machine
    // hosts the conversation and must inject.
    //
    let row: ConversationRow | undefined
    if (env.kind === 'message') {
      row = mirrorRowOf(env.conversationId)
      if (row === undefined) {
        return fail({
          code: 'a2a/conversation-not-found',
          message: `a2a: conversation "${env.conversationId}" is not in the registry — the initiator's conversationId does not resolve here`,
        })
      }
      //
      // D20 SELF-ROUTE WRITE-BACK: the single MIRROR row of a local↔local
      // conversation, and the sender is the hosted peer itself (from.agent ===
      // row.hostAgent, from.machine === self) — deliver into the initiator's
      // session with peer attribution, NEVER inject (the row's session is the
      // SENDER's own; injecting would loop the message back to its author).
      //
      if (row.hostAgent !== undefined && env.from.machine === selfId() && env.from.agent === row.hostAgent) {
        if (env.to.machine !== selfId()) {
          return fail({
            code: 'a2a/conversation-machine-mismatch',
            message: `a2a: conversation "${row.shortId}" write-back must target this machine, not ${env.to.machine}`,
          }, row.sessionId, row.shortId)
        }
        if (row.initiatorSession === undefined || row.initiatorSession === '') {
          return fail({
            code: 'a2a/no-initiator-session',
            message: `a2a: conversation "${row.shortId}" has no persisted initiator session — asynchronous write-backs cannot be addressed`,
          }, row.sessionId, row.shortId)
        }
        const writeBackOutcome = deliverReply(deps.delivery, {
          machine: env.to.machine,
          agent: env.to.id,
          sessionId: row.initiatorSession,
        }, env.message, {
          senderMachine: env.from.machine,
          senderAgent: env.from.agent,
          conversationId: row.shortId,
          messageId: env.messageId,
          title: row.title,
        })
        alog?.('info', 'deliver.writeback', { conversation: row.shortId, from: `${env.from.machine}-${env.from.agent}`, via: 'self-route', outcome: writeBackOutcome.delivered })
        // v1 send-receipt shape (exactly-once wrapper contract)
        return { outcome: 'injected', messageId: env.messageId, conversationId: row.shortId, sessionId: row.initiatorSession }
      }
      if (row.machine !== env.from.machine || row.agent !== env.from.agent) {
        return fail({
          code: 'a2a/conversation-machine-mismatch',
          message: `a2a: conversation "${row.shortId}" belongs to ${row.machine}-${row.agent}, not ${env.from.machine}-${env.from.agent}`,
        }, row.sessionId, row.shortId)
      }
      //
      // R4 amendment — PEER WRITE-BACK: the row is an INITIATOR row (no
      // hostAgent ⇒ the session lives at the PEER). A message envelope from
      // the very peer, addressed to this machine, is the peer using its
      // superd-hub tool with OUR shortId (the teaching envelope's
      // asynchronous-reply clause): deliver into the initiator's session with
      // peer attribution — NEVER a session injection (the session is not
      // ours to drive). deliverReply buffers into the bounded unread buffer
      // when the initiator session is not live (existing machinery, keyed by
      // the initiator's session id).
      //
      if (row.hostAgent === undefined) {
        if (env.to.machine !== selfId()) {
          return fail({
            code: 'a2a/conversation-machine-mismatch',
            message: `a2a: conversation "${row.shortId}" is hosted at ${row.machine}-${row.agent} — a peer write-back must target this machine, not ${env.to.machine}`,
          }, row.sessionId, row.shortId)
        }
        if (row.initiatorSession === undefined || row.initiatorSession === '') {
          return fail({
            code: 'a2a/no-initiator-session',
            message: `a2a: conversation "${row.shortId}" has no persisted initiator session — asynchronous write-backs cannot be addressed`,
          }, row.sessionId, row.shortId)
        }
        const writeBackOutcome = deliverReply(deps.delivery, {
          machine: env.to.machine,
          agent: env.to.id,
          sessionId: row.initiatorSession,
        }, env.message, {
          senderMachine: env.from.machine,
          senderAgent: env.from.agent,
          conversationId: row.shortId,
          messageId: env.messageId,
          title: row.title,
        })
        // v1 send-receipt shape (double-delivery fix): a {delivered:…} body
        // fails the sender's receipt guard → park → sweep re-POST → the
        // write-back would deliver twice.
        alog?.('info', 'deliver.writeback', { conversation: row.shortId, from: `${env.from.machine}-${env.from.agent}`, via: 'peer', outcome: writeBackOutcome.delivered })
        return { outcome: 'injected', messageId: env.messageId, conversationId: row.shortId, sessionId: row.initiatorSession }
      }
    }

    const local: A2aAddress = { machine: env.to.machine, id: env.to.id }
    let gateway: A2aGateway | undefined
    try {
      gateway = deps.gatewayFor(local)
    } catch (error) {
      const body = error instanceof A2aAddressError ? addressErrorBody(error) : receiptErrorOf(error)
      return fail(body)
    }
    if (gateway === undefined) {
      return fail({ code: 'a2a/gateway-unavailable', message: A2aAddressError.messageOf('unreachable', local) })
    }

    try {
      if (env.kind === 'new-conversation') {
        const created = await sessionRpc<{ sessionId: string }>(gateway, WIRE.sessionCreate, {} as SessionCreateRequestMirror)
        if (!isRecord(created) || typeof created.sessionId !== 'string' || created.sessionId === '') {
          return fail({ code: 'a2a/bad-result', message: 'a2a: session/create returned no sessionId' })
        }
        // D17: mirror rows adopt the title VERBATIM (the '[undefined]' placeholder included)
        row = adoptMirrorRow(env, created.sessionId, env.title)
      }
      // (message envelopes resolved their row above — only mirror rows reach here)
    } catch (error) {
      // adoptMirrorRow's fail-loud collision + any registry write failure
      return fail(receiptErrorOf(error))
    }

    if (row === undefined) {
      // unreachable by construction (message rows resolved above; new-conversation adopted or failed)
      return fail({ code: 'a2a/conversation-not-found', message: `a2a: conversation "${env.conversationId}" did not resolve to a hosted session` })
    }

    const promptRequest: SessionPromptRequestMirror = {
      requestId: env.messageId,
      sessionId: row.sessionId,
      mode: env.delivery ?? 'queue',
      content: [{
        type: 'text',
        text: renderA2aEnvelope({
          machine: env.from.machine,
          agent: env.from.agent,
          title: row.title,
          shortId: row.shortId,
          message: env.message,
        }),
      }],
    }
    try {
      // 'injected' on every successful submission ('queued' reserved — same taxonomy as the initiator side)
      await sessionRpc(gateway, WIRE.promptSubmit, promptRequest)
    } catch (error) {
      return fail(receiptErrorOf(error), row.sessionId, row.shortId)
    }
    touchMirror(row)
    watchCompletion(gateway, row, env)
    return { outcome: 'injected', messageId: env.messageId, conversationId: row.shortId, sessionId: row.sessionId }
  }

  const ingestStop = async (env: A2aStopEnvelope): Promise<A2aStopReceipt> => {
    const stopped = (scope: 'turn' | 'turn-only', reason?: string): A2aStopReceipt => {
      alog?.('warn', 'stop.refused', { conversation: env.conversationId, scope, reason })
      return { stopped: false, scope, ...(reason === undefined ? {} : { reason }) }
    }
    const row = mirrorRowOf(env.conversationId)
    if (row === undefined) {
      return stopped(env.scope === 'session' ? 'turn-only' : 'turn', `a2a: conversation "${env.conversationId}" is not in the registry`)
    }
    const local: A2aAddress = { machine: env.to.machine, id: env.to.id }
    let gateway: A2aGateway | undefined
    try {
      gateway = deps.gatewayFor(local)
    } catch (error) {
      return stopped(env.scope === 'session' ? 'turn-only' : 'turn', messageOf(error))
    }
    if (gateway === undefined) {
      return stopped(env.scope === 'session' ? 'turn-only' : 'turn', A2aAddressError.messageOf('unreachable', local))
    }
    try {
      // D5 honesty (same read as the initiator-side stop): liveness BEFORE cancel
      const live = await turnLivenessOf(gateway, row.sessionId)
      await sessionRpc(gateway, WIRE.turnCancel, { sessionId: row.sessionId })
      const result: A2aStopResult = live === false
        ? (env.scope === 'turn'
          ? { scope: 'turn', cancelled: false, note: A2A_NO_TURN_ACTIVE_NOTE }
          : { scope: 'turn-only', cancelled: false, note: A2A_NO_TURN_ACTIVE_NOTE, reason: A2A_NO_SESSION_CLOSE_REASON })
        : (env.scope === 'turn'
          ? { scope: 'turn', cancelled: true }
          : { scope: 'turn-only', cancelled: true, reason: A2A_NO_SESSION_CLOSE_REASON })
      const parts = [result.scope === 'turn-only' ? result.reason : undefined, 'note' in result ? result.note : undefined]
      if (result.cancelled === true) {
        // 0.1.7-h R2: stamp the row so this hub's completion watch attributes
        // the turn end it is about to observe to the initiator's stop, not to
        // the peer going silent. Watermark-safe: the watch only honors stamps
        // set after its own arm time.
        const rows = loadConversations(deps.home).conversations
        const idx = rows.findIndex((r) => r.sessionId === row.sessionId)
        if (idx !== -1) {
          rows[idx] = { ...rows[idx], stoppedAt: Date.now() }
          saveConversations(deps.home, { conversations: rows })
        }
      }
      alog?.('info', 'stop', { conversation: env.conversationId, stopped: result.cancelled, scope: result.scope })
      return {
        stopped: result.cancelled,
        scope: result.scope,
        ...(parts.some((p) => p !== undefined) ? { reason: parts.filter((p) => p !== undefined).join('; ') } : {}),
      }
    } catch (error) {
      return stopped(env.scope === 'session' ? 'turn-only' : 'turn', messageOf(error))
    }
  }

  const dispatch = async (envelope: A2aEnvelope): Promise<A2aWireReceipt | A2aDeliveryOutcome> => {
    switch (envelope.kind) {
      case 'new-conversation':
      case 'message':
        return ingestRequest(envelope)
      case 'stop':
        return ingestStop(envelope)
      case 'reply':
      case 'notice': {
        // inbound return envelope (peer POSTed / sweep pulled). Sender
        // attribution, in order: the envelope's own `sender` (additive v1 —
        // the producing hub stamps itself), else the registry row (the local
        // row for this conversation points AT the peer), else honest
        // 'unknown'. NEVER selfId() — the receiver is not the sender (the
        // 0.1.6-h cross-machine bug: replies landed attributed bfwu-8ah589).
        const row = mirrorRowOf(envelope.conversation)
        const sender = envelope.sender ??
          (row !== undefined ? { machine: row.machine, agent: row.agent } : { machine: 'unknown', agent: 'unknown' })
        deliverLocal(envelope, sender)
        // v1 send-receipt shape: the sender's postA2aEnvelope guard accepts
        // exactly this. The 0.1.6-j double delivery was a {delivered:…} body
        // failing that guard AFTER the receiver had already delivered.
        return { outcome: 'injected', messageId: envelope.messageId, conversationId: envelope.conversation, sessionId: envelope.to.sessionId }
      }
    }
  }

  return {
    async ingest(envelope) {
      // exactly-once over an at-least-once transport (2026-09-28 first-person
      // acceptance finding §7.1): an envelope the sender re-POSTs is
      // re-ACKed with its receipt and NEVER re-executed. Stop envelopes
      // carry no messageId and stay naturally idempotent (cancelling a dead
      // turn answers honestly).
      const mid = (envelope as { messageId?: string }).messageId
      if (mid !== undefined && seenMessageIds(deps.home).has(mid)) {
        alog?.('info', 'ingest.park', { message: mid, reason: 'duplicate' })
        return envelope.kind === 'reply' || envelope.kind === 'notice'
          ? { outcome: 'injected', messageId: mid, conversationId: envelope.conversation, sessionId: envelope.to.sessionId }
          : { outcome: 'injected', messageId: mid, conversationId: (envelope as { conversationId?: string }).conversationId ?? '', sessionId: '' }
      }
      const out = await dispatch(envelope)
      const outcome = (out as { outcome?: unknown }).outcome
      const accepted = typeof outcome === 'string' ? outcome === 'injected' : true
      if (mid !== undefined && accepted) rememberMessageId(deps.home, mid)
      alog?.(accepted ? 'info' : 'warn', 'ingest.done', {
        kind: envelope.kind,
        outcome: accepted ? 'injected' : typeof outcome === 'string' ? outcome : 'failed',
        message: mid,
        conversation: (envelope as { conversationId?: string, conversation?: string }).conversationId ?? (envelope as { conversation?: string }).conversation,
      })
      return out
    },
    claimOutbox(machine: string): A2aEnvelope[] {
      const file = loadOutbox(deps.home)
      const claimed = file.envelopes.filter((e) => e.to.machine === machine)
      if (claimed.length === 0) return []
      saveOutbox(deps.home, { envelopes: file.envelopes.filter((e) => e.to.machine !== machine) })
      alog?.('info', 'outbox.claim', { machine, count: claimed.length })
      return claimed
    },
    routeReturn,
  }
}
