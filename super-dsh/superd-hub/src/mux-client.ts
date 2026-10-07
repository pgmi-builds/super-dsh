/**
 * Remote stream mux CLIENT half (machine-mesh P2 Task 1) — the wire-protocol
 * peer of {@link WorldMuxServer} in `world-mux.ts`, speaking toward a remote
 * hub's `/hub/api/remote.mux`.
 *
 * The wire contract is the one `world-mux.ts` documents (mirroring upstream
 * dsh 0.1.7 `stream-protocol.ts`), frames as JSON text:
 *
 *   client → server   { type:'open', streamId, endpoint, payload }
 *                      { type:'item', streamId, value? }   (uplink)
 *                      { type:'end', streamId }            (uplink half-close)
 *                      { type:'cancel', streamId }
 *                      { type:'pong' }                     (control reply)
 *   server → client   { type:'item', streamId, value }
 *                      { type:'end', streamId }
 *                      { type:'error', streamId, error:{code,message,details} }
 *                      { type:'ping' }                     (control probe)
 *
 * Client-half rulings, each pinned by `test/mux-client.test.mjs`:
 *  - **Ids**: the client owns a monotonic NUMBER counter (the exported
 *    `MuxClientFrame` keeps that numeric space, as the Task-1 brief pins it),
 *    but the WIRE carries `String(streamId)` — both `parseClientMessage` and
 *    upstream's parser accept only non-empty string ids (`validId`).
 *  - **Heartbeat**: a JSON `{type:'ping'}` frame is answered with
 *    `{type:'pong'}` immediately. Liveness is decided by RECEIVED frames: any
 *    frame resets a silence watchdog; 2 heartbeat periods with no frames →
 *    the client closes the socket and fails every live stream. (The server's
 *    own heartbeat is ws-level ping/pong and never surfaces here.)
 *  - **Late frames**: `item`/`end`/`error` for a streamId the client no
 *    longer owns are silently dropped.
 *  - **Protocol violations**: an out-of-protocol server frame (unknown type,
 *    malformed JSON, bad shape — including a server-sent `open`) closes the
 *    socket, mirroring the server's 1008 policy.
 *  - **Error delivery** (the brief allowed a `{muxError}` tail item OR a
 *    throw; this pins THROW): a server `error` frame drains already-received
 *    items, then makes `items` throw {@link MuxClientError} carrying the wire
 *    failure `{code,message,details}`. Local cuts (socket close, silence,
 *    dispose) drop queued items and throw a local-code error — Task 2 maps
 *    every cut to "in-flight stream ends with a wire error".
 *  - **Uplink backpressure**: `upstream` is a live channel iterable — one
 *    read of its iterator (`await it.next(value)`) synchronously sends ONE
 *    `item` frame and nothing is ever queued ("read one, send one"); `end()`
 *    half-closes (idempotent); `cancel()` retires the whole stream locally.
 *
 * PURE protocol module: the socket is injected ({@link MuxClientSocket}, the
 * seam Task 2 wires to `ws`); no `ws` import, no node imports at all.
 */
import type { MuxFailure } from './world-mux.js'

/** Every client→server stream frame (control replies like `pong` excluded). */
export type MuxClientFrame =
  | { type: 'open'; streamId: number; endpoint: string; payload: unknown }
  | { type: 'item'; streamId: number; value?: unknown }
  | { type: 'end'; streamId: number }
  | { type: 'cancel'; streamId: number }

/** The injected text-socket seam (Task 2 adapts `ws` to this shape). */
export interface MuxClientSocket {
  send(data: string): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: () => void): void
  close(): void
}

/** The frozen openStream handle (Task 2 builds on this exact shape). */
export interface MuxStreamHandle {
  /** Server items until `end`/`error`/socket close (see the header rulings). */
  items: AsyncIterable<unknown>
  /** Uplink channel: one `next(value)` read = one item frame, zero buffering. */
  upstream: AsyncIterable<unknown>
  /** Uplink half-close: sends `{type:'end'}` once; downlink stays live. */
  end(): void
  /** Cancel the logical stream: one `{type:'cancel'}` frame, local retirement. */
  cancel(): void
}

/** Options. */
export interface MuxClientOptions {
  /** Server ping cadence used for the silence window (2 × this); upstream default 2s. */
  heartbeatIntervalMs?: number
}

/** A stream/transport failure carrying wire failure fields (or a local cut code). */
export class MuxClientError extends Error {
  readonly code: string
  readonly details: object
  constructor(code: string, message: string, details: object = {}) {
    super(message)
    this.name = 'MuxClientError'
    this.code = code
    this.details = details
  }
}

const DEFAULT_HEARTBEAT_MS = 2_000
const MAX_SILENT_PERIODS = 2
const DONE: IteratorResult<unknown> = { value: undefined, done: true }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** One logical stream's client-side state. */
interface ClientStream {
  readonly downlink: DownlinkQueue
  /** Uplink half-closed locally (`end` sent). */
  ended: boolean
  /** Fully out of the table: server end/error, cancel, or teardown. Late frames drop. */
  retired: boolean
}

/**
 * Downlink lane of one stream: server items until a terminal frame or a local
 * cut. Mirrors the upstream client's `StreamInbox` semantics — a wire `error`
 * drains queued items first and then throws; local cuts drop the queue.
 */
class DownlinkQueue implements AsyncIterable<unknown> {
  private readonly queue: unknown[] = []
  private failure: MuxClientError | undefined
  private thrown = false
  private done = false
  private readonly waiters: Array<() => void> = []

  push(value: unknown): void {
    if (this.done || this.failure !== undefined) return
    this.queue.push(value)
    this.signal()
  }

  /** Terminal server `end` frame: queued items drain, then the iterable finishes. */
  settleEnd(): void {
    if (this.done || this.failure !== undefined) return
    this.done = true
    this.signal()
  }

  /** Server `error` frame: queued items drain, then the iterable throws it. */
  settleFailure(error: MuxClientError): void {
    if (this.done || this.failure !== undefined) return
    this.failure = error
    this.signal()
  }

  /** Local cancellation: queued items are dropped, the iterable finishes. */
  abort(): void {
    if (this.done || this.failure !== undefined) return
    this.queue.length = 0
    this.done = true
    this.signal()
  }

  /** Local cut (socket close, silence, dispose): drop the queue, throw now. */
  fail(error: MuxClientError): void {
    if (this.failure !== undefined) return
    this.queue.length = 0
    this.done = true
    this.failure = error
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this
  }

  async next(): Promise<IteratorResult<unknown>> {
    while (true) {
      if (this.queue.length > 0) return { value: this.queue.shift(), done: false }
      if (this.failure !== undefined && !this.thrown) {
        this.thrown = true
        throw this.failure
      }
      if (this.done || this.thrown) return DONE
      await new Promise<void>((resolve) => { this.waiters.push(resolve) })
    }
  }

  private signal(): void {
    const waiters = [...this.waiters]
    this.waiters.length = 0
    for (const wake of waiters) wake()
  }
}

/** The mux client half: pure protocol, socket injected. */
export class MuxClient {
  private readonly socket: MuxClientSocket
  private readonly heartbeatIntervalMs: number
  private nextId = 1
  private readonly streams = new Map<string, ClientStream>()
  private state: 'open' | 'closed' = 'open'
  private watchdog: ReturnType<typeof setTimeout> | undefined

  constructor(socket: MuxClientSocket, options: MuxClientOptions = {}) {
    this.socket = socket
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS
    socket.onMessage((data) => { this.onData(data) })
    socket.onClose(() => {
      this.teardown(new MuxClientError('gateway/socket-closed', 'mux-client: the server closed the socket'))
    })
    this.armWatchdog()
  }

  /** Open one logical stream; the handle's lanes are documented in the header. */
  openStream(endpoint: string, payload: unknown): MuxStreamHandle {
    if (this.state !== 'open') throw new MuxClientError('gateway/disposed', 'mux-client: disposed')
    const id = this.nextId
    this.nextId += 1
    const stream: ClientStream = { downlink: new DownlinkQueue(), ended: false, retired: false }
    this.streams.set(String(id), stream)
    this.sendFrame({ type: 'open', streamId: id, endpoint, payload })
    const key = String(id)
    const live = (): boolean => this.state === 'open' && !stream.retired
    const upstream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({
        next: (value?: unknown): Promise<IteratorResult<unknown>> => {
          if (!live() || stream.ended) return Promise.resolve(DONE)
          this.sendFrame(value === undefined
            ? { type: 'item', streamId: id }
            : { type: 'item', streamId: id, value })
          return Promise.resolve({ value: undefined, done: false })
        },
        return: (): Promise<IteratorResult<unknown>> => {
          this.endUplink(id, stream)
          return Promise.resolve(DONE)
        },
      }),
    }
    return {
      items: stream.downlink,
      upstream,
      end: () => { this.endUplink(id, stream) },
      cancel: () => {
        if (!live()) return
        this.retire(key, stream)
        stream.downlink.abort()
        this.sendFrame({ type: 'cancel', streamId: id })
      },
    }
  }

  /** Close every stream and the socket. Idempotent; no cancel frames (the server unwinds on socket close). */
  dispose(): void {
    this.teardown(new MuxClientError('gateway/disposed', 'mux-client: disposed'), true)
  }

  private endUplink(id: number, stream: ClientStream): void {
    if (this.state !== 'open' || stream.retired || stream.ended) return
    stream.ended = true
    this.sendFrame({ type: 'end', streamId: id })
  }

  private retire(key: string, stream: ClientStream): void {
    stream.retired = true
    this.streams.delete(key)
  }

  /** Serialize one frame; the wire id is the stringified numeric counter. */
  private sendFrame(frame: MuxClientFrame): void {
    const wire: Record<string, unknown> = { type: frame.type, streamId: String(frame.streamId) }
    if (frame.type === 'open') {
      wire['endpoint'] = frame.endpoint
      wire['payload'] = frame.payload
    }
    if (frame.type === 'item' && frame.value !== undefined) wire['value'] = frame.value
    this.socket.send(JSON.stringify(wire))
  }

  private onData(data: string): void {
    if (this.state !== 'open') return
    this.armWatchdog() // any received frame is liveness
    let raw: unknown
    try {
      raw = JSON.parse(data)
    } catch {
      this.protocolViolation('malformed server frame')
      return
    }
    if (!isRecord(raw)) {
      this.protocolViolation('malformed server frame')
      return
    }
    if (raw['type'] === 'ping') {
      if (!exactKeys(raw, ['type'])) {
        this.protocolViolation('malformed ping frame')
        return
      }
      this.socket.send('{"type":"pong"}')
      return
    }
    if (raw['type'] === 'item') {
      if (!(exactKeys(raw, ['type', 'streamId']) || exactKeys(raw, ['type', 'streamId', 'value']))
        || !validId(raw['streamId'])) {
        this.protocolViolation('malformed item frame')
        return
      }
      const stream = this.streams.get(raw['streamId'])
      if (stream === undefined) return // late frame: stream retired, drop
      stream.downlink.push(Object.hasOwn(raw, 'value') ? raw['value'] : undefined)
      return
    }
    if (raw['type'] === 'end') {
      if (!exactKeys(raw, ['type', 'streamId']) || !validId(raw['streamId'])) {
        this.protocolViolation('malformed end frame')
        return
      }
      const stream = this.streams.get(raw['streamId'])
      if (stream === undefined) return
      this.retire(raw['streamId'], stream)
      stream.downlink.settleEnd()
      return
    }
    if (raw['type'] === 'error') {
      const failure = failureOf(raw['error'])
      if (failure === undefined || !exactKeys(raw, ['type', 'streamId', 'error']) || !validId(raw['streamId'])) {
        this.protocolViolation('malformed error frame')
        return
      }
      const stream = this.streams.get(raw['streamId'])
      if (stream === undefined) return
      this.retire(raw['streamId'], stream)
      stream.downlink.settleFailure(new MuxClientError(failure.code, failure.message, failure.details))
      return
    }
    this.protocolViolation(`out-of-protocol server frame (${String(raw['type'])})`)
  }

  /** The 1008 mirror: an unusable server frame closes the socket. */
  private protocolViolation(detail: string): void {
    this.teardown(
      new MuxClientError('gateway/protocol', `mux-client: ${detail} — closing the socket`),
      true,
    )
  }

  /** Fail every live stream, drop the table, optionally close the socket. */
  private teardown(error: MuxClientError, close = false): void {
    if (this.state !== 'open') return
    this.state = 'closed'
    this.clearWatchdog()
    for (const stream of this.streams.values()) {
      stream.retired = true
      stream.downlink.fail(error)
    }
    this.streams.clear()
    if (close) this.socket.close()
  }

  private armWatchdog(): void {
    this.clearWatchdog()
    const timer = setTimeout(() => {
      this.teardown(
        new MuxClientError(
          'gateway/heartbeat-silence',
          `mux-client: no frames for ${String(this.heartbeatIntervalMs * MAX_SILENT_PERIODS)}ms`,
        ),
        true,
      )
    }, this.heartbeatIntervalMs * MAX_SILENT_PERIODS)
    this.watchdog = timer
  }

  private clearWatchdog(): void {
    if (this.watchdog === undefined) return
    clearTimeout(this.watchdog)
    this.watchdog = undefined
  }
}

/** Validate a wire failure body (`MuxFailure` shape); undefined when malformed. */
function failureOf(value: unknown): MuxFailure | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value['code'] !== 'string' || typeof value['message'] !== 'string') return undefined
  const details = value['details']
  return { code: value['code'], message: value['message'], details: isRecord(details) ? details : {} }
}
