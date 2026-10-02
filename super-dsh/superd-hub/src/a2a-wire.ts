/**
 * Hub-to-hub A2A envelope protocol v1 (postoffice R1; ADR 0011, spec
 * machine-mesh-a2a D16–D19, plan 2026-09-28-machine-mesh-postoffice-rework
 * 契约要点).
 *
 * THE only versioned cross-machine contract in the mesh (D16): everything
 * hub-to-hub rides these envelopes — opaque payloads addressed by
 * `<m4>-<a6>`; the session plane never crosses a machine boundary. Local
 * delivery is the SAME protocol short-circuited in-process (R4), so wire
 * shape = local shape by construction.
 *
 * Frame: `{v: 1, envelope}`. Request envelopes (initiator hub → target hub):
 *   new-conversation — create + inject (conversationId = initiator-minted
 *                     shortId, title already normalized to the
 *                     '[undefined]' placeholder when unspecified, D17)
 *   message          — resume + inject on the adopted shortId
 *   stop             — cancel the target machine's local turn
 * Return envelopes (target hub → initiator hub):
 *   reply  — final assistant text of a captured completion (D3: never empty;
 *            an aborted turn without text is a notice instead)
 *   notice — bounded state account (summary ≤120, mirrors upstream
 *            CONTEXT_SUMMARY_MAX_CHARS)
 *
 * Endpoints (registered by mesh-rpc in R3, consumed here):
 *   POST /api/superd/a2a            body = frame → receipt
 *   GET  /api/superd/a2a/outbox?machine=<m4> → claim & clear the buffered
 *                                     envelopes addressed to that machine
 *                                     (declarative claim inside the trust
 *                                     model, D1 — the consumer holds full
 *                                     authority over its own outbox).
 *
 * Receipts (contract): new/message → `{outcome,messageId,conversationId,
 * sessionId}` ('delivered' on every successful prompt submission — end-to-end
 * delivery complete; 'failed' carries an error body); stop → `{stopped,scope,reason?}`.
 *
 * Guards are STRICT: exact key sets per kind, non-empty strings everywhere,
 * no unknown fields. Version skew is the outer `v`'s job; within v1 a
 * malformed envelope is a protocol violation and fails loud (the collision
 * case — adopting a foreign shortId — likewise rejects loud at ingest, R3).
 */
import type { WireError } from './envelope.js'

/** The wire-protocol version this module speaks (and its guards accept). */
export const A2A_WIRE_VERSION = 1

/** Registry/wire title placeholder when the operator specified none (D17). */
export const A2A_TITLE_PLACEHOLDER = '[undefined]'

/** The a2a ingest endpoint (fence + cookie gate ride the connection channel). */
export const A2A_ENDPOINT_PATH = '/api/superd/a2a'

/** The outbox claim endpoint — `?machine=<m4>` names the CLAIMING machine. */
export const A2A_OUTBOX_PATH = '/api/superd/a2a/outbox'

/** Bound for a notice summary — mirrors upstream CONTEXT_SUMMARY_MAX_CHARS (119 chars + '…' when bounded). */
export const A2A_NOTICE_SUMMARY_MAX = 120

/** Wire call budget — matches mesh-link's FETCH_TIMEOUT_MS (10s). */
export const A2A_WIRE_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------- addresses

/** Request-side destination: machine id (m4) + agent id (a6). */
export interface A2aWireTarget {
  machine: string
  id: string
}

/** Return-side destination: the initiator's machine/agent/session (FULL-length sessionId, D6). */
export interface A2aWireOrigin {
  machine: string
  agent: string
  sessionId: string
}

// ---------------------------------------------------------------- envelopes

/** Prompt delivery mode (upstream `SessionPromptRequest.mode`); default 'queue' — peer semantics. */
export type A2aWireDelivery = 'queue' | 'steer'

export interface A2aNewConversationEnvelope {
  kind: 'new-conversation'
  to: A2aWireTarget
  /** Initiator-minted shortId; the target adopts it verbatim (mirror row). */
  conversationId: string
  /** Already normalized: '[undefined]' when the operator specified none (D17). */
  title: string
  message: string
  from: A2aWireOrigin
  messageId: string
  delivery?: A2aWireDelivery
}

export interface A2aMessageEnvelope {
  kind: 'message'
  to: A2aWireTarget
  conversationId: string
  message: string
  from: A2aWireOrigin
  messageId: string
  delivery?: A2aWireDelivery
}

export interface A2aStopEnvelope {
  kind: 'stop'
  to: A2aWireTarget
  conversationId: string
  scope: 'turn' | 'session'
}
/**
 * Sender identity on a return envelope — the machine+agent that PRODUCED the
 * reply/notice. Additive v1 field: absent on older peers, in which case the
 * receiver falls back to registry attribution (the local row for the
 * conversation points at the peer). Never the receiver's own id.
 */
export interface A2aReturnSender {
  readonly machine: string
  readonly agent: string
}

export interface A2aReplyEnvelope {
  kind: 'reply'
  to: A2aWireOrigin
  /** Conversation shortId (requests say `conversationId`; returns say `conversation` — contract asymmetry, kept verbatim). */
  conversation: string
  text: string
  messageId: string
  /** Who replied — the hosting machine + host agent (additive v1). */
  sender?: A2aReturnSender
  /** D20 (additive v1): present iff the text is the runtime's TRANSCRIPTION of the peer's turn-end last output — the peer never sent it through the channel (latch never set). The delivering side renders the provenance prefix from this flag; absent = a channel reply the peer chose to send. */
  transcribed?: true
}

/**
 * Why a runtime-owned notice was produced — THE cause taxonomy of the a2a
 * face (0.1.7-h R2: this crosses the wire now; the additive `reason` field
 * rides the notice envelope and the receiver renders it into the model-facing
 * envelope line, so "turn ended, no reply" stops being three different facts
 * wearing one sentence). 'peer' = an account minted by the PEER hub and
 * relayed in; absent wire reason (older peer) falls back to 'peer'.
 */
export type A2aNoticeReason = 'send-failed' | 'stream-dead' | 'stop' | 'aborted' | 'peer' | 'delivered' | 'undelivered'

export interface A2aNoticeEnvelope {
  kind: 'notice'
  to: A2aWireOrigin
  conversation: string
  /** Bounded ≤ {@link A2A_NOTICE_SUMMARY_MAX}. */
  summary: string
  messageId: string
  /** Who noticed — the hosting machine + host agent (additive v1). */
  sender?: A2aReturnSender
  /** R2 (additive 0.1.7-h): the cause — rendered into the model-facing notice line; absent = pre-0.1.7-h peer, receiver falls back to 'peer'. */
  reason?: A2aNoticeReason
}

export type A2aEnvelope =
  | A2aNewConversationEnvelope
  | A2aMessageEnvelope
  | A2aStopEnvelope
  | A2aReplyEnvelope
  | A2aNoticeEnvelope

/** The v1 outer frame — the versioned unit that crosses the wire. */
export interface A2aWireFrame {
  v: 1
  envelope: A2aEnvelope
}

// ---------------------------------------------------------------- receipts

/** Receipt for new-conversation / message envelopes (inbox-acceptance). */
export interface A2aSendReceipt {
  outcome: 'delivered' | 'failed'
  messageId: string
  conversationId?: string
  /** Target session ('' when the failure predates session resolution). */
  sessionId: string
  /** Present iff outcome === 'failed'. */
  error?: WireError
}

/** Receipt for stop envelopes; 'turn-only' reports the session-scope degradation honestly (no session-close RPC upstream). */
export interface A2aStopReceipt {
  stopped: boolean
  scope: 'turn' | 'turn-only'
  reason?: string
}

export type A2aWireReceipt = A2aSendReceipt | A2aStopReceipt

// ---------------------------------------------------------------- address error

/**
 * Typed address-resolution failure (D7): THROWN by resolvers and wire
 * helpers so the WHY survives the boundary — consumers (P4 exec, P5
 * injection) branch on `kind` instead of parsing message strings. The three
 * kinds name the actual problem: a typo'd a6 on a known machine is not a
 * pairing issue, and an unpaired machine is not an agent problem.
 *
 * Postoffice R1 note: the class lives here (the protocol layer) since the
 * wire helpers classify transport failures with it; `a2a-service.js`
 * re-exports it unchanged for its existing consumers.
 */
export class A2aAddressError extends Error {
  /** Which failure this is. */
  readonly kind: 'unknown-agent' | 'unknown-machine' | 'unreachable'
  /** The address that failed to resolve. */
  readonly address: A2aWireTarget
  /** The machine the blame lands on (m4; equals `address.machine`). */
  readonly machine: string

  constructor(kind: 'unknown-agent' | 'unknown-machine' | 'unreachable', address: A2aWireTarget) {
    super(A2aAddressError.messageOf(kind, address))
    this.name = 'A2aAddressError'
    this.kind = kind
    this.address = address
    this.machine = address.machine
  }

  /** The honest branch text — one place, shared by every consumer of the error. */
  static messageOf(kind: 'unknown-agent' | 'unknown-machine' | 'unreachable', address: A2aWireTarget): string {
    if (kind === 'unknown-agent') {
      return `a2a: unknown-agent ${address.machine}-${address.id} (no such agent on machine ${address.machine})`
    }
    if (kind === 'unknown-machine') {
      // 0.1.7-h R3 (dev3 first-person 0.1.7-g §6): a malformed address such as
      // "no-such-agent-zzz" parses machine="no" — an error naming only "no"
      // sends the model hunting for a machine it never typed. Name the
      // fragment AND the full address; split-at-first-dash concat is the raw
      // input, so this reconstruction is exact.
      return `a2a: unknown-machine "${address.machine}" — address "${address.machine}-${address.id}" is not a paired machine (addresses are "<m4>-<a6>")`
    }
    return `a2a: no gateway for ${address.machine}-${address.id} — machine unreachable or not paired`
  }
}

/** The target address of any envelope (request `to` directly; return `to` folded agent→id). */
export function a2aAddressOf(envelope: A2aEnvelope): A2aWireTarget {
  const to = envelope.to
  return 'id' in to ? { machine: to.machine, id: to.id } : { machine: to.machine, id: to.agent }
}

// ---------------------------------------------------------------- guards

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v !== ''
}

/** R2 (0.1.7-i): the wire notice reason vocabulary — mirror of the type union. */
const NOTICE_REASONS: ReadonlySet<string> = new Set(['send-failed', 'stream-dead', 'stop', 'aborted', 'peer', 'delivered', 'undelivered'])

function isNoticeReason(v: unknown): v is A2aNoticeReason {
  return typeof v === 'string' && NOTICE_REASONS.has(v)
}

function hasExactKeys(v: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): boolean {
  const expected = new Set([...keys, ...optional])
  for (const key of Object.keys(v)) {
    if (!expected.has(key)) return false
  }
  for (const key of keys) {
    if (!(key in v)) return false
  }
  return true
}

function isTarget(v: unknown): v is A2aWireTarget {
  return isRecord(v) && hasExactKeys(v, ['machine', 'id']) && nonEmptyString(v.machine) && nonEmptyString(v.id)
}

function isReturnSender(v: unknown): v is A2aReturnSender {
  return isRecord(v) && hasExactKeys(v, ['machine', 'agent']) && nonEmptyString(v.machine) && nonEmptyString(v.agent)
}

function isOrigin(v: unknown): v is A2aWireOrigin {
  return isRecord(v) && hasExactKeys(v, ['machine', 'agent', 'sessionId']) &&
    nonEmptyString(v.machine) && nonEmptyString(v.agent) && nonEmptyString(v.sessionId)
}

function isDelivery(v: unknown): v is A2aWireDelivery {
  return v === undefined || v === 'queue' || v === 'steer'
}

/** Strict v1 envelope guard: exact key sets, non-empty strings, bounded notice summaries. */
export function isA2aEnvelope(v: unknown): v is A2aEnvelope {
  if (!isRecord(v) || typeof v['kind'] !== 'string') return false
  switch (v['kind']) {
    case 'new-conversation':
      return hasExactKeys(v, ['kind', 'to', 'conversationId', 'title', 'message', 'from', 'messageId'], ['delivery']) &&
        isTarget(v['to']) && nonEmptyString(v['conversationId']) && nonEmptyString(v['title']) &&
        nonEmptyString(v['message']) && isOrigin(v['from']) && nonEmptyString(v['messageId']) && isDelivery(v['delivery'])
    case 'message':
      return hasExactKeys(v, ['kind', 'to', 'conversationId', 'message', 'from', 'messageId'], ['delivery']) &&
        isTarget(v['to']) && nonEmptyString(v['conversationId']) && nonEmptyString(v['message']) &&
        isOrigin(v['from']) && nonEmptyString(v['messageId']) && isDelivery(v['delivery'])
    case 'stop':
      return hasExactKeys(v, ['kind', 'to', 'conversationId', 'scope']) &&
        isTarget(v['to']) && nonEmptyString(v['conversationId']) && (v['scope'] === 'turn' || v['scope'] === 'session')
    case 'reply':
      return hasExactKeys(v, ['kind', 'to', 'conversation', 'text', 'messageId'], ['sender', 'transcribed']) &&
        isOrigin(v['to']) && nonEmptyString(v['conversation']) && nonEmptyString(v['text']) && nonEmptyString(v['messageId']) &&
        (isReturnSender(v['sender']) || v['sender'] === undefined) &&
        (v['transcribed'] === undefined || v['transcribed'] === true)
    case 'notice':
      // 0.1.7-i R2: `reason` rides additively (the send-failed notice made it
      // load-bearing) — older peers omit it, the guard validates the vocabulary.
      return hasExactKeys(v, ['kind', 'to', 'conversation', 'summary', 'messageId'], ['sender', 'reason']) &&
        isOrigin(v['to']) && nonEmptyString(v['conversation']) && nonEmptyString(v['summary']) &&
        typeof v['summary'] === 'string' && v['summary'].length <= A2A_NOTICE_SUMMARY_MAX && nonEmptyString(v['messageId']) &&
        (isReturnSender(v['sender']) || v['sender'] === undefined) &&
        (isNoticeReason(v['reason']) || v['reason'] === undefined)
    default:
      return false
  }
}

/** Strict v1 frame guard: `{v: 1, envelope}` with a valid envelope inside. */
export function isA2aWireFrame(v: unknown): v is A2aWireFrame {
  return isRecord(v) && v['v'] === A2A_WIRE_VERSION && isA2aEnvelope(v['envelope'])
}

/** Decode one unknown value as a frame; errors name the failure for the ingest side's 400s. */
export function decodeA2aWireFrame(v: unknown): { ok: true; envelope: A2aEnvelope } | { ok: false; error: string } {
  if (!isRecord(v)) return { ok: false, error: 'a2a-wire: frame must be a JSON object' }
  if (v['v'] !== A2A_WIRE_VERSION) {
    return { ok: false, error: `a2a-wire: unsupported frame version ${JSON.stringify(v['v'])} (protocol v${A2A_WIRE_VERSION})` }
  }
  if (!isA2aEnvelope(v['envelope'])) {
    return { ok: false, error: `a2a-wire: malformed v${A2A_WIRE_VERSION} envelope (strict shape check failed)` }
  }
  return { ok: true, envelope: v['envelope'] }
}

/** Wrap one envelope in the v1 outer frame. */
export function a2aWireFrameOf(envelope: A2aEnvelope): A2aWireFrame {
  return { v: A2A_WIRE_VERSION, envelope }
}

/** D17 title normalization: unspecified and empty become the placeholder; a given title stays verbatim. */
export function normalizeA2aTitle(title: string | undefined): string {
  return title === undefined || title === '' ? A2A_TITLE_PLACEHOLDER : title
}

// ---------------------------------------------------------------- receipts (guards)

function isWireError(v: unknown): v is WireError {
  return isRecord(v) && nonEmptyString(v['code']) && nonEmptyString(v['message'])
}

function isSendReceipt(v: unknown): v is A2aSendReceipt {
  if (!isRecord(v)) return false
  if (!hasExactKeys(v, ['outcome', 'messageId', 'sessionId'], ['conversationId', 'error'])) return false
  if (v['outcome'] !== 'delivered' && v['outcome'] !== 'failed') return false
  if (!nonEmptyString(v['messageId'])) return false
  if (typeof v['sessionId'] !== 'string') return false
  if ('conversationId' in v && !nonEmptyString(v['conversationId'])) return false
  if ('error' in v && !isWireError(v['error'])) return false
  return true
}

function isStopReceipt(v: unknown): v is A2aStopReceipt {
  if (!isRecord(v)) return false
  if (!hasExactKeys(v, ['stopped', 'scope'], ['reason'])) return false
  if (typeof v['stopped'] !== 'boolean') return false
  if (v['scope'] !== 'turn' && v['scope'] !== 'turn-only') return false
  if ('reason' in v && !nonEmptyString(v['reason'])) return false
  return true
}

// ---------------------------------------------------------------- wire io

/** Wire-helper options: the cookie riding along, an injectable fetch, and a timeout budget. */
export interface A2aWireOptions {
  /** The claiming/paired machine's request cookie (empty → header omitted, mesh-link discipline). */
  cookie?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Throw one classified unreachable failure with the underlying cause attached (the canonical message stays the classification's). */
function throwUnreachable(envelope: A2aEnvelope, cause: unknown): never {
  const error = new A2aAddressError('unreachable', a2aAddressOf(envelope))
    ; (error as Error & { cause?: unknown }).cause = cause
  throw error
}

/**
 * POST one envelope to a hub's a2a ingest and decode the receipt.
 * Transport failures (network error, non-2xx, 401 cookie rejection) map to
 * {@link A2aAddressError} kind 'unreachable' with the cause attached; a 200
 * whose body is not a v1 receipt shape is a loud protocol error (never a
 * guessed receipt).
 */
export async function postA2aEnvelope(origin: string, envelope: A2aEnvelope, opts: A2aWireOptions = {}): Promise<A2aWireReceipt> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const cookie = opts.cookie ?? ''
  let res: Response
  try {
    res = await fetchImpl(`${origin}${A2A_ENDPOINT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }) },
      body: JSON.stringify(a2aWireFrameOf(envelope)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? A2A_WIRE_TIMEOUT_MS),
    })
  } catch (err) {
    throwUnreachable(envelope, err)
  }
  if (res.status !== 200) {
    throwUnreachable(envelope, `ingest POST answered status ${res.status}${res.status === 401 ? ' (cookie rejected)' : ''}`)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    throw new Error(`a2a-wire: ingest receipt from ${origin} is not JSON — ${errMsg(err)}`)
  }
  if (isSendReceipt(body) || isStopReceipt(body)) return body
  throw new Error(`a2a-wire: ingest receipt from ${origin} is not a v1 receipt shape — ${JSON.stringify(body)}`)
}

/** The outbox claim body: `{v: 1, envelopes}` — envelopes validated on arrival, fail-loud on any malformed entry. */
function decodeOutboxBody(v: unknown, origin: string): A2aEnvelope[] {
  if (!isRecord(v) || v['v'] !== A2A_WIRE_VERSION || !Array.isArray(v['envelopes'])) {
    throw new Error(`a2a-wire: outbox body from ${origin} is not {v: 1, envelopes: []} — ${JSON.stringify(v)}`)
  }
  const envelopes: A2aEnvelope[] = []
  for (const [index, entry] of v['envelopes'].entries()) {
    if (!isA2aEnvelope(entry)) {
      throw new Error(`a2a-wire: outbox entry #${index} from ${origin} is not a v1 envelope — ${JSON.stringify(entry)}`)
    }
    envelopes.push(entry)
  }
  return envelopes
}

/**
 * Claim (and clear, server-side) the envelopes buffered for THIS machine:
 * `GET <origin>/api/superd/a2a/outbox?machine=<m4>` with the cookie riding
 * along. Same failure taxonomy as {@link postA2aEnvelope}.
 */
export async function fetchA2aOutbox(origin: string, machine: string, opts: A2aWireOptions = {}): Promise<A2aEnvelope[]> {
  if (!nonEmptyString(machine)) {
    throw new Error('a2a-wire: outbox claim requires a non-empty machine id')
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const cookie = opts.cookie ?? ''
  let res: Response
  try {
    res = await fetchImpl(`${origin}${A2A_OUTBOX_PATH}?machine=${encodeURIComponent(machine)}`, {
      method: 'GET',
      headers: cookie === '' ? {} : { cookie },
      signal: AbortSignal.timeout(opts.timeoutMs ?? A2A_WIRE_TIMEOUT_MS),
    })
  } catch (err) {
    const error = new A2aAddressError('unreachable', { machine, id: '' })
      ; (error as Error & { cause?: unknown }).cause = err
    throw error
  }
  if (res.status !== 200) {
    const error = new A2aAddressError('unreachable', { machine, id: '' })
      ; (error as Error & { cause?: unknown }).cause =
        `outbox claim answered status ${res.status}${res.status === 401 ? ' (cookie rejected)' : ''}`
    throw error
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    throw new Error(`a2a-wire: outbox body from ${origin} is not JSON — ${errMsg(err)}`)
  }
  return decodeOutboxBody(body, origin)
}
