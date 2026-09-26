/**
 * World-side mount plugin (AW-B DL1/DL3) — `@pgmi-builds/superd-hub/world`.
 *
 * Inserted into the WORLD root's composition (its own process-side root, no
 * listener). It provides the virtual `webServer` for that root, so every
 * route the world's plugins declare has something to bind to. Since
 * path-separation T-C (2026-09-26, `/hub` is the sole entry; no URL-path
 * fallback) that server is a SILENT surface: registrations are accepted and
 * swallowed — no `/<label>/…` route lands on ctx0's real webServer, so the
 * world's pages are unreachable from the outside while the tree boots exactly
 * as before (the world web rows themselves retire with T-D).
 *
 * The RPC channel is NOT the world's: the hub's `/hub` family
 * (`hub-route.ts`) answers `?agent=<key>` traffic in ctx0's auth domain,
 * dispatching to this world's gateway instance. Non-envelope GET/HEAD traffic
 * is forwarded into the world's registered exact Fetch routes (session-log
 * export and friends) through the shared `/api` fetch handler this plugin
 * publishes into the cross-root registry (`world-host.ts`) — still behind
 * ctx0's fence, never the world's own.
 */
import type { Context } from '@deepseek-ai/cordis'
import { noteWorldServer, publishWorldFetch, takeHostMount, type WorldFetchHandler } from './world-host.js'
import { WorldWebServer } from './world-web-server.js'

/** Stable Cordis plugin name. */
export const name = 'superd-world-mount'

/** Row config: which world this root is. */
export interface Config {
  key: string
}

/** Apply the world mount. @param ctx - the WORLD root context. @param config - `{ key }`. */
export function apply(ctx: Context, config?: { key?: unknown }): void {
  const key = typeof config?.key === 'string' ? config.key : undefined
  if (key === undefined) {
    ctx.logger?.warn?.('superd-world-mount: missing config.key — world not mounted')
    return
  }
  const mount = takeHostMount(key)
  if (mount === undefined) {
    ctx.logger?.warn?.(`superd-world-mount: no host mount registered for key ${JSON.stringify(key)}`)
    return
  }
  const worldWebServer = new WorldWebServer(mount.labelPath, {
    onIndexInject: (table) => { ctx.emit('webserver/index-inject', table) },
  })
  noteWorldServer(key, worldWebServer)
  ctx.reflect.provide('webServer', worldWebServer)
  // The world's frontend-static still asks ITS OWN connection to authorize an
  // index request. No index request has reached a world since T-C (pages are
  // unreachable from ctx0), so the neutralization below is inert belt-and-
  // braces until T-D retires the world web rows — kept so the world tree
  // composes unchanged. The same connection also composes the world's `/api`
  // fetch handler (exact Fetch routes + the gateway's RPC interceptor). It is
  // published here so the hub's `/hub` family can forward non-envelope
  // GET/HEAD traffic into the world's registered routes; auth stays in ctx0's
  // domain because the family fences the request BEFORE this handler runs.
  let dropWorldFetch: (() => void) | undefined
  ctx.inject(['connection'], (webCtx) => {
    const connection = webCtx.get('connection') as {
      authorizeIndex?: (...rest: unknown[]) => boolean
      createSharedFetchHandler?: (channel: string) => WorldFetchHandler
    } | undefined
    if (connection === undefined) return
    if (typeof connection.authorizeIndex === 'function') {
      connection.authorizeIndex = () => true
    }
    if (typeof connection.createSharedFetchHandler === 'function') {
      dropWorldFetch = publishWorldFetch(key, connection.createSharedFetchHandler('/api'))
    }
  })
  ctx.effect(() => () => {
    worldWebServer.dispose()
    dropWorldFetch?.()
  }, 'superd-world-mount: virtual webServer')

}

export default apply
