/**
 * World-side mount plugin (AW-B DL1/DL3) — `@pgmi-builds/superd-hub/world`.
 *
 * Inserted into the WORLD root's composition (its own process-side root, no
 * listener). Since path-separation T-D (2026-09-26, "disable their webui
 * build, just like disable their webserver") it provides the world's whole
 * remaining web-adjacent surface, shrunk to data-plane facts:
 *
 *   - the VIRTUAL `webServer` — a silent, registration-only shell
 *     (`world-web-server.ts`): every route a world plugin declares is
 *     accepted and swallowed, so the tree boots exactly as before while
 *     nothing is ever served (`/hub` is the sole entry, T-C);
 *   - the neutral `webRuntime` values — the ONE leg the disabled `web-runtime`
 *     row used to provide that the DATA plane still reads (the `connection`
 *     row injects it): loopback bind ⇒ no LAN literals, plus the deploy-level
 *     `--trusted-host` extras spawnWorld seeds the tree with (carried here by
 *     `worldMountPatches` in the row config).
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
import { superdTrustedHosts } from './world-mount.js'

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
  const worldWebServer = new WorldWebServer(mount.labelPath)
  noteWorldServer(key, worldWebServer)
  ctx.reflect.provide('webServer', worldWebServer)
  // The data-plane leg of the disabled `web-runtime` row: the `connection`
  // row injects `webRuntime` (and reads `ctx.webRuntime.trustedHosts` in its
  // config). Same neutral shape as before T-D: a loopback-only bind resolves
  // no LAN literals; the trusted-host extras are the same deploy-level env
  // list `spawnWorld` feeds this tree as `--trusted-host` arguments (one
  // derivation: `superdTrustedHosts`).
  ctx.reflect.provide('webRuntime', { lanAddresses: [], trustedHosts: superdTrustedHosts(process.env.SUPERD_TRUSTED_HOSTS) })
  // The world's `/api` fetch handler (exact Fetch routes + the gateway's RPC
  // interceptor) is published here so the hub's `/hub` family can forward
  // non-envelope GET/HEAD traffic into the world's registered routes; auth
  // stays in ctx0's domain because the family fences the request BEFORE this
  // handler runs. (The world's own index-authorization neutralization is
  // gone with T-D: no world page exists to authorize.)
  let dropWorldFetch: (() => void) | undefined
  ctx.inject(['connection'], (webCtx) => {
    const connection = webCtx.get('connection') as {
      createSharedFetchHandler?: (channel: string) => WorldFetchHandler
    } | undefined
    if (connection === undefined) return
    if (typeof connection.createSharedFetchHandler === 'function') {
      dropWorldFetch = publishWorldFetch(key, connection.createSharedFetchHandler('/api'))
    }
  })
  ctx.effect(() => () => {
    dropWorldFetch?.()
  }, 'superd-world-mount: virtual webServer')
}

export default apply
