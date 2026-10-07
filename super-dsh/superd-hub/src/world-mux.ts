/**
 * Per-world Remote stream mux server (AW-B DL6).
 *
 * Upstream's `RemoteStreamMuxServer` owns `/api/remote.mux` for the native
 * gateway and is NOT reachable from outside its package (root exports omit it;
 * `./src/*` cannot be imported at runtime). So this is our own wire-compatible
 * implementation of the same protocol (dsh 0.1.7 `stream-protocol.ts`), bound
 * to the ADDRESSED world's `openWireStream`:
 *
 *   browser → server   { type:'open', streamId, endpoint, payload }
 *                      { type:'item', streamId, value? }   (uplink)
 *                      { type:'end', streamId }            (uplink half-close)
 *                      { type:'cancel', streamId }
 *   server → browser   { type:'item', streamId, value }
 *                      { type:'end', streamId }
 *                      { type:'error', streamId, error:{code,message,details} }
 *
 * Dispatch semantics mirror upstream `RemoteStreamMuxConnection`: `item`,
 * `end`, and `cancel` for a stream this connection no longer owns are dropped;
 * a duplicate `open` is the one violation that closes the socket. Uplink items
 * wait in a bounded inbox created before the opener resolves, so items sent
 * right after `open` are never lost. Heartbeat: ping every interval, terminate
 * after two missed pongs.
 */

/** Open one world stream (the world gateway's `openWireStream`). */
export type MuxOpen = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  control: AbortController,
) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>

/** Wire failure body (upstream `RemoteStreamFailure`). */
export interface MuxFailure {
  code: string
  message: string
  details: object
}

/** Options. */
export interface WorldMuxOptions {
  /** Ping interval; upstream default is 2s. */
  heartbeatIntervalMs?: number
  /** Buffered uplink frame bytes one logical stream may hold before it fails; upstream default 256KiB. */
  streamInboxBytes?: number
  /** Error → wire failure mapper. */
  failure?: (error: unknown) => MuxFailure
}

/** One client request frame. */
type ClientMessage =
  | { type: 'open'; streamId: string; endpoint: string; payload: unknown }
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'cancel'; streamId: string }

/** Minimal structural view of the `ws` surface we use. */
interface WsSocketLike {
  readyState: number
  send(text: string, callback: (error?: Error) => void): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
  on(event: string, listener: (...args: unknown[]) => void): void
  once(event: string, listener: (...args: unknown[]) => void): void
}
interface WsServerLike {
  readonly clients: Set<WsSocketLike>
  handleUpgrade(req: unknown, socket: unknown, head: Buffer, callback: (socket: WsSocketLike) => void): void
  close(callback?: (error?: Error) => void): void
}
interface WsModuleLike {
  WebSocketServer: new (options: { noServer: true }) => WsServerLike
  WebSocket: { OPEN: number }
}

/** Specifier is widened on purpose: `ws` is a runtime peer, not a typed dep. */
const WS_MODULE: string = 'ws'
const MAX_MISSED_HEARTBEATS = 2
const DEFAULT_HEARTBEAT_MS = 2_000
const DEFAULT_STREAM_INBOX_BYTES = 262_144
const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** An abort reason carrying wire failure fields (upstream `remoteErrorOf`). */
function isRemoteFailure(reason: unknown): boolean {
  return isRecord(reason) && typeof reason['code'] === 'string'
}

/**
 * Parse one browser text frame.
 * @param text - complete WebSocket text message.
 * @returns the validated request.
 * @throws {Error} on a malformed frame.
 */
export function parseClientMessage(text: string): ClientMessage {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('world-mux: invalid client message')
  }
  if (!isRecord(raw)) throw new Error('world-mux: invalid client message')
  if ((raw['type'] === 'cancel' || raw['type'] === 'end')
    && exactKeys(raw, ['type', 'streamId']) && validId(raw['streamId'])) {
    return { type: raw['type'], streamId: raw['streamId'] }
  }
  if (raw['type'] === 'item'
    && (exactKeys(raw, ['type', 'streamId']) || exactKeys(raw, ['type', 'streamId', 'value']))
    && validId(raw['streamId'])) {
    return Object.hasOwn(raw, 'value')
      ? { type: 'item', streamId: raw['streamId'], value: raw['value'] }
      : { type: 'item', streamId: raw['streamId'] }
  }
  if (raw['type'] === 'open'
    && exactKeys(raw, ['type', 'streamId', 'endpoint', 'payload'])
    && validId(raw['streamId'])
    && typeof raw['endpoint'] === 'string'
    && raw['endpoint'].length > 0) {
    return { type: 'open', streamId: raw['streamId'], endpoint: raw['endpoint'], payload: raw['payload'] }
  }
  throw new Error('world-mux: invalid client message')
}

/** Default failure mapper: keep the error code when it looks like one. */
export function defaultFailure(error: unknown): MuxFailure {
  if (isRecord(error)) {
    const code = typeof error['code'] === 'string' ? error['code'] : undefined
    const message = typeof error['message'] === 'string' ? error['message'] : undefined
    if (code !== undefined) {
      const details = isRecord(error['details']) ? error['details'] : {}
      return { code, message: message ?? code, details }
    }
  }
  return { code: 'gateway/stream-error', message: error instanceof Error ? error.message : String(error), details: {} }
}

/** One uplink violation: an abort reason that must reach the client as a failure frame. */
function uplinkViolation(code: 'gateway/protocol' | 'gateway/uplink-overflow', message: string, endpoint: string): Error {
  return Object.assign(new Error(message), { code, details: { endpoint } })
}

/**
 * Bounded single-consumer uplink queue of one logical stream, the source the
 * world method reads as its uplink iterable. Mirrors upstream `UplinkInbox`:
 * overflow, and an item after the client's `end`, fail the queue and abort the
 * logical stream with a wire failure.
 */
class UplinkInbox implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly queue: Array<{ value: unknown, bytes: number }> = []
  private bytes = 0
  private ended = false
  private closed = false
  private taken = false
  private failure: Error | undefined
  private wake: (() => void) | undefined

  constructor(
    private readonly maxBytes: number,
    private readonly endpoint: string,
    private readonly onViolation: (error: Error) => void,
  ) { }

  push(value: unknown, frameBytes: number): void {
    if (this.failure !== undefined || this.closed) return
    if (this.ended) {
      this.violate(uplinkViolation('gateway/protocol', 'world-mux: Remote stream uplink item after end', this.endpoint))
      return
    }
    if (this.bytes + frameBytes > this.maxBytes) {
      this.violate(uplinkViolation(
        'gateway/uplink-overflow',
        `world-mux: Remote stream uplink exceeded ${String(this.maxBytes)} buffered bytes`,
        this.endpoint,
      ))
      return
    }
    this.queue.push({ value, bytes: frameBytes })
    this.bytes += frameBytes
    this.signal()
  }

  /** Client half-close; idempotent. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.signal()
  }

  /** End the consumer's next read with `error`; idempotent, drops buffered items. */
  fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.queue.length = 0
    this.bytes = 0
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    if (this.taken) throw new Error('world-mux: Remote stream uplink inbox already has a consumer')
    this.taken = true
    return this
  }

  async next(): Promise<IteratorResult<unknown>> {
    while (true) {
      if (this.closed) return UPLINK_DONE
      const entry = this.queue.shift()
      if (entry !== undefined) {
        this.bytes -= entry.bytes
        return { value: entry.value, done: false }
      }
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return UPLINK_DONE
      if (this.wake !== undefined) throw new Error('world-mux: Remote stream uplink inbox has one pending read')
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /** Consumer stopped reading: later items are dropped, a pending read ends. */
  return(): Promise<IteratorResult<unknown>> {
    this.closed = true
    this.queue.length = 0
    this.bytes = 0
    this.signal()
    return Promise.resolve(UPLINK_DONE)
  }

  private violate(error: Error): void {
    this.fail(error)
    this.onViolation(error)
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

interface ActiveStream {
  readonly abort: AbortController
  readonly inbox: UplinkInbox
  /** Cancel the logical stream and end any world read still waiting on its uplink. */
  readonly stop: (reason: Error) => void
  done: Promise<void>
}

/** One world's mux endpoint. */
export class WorldMuxServer {
  private server: WsServerLike | undefined
  private ws: WsModuleLike | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private readonly connections = new Set<Promise<void>>()
  private readonly missed = new WeakMap<object, number>()
  private closed = false

  constructor(
    private readonly open: MuxOpen,
    private readonly options: WorldMuxOptions = {},
  ) { }

  /** Take over one accepted upgrade request. */
  async handleUpgrade(req: unknown, socket: unknown, head: Buffer): Promise<void> {
    const { server, ws } = await this.load()
    server.handleUpgrade(req, socket, head, (client) => {
      this.missed.set(client as object, 0)
      client.on('pong', () => { this.missed.set(client as object, 0) })
      this.startHeartbeat()
      const done = this.runConnection(client, ws)
      this.connections.add(done)
      void done.then(() => { this.connections.delete(done) })
    })
  }

  /** Terminate every socket and wait for the active streams to unwind. */
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
    const server = this.server
    if (server !== undefined) {
      for (const client of server.clients) client.terminate()
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    }
    await Promise.all([...this.connections])
  }

  private async load(): Promise<{ server: WsServerLike; ws: WsModuleLike }> {
    if (this.server !== undefined && this.ws !== undefined) return { server: this.server, ws: this.ws }
    const mod = (await import(WS_MODULE)) as unknown as WsModuleLike & { default?: WsModuleLike }
    const ws = typeof mod.WebSocketServer === 'function' ? mod : (mod.default as WsModuleLike)
    const server = new ws.WebSocketServer({ noServer: true })
    this.server = server
    this.ws = ws
    return { server, ws }
  }

  private async runConnection(client: WsSocketLike, ws: WsModuleLike): Promise<void> {
    const streams = new Map<string, ActiveStream>()
    let writes = Promise.resolve()
    const send = (message: unknown): Promise<void> => {
      let text: string
      try {
        text = JSON.stringify(message)
      } catch (cause) {
        return Promise.reject(new Error('world-mux: item is not JSON serializable', { cause }))
      }
      const delivery = writes.then(() => new Promise<void>((resolve, reject) => {
        if (client.readyState !== ws.WebSocket.OPEN) {
          reject(new Error('world-mux: socket is closed'))
          return
        }
        client.send(text, (error) => { if (error) reject(error); else resolve() })
      }))
      writes = delivery.catch(() => undefined)
      return delivery
    }
    const failureOf = this.options.failure ?? defaultFailure
    const sendFailure = async (streamId: string, error: unknown): Promise<void> => {
      if (client.readyState !== ws.WebSocket.OPEN) return
      try {
        await send({ type: 'error', streamId, error: failureOf(error) })
      } catch {
        client.close(1011, 'Remote stream failure could not be delivered')
      }
    }
    const pump = async (streamId: string, endpoint: string, payload: unknown, active: ActiveStream): Promise<void> => {
      let failed: { readonly error: unknown } | undefined
      try {
        const source = await this.open(endpoint, payload, active.inbox, active.abort)
        for await (const value of source) {
          await send({ type: 'item', streamId, value })
        }
      } catch (error) {
        failed = { error }
      }
      // The downlink has settled; later uplink frames cannot change the outcome.
      active.inbox.fail(new Error('world-mux: Remote stream ended'))
      if (active.abort.signal.aborted) {
        // A wire failure as the abort reason is this mux failing the stream (a
        // rejected or overflowing uplink item, or an item after end); the client
        // is still waiting for that terminal frame. Any other abort is a
        // cancellation and stays silent.
        const reason: unknown = active.abort.signal.reason
        if (isRemoteFailure(reason)) await sendFailure(streamId, reason)
        return
      }
      if (failed !== undefined) {
        await sendFailure(streamId, failed.error)
        return
      }
      try {
        await send({ type: 'end', streamId })
      } catch (error) {
        await sendFailure(streamId, error)
      }
    }
    await new Promise<void>((resolve) => {
      client.once('close', () => { resolve() })
      client.on('error', () => { client.terminate() })
      client.on('message', (data: unknown, isBinary?: unknown) => {
        if (isBinary === true) {
          client.close(1003, 'text messages required')
          return
        }
        const text = String(data)
        let message: ClientMessage
        try {
          message = parseClientMessage(text)
        } catch {
          client.close(1008, 'invalid Remote stream request')
          return
        }
        if (message.type === 'open') {
          if (streams.has(message.streamId)) {
            client.close(1008, 'duplicate Remote stream id')
            return
          }
          const abort = new AbortController()
          // Created before the opener resolves so items the client sends right
          // after `open` wait in the inbox instead of being lost.
          const inbox = new UplinkInbox(
            this.options.streamInboxBytes ?? DEFAULT_STREAM_INBOX_BYTES,
            message.endpoint,
            (error) => { abort.abort(error) },
          )
          const active: ActiveStream = {
            abort,
            inbox,
            stop: (reason) => {
              abort.abort(reason)
              inbox.fail(reason)
            },
            done: Promise.resolve(),
          }
          streams.set(message.streamId, active)
          const done = pump(message.streamId, message.endpoint, message.payload, active)
          active.done = done
          void done.then(() => streams.delete(message.streamId), () => streams.delete(message.streamId))
          return
        }
        // `item`, `end`, and `cancel` for a stream this connection no longer
        // owns are dropped: a finished stream leaves the table while the
        // client's in-flight frames are still arriving.
        if (message.type === 'item') {
          streams.get(message.streamId)?.inbox.push(message.value, Buffer.byteLength(text, 'utf8'))
          return
        }
        if (message.type === 'end') {
          streams.get(message.streamId)?.inbox.end()
          return
        }
        streams.get(message.streamId)?.stop(new Error('world-mux: Remote stream cancelled'))
      })
    })
    const active = [...streams.values()]
    for (const stream of active) stream.stop(new Error('world-mux: Remote stream socket closed'))
    await Promise.all(active.map(stream => stream.done))
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== undefined || this.closed) return
    const interval = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS
    this.heartbeat = setInterval(() => {
      const server = this.server
      if (server === undefined) return
      for (const client of server.clients) {
        if (client.readyState !== (this.ws?.WebSocket.OPEN ?? 1)) continue
        const missed = this.missed.get(client as object) ?? 0
        if (missed >= MAX_MISSED_HEARTBEATS) {
          client.terminate()
          continue
        }
        this.missed.set(client as object, missed + 1)
        client.ping()
      }
    }, interval)
    this.heartbeat.unref()
  }
}
