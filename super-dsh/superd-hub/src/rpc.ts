/**
 * Control-plane RPC face for the agents hub (DL7: NO server-side selection).
 *
 * Auth conclusion (upstream source, inherited from the shelved route): every
 * upstream `/api/*` feature mounts via `ctx.connection.fetch.register(...)` —
 * the client-connection service owns the single `/api` prefix webServer route
 * and runs the Host/Origin browser-trust fence + persistent browser auth
 * before dispatching. Registering our own webServer route would bypass that
 * fence; we mount through `connection.fetch` and inherit it.
 *
 * This face is superd-owned control traffic and is ALWAYS answered by CTX0:
 * it reports which worlds exist. It carries no selection: world ownership is
 * per-request and travels on the mount path (`/<label>/...`, see carrier.ts),
 * so two tabs on two worlds cannot step on each other.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { listRuntimeKeys } from './targets.js'
import { agentLinks } from './agent-roster.js'
import { ensureSelf } from './machines.js'

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

/** Injection seam for the roster/hub identity: the hub home backing the a6
 * id store and the machines registry. Defaults to `resolveDshHome()`
 * (registerSelectorRpc passes no deps — the same home the rest of this
 * process uses); unit tests inject a tmpdir so nothing ever touches an
 * ambient/prod DSH_HOME. */
export interface AgentRuntimeDeps {
  home?: string
}

/** The hub package's own version, read once at module load. createRequire
 * keeps it sync and resolves from dist/ too — package.json always ships
 * beside the compiled output (npm includes it unconditionally). */
const { version: HUB_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string }

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

/**
 * The control-plane handler: world inventory only.
 *
 * ADDITIVE contract (mesh P1): the GET body gained `hub: {machineId, label,
 * version}` and every `agents` row gained `id` (a6); `available` and all
 * pre-existing agents fields are unchanged — old clients ignore the new
 * fields, new clients read them.
 * @param request - the incoming `/api/agent-runtime` request.
 * @param source - live runtime registry view.
 * @param deps - optional home override; defaults to `resolveDshHome()`.
 * @returns the JSON response.
 */
export async function handleAgentRuntime(
  request: Request,
  source: RuntimeTargetSource,
  deps?: AgentRuntimeDeps,
): Promise<Response> {
  const available = source.listRuntimes()
  if (request.method === 'GET' || request.method === 'HEAD') {
    // The selector asks this face for the roster: keys AND the mount path each
    // key is addressed by. Read-only — the roster carries no selection. The
    // hub block (this machine's m4 + label + hub version) rides along for the
    // multi-machine UI; the a6 row ids ride on every agents row.
    const home = deps?.home ?? resolveDshHome()
    const self = ensureSelf(home, 'local')
    return json(200, { available, agents: agentLinks(home), hub: { machineId: self.id, label: self.label, version: HUB_VERSION } })
  }
  // A POST that used to switch a global selector has no meaning any more:
  // the addressed world is the mount path of the request, not a shared value.
  return json(400, {
    error: 'selection is per-request (mount path); no server-side switch',
    available,
  })
}

/**
 * Register the control-plane RPC face on the shared `/api` connection channel
 * (behind the standard browser-trust + auth fence). No-op when the
 * `connection` service is absent (e.g. fake-ctx unit tests). The route answers
 * with the DEFAULT home (`resolveDshHome()` at request time); callers needing
 * a pinned home invoke handleAgentRuntime directly with deps.
 */
export function registerSelectorRpc(ctx: Context, source: RuntimeTargetSource): void {
  ctx.inject(['connection'], (connCtx) => {
    const fetchFace = (Reflect.get(connCtx, 'connection') as { fetch?: ConnectionFetchFace } | undefined)?.fetch
    if (fetchFace === undefined) return // connection not actually present (test ctx)
    connCtx.effect(() => fetchFace.register({
      path: AGENT_RUNTIME_RPC_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => handleAgentRuntime(request, source),
    }), 'superd-hub: /api/agent-runtime route')
  })
}
