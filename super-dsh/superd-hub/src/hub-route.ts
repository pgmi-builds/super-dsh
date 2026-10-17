/**
 * The hub-owned `/hub` route family (native UI fusion, plan Task 2).
 *
 * ONE prefix route + ONE upgrade route on ctx0's webServer (design ratified
 * 2026-09-26): every FOREIGN-agent request funnels into this family and the
 * demux key rides the query (`?agent=<label>`) instead of the path. The
 * native `/api` surface is never touched — this family is the only seam. It
 * registers unconditionally (authorize-gated, inert until a request carries a
 * registered foreign label); the fusion feature flag never gates server route
 * registration.
 *
 * Semantics per request:
 *  - `?agent=<label>` with a registered gateway → the request is consumed and
 *    forwarded to that world: envelope POST → `dispatchRpc`, non-envelope
 *    GET/HEAD → the world's published `/api` fetch handler, WS upgrade → a
 *    `WorldMuxServer` bound to that gateway. The demux key is CONSUMED, so
 *    the world sees exactly the URL its native page would have sent
 *    (`/hub/api/x?agent=o&p=1` → world `/api/x?p=1`).
 *  - no `agent` param or `agent=native` → 404 JSON: the family serves foreign
 *    traffic only; native belongs to `/api`.
 *  - unknown / not-yet-spawned label → 404 JSON `{error:'unknown-agent',
 *    label}` — silent degradation, never a locked page.
 *
 * The ctx0 gate is the SAME authorize source the world mounts use
 * (`connection.authorizeIndex`, the boolean face whose false path already
 * wrote the answer — 401 or the token→cookie 303); the family then runs the
 * SAME browser-trust fence the sibling `/<label>/api` mounts run
 * (`requestRejection`, the connection's `isTrustedApiRequest` face) before it
 * answers anything — the family is never weaker than the neighbors carrying
 * identical traffic. Forwarding reuses the carrier kernel
 * ({@link forwardApiCall} / {@link worldMuxOf}) unchanged: this module only
 * gates, fences and demuxes.
 *
 * Mux lifecycle (review round 1): each accepted upgrade constructs ONE
 * `WorldMuxServer`, which roots a heartbeat interval and a per-connection
 * WebSocketServer — resources that would otherwise outlive the client forever
 * (one 2s no-op timer per reconnect). The mux is therefore CLOSED the moment
 * its socket dies: close-on-disconnect. The carrier's shared-mux-per-mount
 * shape does not transfer (the hub rebinds per respawn); close-on-disconnect
 * does.
 */
import { forwardApiCall, worldMuxOf, writeJson, type CarrierGatewayFace } from './carrier.js'
import { stripLabelFromUrl, type RealWebServerFace, type WorldRequest, type WorldResponse } from './world-web-server.js'

/** The mount prefix the family owns. */
export const HUB_MOUNT_PATH = '/hub'

/** The WebSocket upgrade path (upstream matches upgrades by pathname, so `?agent=` rides along). */
export const HUB_MUX_PATH = '/hub/api/remote.mux'

/** Options for registering the family on one (real) webServer. */
export interface HubRouteOptions {
  /** The ctx0 webServer the family registers on. */
  real: RealWebServerFace
  /**
   * ctx0's index authorization (the world-mount gate source): false means the
   * authorizer already answered (401, or the token→cookie 303) and the family
   * must not touch any gateway.
   */
  authorize(req: unknown, res: unknown): boolean
  /**
   * ctx0's browser-trust fence — the SAME `isTrustedApiRequest` face the
   * sibling carrier mounts run: returns an HTTP status to reject with, or
   * undefined for trusted Host/Origin. Runs after {@link authorize} (auth
   * first, the carrier's own ordering precedent) and before ANY family
   * answer, so even the demux 404s never speak to untrusted traffic.
   */
  requestRejection?(req: unknown): number | undefined
  /** The live target (gateway + owner peer) of a registered label, or undefined (unknown / not yet spawned). */
  gatewayOf(label: string): { gateway: CarrierGatewayFace, peer?: unknown } | undefined
}

/** The demux key of one family request; absent or empty means "not foreign-addressed". */
function agentOf(req: WorldRequest): string | undefined {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const value = url.searchParams.get('agent')
  return value === null || value === '' ? undefined : value
}

/**
 * The world-relative URL for one family request: the `/hub` mount prefix
 * stripped (same translation the `/<label>` mounts apply) and the demux key
 * removed with byte-preserving query surgery — every other parameter keeps
 * its original order and encoding.
 */
function worldUrlOf(url: string | undefined): string {
  const raw = stripLabelFromUrl(url, HUB_MOUNT_PATH)
  const queryAt = raw.indexOf('?')
  if (queryAt === -1) return raw
  const kept = raw.slice(queryAt + 1).split('&').filter((pair) => {
    if (pair === '') return false
    const eq = pair.indexOf('=')
    return (eq === -1 ? pair : pair.slice(0, eq)) !== 'agent'
  })
  return kept.length === 0 ? raw.slice(0, queryAt) : `${raw.slice(0, queryAt)}?${kept.join('&')}`
}

/** Reason phrases for the raw-socket upgrade rejections this family writes. */
const REASON_PHRASE: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' }

/** Reject an upgrade on the raw socket (no ws ownership transfer). */
function rejectUpgrade(socket: unknown, status: number, body: string, contentType: string): void {
  const writable = socket as { write?: (chunk: string) => unknown; destroy?: () => void }
  writable.write?.(
    `HTTP/1.1 ${status} ${REASON_PHRASE[status] ?? 'Rejected'}\r\n`
    + 'Connection: close\r\n'
    + `Content-Type: ${contentType}\r\n`
    + `Content-Length: ${String(Buffer.byteLength(body, 'utf8'))}\r\n\r\n`
    + body,
  )
  writable.destroy?.()
}

/**
 * Run the boolean gate against an upgrade: the authorizer's false path writes
 * to a `res` that does not exist on an upgrade, so the answer is captured and
 * replayed on the raw socket verbatim. False means the upgrade was answered.
 */
function gateUpgrade(options: HubRouteOptions, req: WorldRequest, socket: unknown): boolean {
  let status = 401
  let body: string | undefined
  const admitted = options.authorize(req, {
    writeHead: (answered: number) => { status = answered },
    end: (chunk?: unknown) => { if (chunk !== undefined && chunk !== null) body = String(chunk) },
  })
  if (admitted) return true
  rejectUpgrade(socket, status, body ?? '', 'text/plain; charset=utf-8')
  return false
}

/** One shared 404 answer shape for family-level demux misses. */
function answer404(res: WorldResponse, body: Record<string, unknown>): void {
  writeJson(res, 404, JSON.stringify(body))
}

/**
 * Register the family on ctx0's webServer.
 * @param options - see {@link HubRouteOptions}.
 * @returns the disposer unregistering both routes.
 */
export function registerHubRoute(options: HubRouteOptions): () => void {
  const handleRequest = async (req: WorldRequest, res: WorldResponse): Promise<void> => {
    // ctx0's gate first (world-mount order): false ⇒ already answered.
    if (!options.authorize(req, res)) return
    // Then the SAME browser-trust fence the sibling carrier family runs
    // (the kernel's first statement there): before ANY family answer — the
    // demux 404s below are for trusted traffic only.
    const rejection = options.requestRejection?.(req)
    if (rejection !== undefined) {
      writeJson(res, rejection, JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
      return
    }
    const agent = agentOf(req)
    if (agent === undefined || agent === 'native') {
      answer404(res, {
        error: 'foreign-only',
        message: 'the /hub family serves ?agent=<label> foreign traffic only; native belongs to /api',
      })
      return
    }
    const target = options.gatewayOf(agent)
    if (target === undefined) {
      answer404(res, { error: 'unknown-agent', label: agent })
      return
    }
    // Consume the family plumbing: the kernel forwards a native-shaped URL
    // (the kernel carries the same fence face as the carrier's own kernel).
    req.url = worldUrlOf(req.url)
    await forwardApiCall({ gateway: target.gateway, peer: target.peer, label: agent, mountPath: HUB_MOUNT_PATH, requestRejection: options.requestRejection }, req, res)
  }

  const handleUpgrade = (req: WorldRequest, socket: unknown, head: Buffer): void => {
    if (!gateUpgrade(options, req, socket)) return
    // Same fence as the sibling carrier's mux: raw 401/403, no ws handover
    // for untrusted Host/Origin.
    const rejection = options.requestRejection?.(req)
    if (rejection !== undefined) {
      rejectUpgrade(socket, rejection, JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }), 'application/json')
      return
    }
    const agent = agentOf(req)
    if (agent === undefined || agent === 'native') {
      rejectUpgrade(socket, 404, JSON.stringify({ error: 'foreign-only' }), 'application/json')
      return
    }
    const target = options.gatewayOf(agent)
    if (target === undefined) {
      rejectUpgrade(socket, 404, JSON.stringify({ error: 'unknown-agent', label: agent }), 'application/json')
      return
    }
    // One mux per accepted connection: the binding resolves at upgrade time,
    // so a respawned world is addressed by its CURRENT gateway. The mux roots
    // a heartbeat interval and a per-connection WebSocketServer; on socket
    // close it must be CLOSED (world-mux clears the heartbeat only in close),
    // or every reconnect leaks the timer plus the mux graph forever.
    const mux = worldMuxOf(target.gateway, target.peer)
    ;(socket as { once?: (event: string, listener: () => void) => void }).once?.('close', () => {
      void mux.close().catch(() => undefined)
    })
    void mux.handleUpgrade(req, socket, head)
  }

  const disposers: Array<() => void> = [
    options.real.register({ kind: 'prefix', path: HUB_MOUNT_PATH, handler: handleRequest as never }),
    options.real.registerUpgrade({ path: HUB_MUX_PATH, handler: handleUpgrade as never }),
  ]
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // teardown must not throw
      }
    }
  }
}
