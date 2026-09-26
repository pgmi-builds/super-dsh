/**
 * Cross-root mount registry (AW-B DL1/DL3).
 *
 * A world runs as its OWN cordis ROOT (events are root-scoped — probe
 * 2026-09-16), so ctx0 and the world cannot share service instances through
 * the context tree. They DO share this module (the profile links
 * `@pgmi-builds/superd-hub` at the same path), which is where the host hands the
 * world what it needs to mount itself:
 *
 *   ctx0 hub  → registerHostMount({ key, labelPath, real })   (before spawn)
 *   world     → takeHostMount(key) → provides the virtual `webServer`
 *
 * T-C (2026-09-26): the `real`/`authorize` legs are RETIRED — the world's
 * virtual webServer swallows every registration (`/hub` is the sole entry, no
 * URL-path fallback), so nothing crosses to ctx0's listener anymore. The
 * fields stay on the published shape only because the adapter world-plugins'
 * spawn-time call sites still pass them (zero-churn hub-layer sever); the
 * mount itself remains the world's addressability record (`agentLinks`).
 *
 * No selection state: the key is the world's own identity, fixed at spawn.
 */
import type { RealWebServerFace } from './world-web-server.js'

/** What the host publishes for one world mount (the world's identity record). */
export interface HostMount {
  /** Runtime key (`omp`, `codex`, …) — equals the mount label. */
  key: string
  /** Mount root (`/omp`). */
  labelPath: string
  /** (inert since T-C) ctx0's webServer instance — no world route reaches it. */
  real: RealWebServerFace
  /**
   * (inert since T-C) ctx0's index authorization — no world page is served,
   * so nothing consults it; kept for adapter call-site compatibility.
   */
  authorize?(req: unknown, res: unknown): boolean
}

const mounts = new Map<string, HostMount>()


/** Publish the host side of one world mount (idempotent replace). */
export function registerHostMount(mount: HostMount): () => void {
  mounts.set(mount.key, mount)
  return () => {
    if (mounts.get(mount.key) === mount) mounts.delete(mount.key)
  }
}

const servers = new Map<string, unknown>()

/** Record the virtual webServer a world root provided (diagnostics/tests). */
export function noteWorldServer(key: string, server: unknown): void {
  servers.set(key, server)
}

/** The virtual webServer a world root provided, if it mounted yet. */
export function worldServerOf(key: string): unknown {
  return servers.get(key)
}

/** Read one host mount (called from inside the world root). */
export function takeHostMount(key: string): HostMount | undefined {
  return mounts.get(key)
}

/** Keys with a published host mount. */
export function listHostMounts(): string[] {
  return [...mounts.keys()]
}

/**
 * The structural face of a world connection's shared `/api` fetch handler
 * (upstream `ConnectionFetchHandler` from `client/connection`): exact Fetch
 * routes first, then the shared-channel RPC interceptor, then 404. Trust and
 * authentication are NOT part of this face — upstream applies them in the
 * physical carrier around it, which under a mount is the hub's carrier with
 * ctx0's fence.
 */
export interface WorldFetchHandler {
  /** Resolve body handling for one request before any bytes are read. */
  requestBodyMode(request: { readonly method: string; readonly url: URL }): 'buffered' | 'streaming'
  /** Dispatch one already-authenticated request to its route owner. */
  fetch(request: Request): Promise<Response>
}

const worldFetchHandlers = new Map<string, WorldFetchHandler>()

/**
 * Publish one world's shared `/api` fetch handler so the hub's `/hub` family
 * can forward non-envelope traffic (`?agent=<label>` GET/HEAD) into the
 * world's registered routes (session-log export and friends). Called from
 * inside the world root (`world-entry`); read from the host root
 * (`carrier`). Idempotent replace.
 */
export function publishWorldFetch(key: string, handler: WorldFetchHandler): () => void {
  worldFetchHandlers.set(key, handler)
  return () => {
    if (worldFetchHandlers.get(key) === handler) worldFetchHandlers.delete(key)
  }
}

/** The world's published shared `/api` fetch handler, if its root published one yet. */
export function worldFetchHandlerOf(key: string): WorldFetchHandler | undefined {
  return worldFetchHandlers.get(key)
}

