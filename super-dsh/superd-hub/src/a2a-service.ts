/**
 * A2A conversation service (mesh P3 Task 2): the conversation registry plus
 * create / resume / inject / completion-capture against a target agent's
 * session plane, reached through an injected `gatewayFor(addr)` resolver
 * (local in-process gateway or remote wire — the service cannot tell).
 *
 * Pure service core, no cordis dependencies: assembly (completion cb → reply
 * delivery) is Task 3's layer. Every session-plane call is built from the
 * Task 1 vocabulary (`wire-endpoints.ts`): endpoint constants + payload
 * mirrors + `wireArgsOf()` — never hand-rolled payloads.
 *
 * Frame vocabulary for completion capture (upstream anchors,
 * `upstream/deepseek-harness` @ dsh-v0.1.7-rc.1):
 *   - follow frames: `SessionFollowFrame` union
 *     packages/api/session-controller/src/types.ts:550 — opening
 *     `{type:'snapshot', records}` then ordered `{type:'event', event}`
 *     entries; `assistant-stream` frames are live partials (ignored — final
 *     text comes from the durable `assistant/message` events).
 *   - event entries: `SessionEventEntry` types.ts:424, `SessionWireEvent`
 *     {type, seq, time, data} types.ts:436.
 *   - turn lifecycle: `SessionEventMap` 'turn/start' | 'turn/end'
 *     packages/core/session/src/types.ts:288–297; `turn/end.data.reason.kind`
 *     = TurnEndReasonMap kinds (types.ts:201 — completed/aborted/blocked/
 *     error/max-tokens/interrupted/forked).
 *   - final text: `assistant/message` events carry `{turn, step, message,
 *     stream, interrupted?}` (packages/core/session/src/index.ts:286,
 *     settlement shape :675; `interrupted === true` marks a replaced attempt,
 *     client/sessions/assistant-stream.ts:189). Text blocks of
 *     `message.content` (`TextBlock` packages/llm/llm/src/types.ts:61) are
 *     joined with '\n\n'.
 *   - send correlation: `session/prompt`'s client-minted `requestId`
 *     (`SessionPromptRequest` types.ts:331) is persisted on the accepted
 *     user message as `data.source.rpcId` (source kind `user-rpc`,
 *     types.ts:196–199) — the stream matcher keys on it.
 *
 * Controller rulings baked in (2026-09-28):
 *   - receipt outcome: 'injected' on EVERY successful prompt submission;
 *     'queued' is RESERVED — the type exists for the OMP-hub-compatible
 *     taxonomy but T2 never returns it (busy-detection is not built — the
 *     target's busy-ness is not cheaply knowable from the hub).
 *   - completion correlation is BY TURN via the requestId arming above: one
 *     `turn/end` fires the cb exactly once (debounce-free, order-safe on the
 *     session log's contiguous seq space); the requestId-armed subscription
 *     auto-disposes after its turn fires, so a send observes at most one
 *     completion. Snapshot-replayed history never re-fires a fired turn.
 *   - stop('session'): upstream has NO session-close RPC (Task 1 finding —
 *     `WIRE.sessionClose === undefined`); the scope degrades to turnCancel
 *     and the result reports `{scope:'turn-only', reason}` so callers can
 *     notice the degradation (the upstream analogues live on the workspace
 *     namespace and stay out of the session plane).
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EnvelopeError, type WireError } from './envelope.js'
import { A2aAddressError } from './a2a-wire.js'
// compat re-export (postoffice R1): the class moved to the protocol layer
// (a2a-wire.ts) so the wire helpers can classify with it; every existing
// consumer importing it from this module keeps compiling unchanged.
export { A2aAddressError }
import {
  WIRE,
  type SessionCreateRequestMirror,
  type SessionPromptRequestMirror,
  type SessionCancelRequestMirror,
  type SessionRenameRequestMirror,
  type SessionFollowRequestMirror,
} from './wire-endpoints.js'
import { wireArgsOf } from './wire-endpoints.js'

// ---------------------------------------------------------------- registry


/** One tracked conversation = one target-side DSH session (spec §2). */
export interface ConversationRow {
  /** Display/tool alias — first 6 chars of the session id's uuid part (the constant `session-` prefix stripped), collision-lengthened 6→8→10; legacy rows keep older spellings verbatim. */
  shortId: string
  /** Machine id (m4) the conversation lives on. */
  machine: string
  /** Agent id (a6) the conversation belongs to. */
  agent: string
  /** Full DSH session id (the wire identity). */
  sessionId: string
  /** Operator-facing title (optional; never an identity). */
  title?: string
  /** Epoch ms when the row was created. */
  createdAt: number
  /** Epoch ms of the last successful send. */
  lastActivityAt: number
}

/** The whole registry file. */
export interface ConversationsFile {
  conversations: ConversationRow[]
}

function conversationsPath(home: string): string {
  return join(home, 'superd', 'a2a-conversations.json')
}

function isConversationRow(v: unknown): v is ConversationRow {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.shortId === 'string' && r.shortId !== '' &&
    typeof r.machine === 'string' && r.machine !== '' &&
    typeof r.agent === 'string' && r.agent !== '' &&
    typeof r.sessionId === 'string' && r.sessionId !== '' &&
    (r.title === undefined || typeof r.title === 'string') &&
    typeof r.createdAt === 'number' && typeof r.lastActivityAt === 'number'
  )
}

/** Read the registry; a missing or unreadable/corrupt file degrades to empty (never throws). */
export function loadConversations(home: string): ConversationsFile {
  let raw: string
  try {
    raw = readFileSync(conversationsPath(home), 'utf8')
  } catch {
    return { conversations: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { conversations: [] }
  }
  if (typeof parsed !== 'object' || parsed === null) return { conversations: [] }
  const list = (parsed as Record<string, unknown>)['conversations']
  if (!Array.isArray(list)) return { conversations: [] }
  return { conversations: list.filter(isConversationRow) }
}

/** Persist the registry: recursive mkdir, tmp write, chmod 0600, atomic rename (machines.ts discipline). */
export function saveConversations(home: string, file: ConversationsFile): void {
  if (!Array.isArray(file.conversations)) {
    throw new TypeError('a2a: save rejected — file must be {conversations: []}')
  }
  for (const r of file.conversations) {
    if (!isConversationRow(r)) {
      throw new TypeError('a2a: save rejected — every row needs shortId/machine/agent/sessionId/createdAt/lastActivityAt')
    }
  }
  const dir = join(home, 'superd')
  mkdirSync(dir, { recursive: true })
  const target = conversationsPath(home)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, target)
}

/** Mint core: strip the optional leading `session-`, take the first 6 chars of the
 * base, collision-lengthen 6→8→10… (step 2). Shared by the fresh-mint path and the
 * one-time registry migration so both produce identical ids. */
function mintShortIdOf(sessionId: string, taken: ReadonlySet<string>): string {
  const stripped = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  const base = stripped === '' ? sessionId : stripped
  for (let len = 6; len < base.length; len += 2) {
    const candidate = base.slice(0, len)
    if (!taken.has(candidate)) return candidate
  }
  if (!taken.has(base)) return base
  throw new Error(`a2a: short-id space exhausted for session ${sessionId}`)
}

/**
 * shortId mint (D2 fix): DSH session ids are `session-<uuid>`, so slicing the
 * raw id only ever captures the constant prefix (the live registry degenerated
 * to "session-", "session-3", …). Strip the prefix, mint the first 6 chars of
 * the uuid part, collision-lengthen 6→8→10… (step 2, spec §11). Ids without the
 * prefix (older/foreign spellings) mint from the whole id the same way. A
 * re-seen sessionId keeps its row's shortId (stable across restarts); stored
 * shortIds are reserved as taken — DEGENERATE ones are re-minted once by
 * {@link migrateConversations}, all others stay verbatim forever.
 */
export function shortIdFor(sessionId: string, rows: readonly ConversationRow[]): string {
  const existing = rows.find((r) => r.sessionId === sessionId)
  if (existing) return existing.shortId
  return mintShortIdOf(sessionId, new Set(rows.map((r) => r.shortId)))
}

/**
 * Degenerate-pattern predicate (D2 migration): a stored shortId that still
 * carries the `session-` prefix AND whose remainder is shorter than the new
 * mint length — exactly the ids the old prefix-slicing bug produced. Such ids
 * carry (almost) no information and teach peers to echo garbage.
 */
export function isDegenerateShortId(shortId: string): boolean {
  return shortId.startsWith('session-') && shortId.length < 'session-'.length + 6
}

/**
 * One-time registry migration (D2 amended, review 2026-09-28): rows matching
 * the degenerate pattern are re-minted with the current algorithm and written
 * back; non-degenerate rows are never touched. Peers still holding an old
 * degenerate id in their context is accepted collateral — the registry holds
 * test data today, which is the cheapest migration window there will ever be.
 * @returns the re-minted rows (empty when nothing needed migrating).
 */
export function migrateConversations(home: string): ConversationRow[] {
  const rows = loadConversations(home).conversations
  if (!rows.some((r) => isDegenerateShortId(r.shortId))) return []
  const taken = new Set(rows.filter((r) => !isDegenerateShortId(r.shortId)).map((r) => r.shortId))
  const minted = new Map<string, string>()
  for (const row of rows) {
    if (!isDegenerateShortId(row.shortId)) continue
    const shortId = mintShortIdOf(row.sessionId, taken)
    taken.add(shortId)
    minted.set(row.sessionId, shortId)
  }
  const next = rows.map((r) => (minted.has(r.sessionId) ? { ...r, shortId: minted.get(r.sessionId) as string } : r))
  saveConversations(home, { conversations: next })
  return next.filter((r) => minted.has(r.sessionId))
}
// ---------------------------------------------------------------- envelopes

/**
 * THE reply-teaching envelope — one template constant. Filled with the
 * INITIATOR's identity (machine-agent address), the conversation title, the
 * body, and the shortId a superd-hub tool would address. E3 rewording
 * (2026-09-28): the peer is taught to reply NORMALLY — world trees do not
 * compose the a2a row yet (P5 pending) and the hub's completion watch relays
 * the peer's turn output regardless; the tool clause is secondary, for later
 * or asynchronous replies when the peer ALSO has a superd-hub tool.
 */
export const A2A_MESSAGE_TEMPLATE =
  'A2A message from {machine}-{agent} (conversation "{title}"):\n\n{message}\n\nReply normally in this conversation — your reply is relayed to the sender automatically. If you also have a superd-hub tool, you may use it with conversationId {shortId} for later or asynchronous replies.'

/** Title shown when the conversation has none. */
export const A2A_UNTITLED = '(untitled)'

/**
 * Render the teaching envelope for one send — a SINGLE pass over the template
 * (injection fix, 2026-09-28): each placeholder is expanded exactly once from
 * the fields, and user-supplied values (title, message) are never re-scanned,
 * so a title containing the literal `{shortId}` or `{message}` lands verbatim
 * instead of being expanded by a later replaceAll round.
 */
export function renderA2aEnvelope(fields: {
  machine: string
  agent: string
  title?: string
  shortId: string
  message: string
}): string {
  const title = fields.title === undefined || fields.title === '' ? A2A_UNTITLED : fields.title
  return A2A_MESSAGE_TEMPLATE.replace(/\{(machine|agent|title|shortId|message)\}/g, (_match, key: string): string => {
    switch (key) {
      case 'machine': return fields.machine
      case 'agent': return fields.agent
      case 'title': return title
      case 'shortId': return fields.shortId
      default: return fields.message
    }
  })
}

/** Bounded unread buffer size per initiator session. */
export const A2A_BUFFER_MAX = 32

/** stop('session') degradation notice — the session plane has no close RPC upstream. */
export const A2A_NO_SESSION_CLOSE_REASON = 'no session-close endpoint upstream'

// ---------------------------------------------------------------- service types

/** Target address: machine id (m4) + agent id (a6) — the `gatewayFor` key. */
export interface A2aAddress {
  machine: string
  id: string
}

/**
 * Initiator identity envelope (spec §7.3), opaque in T2 — Task 3 gives it its
 * real shape. T2 uses `machine`/`agent` for the teaching template and
 * `sessionId` as the unread-buffer key.
 */
export interface A2aInitiator {
  machine: string
  agent: string
  sessionId: string
}

/** Prompt delivery mode (upstream `SessionPromptRequest.mode`); default 'queue' — peer semantics, never interrupting. */
export type A2aDelivery = 'queue' | 'steer'

/**
 * Receipt taxonomy (spec §2, OMP-hub-compatible). 'queued' is RESERVED in
 * T2: busy-detection is deliberately not built, so every successful prompt
 * submission receipts 'injected'.
 */
export type A2aReceiptOutcome = 'injected' | 'queued' | 'failed'

/** One failed-send error body, verbatim from the gateway (wire error shape). */
export interface A2aReceiptError {
  code: string
  message: string
  details?: unknown
}

/** send()'s immediate return (spec §2: inbox-acceptance receipt). */
export interface A2aReceipt {
  outcome: A2aReceiptOutcome
  /** The client-minted requestId — the durable identity of the injected user message. */
  messageId: string
  /** Conversation shortId (absent when no conversation resolved). */
  conversationId?: string
  /** Target session ('' when the failure predates session resolution). */
  sessionId: string
  /** Present iff outcome === 'failed'. */
  error?: A2aReceiptError
}

/** One send request (spec §7.2): no conversationId ≡ new conversation. */
export interface A2aSendRequest {
  to: A2aAddress
  conversationId?: string
  title?: string
  message: string
  delivery?: A2aDelivery
}

/** Conversation reference: address + shortId. */
export interface A2aConversationRef {
  to: A2aAddress
  conversationId: string
}

/** One captured turn completion. */
export interface A2aCompletion {
  conversationId: string
  sessionId: string
  turn: number
  /** `turn/end.data.reason.kind` (TurnEndReason). */
  reason: string
  /** Text blocks of the turn's LAST non-interrupted assistant/message, joined with '\n\n'. */
  text: string
}

export type A2aCompletionCb = (completion: A2aCompletion) => void
export type A2aErrorCb = (error: { code: string; message: string }) => void

export interface A2aSubscribeOptions {
  /**
   * Correlate one send: the requestId used on `session/prompt`. The cb fires
   * exactly once — for the turn that admitted this request's user message
   * (matched by `data.source.rpcId`) — then the subscription auto-disposes.
   * Omit to observe every turn completion while subscribed (one cb per turn).
   */
  requestId?: string
  /** Death/failure notice path (missing conversation/gateway, second stream death). */
  onError?: A2aErrorCb
}

export type A2aStopScope = 'turn' | 'session'

/** stop() idle note — the honest answer when the pre-cancel liveness snapshot showed no live turn (D5). */
export const A2A_NO_TURN_ACTIVE_NOTE = 'no turn was active'

/** stop() result: 'turn' answers a turn-scope stop; 'turn-only' reports the session-scope degradation.
 * `cancelled:false` is the honest idle answer (D5): the cancel RPC still fired (today's wire behavior
 * is unchanged), but the pre-cancel liveness read showed no turn to stop — the note says so. */
export type A2aStopResult =
  | { scope: 'turn'; cancelled: true }
  | { scope: 'turn'; cancelled: false; note: typeof A2A_NO_TURN_ACTIVE_NOTE }
  | { scope: 'turn-only'; cancelled: true; reason: typeof A2A_NO_SESSION_CLOSE_REASON }
  | { scope: 'turn-only'; cancelled: false; note: typeof A2A_NO_TURN_ACTIVE_NOTE; reason: typeof A2A_NO_SESSION_CLOSE_REASON }
/** One buffered (undelivered) inbound message for an initiator session. */
export interface A2aBufferedMessage {
  messageId: string
  initiatorSessionId: string
  from: A2aAddress
  conversationId: string
  text: string
  bufferedAt: number
}

/** Input half of a buffer push (Task 3's delivery layer calls this on reply-delivery failure). */
export type A2aBufferInput = Omit<A2aBufferedMessage, 'initiatorSessionId' | 'bufferedAt'>

/** The gateway face this service consumes — structural subset of `GatewayFace` (targets.ts). */
export interface A2aGateway {
  dispatchRpc(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown>
  openWireStream(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
}

/**
 * Typed address-resolution failure (D7) — the class lives in a2a-wire.ts
 * since postoffice R1 (the wire helpers classify transport failures with
 * it); re-exported above for this module's existing consumers.
 */

export interface A2aServiceDeps {
  home: string
  gatewayFor(addr: A2aAddress): A2aGateway
  now?(): number
}

export interface A2aService {
  /** Create a conversation on the target (session/create [+ session/rename]); typed errors on 401/unreachable/business rejection — EXCEPT a rejected title, which returns the created conversation with a `warning` (D1 hardening: never orphan an addressable row). */
  newConversation(addr: A2aAddress, title?: string): Promise<{ shortId: string; sessionId: string; warning?: string }>
  /** Create-or-resume + inject one user turn; receipt semantics (never throws — failures are 'failed' receipts). */
  send(req: A2aSendRequest, initiator: A2aInitiator): Promise<A2aReceipt>
  /** Subscribe turn completions of one conversation over session/follow; returns the dispose fn. */
  subscribeCompletion(conv: A2aConversationRef, cb: A2aCompletionCb, opts?: A2aSubscribeOptions): () => void
  /** Cancel the active turn; 'session' scope degrades to turn-only with the typed reason. cancelled:false + note is the honest idle answer (D5 — the cancel still fires; a pre-cancel snapshot read proved no turn was live). */
  stop(conv: A2aConversationRef, scope: A2aStopScope): Promise<A2aStopResult>
  /** Buffer one undelivered message for an initiator (bounded A2A_BUFFER_MAX, oldest dropped). */
  buffer(initiatorSessionId: string, message: A2aBufferInput): void
  /** Sweep the unread buffer — one initiator, or all; swept entries are returned and cleared. */
  read(initiatorSessionId?: string): A2aBufferedMessage[]
  /** Snapshot of the registry rows. */
  listConversations(): ConversationRow[]
}

// ---------------------------------------------------------------- helpers

type WireResult = { ok: true; value: unknown } | { ok: false; error: WireError }

function a2aError(code: string, message: string, details?: unknown): EnvelopeError {
  return new EnvelopeError(details === undefined ? { code, message } : { code, message, details })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Map any thrown error into the receipt error body — an EnvelopeError's wire body passes verbatim. */
function receiptErrorOf(error: unknown): A2aReceiptError {
  if (error instanceof EnvelopeError) return { ...error.wire }
  if (error instanceof Error) return { code: 'gateway/uncaught', message: error.message }
  return { code: 'gateway/uncaught', message: String(error) }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Fresh non-aborted signal for one-shot rpc calls (T2 exposes no cancellation surface on send/stop). */
function freshSignal(): AbortSignal {
  return new AbortController().signal
}

/** Map one typed address failure to its wire error body (D7): the error's own
 * message; the code keeps 'a2a/gateway-unavailable' for the unreachable branch
 * (today's code) and names the kind otherwise. */
function addressErrorBody(error: A2aAddressError): { code: string; message: string } {
  return { code: error.kind === 'unreachable' ? 'a2a/gateway-unavailable' : `a2a/${error.kind}`, message: error.message }
}

/** Resolve through the injected resolver, mapping A2aAddressError to the typed wire
 * error (D7). A resolver that still returns undefined instead of throwing is defensively
 * spelled 'unreachable' — the service never proceeds with a missing face. */
function gatewayOrThrow(gatewayFor: A2aServiceDeps['gatewayFor'], addr: A2aAddress): A2aGateway {
  let gateway: A2aGateway | undefined
  try {
    gateway = gatewayFor(addr)
  } catch (error) {
    if (error instanceof A2aAddressError) {
      const body = addressErrorBody(error)
      throw a2aError(body.code, body.message)
    }
    throw error
  }
  if (gateway === undefined) {
    throw a2aError('a2a/gateway-unavailable', A2aAddressError.messageOf('unreachable', addr))
  }
  return gateway
}

/** Bound for the stop() liveness read — a healthy session plane answers the first
 * follow frame in well under a second, even cross-machine; the bound only fires on
 * a wedged plane, where the cancel RPC itself would stall anyway. */
const STOP_LIVENESS_TIMEOUT_MS = 3_000

/**
 * D5 turn-liveness read: open the follow stream, replay the FIRST snapshot
 * frame's records, and report whether a turn is still open (a turn/start not
 * followed by its turn/end). Read manually (no for-await) and aborted BEFORE
 * returning — closing an async generator suspended at an await must not gate
 * the answer (the close promise can reject on abort and would eat the result).
 * @returns true (a turn is live), false (idle), or undefined when the plane
 * could not answer (stream death, stream end, no snapshot, read timeout) —
 * callers treat undefined conservatively: cancel anyway, keep today's shape.
 */
async function turnLivenessOf(gateway: A2aGateway, sessionId: string): Promise<boolean | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STOP_LIVENESS_TIMEOUT_MS)
  try {
    const request: SessionFollowRequestMirror = { address: { kind: 'session', sessionId } } // no assistantStream — liveness needs no live partials
    const iterable = await gateway.openWireStream(WIRE.streamOpen, wireArgsOf(WIRE.streamOpen, request), controller.signal)
    const iterator = (await iterable)[Symbol.asyncIterator]()
    for (;;) {
      const next = await iterator.next()
      if (next.done) return undefined
      const frame = next.value
      if (!isRecord(frame) || frame['type'] !== 'snapshot') continue
      const records = frame['records']
      if (!Array.isArray(records)) return undefined
      let openTurn: number | undefined
      for (const record of records) {
        if (!isRecord(record) || record['type'] !== 'event') continue
        const event = record['event']
        if (!isRecord(event) || typeof event['type'] !== 'string') continue
        const data = isRecord(event['data']) ? event['data'] : {}
        if (event['type'] === 'turn/start' && typeof data['turn'] === 'number') openTurn = data['turn']
        else if (event['type'] === 'turn/end' && data['turn'] === openTurn) openTurn = undefined
      }
      controller.abort() // snapshot consumed — drop the stream now
      return openTurn !== undefined
    }
  } catch {
    return undefined
  } finally {
    controller.abort()
    clearTimeout(timer)
  }
}
/**
 * One session-plane RPC through the gateway: payload via `wireArgsOf`,
 * `{ok:false,error}` rethrown as a typed EnvelopeError (error body verbatim),
 * transport throws pass through untouched (they are already gateway/* typed).
 */
async function sessionRpc<T>(gateway: A2aGateway, endpoint: string, request: unknown): Promise<T> {
  const result: unknown = await gateway.dispatchRpc(endpoint, wireArgsOf(endpoint, request), freshSignal())
  if (!isRecord(result) || typeof result['ok'] !== 'boolean') {
    throw a2aError('a2a/bad-result', `a2a: ${endpoint} returned a non-envelope result`)
  }
  if (result['ok'] === true) return result['value'] as T
  const err = result['error']
  const wire: WireError = isRecord(err) && typeof err['code'] === 'string' && typeof err['message'] === 'string'
    ? { code: err['code'], message: err['message'], ...(err['details'] === undefined ? {} : { details: err['details'] }) }
    : { code: 'gateway/bad-response', message: `a2a: ${endpoint} rejected with a malformed error body` }
  throw new EnvelopeError(wire)
}

/** Text blocks of a message content array joined with '\n\n' ("" when none). */
function assistantTextOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const part of content) {
    if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') texts.push(part['text'])
  }
  return texts.join('\n\n')
}

/** Reducer state carried across frames AND across the one resubscribe (seq-ordered, fired-set deduped). */
interface FollowState {
  openTurn: number | undefined
  /** turn → last non-interrupted assistant text (+ its seq, higher seq wins). */
  lastText: Map<number, { text: string; seq: number }>
  armedSeen: boolean
  armedTurn: number | undefined
  fired: Set<number>
  /** Historical turn/end records (snapshot-replayed): turn → terminal `reason.kind`, read back at armed-history fire time. */
  completedHistorical: Map<number, string>
}

// ---------------------------------------------------------------- service

export function createA2aService(deps: A2aServiceDeps): A2aService {
  const now = deps.now ?? Date.now
  // D2 migration: re-mint degenerate shortIds at assembly — writes only when a
  // degenerate row exists; after the first pass the registry stays clean.
  migrateConversations(deps.home)
  const bufferByInitiator = new Map<string, A2aBufferedMessage[]>()

  const persist = (conversations: ConversationRow[]): void => {
    saveConversations(deps.home, { conversations })
  }

  const findRow = (conversationId: string): ConversationRow | undefined => {
    const rows = loadConversations(deps.home).conversations
    return rows.find((r) => r.shortId === conversationId || r.sessionId === conversationId)
  }

  /** Insert a row (idempotent per sessionId: re-seen session keeps its shortId). */
  const insertRow = (addr: A2aAddress, sessionId: string): ConversationRow => {
    const file = loadConversations(deps.home)
    const rows = file.conversations
    const prior = rows.find((r) => r.sessionId === sessionId)
    if (prior) return prior
    const row: ConversationRow = {
      shortId: shortIdFor(sessionId, rows),
      machine: addr.machine,
      agent: addr.id,
      sessionId,
      // NOTE: the title is deliberately NOT persisted here — it lands via
      // touchRow only after session/rename succeeds upstream.
      createdAt: now(),
      lastActivityAt: now(),
    }
    rows.push(row)
    persist(rows)
    return row
  }

  const touchRow = (row: ConversationRow, title?: string): void => {
    const rows = loadConversations(deps.home).conversations
    const idx = rows.findIndex((r) => r.sessionId === row.sessionId)
    if (idx === -1) return
    rows[idx] = { ...rows[idx], lastActivityAt: now(), ...(title === undefined ? {} : { title }) }
    persist(rows)
  }

  const service: A2aService = {
    async newConversation(addr, title) {
      const gateway = gatewayOrThrow(deps.gatewayFor, addr)
      const createRequest: SessionCreateRequestMirror = {}
      const created = await sessionRpc<{ sessionId: string }>(gateway, WIRE.sessionCreate, createRequest)
      if (!isRecord(created) || typeof created['sessionId'] !== 'string' || created['sessionId'] === '') {
        throw a2aError('a2a/bad-result', 'a2a: session/create returned no sessionId')
      }
      const row = insertRow(addr, created['sessionId'])
      if (title !== undefined && row.title !== title) {
        const renameRequest: SessionRenameRequestMirror = { sessionId: row.sessionId, title }
        // Row is already persisted: a rejected title leaves the conversation
        // addressable (untitled) rather than orphaned upstream. D1 hardening:
        // return the structured result with a warning instead of throwing —
        // the caller MUST learn the conversation's ids either way.
        try {
          await sessionRpc(gateway, WIRE.sessionTitle, renameRequest)
        } catch (error) {
          return { shortId: row.shortId, sessionId: row.sessionId, warning: `title not set: ${messageOf(error)}` }
        }
        touchRow(row, title)
        row.title = title
      }
      return { shortId: row.shortId, sessionId: row.sessionId }
    },

    async send(req, initiator) {
      const messageId = `a2a-${randomUUID()}`
      const fail = (error: A2aReceiptError, sessionId = '', conversationId?: string): A2aReceipt => ({
        outcome: 'failed',
        messageId,
        ...(conversationId === undefined ? {} : { conversationId }),
        sessionId,
        error,
      })

      let row: ConversationRow | undefined
      if (req.conversationId !== undefined) {
        row = findRow(req.conversationId)
        if (row === undefined) {
          return fail({
            code: 'a2a/conversation-not-found',
            message: `a2a: conversation "${req.conversationId}" is not in the registry — send without conversationId (creates one) or check the id`,
          })
        }
        if (row.machine !== req.to.machine || row.agent !== req.to.id) {
          return fail({
            code: 'a2a/conversation-machine-mismatch',
            message: `a2a: conversation "${row.shortId}" belongs to ${row.machine}-${row.agent}, not ${req.to.machine}-${req.to.id}`,
          }, row.sessionId, row.shortId)
        }
      }

      let gateway: A2aGateway | undefined
      try {
        gateway = deps.gatewayFor(req.to)
      } catch (error) {
        // D7: a typed address failure is the honest receipt; anything else the
        // resolver threw is still a failed receipt — send never throws (T2 contract).
        const body = error instanceof A2aAddressError ? addressErrorBody(error) : receiptErrorOf(error)
        return fail(body, row?.sessionId ?? '', row?.shortId)
      }
      if (gateway === undefined) {
        // legacy resolver spelling (no throw) — unreachable, honestly reported
        return fail({ code: 'a2a/gateway-unavailable', message: A2aAddressError.messageOf('unreachable', req.to) }, row?.sessionId ?? '', row?.shortId)
      }

      if (row === undefined) {
        // create path — no conversationId ≡ new conversation (title optional)
        try {
          const created = await sessionRpc<{ sessionId: string }>(gateway, WIRE.sessionCreate, {} as SessionCreateRequestMirror)
          if (!isRecord(created) || typeof created['sessionId'] !== 'string' || created['sessionId'] === '') {
            throw a2aError('a2a/bad-result', 'a2a: session/create returned no sessionId')
          }
          row = insertRow(req.to, created['sessionId'])
          if (req.title !== undefined && row.title !== req.title) {
            const renameRequest: SessionRenameRequestMirror = { sessionId: row.sessionId, title: req.title }
            try {
              await sessionRpc(gateway, WIRE.sessionTitle, renameRequest)
            } catch (error) {
              // D1 hardening: the failure happened during create (the prompt
              // has NOT gone out) — the receipt fails as today, but the orphan
              // session is addressable and its id rides in error details.
              const base = receiptErrorOf(error)
              throw a2aError(base.code, base.message, {
                ...(isRecord(base.details) ? base.details : {}),
                orphanSessionId: row.sessionId,
                conversationId: row.shortId,
              })
            }
            touchRow(row, req.title)
            row.title = req.title
          }
        } catch (error) {
          return fail(receiptErrorOf(error), row?.sessionId ?? '', row?.shortId)
        }
      }

      const promptRequest: SessionPromptRequestMirror = {
        requestId: messageId,
        sessionId: row.sessionId,
        mode: req.delivery ?? 'queue',
        content: [{
          type: 'text',
          text: renderA2aEnvelope({
            machine: initiator.machine,
            agent: initiator.agent,
            title: row.title,
            shortId: row.shortId,
            message: req.message,
          }),
        }],
      }
      try {
        // 'injected' on every successful submission ('queued' reserved — no busy-detection)
        await sessionRpc(gateway, WIRE.promptSubmit, promptRequest)
      } catch (error) {
        return fail(receiptErrorOf(error), row.sessionId, row.shortId)
      }
      touchRow(row)
      return { outcome: 'injected', messageId, conversationId: row.shortId, sessionId: row.sessionId }
    },

    subscribeCompletion(conv, cb, opts = {}) {
      const row = findRow(conv.conversationId)
      if (row === undefined) {
        opts.onError?.({
          code: 'a2a/conversation-not-found',
          message: `a2a: conversation "${conv.conversationId}" is not in the registry`,
        })
        return () => { }
      }
      if (row.machine !== conv.to.machine || row.agent !== conv.to.id) {
        opts.onError?.({
          code: 'a2a/conversation-machine-mismatch',
          message: `a2a: conversation "${row.shortId}" belongs to ${row.machine}-${row.agent}, not ${conv.to.machine}-${conv.to.id}`,
        })
        return () => { }
      }
      let gateway: A2aGateway | undefined
      try {
        gateway = deps.gatewayFor(conv.to)
      } catch (error) {
        const body = error instanceof A2aAddressError ? addressErrorBody(error) : receiptErrorOf(error)
        opts.onError?.(body)
        return () => { }
      }
      if (gateway === undefined) {
        opts.onError?.({ code: 'a2a/gateway-unavailable', message: A2aAddressError.messageOf('unreachable', conv.to) })
        return () => { }
      }

      const controller = new AbortController()
      const state: FollowState = {
        openTurn: undefined,
        lastText: new Map(),
        armedSeen: false,
        armedTurn: undefined,
        fired: new Set(),
        completedHistorical: new Map(),
      }
      let disposed = false
      const dispose = (): void => {
        disposed = true
        controller.abort()
      }

      const followRequest: SessionFollowRequestMirror = {
        address: { kind: 'session', sessionId: row.sessionId },
        assistantStream: true,
      }

      const fire = (turn: number, reason: string): void => {
        state.fired.add(turn)
        cb({
          conversationId: row.shortId,
          sessionId: row.sessionId,
          turn,
          reason,
          text: state.lastText.get(turn)?.text ?? '',
        })
        if (opts.requestId !== undefined) dispose()
      }

      const applyEvent = (event: unknown, live: boolean): void => {
        if (!isRecord(event) || typeof event['type'] !== 'string') return
        const seq = typeof event['seq'] === 'number' ? event['seq'] : Number.MAX_SAFE_INTEGER
        const data = isRecord(event['data']) ? event['data'] : {}
        switch (event['type']) {
          case 'turn/start':
            if (typeof data['turn'] === 'number') state.openTurn = data['turn']
            break
          case 'user/message': {
            const source = isRecord(data['source']) ? data['source'] : undefined
            if (opts.requestId !== undefined && !state.armedSeen && source?.['rpcId'] === opts.requestId) {
              state.armedSeen = true
              state.armedTurn = state.openTurn
            }
            break
          }
          case 'assistant/message': {
            if (data['interrupted'] === true) break // replaced attempt — the real settlement follows
            const turn = data['turn']
            if (typeof turn !== 'number') break
            const message = isRecord(data['message']) ? data['message'] : undefined
            const text = assistantTextOf(message?.['content'])
            const prior = state.lastText.get(turn)
            if (prior === undefined || seq >= prior.seq) state.lastText.set(turn, { text, seq })
            break
          }
          case 'turn/end': {
            const turn = data['turn']
            if (typeof turn !== 'number') break
            if (state.openTurn === turn) state.openTurn = undefined
            const reason = isRecord(data['reason']) && typeof data['reason']['kind'] === 'string'
              ? data['reason']['kind']
              : 'unknown'
            if (!live) {
              state.completedHistorical.set(turn, reason)
              break
            }
            const shouldFire = opts.requestId === undefined
              ? !state.fired.has(turn)
              : state.armedSeen && !state.fired.has(turn) && (state.armedTurn === undefined || state.armedTurn === turn)
            if (shouldFire) fire(turn, reason)
            break
          }
          default:
            break // merge-extensible event names are not ours to interpret
        }
      }

      /** After a snapshot: an armed request whose turn already completed in history fires from history (prompt-accepted-before-subscribe race). */
      const maybeFireFromHistory = (): void => {
        if (opts.requestId === undefined) return
        if (!state.armedSeen || state.armedTurn === undefined) return
        if (state.fired.has(state.armedTurn) || !state.completedHistorical.has(state.armedTurn)) return
        fire(state.armedTurn, state.completedHistorical.get(state.armedTurn) ?? 'unknown')
      }

      const handleFrame = (frame: unknown): void => {
        if (!isRecord(frame)) return
        if (frame['type'] === 'snapshot') {
          const records = frame['records']
          if (Array.isArray(records)) {
            for (const record of records) {
              if (isRecord(record) && record['type'] === 'event') applyEvent(record['event'], false)
            }
          }
          maybeFireFromHistory()
        } else if (frame['type'] === 'event') {
          applyEvent(frame['event'], true)
        }
        // 'assistant-stream' frames are live partials — final text is durable
      }

      const onDeath = (error: unknown, attempt: number): void => {
        if (disposed || controller.signal.aborted) return
        if (attempt === 0) {
          open(1) // exactly one resubscribe
          return
        }
        opts.onError?.({
          code: 'a2a/stream-dead',
          message: `a2a: completion stream for ${row.shortId} died twice — ${messageOf(error)}`,
        })
      }

      const open = (attempt: number): void => {
        let iterable: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
        try {
          iterable = gateway.openWireStream(WIRE.streamOpen, wireArgsOf(WIRE.streamOpen, followRequest), controller.signal)
        } catch (error) {
          onDeath(error, attempt)
          return
        }
        void (async () => {
          try {
            const stream = await iterable
            for await (const frame of stream) {
              if (disposed) return
              handleFrame(frame)
            }
            onDeath(new Error('stream ended'), attempt) // a live follow stream never ends while the session lives
          } catch (error) {
            onDeath(error, attempt)
          }
        })()
      }

      open(0)
      return dispose
    },

    async stop(conv, scope) {
      const row = findRow(conv.conversationId)
      if (row === undefined) {
        throw a2aError('a2a/conversation-not-found', `a2a: conversation "${conv.conversationId}" is not in the registry`)
      }
      if (row.machine !== conv.to.machine || row.agent !== conv.to.id) {
        throw a2aError('a2a/conversation-machine-mismatch', `a2a: conversation "${row.shortId}" belongs to ${row.machine}-${row.agent}, not ${conv.to.machine}-${conv.to.id}`)
      }
      const gateway = gatewayOrThrow(deps.gatewayFor, conv.to)
      // D5 honesty: read turn liveness BEFORE the cancel — a post-cancel
      // snapshot cannot distinguish "idle all along" from "we just aborted
      // it", so the pre-cancel state is the fact the result reports. The
      // cancel itself always fires (today's wire behavior); an undeterminable
      // read (dead stream, no snapshot, timeout) stays conservative: stopped.
      const live = await turnLivenessOf(gateway, row.sessionId)
      const cancelRequest: SessionCancelRequestMirror = { sessionId: row.sessionId }
      // Both scopes cancel the active turn; 'session' cannot go further —
      // upstream has no session-close RPC (WIRE.sessionClose === undefined).
      await sessionRpc(gateway, WIRE.turnCancel, cancelRequest)
      if (live === false) {
        if (scope === 'turn') return { scope: 'turn', cancelled: false, note: A2A_NO_TURN_ACTIVE_NOTE }
        return { scope: 'turn-only', cancelled: false, note: A2A_NO_TURN_ACTIVE_NOTE, reason: A2A_NO_SESSION_CLOSE_REASON }
      }
      if (scope === 'turn') return { scope: 'turn', cancelled: true }
      return { scope: 'turn-only', cancelled: true, reason: A2A_NO_SESSION_CLOSE_REASON }
    },

    buffer(initiatorSessionId, message) {
      const list = bufferByInitiator.get(initiatorSessionId) ?? []
      list.push({ ...message, initiatorSessionId, bufferedAt: now() })
      while (list.length > A2A_BUFFER_MAX) list.shift()
      bufferByInitiator.set(initiatorSessionId, list)
    },

    read(initiatorSessionId) {
      if (initiatorSessionId !== undefined) {
        const list = bufferByInitiator.get(initiatorSessionId) ?? []
        bufferByInitiator.delete(initiatorSessionId)
        return list
      }
      const swept: A2aBufferedMessage[] = []
      for (const list of bufferByInitiator.values()) swept.push(...list)
      bufferByInitiator.clear()
      return swept
    },

    listConversations() {
      return loadConversations(deps.home).conversations.map((r) => ({ ...r }))
    },
  }
  return service
}
