/**
 * Per-world virtual webServer (AW-B DL3; path-separation T-C silent sink →
 * T-D registration-only shell).
 *
 * A world's plugins still declare ANY path they like (`/api`, `/plugins`,
 * `/whatever-name-i-like`), and the world root still needs a `webServer`
 * provider for them to bind (the `modules` row injects it; `worldMountPatches`
 * pins that inject). It used to translate every registration onto ctx0's real
 * webServer as `/<label>+path` — the per-label page family. T-C (2026-09-26,
 * user ruling "strip off the per agent url path … no need the url path
 * fallback (we have git history)") severed that: every route a world plugin
 * declares is accepted and SWALLOWED — no `/<label>/…` route ever lands on
 * ctx0's real webServer. T-D (2026-09-26, "disable their webui build, just
 * like disable their webserver") then disabled the world webui rows
 * (`web-runtime`/`client-hmr`, see `worldMountPatches`) and retired the whole
 * index face with them: no `renderIndex`, no taps, no index injections, no
 * client mount shim — nothing renders a world page anywhere, and the mount
 * HTML pass (`index-pass.ts`) plus the shim retired with the last consumer.
 *
 * What REMAINS and why (the data-plane coupling the guardrail protects):
 *   - the `webServer` provider itself: world-tree rows (`modules`, adapter
 *     rows) inject/bind it; removing the provider would pend them and fail
 *     the world boot;
 *   - `stripLabelFromUrl`/`RealWebServerFace`: the `/hub` family
 *     (`hub-route.ts`) types ctx0's real server and strips the `/hub` prefix
 *     with the same URL rule;
 *   - the neutral `port`/`host` getters: the shape every remaining reader
 *     sees (a world owns no socket).
 *
 * The RPC channel is hub-owned: the `/hub` family (`hub-route.ts`) is the
 * sole foreign entry.
 */

/** Route match kind (mirrors the upstream contract). */
export type WebRouteKind = 'exact' | 'prefix'

/** The slice of node:http we touch (kept structural for testability). */
export interface WorldRequest { url?: string }
export interface WorldResponse {
  writeHead(status: number, headers: Record<string, string>): unknown
  end(...args: unknown[]): unknown
}

/** A world route handler as plugins write it. */
export type WorldHandler = (req: WorldRequest, ...rest: never[]) => void | Promise<void>

/** One named route registration (structural mirror of the upstream type). */
export interface WorldWebRoute {
  kind: WebRouteKind
  path: string
  handler: (req: WorldRequest, res: WorldResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration. */
export interface WorldWebUpgradeRoute {
  path: string
  handler: (req: WorldRequest, socket: unknown, head: Buffer) => void | Promise<void>
}

/**
 * The real (ctx0) webServer surface — since T-C no longer reachable from a
 * world mount. The type stays for the `/hub` family (`hub-route.ts`), which
 * registers on ctx0's real webServer directly.
 */
export interface RealWebServerFace {
  register(route: { kind: WebRouteKind; path: string; handler: never }): () => void
  registerUpgrade(route: { path: string; handler: never }): () => void
  registerFallback(handler: never): () => void
  tapIndex?(transform: (html: string) => string): () => void
  readonly port?: number
  readonly host?: string
}

/** Remove the mount label from `req.url`, preserving the trailing query. */
export function stripLabelFromUrl(url: string | undefined, labelPath: string): string {
  const raw = typeof url === 'string' && url !== '' ? url : '/'
  const queryAt = raw.indexOf('?')
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt)
  const rest = queryAt === -1 ? '' : raw.slice(queryAt)
  if (path === labelPath) return `/${rest}`
  if (path.startsWith(`${labelPath}/`)) return `${path.slice(labelPath.length)}${rest}`
  return raw
}

/** No-op registration disposer (the swallowed-route shape). */
function swallowed(): () => void {
  return () => {}
}

/**
 * One world's web surface — a registration-only shell: it accepts every
 * registration a world plugin makes (so the tree boots and composes exactly
 * as before) and forwards none of them anywhere; nothing is stored, nothing
 * is served (T-C), and nothing renders (T-D).
 */
export class WorldWebServer {
  /**
   * @param labelPath - mount root, e.g. `/omp` (no trailing slash) — the
   *   world's identity record; no page is ever served under it.
   */
  constructor(readonly labelPath: string) {
    if (typeof labelPath !== 'string' || !labelPath.startsWith('/') || labelPath === '/' || labelPath.endsWith('/')) {
      throw new Error(`world-web-server: labelPath must start with "/" and carry no trailing slash, got ${JSON.stringify(labelPath)}`)
    }
  }

  /**
   * The ctx0 listener facts (read-through retired with the mount): worlds
   * keep the same neutral defaults the disconnected read-through always
   * fell back to — a world owns no socket and no page anyone can hit.
   */
  get port(): number {
    return 0
  }

  /** The neutral bind host (see {@link WorldWebServer.port}). */
  get host(): string {
    return '127.0.0.1'
  }

  /**
   * Accept one world route — and swallow it (T-C): pages have no road to
   * ctx0. The disposer is a no-op, matching the swallowed-registration
   * contract the `/api` family always had.
   */
  register(_route: WorldWebRoute): () => void {
    return swallowed()
  }

  /** Accept one world upgrade route — and swallow it (see {@link register}). */
  registerUpgrade(_route: WorldWebUpgradeRoute): () => void {
    return swallowed()
  }

  /**
   * Accept the world's SPA fallback claim — and swallow it (see
   * {@link register}): the ctx0 fallback seat was always native
   * frontend-static's alone.
   */
  registerFallback(_handler: (req: WorldRequest, res: WorldResponse) => void | Promise<void>): () => void {
    return swallowed()
  }
}
