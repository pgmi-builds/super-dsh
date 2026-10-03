/**
 * runtime-settings-api.ts — the browser half of a runtime's settings panel.
 *
 * The panel's config belongs to the ADAPTER, so nothing here knows what an auth
 * method is: it posts a `client-request` envelope at the runtime's own world and
 * hands the adapter's answer to `parseAuthView` (agent-settings.ts).
 *
 *    POST /hub/api?agent=agy
 *    { type:'client-request', rpcId, method:'agyAuth/get'|'agyAuth/set',
 *      payload:{ args: {} | { request: { mode } } } }
 *
 * `/hub/api` is the hub family's prefix mount (`hub-route.ts`), which forwards
 * `method` verbatim to the addressed world's `typertGateway`. The path needs no
 * `CONTROL` exemption in fusion-transport.ts: the rewrite only touches same-origin
 * `/api/...` paths, and `/hub/...` is never one of them.
 *
 * Node-safe: no DOM reach at module scope and `fetch` is injectable, so
 * test/client-runtime-settings.test.mjs pins the envelope and every failure
 * branch under `node --test` (the mesh-api.ts precedent).
 *
 * @module superd-hub/client/runtime-settings-api
 */

import { parseAuthView, parseProvidersView, type RuntimeAuthView, type RuntimeProvidersView } from './agent-settings.js'

/** Structural slice of `fetch` — the bundle uses the global, tests inject a stub. */
export type FetchLike = (input: string, init: RequestInit) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

/** One rpcId for request/response correlation. `randomUUID` needs a secure context. */
export function mintRpcId(): string {
  const webCrypto: Crypto | undefined = globalThis.crypto
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID()
  if (webCrypto !== undefined && typeof webCrypto.getRandomValues === 'function') {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16))
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  return `rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** The wire body of one unary call. */
export interface ClientRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: { args: Record<string, unknown> }
}

/** Build the envelope for one panel call (exported so tests pin the exact wire shape). */
/** The operation names the adapter Remotes accept (auth ladder + providers). */
export type RuntimeSettingsOp = 'get' | 'set' | 'save' | 'remove'

export function settingsEnvelope(namespace: string, op: RuntimeSettingsOp, args: Record<string, unknown>): ClientRequestEnvelope {
  return {
    type: 'client-request',
    rpcId: mintRpcId(),
    method: `${namespace}/${op}`,
    payload: { args },
  }
}

/** What a caller can do with a failed panel call — kept structural for the tests. */
function messageOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return String(error)
}

/**
 * One unary call at a runtime's world, unwrapped to the RPC's value.
 *
 * Every failure mode is reported as a thrown `Error` carrying the adapter's own
 * message where one exists: a transport failure, a malformed answer, and the
 * gateway's business error (`{ok:false,error}`) must not look alike to the panel.
 *
 * @param agentKey - roster key addressing the world (`?agent=`).
 * @param namespace - the adapter's Remote namespace (`agyAuth`).
 * @param op - the Remote method.
 * @param args - exact named wire arguments.
 * @param doFetch - fetch implementation (tests inject).
 * @returns the raw RPC value.
 * @throws {Error} on transport, framing, or gateway failure.
 */
export async function callRuntimeSettings(
  agentKey: string,
  namespace: string,
  op: RuntimeSettingsOp,
  args: Record<string, unknown>,
  doFetch?: FetchLike,
): Promise<unknown> {
  const send: FetchLike = doFetch ?? ((input, init) => fetch(input, init))
  const envelope = settingsEnvelope(namespace, op, args)
  const response = await send(`/hub/api?agent=${encodeURIComponent(agentKey)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`settings ${envelope.method}: unreadable answer (HTTP ${response.status})`)
  }
  const result = (body as { result?: unknown } | null)?.result
  if (result === null || typeof result !== 'object') {
    throw new Error(`settings ${envelope.method}: malformed answer (HTTP ${response.status})`)
  }
  const record = result as { ok?: unknown; value?: unknown; error?: unknown }
  if (record.ok === true) return record.value
  const error = record.error as { message?: unknown; code?: unknown } | undefined
  if (error !== undefined && typeof error.message === 'string') {
    throw new Error(error.message)
  }
  throw new Error(`settings ${envelope.method}: failed (HTTP ${response.status})`)
}

/** Read one runtime's panel state, parsed. */
export async function fetchAuthView(
  agentKey: string,
  namespace: string,
  doFetch?: FetchLike,
): Promise<RuntimeAuthView> {
  const value = await callRuntimeSettings(agentKey, namespace, 'get', {}, doFetch)
  const view = parseAuthView(value)
  if (view === undefined) throw new Error('settings: the runtime returned no usable auth options')
  return view
}

/** Adopt one auth form (`null` clears the explicit choice). */
export async function setAuthMode(
  agentKey: string,
  namespace: string,
  mode: string | null,
  doFetch?: FetchLike,
): Promise<RuntimeAuthView> {
  const value = await callRuntimeSettings(agentKey, namespace, 'set', { request: { mode } }, doFetch)
  const view = parseAuthView(value)
  if (view === undefined) throw new Error('settings: the runtime returned no usable auth options')
  return view
}

// ------------------------------------------- the codex providers body (P4)

// Same transport, same namespace rule; only the operation names and the
// argument shapes differ. Every call re-parses the adapter's answer through
// `parseProvidersView`, so a malformed reply is an error here rather than a
// half-rendered panel.

function requireProvidersView(value: unknown): RuntimeProvidersView {
  const view = parseProvidersView(value)
  if (view === undefined) throw new Error('settings: the runtime returned no usable provider list')
  return view
}

/** Read the multi-provider state of one runtime. */
export async function fetchProvidersView(
  agentKey: string,
  namespace: string,
  doFetch?: FetchLike,
): Promise<RuntimeProvidersView> {
  return requireProvidersView(await callRuntimeSettings(agentKey, namespace, 'get', {}, doFetch))
}

/**
 * Add or edit one provider in the adapter's list. Which provider a session runs
 * on is DSH's own per-session model selection, so this touches no active half.
 */
export async function saveProvider(
  agentKey: string,
  namespace: string,
  provider: unknown,
  doFetch?: FetchLike,
): Promise<RuntimeProvidersView> {
  return requireProvidersView(await callRuntimeSettings(agentKey, namespace, 'save', { request: { provider } }, doFetch))
}

/** Drop one provider from the list. Does not rewrite the runtime's own config. */
export async function removeProvider(
  agentKey: string,
  namespace: string,
  id: string,
  doFetch?: FetchLike,
): Promise<RuntimeProvidersView> {
  return requireProvidersView(await callRuntimeSettings(agentKey, namespace, 'remove', { request: { id } }, doFetch))
}

export { messageOf as settingsErrorText }
