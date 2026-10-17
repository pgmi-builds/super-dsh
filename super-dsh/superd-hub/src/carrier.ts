/**
 * The carrier forwarding kernel (AW-B DL1/DL5 → native UI fusion Task 2 →
 * path-separation T-C): the wire semantics every foreign-agent entry shares.
 *
 * History and the T-C/T-D cuts:
 *  - The kernel — envelope dispatch ({@link forwardApiCall}), the world fetch
 *    bridge ({@link forwardWorldFetch}) and the mux construction
 *    ({@link worldMuxOf}) — is parameterized by (gateway, label, mountPath).
 *  - It used to be mounted twice: the per-label page family
 *    (`/<label>/api`, `/<label>/api/remote.mux`, `/<label>/open-in-app` —
 *    registered by the now-deleted `mountWorld`) and, since 2026-09-26, the
 *    hub-owned `/hub` family (`hub-route.ts`, demuxed by `?agent=`).
 *  - T-C (2026-09-26, user ruling "strip off the per agent url path … no need
 *    the url path fallback (we have git history)"): the per-label family is
 *    RETIRED — `/hub` is the sole foreign entry and the only remaining
 *    consumer of this kernel. The world DATA planes are untouched: the same
 *    gateway faces (dispatchRpc/openWireStream), the same WorldMuxServer, the
 *    same envelope, the same worldFetchHandlerOf lane, all reached through
 *    `/hub`.
 *  - T-D (2026-09-26, "disable their webui build"): the retired `mountWorld`
 *    no-op and the mount HTML pass re-export left the module; the carrier is
 *    the forwarding kernel alone.
 *
 * Nothing here reads a global: the addressed world travels with the request.
 */
import {
  EnvelopeError,
  parseClientRequest,
  serverError,
  serverResult,
  wireErrorOf,
} from './envelope.js'
import { stripLabelFromUrl, type RealWebServerFace, type WorldRequest, type WorldResponse } from './world-web-server.js'
import { worldFetchHandlerOf } from './world-host.js'
import { WorldMuxServer, type MuxFailure } from './world-mux.js'

/** The face of a world's typertGateway service instance the hub forwards through. */
export interface CarrierGatewayFace {
  dispatchRpc(endpoint: string, payload: unknown, signal: AbortSignal, peer: unknown): Promise<unknown>
  /**
   * Streams return an async iterable (upstream face is synchronous-returning).
   * Canonical order: (endpoint, payload, uplink, peer, signal, control) — the
   * carrier passes the world's owner browser Peer (0.2.1 gateways read it on
   * every invocation), the mux controller's signal, and the controller
   * itself, exactly as the native gateway's mux wires its own streams.
   */
  openWireStream(
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    peer: unknown,
    signal: AbortSignal,
    control: AbortController,
  ): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>
}

/** Default body cap, aligned with the connection service. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

interface BodyCarrier {
  [Symbol.asyncIterator]?(): AsyncIterator<unknown>
  on?(event: 'data' | 'end' | 'error', listener: (chunk?: unknown) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}

async function readBody(req: unknown, limit: number): Promise<string> {
  const carrier = req as BodyCarrier
  const chunks: Buffer[] = []
  let size = 0
  if (typeof carrier[Symbol.asyncIterator] === 'function') {
    for await (const chunk of carrier as AsyncIterable<unknown>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.byteLength
      if (size > limit) throw new EnvelopeError({ code: 'gateway/bad-request', message: 'request body too large' })
      chunks.push(buf)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  if (typeof carrier.on !== 'function') return ''
  return await new Promise<string>((resolve, reject) => {
    carrier.on?.('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
      size += buf.byteLength
      if (size > limit) {
        reject(new EnvelopeError({ code: 'gateway/bad-request', message: 'request body too large' }))
        return
      }
      chunks.push(buf)
    })
    carrier.on?.('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    carrier.on?.('error', (error) => reject(error instanceof Error ? error : new Error(String(error))))
  })
}

export function writeJson(res: WorldResponse, status: number, body: string): void {
  const carrier = res as WorldResponse & { writeHead?: (status: number, headers?: Record<string, string>) => void }
  carrier.writeHead?.(status, { 'content-type': 'application/json' })
  res.end(body)
}

/** Write a plain-text answer (the shape upstream's own 404/413 answers use). */
function writeText(res: WorldResponse, status: number, body: string): void {
  const carrier = res as WorldResponse & { writeHead?: (status: number, headers?: Record<string, string>) => void }
  carrier.writeHead?.(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}

/** Deps the forwarding kernel needs to answer for one world's traffic. */
export interface ForwardOptions {
  /** The addressed world's gateway instance. */
  gateway: CarrierGatewayFace
  /** The addressed world's owner browser Peer (0.2.1 invocation identity). */
  peer?: unknown
  /** World key addressing the world's published `/api` fetch handler. */
  label: string
  /** URL prefix this carrier strips before the world sees the request (`/omp`, `/hub`). */
  mountPath: string
  /** ctx0's browser-trust fence: returns an HTTP status to reject with. */
  requestRejection?(req: unknown): number | undefined
  /** Max request body bytes (mirrors the connection default). */
  maxBodyBytes?: number
}

const forwardsFetchMethod = (req: WorldRequest): boolean => {
  const method = (req as { method?: unknown }).method
  return method === 'GET' || method === 'HEAD'
}

/**
 * Forward one non-envelope GET/HEAD request into the owning world's shared
 * `/api` fetch handler (exact Fetch routes first, then the gateway's RPC
 * interceptor, then 404 — the upstream composition). The caller has already
 * answered the ctx0 fence by the time we get here; the world's own
 * browser-auth gate is never consulted (a different tree, a different secret).
 */
export async function forwardWorldFetch(
  options: { label: string; mountPath: string },
  req: WorldRequest,
  res: WorldResponse,
): Promise<void> {
  const worldFetch = worldFetchHandlerOf(options.label)
  if (worldFetch === undefined) {
    writeText(res, 404, 'not found')
    return
  }
  const method = ((req as { method?: unknown }).method ?? 'GET') as string
  const resCarrier = res as WorldResponse & {
    write?(chunk: unknown): boolean
    once?(event: string, listener: () => void): unknown
    off?(event: string, listener: () => void): unknown
    destroy?(): void
    readonly writableEnded?: boolean
  }
  // Client-disconnect detection rides the response (same reason as the
  // upstream node:http bridge: the request 'close' fires as soon as a
  // bodyless GET is consumed).
  const abort = new AbortController()
  const onClose = (): void => {
    if (resCarrier.writableEnded !== true) abort.abort()
  }
  resCarrier.once?.('close', onClose)
  let headersSent = false
  try {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries((req as { headers?: Record<string, unknown> }).headers ?? {})) {
      if (typeof value === 'string') headers[name.toLowerCase()] = value
    }
    // The world route owns the world-relative URL: strip the mount prefix,
    // keep the query (the session-export route reads it from searchParams).
    const request = new Request(
      new URL(stripLabelFromUrl(req.url, options.mountPath), 'http://dsh.internal'),
      { method, headers, signal: abort.signal },
    )
    const response = await worldFetch.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    headersSent = true
    if (response.body === null) {
      res.end()
      return
    }
    for await (const chunk of response.body) {
      // Backpressure: wait for drain instead of buffering unboundedly; a
      // socket close resolves the wait and the aborted signal ends the stream.
      if (resCarrier.write?.(chunk) === false && typeof resCarrier.once === 'function') {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            resCarrier.off?.('drain', done)
            resCarrier.off?.('close', done)
            resolve()
          }
          resCarrier.once?.('drain', done)
          resCarrier.once?.('close', done)
        })
      }

    }
    res.end()
  } catch {
    // The world route owns its statuses; only carrier-level faults land here.
    if (!headersSent) writeText(res, 500, 'carrier fetch bridge failure')
    else resCarrier.destroy?.()
  } finally {
    resCarrier.off?.('close', onClose)
  }
}

/**
 * The reusable forwarding kernel (envelope dispatch + world fetch bridge):
 * decode the connection envelope and dispatch into the ADDRESSED world's
 * gateway instance; non-envelope GET/HEAD traffic forwards into the world's
 * own registered fetch routes. Parameterized by (gateway, label, mountPath)
 * so the `/hub` route family shares this exact behavior — the demux key is
 * the caller's business, the wire semantics live here.
 */
export async function forwardApiCall(options: ForwardOptions, req: WorldRequest, res: WorldResponse): Promise<void> {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const rejection = options.requestRejection?.(req)
  if (rejection !== undefined) {
    writeJson(res, rejection, JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
    return
  }
  let rpcId = 'invalid-request'
  try {
    const text = await readBody(req, maxBody)
    let envelope: ReturnType<typeof parseClientRequest>
    try {
      envelope = parseClientRequest(text)
    } catch (error) {
      // Non-envelope GET/HEAD traffic on the shared mount prefix belongs to
      // the world's own registered fetch routes; envelopes (and every other
      // method) keep the transport-level 400 below.
      if (error instanceof EnvelopeError && forwardsFetchMethod(req)) {
        await forwardWorldFetch(options, req, res)
        return
      }
      throw error
    }
    rpcId = envelope.rpcId
    const controller = new AbortController()
    const result = await options.gateway.dispatchRpc(envelope.method, envelope.payload, controller.signal, options.peer)
    // The gateway already returns a Result (`{ok:true,value}` | `{ok:false,error}`),
    // which is exactly the server-response's `result` field.
    writeJson(res, 200, serverResult(rpcId, result))
  } catch (error) {
    const wire = wireErrorOf(error)
    // Envelope-level failures are transport-level 400s; dispatch failures are
    // business results carried inside a 200 server-response (upstream shape).
    if (error instanceof EnvelopeError) {
      writeJson(res, 400, serverError(rpcId, wire))
      return
    }
    writeJson(res, 200, serverError(rpcId, wire))
  }
}

/** One WorldMuxServer bound to `gateway` — the canonical openWireStream wiring in one place. */
export function worldMuxOf(
  gateway: CarrierGatewayFace,
  peer?: unknown,
  options?: { heartbeatIntervalMs?: number; failure?: (error: unknown) => MuxFailure },
): WorldMuxServer {
  return new WorldMuxServer(
    (endpoint, payload, uplink, control) => Promise.resolve(
      gateway.openWireStream(endpoint, payload, uplink, peer, control.signal, control),
    ),
    {
      ...(options?.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options?.failure === undefined ? {} : { failure: options.failure }),
    },
  )
}

/**
 * RETIRED with T-D (2026-09-26): the T-C `mountWorld` no-op — which itself
 * used to register `/<label>/api`, `/<label>/open-in-app` and
 * `/<label>/api/remote.mux` on the real webServer — is GONE from the module.
 * The adapter world-plugins' spawn-time call sites were updated in the same
 * round (the registerHostMount record needs no webServer and no fence; the
 * `/hub` family reaches each world's gateway through the foreign-target
 * table). Git history keeps the function.
 */

// The carrier is now purely the forwarding kernel: no mount-time HTML pass,
// no per-label registration — `/hub` (hub-route.ts) is the sole consumer.
