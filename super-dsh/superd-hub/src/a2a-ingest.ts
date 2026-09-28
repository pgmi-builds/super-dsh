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

/** Ingest assembly inputs: hub home + the LOCAL resolver + the in-process delivery face. */
export interface A2aIngestDeps {
  home: string
  /** The local leg of a2a-host's resolver: an address on THIS machine → its session-plane gateway. */
  gatewayFor(addr: A2aAddress): A2aGateway
  /** The initiator-side delivery face (live agents + the bounded unread buffer). */
  delivery: A2aDeliveryCtx
  fetchImpl?: typeof fetch
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
        existing.machine === env.from.machine && existing.agent === env.from.agent
      if (sameConversation) return existing
      throw new Error(`a2a: conversation-id conflict — "${env.conversationId}" is already bound to ${existing.machine}-${existing.agent}/${existing.sessionId} (claimed by ${env.from.machine}-${env.from.agent}/${sessionId})`)
    }
    const row: ConversationRow = {
      shortId: env.conversationId,
      machine: env.from.machine,
      agent: env.from.agent,
      sessionId,
      title,
      createdAt: now(),
      lastActivityAt: now(),
    }
    rows.push(row)
    saveConversations(deps.home, { conversations: rows })
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
  const deliverLocal = (envelope: A2aReplyEnvelope | A2aNoticeEnvelope, responderAgent: string, noticeReason: A2aNoticeReason = 'peer'): A2aDeliveryOutcome => {
    const initiator = { machine: envelope.to.machine, agent: envelope.to.agent, sessionId: envelope.to.sessionId }
    const row = mirrorRowOf(envelope.conversation)
    if (envelope.kind === 'reply') {
      return deliverReply(deps.delivery, initiator, envelope.text, {
        senderMachine: selfId(),
        senderAgent: responderAgent,
        conversationId: envelope.conversation,
        messageId: envelope.messageId,
        title: row?.title,
      })
    }
    return deliverNotice(deps.delivery, initiator, envelope.summary, {
      senderMachine: selfId(),
      senderAgent: responderAgent,
      conversationId: envelope.conversation,
      reason: noticeReason,
    })
  }

  const parkInOutbox = (envelope: A2aReplyEnvelope | A2aNoticeEnvelope): void => {
    const file = loadOutbox(deps.home)
    file.envelopes.push(envelope)
    while (file.envelopes.length > A2A_BUFFER_MAX) file.envelopes.shift()
    saveOutbox(deps.home, file)
  }

  const routeReturn: A2aIngest['routeReturn'] = async (envelope, meta) => {
    if (envelope.to.machine === selfId()) {
      deliverLocal(envelope, meta.responderAgent, meta.noticeReason)
      return 'delivered'
    }
    const machine = listRemotes(deps.home).find((r) => r.id === envelope.to.machine)
    if (machine !== undefined) {
      try {
        await postA2aEnvelope(machine.origin, envelope, {
          cookie: cookieOf(machine.id, deps.home),
          fetchImpl: deps.fetchImpl,
        })
        return 'posted'
      } catch {
        // peer briefly down — park for the next contact (sweep pull / next send)
        parkInOutbox(envelope)
        return 'outbox'
      }
    }
    parkInOutbox(envelope)
    return 'outbox'
  }

  /** The completion watcher behind every successful inject (D16/D3). */
  const watchCompletion = (gateway: A2aGateway, row: ConversationRow, env: A2aNewConversationEnvelope | A2aMessageEnvelope): void => {
    const to: A2aWireOrigin = { machine: env.from.machine, agent: env.from.agent, sessionId: env.from.sessionId }
    const noticeOf = (summary: string): A2aNoticeEnvelope => ({
      kind: 'notice',
      to,
      conversation: row.shortId,
      summary: boundNoticeSummary(summary),
      messageId: `a2a-notice-${randomUUID()}`,
    })
    subscribeSessionCompletion(
      { gateway, sessionId: row.sessionId, conversationId: row.shortId },
      (completion: A2aCompletion) => {
        // D3: a terminal turn with NO reply text must not relay — an aborted
        // turn WITH captured text still relays (the words exist).
        const envelope: A2aReplyEnvelope | A2aNoticeEnvelope = completion.reason !== 'completed' && completion.text === ''
          ? noticeOf(`conversation "${row.shortId}": turn aborted, no reply`)
          : {
            kind: 'reply',
            to,
            conversation: row.shortId,
            text: completion.text,
            messageId: `a2a-relay-${randomUUID()}`,
          }
        void routeReturn(envelope, { responderAgent: env.to.id, noticeReason: completion.reason !== 'completed' && completion.text === '' ? 'aborted' : undefined }).catch(() => parkInOutbox(envelope))
      },
      {
        requestId: env.messageId,
        onError: (error) => {
          const notice = noticeOf(`A2A completion stream for conversation "${row.shortId}" failed: ${error.message}`)
          void routeReturn(notice, { responderAgent: env.to.id, noticeReason: 'stream-dead' }).catch(() => parkInOutbox(notice))
        },
      },
    )
  }

  // ---------------- request kinds

  const ingestRequest = async (env: A2aNewConversationEnvelope | A2aMessageEnvelope): Promise<A2aWireReceipt> => {
    const fail = (error: { code: string; message: string; details?: unknown }, sessionId = '', conversationId?: string): A2aWireReceipt => ({
      outcome: 'failed',
      messageId: env.messageId,
      ...(conversationId === undefined ? {} : { conversationId }),
      sessionId,
      error,
    })

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

    let row: ConversationRow | undefined
    try {
      if (env.kind === 'new-conversation') {
        const created = await sessionRpc<{ sessionId: string }>(gateway, WIRE.sessionCreate, {} as SessionCreateRequestMirror)
        if (!isRecord(created) || typeof created.sessionId !== 'string' || created.sessionId === '') {
          return fail({ code: 'a2a/bad-result', message: 'a2a: session/create returned no sessionId' })
        }
        // D17: mirror rows adopt the title VERBATIM (the '[undefined]' placeholder included)
        row = adoptMirrorRow(env, created.sessionId, env.title)
      } else {
        row = mirrorRowOf(env.conversationId)
        if (row === undefined) {
          return fail({
            code: 'a2a/conversation-not-found',
            message: `a2a: conversation "${env.conversationId}" is not in the registry — the initiator's conversationId does not resolve here`,
          })
        }
        if (row.machine !== env.from.machine || row.agent !== env.from.agent) {
          return fail({
            code: 'a2a/conversation-machine-mismatch',
            message: `a2a: conversation "${row.shortId}" belongs to ${row.machine}-${row.agent}, not ${env.from.machine}-${env.from.agent}`,
          }, row.sessionId, row.shortId)
        }
      }
    } catch (error) {
      // adoptMirrorRow's fail-loud collision + any registry write failure
      return fail(receiptErrorOf(error))
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
    const stopped = (scope: 'turn' | 'turn-only', reason?: string): A2aStopReceipt =>
      ({ stopped: false, scope, ...(reason === undefined ? {} : { reason }) })
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
      return {
        stopped: result.cancelled,
        scope: result.scope,
        ...(parts.some((p) => p !== undefined) ? { reason: parts.filter((p) => p !== undefined).join('; ') } : {}),
      }
    } catch (error) {
      return stopped(env.scope === 'session' ? 'turn-only' : 'turn', messageOf(error))
    }
  }

  return {
    async ingest(envelope) {
      switch (envelope.kind) {
        case 'new-conversation':
        case 'message':
          return ingestRequest(envelope)
        case 'stop':
          return ingestStop(envelope)
        case 'reply':
        case 'notice':
          // inbound return envelope (peer POSTed / sweep pulled): the registry
          // row for this conversation points AT the sender — its agent is the
          // attribution; a missing row degrades the sender to 'unknown'.
          return deliverLocal(envelope, mirrorRowOf(envelope.conversation)?.agent ?? 'unknown')
      }
    },
    claimOutbox(machine: string): A2aEnvelope[] {
      const file = loadOutbox(deps.home)
      const claimed = file.envelopes.filter((e) => e.to.machine === machine)
      if (claimed.length === 0) return []
      saveOutbox(deps.home, { envelopes: file.envelopes.filter((e) => e.to.machine !== machine) })
      return claimed
    },
    routeReturn,
  }
}
