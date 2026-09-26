/**
 * Per-world virtual webServer (AW-B DL3; path-separation T-C: a SILENT
 * surface).
 *
 * A world's plugins still declare ANY path they like (`/api`, `/plugins`,
 * `/whatever-name-i-like`), and the world root still needs a `webServer`
 * provider for them to bind (`worldMountPatches` pins the `modules` row to
 * wait for it). It used to translate every registration onto ctx0's real
 * webServer as `/<label>+path` — the per-label page family. T-C (2026-09-26,
 * user ruling "strip off the per agent url path … no need the url path
 * fallback (we have git history)") severs exactly that: every route a world
 * plugin declares is accepted and SWALLOWED. No `/<label>/…` route ever lands
 * on ctx0's real webServer, so a world's pages are unreachable from the
 * outside while its tree keeps booting untouched — the world still composes
 * its web rows (their retirement is T-D's scope), their output simply goes
 * nowhere. The RPC channel was always hub-owned and stays with the hub: the
 * `/hub` family (`hub-route.ts`) is the sole foreign entry.
 *
 * What remains live is the world-local index face: `renderIndex` (the world's
 * frontend-static still renders through it) with the client mount shim, the
 * world's own index-inject rows and its taps — all consumed inside the world
 * tree; T-D retires that baking together with the world webui rows.
 */
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { rewriteIndexHtml } from './index-pass.js'
import { renderClientShim } from './client-shim.js'

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

/** Options: how this world collects its own index rows. */
export interface WorldWebServerOptions {
  /**
   * Push the world's index injection rows. The world plugin supplies a
   * function that emits on the WORLD root (never on ctx0's tree).
   */
  onIndexInject?(table: IndexInjection[]): void
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
 * One world's web surface — since T-C a silent sink: it accepts every
 * registration a world plugin makes (so the tree boots and composes exactly
 * as before) and forwards none of them anywhere.
 */
export class WorldWebServer {
  private readonly taps: Array<(html: string) => string> = []

  /**
   * @param labelPath - mount root, e.g. `/omp` (no trailing slash) — the
   *   world's identity, still baked into its index pass.
   * @param options - world-local index row source.
   */
  constructor(
    readonly labelPath: string,
    private readonly options: WorldWebServerOptions = {},
  ) {
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

  /** World-local raw index transform (never forwarded to ctx0's taps). */
  tapIndex(transform: (html: string) => string): () => void {
    this.taps.push(transform)
    return () => {
      const at = this.taps.indexOf(transform)
      if (at !== -1) this.taps.splice(at, 1)
    }
  }

  /** Apply this world's taps in registration order. */
  applyIndexTaps(html: string): string {
    let out = html
    for (const transform of this.taps) out = transform(out)
    return out
  }

  /** Collect this world's structured rows (supplied by the world root). */
  collectIndexInjections(): IndexInjection[] {
    const table: IndexInjection[] = []
    this.options.onIndexInject?.(table)
    return table
  }

  /**
   * Render the world's index: the client mount shim first (it must run before
   * the app entry module), then the world's rows, then its taps, then the
   * mount pass (base pinned at `/<label>/`, root-absolute strings re-rooted).
   *
   * The agent roster arrives through the world's own index-inject rows (the
   * world composes the hub row); ctx0's own index gets it from the hub
   * plugin's ctx0-side row. Nothing rendered here is served to anyone since
   * T-C — the render survives because the world's frontend-static still runs
   * (T-D retires it).
   */
  renderIndex(html: string): string {
    // Injection rows FIRST, the client shim LAST: index-inject rows may need
    // to own the transport global before anything else materializes — the
    // page-trust component's `window.__DSH_TRANSPORT__ = { ownsHost: true }`
    // guards on absence, while the shim MERGES into an existing object
    // (`globalThis.__DSH_TRANSPORT__ = globalThis.__DSH_TRANSPORT__ || {}`).
    // Shim-first would create the object and silently eat the verdict.
    const rows: IndexInjection[] = [
      // No hub-invented widget here: the world composes the hub's own client
      // plugin (see worldMountPatches), so its selector IS the native one.
      ...this.collectIndexInjections(),
      { kind: 'script', placement: 'head', text: renderClientShim(this.labelPath) },
    ]
    const rendered = this.applyIndexTaps(renderIndexInjections(html, rows))
    return rewriteIndexHtml(rendered, this.labelPath)
  }

  /** Release the world-local index state (world unloaded). */
  dispose(): void {
    this.taps.length = 0
  }
}
