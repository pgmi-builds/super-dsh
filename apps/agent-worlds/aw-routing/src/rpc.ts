/**
 * App-level selector RPC face (adapted from the shelved route's per-session
 * key face, 2026-09-10 ruling: ONE selector for the whole app).
 *
 * Auth conclusion (upstream source, inherited verbatim from the shelved
 * route): every upstream `/api/*` feature mounts via
 * `ctx.connection.fetch.register(...)` — the client-connection service owns
 * the single `/api` prefix webServer route and runs the Host/Origin
 * browser-trust fence + persistent browser auth before dispatching.
 * Registering our own webServer route would bypass that fence. We mount
 * through `connection.fetch` and inherit it.
 *
 * This face is superd-owned control traffic: it must ALWAYS be answered by
 * CTX0 locally and never forwarded to a foreign context (the selector is
 * the control plane, not the data plane).
 */
import type { Context } from '@deepseek-ai/cordis'
import { readSelector, writeSelector } from './selector.js'
import { listRuntimeKeys } from './targets.js'

/** The shared-channel Fetch route path this RPC face owns. */
export const AGENT_RUNTIME_RPC_PATH = '/api/agent-runtime'

/** What the RPC reads to compute the `available` list. */
export interface RuntimeTargetSource {
  /** Registered runtime keys, including `native`. */
  listRuntimes(): string[]
}

/** The live registry view: native plus every registered foreign context. */
export const registryTargets: RuntimeTargetSource = {
  listRuntimes: listRuntimeKeys,
}

/** Structural type of `ctx.connection.fetch` (upstream: HostConnectionFetch). */
interface ConnectionFetchFace {
  register(route: {
    path: string
    methods: readonly ('GET' | 'HEAD' | 'POST')[]
    requestBody: 'buffered'
    fetch: (request: Request) => Promise<Response>
  }): () => Promise<void>
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function handle(request: Request, source: RuntimeTargetSource): Promise<Response> {
  const available = source.listRuntimes()
  if (request.method === 'GET') {
    return json(200, { runtime: readSelector(), available })
  }
  // POST: app-level switch — one value for the whole world.
  let payload: unknown
  try {
    payload = JSON.parse(await request.text())
  } catch {
    return json(400, { error: 'body must be valid JSON' })
  }
  const { runtime } = (payload ?? {}) as { runtime?: unknown }
  if (typeof runtime !== 'string' || runtime === '') return json(400, { error: 'runtime (string) is required' })
  if (!available.includes(runtime)) {
    return json(400, { error: `unknown runtime "${runtime}"`, available })
  }
  writeSelector(runtime)
  return json(200, { runtime, available })
}

/**
 * Register the selector RPC face on the shared `/api` connection channel
 * (behind the standard browser-trust + auth fence). No-op when the
 * `connection` service is absent (e.g. fake-ctx unit tests).
 */
export function registerSelectorRpc(ctx: Context, source: RuntimeTargetSource): void {
  ctx.inject(['connection'], (connCtx) => {
    const fetchFace = (Reflect.get(connCtx, 'connection') as { fetch?: ConnectionFetchFace } | undefined)?.fetch
    if (fetchFace === undefined) return // connection not actually present (test ctx)
    connCtx.effect(() => fetchFace.register({
      path: AGENT_RUNTIME_RPC_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => handle(request, source),
    }), 'multi-agent-routing: /api/agent-runtime route')
  })
}
