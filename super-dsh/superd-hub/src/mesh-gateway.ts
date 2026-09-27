/**
 * RemoteGatewayFace (machine-mesh P2 Task 2) — the wire form of a
 * {@link GatewayFace}: one paired remote agent's dispatch/stream surface,
 * reached over the PEER hub exactly as that hub would serve it locally —
 * on ONE of two surfaces, selected by {@link RemoteGatewayOptions.face}:
 *
 *   foreign (default) — the `/hub` family (hub-route is the server half):
 *     dispatchRpc     POST <origin>/hub/api?agent=<agentKey>
 *     openWireStream  WS   <origin ws(s)>/hub/api/remote.mux?agent=<agentKey>
 *   native — ctx0's OWN envelope+mux surface, exactly how a browser ON the
 *     peer consumes its native DSH (NO demux key anywhere — the peer's
 *     native agent row federates as `key:'native'` with a minted a6, and the
 *     `/hub` family would 404 it as foreign-only):
 *     dispatchRpc     POST <origin>/api
 *     openWireStream  WS   <origin ws(s)>/api/remote.mux
 *
 * Everything else (envelope shape, cookie, Result verbatim, error taxonomy,
 * connection lifecycle) is face-independent.
 * Every call rides the machine's pairing cookie ({@link RemoteGatewayOptions.cookie},
 * the per-machine jar fronting the persisted `MachineRow.cookie`).
 *
 * ## Mux connection lifecycle — ONE per gateway
 * Lazy (dialed by the first stream), SHARED by every concurrent stream
 * (per-call logical streams multiplex over it, T1 counter ids), IDLE-CLOSED
 * {@link DEFAULT_IDLE_CLOSE_MS} after the last stream retires (the timer is
 * `unref`d), and REDIALED transparently after any transport cut: on socket
 * close the MuxClient fails every in-flight stream with
 * `gateway/socket-closed`, the dead connection is dropped, and the next call
 * dials fresh. The wire stream itself opens lazily on the returned iterable's
 * first read — an iterable never iterated holds no connection and no stream.
 *
 * ## Heartbeat ruling (carried from the T1 review, controller ruling)
 * The remote's heartbeat is WS-LEVEL ping/pong (WorldMuxServer pings its
 * clients and terminates after two missed pongs); `ws` auto-answers those
 * pings at the protocol layer and they NEVER surface as text (`on('message')`
 * fires for data frames only — surfacing them would 1008-close the socket,
 * since the server's parser has no ping case). Accordingly the MuxClient is
 * configured with {@link HEARTBEAT_OFF_MS} (6 h), putting its JSON-text
 * silence watchdog effectively OFF — an idle-but-alive connection is never
 * torn down by the client — and liveness rides WS events alone: a dead peer
 * surfaces as ws `close` → in-flight streams fail, the next call reconnects.
 *
 * ## Call shapes (the carrier lesson: canonical parameter order)
 * `openWireStream` accepts BOTH faces with one runtime dispatch (an uplink
 * iterable is recognizably not an AbortSignal):
 *  - GatewayFace: `(endpoint, payload, signal)` — the face `targets.ts`
 *    freezes. It carries NO uplink lane, so the stream's uplink is
 *    half-closed immediately (`end` right after `open`): a server handler
 *    reading uplink sees EOF instead of hanging.
 *  - CarrierGatewayFace: `(endpoint, payload, uplink, peer, signal, control)`
 *    — the exact order `worldMuxOf` calls with. The uplink is bridged into
 *    the wire upstream lane with the T1 channel idiom
 *    `for await (const v of uplink) await upstream.next(v); handle.end()`
 *    (read-one-send-one, zero buffering; a `done` read — dead stream — stops
 *    the pump quietly). `control` is accepted for shape
 *    parity only — cancellation rides the mux `cancel` frame, which is what
 *    actually stops the server-side stream.
 *
 * ## Error taxonomy (every throw is a plain `{code,message}` body — the
 * brief-pinned shape; `wireErrorOf` normalizes it onto the wire downstream)
 *  - `gateway/unreachable` — network failure, or a non-200 answer that is
 *    not 401 (the status rides the message).
 *  - `gateway/auth-expired` — 401 anywhere: the MACHINE-LEVEL classification
 *    (the pairing cookie is dead) the roster downgrade consumes; never a
 *    per-request retry.
 *  - `gateway/bad-response` — 200 but the body is not a `server-response`
 *    envelope for the rpc we sent.
 *  - `gateway/aborted` — the caller's AbortSignal fired.
 *  - stream cuts — T1 `MuxClientError` codes pass through verbatim:
 *    `gateway/socket-closed` (peer cut / transport died),
 *    `gateway/disposed`, `gateway/protocol`; `gateway/heartbeat-silence` is
 *    dormant by the heartbeat ruling above. A REMOTE error frame keeps the
 *    remote's own code/message/details.
 *
 * ## Payload rule (T1 carry)
 * `undefined` payloads are coerced to `null` on both lanes before the wire
 * (T1's serializer drops the key for `undefined`, which the server's parser
 * rejects); wire streamIds are T1's own stringified counters.
 */
import { createRequire } from 'node:module'
import { MuxClient } from './mux-client.js'
import type { MuxClientSocket, MuxStreamHandle } from './mux-client.js'
import type { GatewayFace } from './targets.js'

export type { MuxClientSocket } from './mux-client.js'

/** Text-watchdog-off horizon (see the heartbeat ruling in the header). */
const HEARTBEAT_OFF_MS = 6 * 60 * 60 * 1000

/** Idle window before the shared ws closes with zero live streams. */
const DEFAULT_IDLE_CLOSE_MS = 30_000

/** Structural view of the `ws` client socket this module adapts (untyped runtime peer — world-mux precedent). */
interface WsSocketLike {
  send(data: unknown): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
  close(): void
}
type WsConstructorLike = new (url: string, options: { headers: Record<string, string> }) => WsSocketLike

/** Specifier widened on purpose: `ws` is a runtime peer, not a typed dep. */
const WS_MODULE: string = 'ws'
let wsConstructor: WsConstructorLike | undefined

/** Synchronously load the ws constructor once (createRequire — rpc.ts precedent). */
function loadWs(): WsConstructorLike {
  if (wsConstructor !== undefined) return wsConstructor
  const require = createRequire(import.meta.url)
  const mod: unknown = require(WS_MODULE)
  const boxed = mod as { default?: unknown }
  wsConstructor = (typeof mod === 'function' ? mod : boxed.default) as WsConstructorLike
  return wsConstructor
}

/**
 * The default ws seam: connect one `ws` WebSocket to `url` with `headers`
 * riding the upgrade request (the pairing Cookie), presented as T1's
 * {@link MuxClientSocket}.
 *
 * The adapter is crash-proof by construction (fix round 1):
 *  - an `'error'` listener is ALWAYS registered: an unreachable peer
 *    (ECONNREFUSED) or a rejected upgrade (non-101, e.g. a dead cookie's
 *    HTTP 401) emits `'error'` with no listener of its own — an uncaught
 *    exception that kills the hub process. The listener is a no-op: ws
 *    guarantees `'close'` follows `'error'`, and the close path already
 *    classifies (in-flight streams fail `gateway/socket-closed`) and retires
 *    the connection for redial. WS-lane auth failure therefore classifies
 *    as a socket cut post-fix — acceptable: the next POST-lane call is the
 *    one that reports `gateway/auth-expired`.
 *  - `ws` THROWS on sends made while CONNECTING, and its post-close send
 *    bookkeeping can itself throw in teardown windows, so every send is
 *    guarded: pre-open sends queue (flushed in order on 'open'), post-close
 *    sends are swallowed — the stream is dead and the close path owns the
 *    teardown. WS-level pings stay at the WS layer: `on('message')` fires
 *    for text data frames only, so protocol-level ping/pong NEVER surfaces
 *    as text.
 */
export function defaultWsFactory(url: string, headers: Record<string, string>): MuxClientSocket {
  const WebSocketCtor = loadWs()
  const socket = new WebSocketCtor(url, { headers })
  socket.on('error', () => {}) // crash guard: 'close' (and its classification) always follows
  let open = false
  let closed = false
  const pending: string[] = []
  socket.on('open', () => {
    open = true
    for (const data of pending.splice(0)) socket.send(data)
  })
  socket.on('close', () => {
    closed = true
    open = false
    pending.length = 0
  })
  return {
    send: (data: string): void => {
      if (closed) return
      if (!open) {
        pending.push(data)
        return
      }
      try {
        socket.send(data)
      } catch {
        // CONNECTING/CLOSING race or sendAfterClose bookkeeping — the close
        // path owns teardown; a lost frame on a dying socket changes nothing.
      }
    },
    onMessage: (cb: (data: string) => void): void => {
      socket.on('message', (data: unknown) => { cb(String(data)) })
    },
    onClose: (cb: () => void): void => { socket.on('close', () => { cb() }) },
    close: (): void => { socket.close() },
  }
}

/** Options for {@link createRemoteGateway}. */
export interface RemoteGatewayOptions {
  /** The peer hub origin (`http(s)://host[:port]`; the mux lane maps it to ws(s)). */
  origin: string
  /** The remote agent's demux key (`?agent=` on both lanes; ignored by the native face). */
  agentKey: string
  /** The machine's pairing cookie, read per call (the jar fronting `MachineRow.cookie`). */
  cookie: () => string
  /** Fetch override (tests); defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Socket factory override (tests); defaults to {@link defaultWsFactory}. */
  wsFactory?: (url: string, headers: Record<string, string>) => MuxClientSocket
  /** Which peer surface to address (see the header's face table): 'foreign' =
   * the `/hub` family with the `?agent=` demux (default); 'native' = ctx0's
   * own `/api` surface, no demux key — how a browser ON the peer consumes its
   * native DSH. */
  face?: 'foreign' | 'native'
  /** Idle ms with zero live streams before the ws closes (default 30 s; test hook for short real timers). */
  idleCloseMs?: number
}

/** A wire-form gateway: a {@link GatewayFace} plus the carrier call shape and a hard close. */
export interface RemoteGateway extends GatewayFace {
  /**
   * CarrierGatewayFace shape — the canonical order `worldMuxOf` calls with
   * (`(endpoint, payload, uplink, peer, signal, control)`); the uplink is
   * bridged into the wire upstream lane.
   */
  openWireStream(endpoint: string, payload: unknown, uplink: AsyncIterable<unknown> | Iterable<unknown>, peer: undefined, signal: AbortSignal, control: AbortController): AsyncIterable<unknown>
  /** GatewayFace shape — no uplink lane; the stream's uplink half-closes immediately. */
  openWireStream(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>
  /** Hard-close the shared connection now (machine unpair); in-flight streams fail `gateway/disposed`. */
  dispose(): void
}

/** The ws(s) URL of the peer's mux lane (foreign: the `/hub` family with
 * the demux key; native: ctx0's own surface, no query). */
function muxUrlOf(origin: string, agentKey: string, face: 'foreign' | 'native'): string {
  const url = new URL(origin)
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${face === 'native' ? '/api/remote.mux' : '/hub/api/remote.mux'}`
  if (face === 'foreign') url.search = `agent=${encodeURIComponent(agentKey)}`
  return url.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An uplink lane is recognizable at the seam: iterables (sync or async —
 * `for await` bridges sync ones) are never AbortSignals. */
function isUplinkLane(value: unknown): value is AsyncIterable<unknown> | Iterable<unknown> {
  return typeof value === 'object' && value !== null
    && (Symbol.asyncIterator in value || Symbol.iterator in value)
}

/** One gateway/* failure body — the brief-pinned thrown shape. */
function wireFail(code: string, message: string): { code: string; message: string } {
  return { code, message }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The shared connection plus its live-stream count. */
interface MuxConnection {
  readonly client: MuxClient
  live: number
}

class RemoteGatewayImpl implements RemoteGateway {
  private readonly origin: string
  private readonly agentKey: string
  private readonly cookieFn: () => string
  private readonly fetchImpl: typeof fetch
  private readonly wsFactory: (url: string, headers: Record<string, string>) => MuxClientSocket
  private readonly idleCloseMs: number
  private readonly face: 'foreign' | 'native'
  private readonly muxUrl: string
  private nextRpcId = 1
  private connection: MuxConnection | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: RemoteGatewayOptions) {
    this.origin = options.origin
    this.agentKey = options.agentKey
    this.cookieFn = options.cookie
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.wsFactory = options.wsFactory ?? defaultWsFactory
    this.idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS
    this.face = options.face ?? 'foreign'
    this.muxUrl = muxUrlOf(options.origin, options.agentKey, this.face)
  }

  async dispatchRpc(endpoint: string, payload: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    // Foreign: the /hub family with the demux key; native: ctx0's own /api,
    // no query — a browser on the peer addresses the same surface.
    const url = this.face === 'native'
      ? `${this.origin}/api`
      : `${this.origin}/hub/api?agent=${encodeURIComponent(this.agentKey)}`
    const rpcId = String(this.nextRpcId)
    this.nextRpcId += 1
    const body = JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: payload === undefined ? null : payload, // the payload rule: never undefined
    })
    const cookie = this.cookieFn()
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie === '' ? {} : { cookie }),
        },
        body,
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw wireFail('gateway/aborted', `mesh-gateway: ${endpoint} aborted`)
      throw wireFail('gateway/unreachable', `mesh-gateway: POST ${url} failed — ${messageOf(error)}`)
    }
    if (response.status === 401) {
      throw wireFail('gateway/auth-expired', `mesh-gateway: ${endpoint} answered 401 — the pairing cookie is expired (machine-level downgrade material)`)
    }
    if (response.status !== 200) {
      throw wireFail('gateway/unreachable', `mesh-gateway: ${endpoint} answered unexpected status ${response.status} from ${this.origin}`)
    }
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      if (signal?.aborted) throw wireFail('gateway/aborted', `mesh-gateway: ${endpoint} aborted mid-body`)
      throw wireFail('gateway/unreachable', `mesh-gateway: reading ${endpoint} response failed — ${messageOf(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw wireFail('gateway/bad-response', `mesh-gateway: ${endpoint} response is not JSON`)
    }
    if (!isRecord(parsed) || parsed['type'] !== 'server-response' || parsed['rpcId'] !== rpcId || !('result' in parsed)) {
      throw wireFail('gateway/bad-response', `mesh-gateway: ${endpoint} response is not a server-response envelope for rpc ${rpcId}`)
    }
    // The Result ({ok,value} | {ok:false,error}) is DATA: returned verbatim,
    // never unwrapped or thrown — the caller classifies.
    return parsed['result']
  }

  openWireStream(
    endpoint: string,
    payload: unknown,
    uplinkOrSignal?: AsyncIterable<unknown> | Iterable<unknown> | AbortSignal,
    _peer?: undefined,
    signal?: AbortSignal,
    _control?: AbortController,
  ): AsyncIterable<unknown> {
    const carrierShape = isUplinkLane(uplinkOrSignal)
    const uplink = carrierShape ? (uplinkOrSignal as AsyncIterable<unknown> | Iterable<unknown>) : undefined
    const abortSignal = carrierShape ? signal : (uplinkOrSignal as AbortSignal | undefined)
    const gateway = this
    // The wire stream opens on the first read — an iterable never iterated
    // dials nothing and leaks nothing.
    async function* downlink(): AsyncGenerator<unknown> {
      if (abortSignal?.aborted) return
      const conn = gateway.acquireConnection()
      let handle: MuxStreamHandle
      try {
        handle = conn.client.openStream(endpoint, payload === undefined ? null : payload)
      } catch (error) {
        gateway.releaseConnection(conn)
        throw error
      }
      if (uplink === undefined) {
        // The GatewayFace shape carries no uplink lane: half-close at once so
        // a server handler reading uplink sees EOF instead of hanging.
        handle.end()
      } else {
        // T1 ruling idiom: one read of the channel iterator sends one item
        // frame; empty/errored uplink settles to end/cancel. A `done` read
        // means the stream died (socket cut / cancel) — stop pumping quietly
        // instead of draining the source against a dead wire.
        const push = handle.upstream[Symbol.asyncIterator]()
        void (async () => {
          try {
            for await (const value of uplink) {
              if ((await push.next(value)).done) return
            }
          } catch {
            handle.cancel()
            return
          }
          handle.end()
        })()
      }
      const onAbort = (): void => { handle.cancel() }
      abortSignal?.addEventListener('abort', onAbort, { once: true })
      try {
        yield* handle.items
      } finally {
        abortSignal?.removeEventListener('abort', onAbort)
        handle.cancel() // no-op when the stream settled; cancels the wire on early exit
        gateway.releaseConnection(conn)
      }
    }
    return downlink()
  }

  dispose(): void {
    this.clearIdleTimer()
    const conn = this.connection
    this.connection = undefined
    conn?.client.dispose()
  }

  /** Take a live-stream slot on the shared connection, dialing it if needed. */
  private acquireConnection(): MuxConnection {
    this.clearIdleTimer()
    let conn = this.connection
    if (conn === undefined) {
      conn = this.connect()
      this.connection = conn
    }
    conn.live += 1
    return conn
  }

  /** Drop a live-stream slot; the last one out arms the idle-close timer. */
  private releaseConnection(conn: MuxConnection): void {
    conn.live = Math.max(0, conn.live - 1)
    if (conn.live > 0 || this.connection !== conn || this.idleTimer !== undefined) return
    const timer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.connection === conn && conn.live === 0) {
        this.connection = undefined
        conn.client.dispose()
      }
    }, this.idleCloseMs)
    timer.unref()
    this.idleTimer = timer
  }

  /** Dial the mux ws and wrap it so a transport cut retires the connection. */
  private connect(): MuxConnection {
    const cookie = this.cookieFn()
    const headers: Record<string, string> = cookie === '' ? {} : { cookie }
    const socket = this.wsFactory(this.muxUrl, headers)
    let conn!: MuxConnection
    const wrapped: MuxClientSocket = {
      send: (data: string): void => { socket.send(data) },
      onMessage: (cb: (data: string) => void): void => { socket.onMessage(cb) },
      onClose: (cb: () => void): void => {
        socket.onClose(() => {
          cb() // the MuxClient tears its streams down first (T1 contract) …
          if (this.connection === conn) {
            this.connection = undefined // … then the dead connection is dropped: the next call redials
            this.clearIdleTimer()
          }
        })
      },
      close: (): void => { socket.close() },
    }
    const client = new MuxClient(wrapped, { heartbeatIntervalMs: HEARTBEAT_OFF_MS })
    conn = { client, live: 0 }
    return conn
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}

/**
 * Build one remote agent's wire gateway toward a paired hub's `/hub` family.
 * @param options - see {@link RemoteGatewayOptions}.
 * @returns the {@link RemoteGateway} (a GatewayFace; register it with
 * `registerForeignTarget` — callers cannot tell it from a local world gateway).
 */
export function createRemoteGateway(options: RemoteGatewayOptions): RemoteGateway {
  return new RemoteGatewayImpl(options)
}
