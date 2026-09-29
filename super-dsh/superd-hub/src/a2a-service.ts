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
import { A2aAddressError, A2A_TITLE_PLACEHOLDER, A2A_NOTICE_SUMMARY_MAX, normalizeA2aTitle, postA2aEnvelope, a2aAddressOf } from './a2a-wire.js'
import type {
  A2aEnvelope,
  A2aMessageEnvelope,
  A2aNewConversationEnvelope,
  A2aStopEnvelope,
  A2aStopReceipt,
  A2aWireOrigin,
  A2aWireReceipt,
  A2aNoticeEnvelope,
} from './a2a-wire.js'
// R4: the ingest leg — TYPE-ONLY (the instance is injected; no runtime cycle).
import type { A2aIngest } from './a2a-ingest.js'
import type { A2aDeliveryOutcome } from './a2a-delivery.js'
import { ensureSelf, listRemotes, mintShortId as mintMachineId } from './machines.js'
import { cookieOf } from './mesh-link.js'
import type { A2aLogFn } from './a2a-log.js'
import { WIRE, type SessionFollowRequestMirror, wireArgsOf } from './wire-endpoints.js'
// compat re-export (postoffice R1): the class moved to the protocol layer
// (a2a-wire.ts) so the wire helpers can classify with it; every existing
// consumer importing it from this module keeps compiling unchanged.
export { A2aAddressError }

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
  /**
   * R4 amendment (2026-09-28 review): present ONLY on MIRROR rows (the peer
   * hosted the conversation here) = the LOCAL a6 hosting the session.
   * Presence identifies the row as locally-hosted and routes continuations
   * to our own ingest. Absent = initiator-row semantics (the session lives
   * at {machine, agent}). Additive optional; no migration.
   */
  hostAgent?: string
  /**
   * The initiator identity's full session id — the peer→initiator asynchronous
   * delivery address. R4: persisted at create/first-send on INITIATOR rows.
   * 0.1.7-i: MIRROR rows persist it at adoption too (the opener's session
   * from the envelope) — the send-failed notice must address the original
   * initiator even when the write-back dies before the initiator-side ingest
   * ever learned the conversation. Additive; absent = pre-R4 rows / not yet
   * sent.
   */
  initiatorSession?: string
  /**
   * D20 (2026-09-29): present ONLY on MIRROR rows = the hosted peer has sent
   * through the channel at least once in this conversation. Monotonic per
   * conversation — once set, the completion watch NEVER transcribes again
   * (the channel reply IS the reply; unsent turn-end output is the peer's
   * own business). Additive optional; no migration.
   */
  channelUsed?: true
  /** D20: epoch ms of the peer's LAST channel send on this row — the watermark the completion watch compares against its arm time to detect "sent during this turn's window" (suppresses the artifact when the send already was it). */
  lastSentAt?: number
  /**
   * 0.1.7-h R2: epoch ms when a stop envelope cancelled a LIVE turn here.
   * The completion watch compares it against its arm watermark — a turn that
   * ends because the INITIATOR stopped it must surface as
   * reason=stopped-by-initiator, not as the peer going silent. Additive
   * optional; no migration.
   */
  stoppedAt?: number
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
    (r.hostAgent === undefined || typeof r.hostAgent === 'string') &&
    (r.initiatorSession === undefined || typeof r.initiatorSession === 'string') &&
    (r.channelUsed === undefined || r.channelUsed === true) &&
    (r.lastSentAt === undefined || typeof r.lastSentAt === 'number') &&
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
 * THE teaching envelope — one template constant (D20 v3, 2026-09-29: the
 * SINGLE merged text, no variants). Filled with the INITIATOR's identity
 * (machine-agent address = the write-back target), the conversation title,
 * the body, and the shortId a superd-hub tool addresses. Tail = the user's
 * 2026-09-29 redline, four short paragraphs, each carrying one load:
 * provenance + channel-only principle / heterogeneity disclosure (tool
 * availability genuinely differs per runtime — this is what stops a
 * tool-less model from hunting for one) / how+when to send (sending does
 * not end the turn) / the fallback, phrased from the RECEIVER's operational
 * truth ("the hub receive no hub message" — intentionally or prevented;
 * wording per user ruling 0.1.7-h: the receiver is the hub, the message
 * class is a hub message). The "if available" conditional is evaluated by
 * the MODEL against its own tool
 * list; never pre-select variants on unknowable runtime state. Never a
 * separate user prompt (the OMP 20-tool-call incident).
 */
export const A2A_MESSAGE_TEMPLATE =
  'A2A message from {machine}-{agent} (conversation "{title}"):\n\n{message}\n\nThis conversation is initiated through superd-hub by the sender. The sender sees only what arrives through this conversation.\n\nAs superd-hub hosts various kinds of agent runtimes, integration into each runtime and superd-hub tool availability in each runtime session might differ.\n\nTo reply, send a message back: with a superd-hub tool, if available, {action:"send", agent:"{machine}-{agent}", conversationId:"{shortId}", message:"…"}. You can send at any point, more than once — sending does not end your turn.\n\nIf the hub receive no hub message from you (intentionally or whatever situation prevents so), your last output at this turn\'s end is delivered to the sender as your reply.'

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
  const title = fields.title === undefined || fields.title === '' || fields.title === A2A_TITLE_PLACEHOLDER ? A2A_UNTITLED : fields.title
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

/**
 * R4: the fixed opening line a message-less newConversation carries on its
 * envelope — the wire envelope requires a message, and the peer's teaching
 * envelope (which wraps this) IS the conversation opener the spec describes.
 */
export const A2A_OPENING_MESSAGE = '(conversation opened)'

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
export type A2aReceiptOutcome = 'injected' | 'queued' | 'pending' | 'failed'

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
  /** Still the LOCAL leg's resolver (subscribeCompletion + the ingest assembly source); the send/stop paths never resolve a REMOTE gateway since R4 — remote routing is envelope-wire only. */
  gatewayFor(addr: A2aAddress): A2aGateway
  /**
   * R4: the ingest handler shared with the HTTP endpoint — the self-routing
   * leg. LAZY (resolved at send time, never construction time: the ingest's
   * delivery face buffers through THIS service's buffer leg, so the instance
   * can only exist after the service does).
   */
  ingest?(): A2aIngest | undefined
  /** R4: fetch override for the remote wire leg (tests inject fixtures). */
  fetchImpl?: typeof fetch
  /** Operational journal (0.1.7-b): one greppable line per machine event; the cordis host wires it onto ctx.logger, tests inject a collector. */
  log?: A2aLogFn
  now?(): number
}

export interface A2aService {
  /** Create a conversation on the target (session/create ONLY — D17/R2: no session/rename write-through); title is hub-owned registry state (stored normalized, immutable). Typed errors on 401/unreachable/business rejection. The vestigial `warning?` return field stays for signature stability and is never set. */
  newConversation(addr: A2aAddress, title?: string, message?: string, initiator?: A2aInitiator): Promise<{ shortId: string; sessionId: string; warning?: string }>
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
export function addressErrorBody(error: A2aAddressError): { code: string; message: string } {
  return { code: error.kind === 'unreachable' ? 'a2a/gateway-unavailable' : `a2a/${error.kind}`, message: error.message }
}

/** (gatewayOrThrow retired in R4 — the send/stop paths route envelopes; the
 * local resolver is consumed by subscribeCompletion and the ingest assembly.) */
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
export async function turnLivenessOf(gateway: A2aGateway, sessionId: string): Promise<boolean | undefined> {
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
export async function sessionRpc<T>(gateway: A2aGateway, endpoint: string, request: unknown): Promise<T> {
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

/** A directly-addressed session to watch — the ingest leg (postoffice R3)
 * subscribes the LOCAL gateway without the initiator-side registry checks. */
export interface A2aSessionSource {
  /** The session-plane gateway owning the session (local leg on the ingest side). */
  gateway: A2aGateway
  /** The session to follow. */
  sessionId: string
  /** Conversation id reported in fired completions (the registry shortId). */
  conversationId: string
}

/**
 * The completion watcher behind `subscribeCompletion` (extracted verbatim in
 * postoffice R3): one follow stream over the addressed session, turn-text
 * reduction, requestId arming, one resubscribe, snapshot-history fire.
 * Same contract as the service method — every fired completion is one cb,
 * armed subscriptions auto-dispose after their turn fires.
 */
export function subscribeSessionCompletion(
  source: A2aSessionSource,
  cb: A2aCompletionCb,
  opts: A2aSubscribeOptions = {},
): () => void {
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
    address: { kind: 'session', sessionId: source.sessionId },
    assistantStream: true,
  }

  const fire = (turn: number, reason: string): void => {
    state.fired.add(turn)
    cb({
      conversationId: source.conversationId,
      sessionId: source.sessionId,
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
        const sourceRec = isRecord(data['source']) ? data['source'] : undefined
        if (opts.requestId !== undefined && !state.armedSeen && sourceRec?.['rpcId'] === opts.requestId) {
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
      message: `a2a: completion stream for ${source.conversationId} died twice — ${messageOf(error)}`,
    })
  }

  const open = (attempt: number): void => {
    let iterable: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
    try {
      iterable = source.gateway.openWireStream(WIRE.streamOpen, wireArgsOf(WIRE.streamOpen, followRequest), controller.signal)
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
}

// ---------------------------------------------------------------- service

export function createA2aService(deps: A2aServiceDeps): A2aService {
  const now = deps.now ?? Date.now
  const alog = deps.log
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

  /**
   * R4: record the INITIATOR row for a conversation the envelope routing
   * just created/receipted. One row per conversation: a row already bound to
   * the shortId (the mirror row a SELF-hosted conversation adopted on our
   * own ingest) covers the id — never a duplicate. Title normalized at mint
   * (D17); the initiator's session id is persisted for peer write-backs.
   */
  const recordInitiatorRow = (shortId: string, to: A2aAddress, sessionId: string, title: string, initiator: A2aInitiator): void => {
    const rows = loadConversations(deps.home).conversations
    // D20 self-route: the single MIRROR row (hostAgent set, initiator local)
    // IS the initiator row too — backfill the write-back address instead of
    // returning (a cross-machine mirror row never reaches here: its
    // conversation was initiated on the peer's hub, not ours).
    const existing = rows.find((r) => r.shortId === shortId || r.sessionId === sessionId)
    if (existing !== undefined) {
      if (existing.hostAgent !== undefined && existing.machine === selfM4() && existing.initiatorSession === undefined) {
        persist(rows.map((r) => (r.sessionId === existing.sessionId ? { ...r, initiatorSession: initiator.sessionId } : r)))
      }
      return
    }
    rows.push({
      shortId,
      machine: to.machine,
      agent: to.id,
      sessionId,
      title,
      initiatorSession: initiator.sessionId,
      createdAt: now(),
      lastActivityAt: now(),
    })
    persist(rows)
  }

  /** Bump the activity stamp; optionally backfill the initiator session on INITIATOR rows and self-route MIRROR rows (never on cross-machine mirror rows). */
  const touchRow = (row: ConversationRow, initiatorSession?: string): void => {
    const rows = loadConversations(deps.home).conversations
    const idx = rows.findIndex((r) => r.sessionId === row.sessionId)
    if (idx === -1) return
    // D17: only the activity stamp moves — a later write path never touches title.
    const backfill = initiatorSession !== undefined &&
      (rows[idx].hostAgent === undefined || rows[idx].machine === selfM4())
    rows[idx] = {
      ...rows[idx],
      lastActivityAt: now(),
      ...(backfill ? { initiatorSession } : {}),
    }
    persist(rows)
  }

  const selfM4 = (): string => ensureSelf(deps.home, 'local').id

  /** D20: mark the hosted peer as channel-capable for this conversation — monotonic latch + send watermark. */
  const markChannelUsed = (row: ConversationRow): void => {
    const rows = loadConversations(deps.home).conversations
    const idx = rows.findIndex((r) => r.sessionId === row.sessionId)
    if (idx === -1) return
    rows[idx] = { ...rows[idx], channelUsed: true, lastSentAt: now() }
    persist(rows)
  }

  /** Mint a fresh conversation id — random 6 over [a-z0-9], collision-checked against our registry (the initiator mints; the peer adopts verbatim). */
  const mintConversationId = (): string =>
    mintMachineId(6, loadConversations(deps.home).conversations.map((r) => r.shortId))

  /** The wire `from` of one initiator identity (full-length session id, D6). */
  const originOf = (initiator: A2aInitiator): A2aWireOrigin =>
    ({ machine: initiator.machine, agent: initiator.agent, sessionId: initiator.sessionId })

  /** What an envelope's routing answers: a send/stop receipt, or (additive) a delivery outcome. */
  type IngestAnswer = A2aWireReceipt | A2aDeliveryOutcome

  /**
   * R4 THE ROUTER: one envelope, two legs — target machine === self → the
   * SAME ingest handler the HTTP endpoint calls (in-process short-circuit;
   * protocol-identical by construction); a paired remote → wire POST with
   * its cookie riding along. Unpaired → the typed unknown-machine failure.
   */
  const routeEnvelope = async (envelope: A2aEnvelope): Promise<IngestAnswer> => {
    const target = a2aAddressOf(envelope)
    if (target.machine === selfM4()) {
      const ingest = deps.ingest?.()
      if (ingest === undefined) {
        throw a2aError('a2a/no-ingest', `a2a: envelope for ${target.machine}-${target.id} addresses THIS machine but no ingest is wired (post-office assembly incomplete)`)
      }
      return ingest.ingest(envelope)
    }
    const machine = listRemotes(deps.home).find((r) => r.id === target.machine)
    if (machine === undefined) {
      throw new A2aAddressError('unknown-machine', target)
    }
    return postA2aEnvelope(machine.origin, envelope, {
      cookie: cookieOf(machine.id, deps.home),
      fetchImpl: deps.fetchImpl,
    })
  }

  /** Map one wire stop receipt back onto the typed result (canonical constants; the ingest emits exactly these). */
  const mapStopReceipt = (receipt: A2aStopReceipt): A2aStopResult => {
    if (receipt.scope === 'turn') {
      return receipt.stopped
        ? { scope: 'turn', cancelled: true }
        : { scope: 'turn', cancelled: false, note: A2A_NO_TURN_ACTIVE_NOTE }
    }
    return receipt.stopped
      ? { scope: 'turn-only', cancelled: true, reason: A2A_NO_SESSION_CLOSE_REASON }
      : { scope: 'turn-only', cancelled: false, note: A2A_NO_TURN_ACTIVE_NOTE, reason: A2A_NO_SESSION_CLOSE_REASON }
  }



  const service: A2aService = {
    async newConversation(addr, title, message, initiator) {
      // R4: an envelope IS the unit — a message-less create carries the fixed
      // opening line (the teaching envelope wraps it on the peer's session).
      // D21: a message-bearing create folds opening + content into ONE turn
      // (the bare-opening turn that peers burned steps investigating is gone).
      if (initiator === undefined) {
        throw a2aError('a2a/no-initiator', 'a2a: newConversation needs the initiator identity to address the envelope (postoffice R4)')
      }
      const messageId = `a2a-${randomUUID()}`
      const envelope: A2aNewConversationEnvelope = {
        kind: 'new-conversation',
        to: { machine: addr.machine, id: addr.id },
        conversationId: mintConversationId(),
        title: normalizeA2aTitle(title),
        message: message === undefined || message === '' ? A2A_OPENING_MESSAGE : message,
        from: originOf(initiator),
        messageId,
      }
      let answer: IngestAnswer
      try {
        answer = await routeEnvelope(envelope)
      } catch (error) {
        if (error instanceof EnvelopeError) throw error
        if (error instanceof A2aAddressError) {
          const body = addressErrorBody(error)
          throw a2aError(body.code, body.message)
        }
        throw a2aError('gateway/uncaught', messageOf(error))
      }
      if (!('outcome' in answer)) {
        throw a2aError('a2a/bad-result', 'a2a: new-conversation envelope answered a non-receipt')
      }
      if (answer.outcome !== 'injected') {
        const err = answer.error ?? { code: 'a2a/remote-failed', message: 'a2a: the peer ingest rejected the envelope without an error body' }
        throw a2aError(err.code, err.message, err.details)
      }
      const shortId = answer.conversationId ?? envelope.conversationId
      // D17: title stored normalized at mint, immutable; zero rename calls
      // (the write-through is gone). The vestigial `warning` stays for
      // signature stability and is never set.
      recordInitiatorRow(shortId, addr, answer.sessionId, normalizeA2aTitle(title), initiator)
      alog?.('info', 'conversation.new', { conversation: shortId, session: answer.sessionId, peer: `${addr.machine}-${addr.id}`, initiator: `${initiator.machine}-${initiator.agent}` })
      return { shortId, sessionId: answer.sessionId }
    },

    async send(req, initiator) {
      const messageId = `a2a-${randomUUID()}`
      const fail = (error: A2aReceiptError, sessionId = '', conversationId?: string): A2aReceipt => {
        alog?.('warn', 'send.fail', { code: error.code, conversation: conversationId, message: messageId })
        return {
          outcome: 'failed',
          messageId,
          ...(conversationId === undefined ? {} : { conversationId }),
          sessionId,
          error,
        }
      }

      let row: ConversationRow | undefined
      if (req.conversationId !== undefined) {
        row = findRow(req.conversationId)
        if (row === undefined) {
          return fail({
            code: 'a2a/conversation-not-found',
            message: `a2a: conversation "${req.conversationId}" is not in the registry — send without conversationId (creates one) or check the id`,
          })
        }
        // Address consistency by row kind (R4 continuation routing):
        // mirror rows (hostAgent) are hosted HERE and addressed as
        // {self, hostAgent}; initiator rows keep today's peer-address check.
        // D20 WRITE-BACK exception: on a mirror row, addressing the row's
        // {machine, agent} (the INITIATOR) is the hosted peer using its
        // channel — the teaching envelope's reply clause. It routes to the
        // initiator's hub (write-back delivery there), and it SETS THE LATCH:
        // from this send on, the completion watch never transcribes again.
        const expected = row.hostAgent !== undefined
          ? { machine: selfM4(), id: row.hostAgent }
          : { machine: row.machine, id: row.agent }
        const writeBack = row.hostAgent !== undefined &&
          req.to.machine === row.machine && req.to.id === row.agent
        if (!writeBack && (req.to.machine !== expected.machine || req.to.id !== expected.id)) {
          return fail({
            code: 'a2a/conversation-machine-mismatch',
            message: `a2a: conversation "${row.shortId}" belongs to ${expected.machine}-${expected.id}, not ${req.to.machine}-${req.to.id}`,
          }, row.sessionId, row.shortId)
        }
        if (writeBack) {
          // The latch is the runtime TRUTH about the peer (it chose the
          // channel), set before routing so the completion watch can never
          // race it; a routing failure parks/retries without un-latching.
          markChannelUsed(row)
          alog?.('info', 'send.channel', { conversation: row.shortId, from: `${selfM4()}-${row.hostAgent}`, latch: true })
        }
      }

      // Build the envelope: create mints the conversation id (initiator-side,
      // random 6); continuation routes by row kind — mirror rows to OUR OWN
      // ingest (the conversation is hosted here), initiator rows to the
      // machine/agent the row points at.
      const from = originOf(initiator)
      let envelope: A2aNewConversationEnvelope | A2aMessageEnvelope
      // hoisted for the failed-receipt leg below: a failed WRITE-BACK must
      // still reach the original initiator (0.1.7-h R2 send-failed notice).
      let writeBackOrigin: A2aWireOrigin | undefined
      if (row === undefined) {
        envelope = {
          kind: 'new-conversation',
          to: { machine: req.to.machine, id: req.to.id },
          conversationId: mintConversationId(),
          title: normalizeA2aTitle(req.title),
          message: req.message,
          from,
          messageId,
          ...(req.delivery === undefined ? {} : { delivery: req.delivery }),
        }
      } else {
        const writeBack = row.hostAgent !== undefined &&
          req.to.machine === row.machine && req.to.id === row.agent
        // D20: a write-back's `from` is the HOSTED PEER itself (its own
        // session on this row) — the initiator-side ingest attributes the
        // reply from this origin, and the self-route ingest recognizes the
        // shape (from.agent === row.hostAgent) to deliver, never inject.
        const peerOrigin: A2aWireOrigin | undefined = writeBack && row.hostAgent !== undefined
          ? { machine: selfM4(), agent: row.hostAgent, sessionId: row.sessionId }
          : undefined
        writeBackOrigin = peerOrigin
        const to = peerOrigin !== undefined
          ? { machine: row.machine, id: row.agent }
          : row.hostAgent !== undefined
            ? { machine: selfM4(), id: row.hostAgent }
            : { machine: row.machine, id: row.agent }
        envelope = {
          kind: 'message',
          to,
          conversationId: row.shortId,
          message: req.message,
          from: peerOrigin ?? from,
          messageId,
          ...(req.delivery === undefined ? {} : { delivery: req.delivery }),
        }
      }

      let answer: IngestAnswer
      try {
        answer = await routeEnvelope(envelope)
      } catch (error) {
        // D7 layering preserved: typed address failures (unknown-machine,
        // unreachable transport) and wire faults land as failed receipts —
        // send never throws.
        const body = error instanceof A2aAddressError ? addressErrorBody(error) : receiptErrorOf(error)
        return fail(body, row?.sessionId ?? '', row?.shortId)
      }
      if (!('outcome' in answer)) {
        return fail({ code: 'a2a/bad-result', message: 'a2a: envelope routed but the answer was not a send receipt' }, row?.sessionId ?? '', row?.shortId ?? envelope.conversationId)
      }
      if (answer.outcome !== 'injected') {
        // D1 hardening: a failed receipt that still carries the peer's session
        // and conversation ids keeps the row addressable — retries resume.
        if (row === undefined && answer.sessionId !== '' && answer.conversationId !== undefined && answer.conversationId !== '') {
          recordInitiatorRow(answer.conversationId, req.to, answer.sessionId, normalizeA2aTitle(req.title), initiator)
        }
        alog?.('warn', 'send.fail', { code: (answer.error ?? { code: 'a2a/remote-failed' }).code, conversation: answer.conversationId ?? row?.shortId, message: messageId })
        // 0.1.7-h R2 live finding (r2e2eh probe): a FAILED write-back still
        // bumps the row's send watermark (markChannelUsed ran at send time),
        // so the peer's completion watch goes quiet — the turn's only artifact
        // was lost and the original initiator never heard a word. The taxonomy
        // reserved 'send-failed' for exactly this: mint the notice and route it
        // to the original initiator (notices deliver without a registry row —
        // deliverLocal keys off envelope.to alone; deliverNotice re-bounds the
        // summary). Fire-and-forget: the caller still gets its failed receipt;
        // parked sends stay silent (a parked envelope is pending, not failed —
        // it delivers on retry).
        if (writeBackOrigin !== undefined && row?.initiatorSession !== undefined && row.initiatorSession !== '') {
          const notice: A2aNoticeEnvelope = {
            kind: 'notice',
            to: { machine: row.machine, agent: row.agent, sessionId: row.initiatorSession },
            conversation: row.shortId,
            // answer.error is the WIRE error shape {code, message} — messageOf it and it stringifies as [object Object].
            // Bound at MINT time: the receiving side's strict guard 400s an
            // over-max summary (0.1.7-l live finding — the long ingest error
            // message blew the 120 bound and the notice died as 'unreachable').
            summary: (() => {
              const raw = `conversation ${row.shortId}: the peer's reply could not be delivered — ${answer.error?.message ?? 'unknown error'}`
              return raw.length > A2A_NOTICE_SUMMARY_MAX ? raw.slice(0, A2A_NOTICE_SUMMARY_MAX - 1) + '…' : raw
            })(),
            messageId: `a2a-notice-${randomUUID()}`,
            sender: { machine: selfM4(), agent: row.hostAgent ?? row.agent },
            reason: 'send-failed',
          }
          // 0.1.7-i live lesson: a swallowed emission failure reads as "no notice"
          // downstream — journal it (the r2e2ej probe chased a silent strict-guard
          // rejection for a round because of this exact swallow).
          void routeEnvelope(notice).catch((error: unknown) => {
            alog?.('warn', 'send.notice-fail', { conversation: row.shortId, error: messageOf(error) })
          })
        }
        return {
          outcome: 'failed',
          messageId,
          ...(answer.conversationId === undefined ? {} : { conversationId: answer.conversationId }),
          sessionId: answer.sessionId,
          error: answer.error ?? { code: 'a2a/remote-failed', message: 'a2a: the peer ingest rejected the envelope without an error body' },
        }
      }
      const conversationId = answer.conversationId ?? envelope.conversationId
      if (row === undefined) {
        // SELF-hosted creates already adopted the mirror row on our ingest —
        // recordInitiatorRow never duplicates; remote creates record ours.
        recordInitiatorRow(conversationId, req.to, answer.sessionId, normalizeA2aTitle(req.title), initiator)
      } else {
        touchRow(row, row.hostAgent === undefined ? initiator.sessionId : undefined)
      }
      alog?.('info', 'send.ok', { conversation: conversationId, to: `${envelope.to.machine}-${envelope.to.id}`, message: messageId })
      return { outcome: 'injected', messageId, conversationId, sessionId: answer.sessionId }
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

      // The watcher itself is the shared session-plane primitive (postoffice
      // R3): the ingest leg subscribes the same machinery against the LOCAL
      // gateway without the initiator-side registry checks.
      return subscribeSessionCompletion({ gateway, sessionId: row.sessionId, conversationId: row.shortId }, cb, opts)
    },

    async stop(conv, scope) {
      const row = findRow(conv.conversationId)
      if (row === undefined) {
        throw a2aError('a2a/conversation-not-found', `a2a: conversation "${conv.conversationId}" is not in the registry`)
      }
      const expected = row.hostAgent !== undefined
        ? { machine: selfM4(), id: row.hostAgent }
        : { machine: row.machine, id: row.agent }
      if (conv.to.machine !== expected.machine || conv.to.id !== expected.id) {
        throw a2aError('a2a/conversation-machine-mismatch', `a2a: conversation "${row.shortId}" belongs to ${expected.machine}-${expected.id}, not ${conv.to.machine}-${conv.to.id}`)
      }
      // R4: the cancel executes where the session lives — the D5 liveness
      // read, the cancel, and the session-scope degradation are all the
      // INGEST side's business now (same machine as the session).
      const envelope: A2aStopEnvelope = { kind: 'stop', to: expected, conversationId: row.shortId, scope }
      let answer: IngestAnswer
      try {
        answer = await routeEnvelope(envelope)
      } catch (error) {
        if (error instanceof EnvelopeError) throw error
        if (error instanceof A2aAddressError) {
          const body = addressErrorBody(error)
          throw a2aError(body.code, body.message)
        }
        throw a2aError('gateway/uncaught', messageOf(error))
      }
      if (!('stopped' in answer)) {
        throw a2aError('a2a/bad-result', 'a2a: stop envelope answered a non-receipt')
      }
      return mapStopReceipt(answer)
    },

    buffer(initiatorSessionId, message) {
      const list = bufferByInitiator.get(initiatorSessionId) ?? []
      list.push({ ...message, initiatorSessionId, bufferedAt: now() })
      while (list.length > A2A_BUFFER_MAX) list.shift()
      bufferByInitiator.set(initiatorSessionId, list)
      alog?.('info', 'deliver.buffer', { session: initiatorSessionId, conversation: message.conversationId, depth: list.length })
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
