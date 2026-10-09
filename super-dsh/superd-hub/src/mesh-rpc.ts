/**
 * Machine-mesh management API (mesh P1, spec §6.3): the add-machine face
 * mounted behind `ctx.connection.fetch` — the client-connection service owns
 * the single `/api` prefix webServer route and runs the Host/Origin
 * browser-trust fence + persistent browser auth before dispatching (same
 * auth conclusion as rpc.ts; registering our own webServer route would
 * bypass that fence).
 *
 * Route + handler ONLY — pairing/probing business logic lives in
 * `./mesh-link.js`, persistence in `./machines.js`. This module never writes
 * the mesh-link status table: `machineStatus()` is imported READ-ONLY and
 * joined into GET rows by id (absent → `'pending'`).
 *
 * One exact route, body/method dispatched:
 *   GET    /api/superd/machines            → `{self, machines}` (public row
 *                                           projection — NEVER token/cookie on
 *                                           a row; the SELF block carries a 10-char
 *                                           token PREVIEW for the copy affordance,
 *                                           full token only via op 'tokenUrl')
 *   POST   /api/superd/machines            → `{op?: 'reprobe' | 'tokenUrl', ...}`:
 *        op:'reprobe' + {id}               → `{probe: ProbeResult}` (the
 *                                           brief's `/machines/reprobe` path
 *                                           variant is FOLDED here because
 *                                           connection.fetch matches by exact
 *                                           path — one registration, body
 *                                           dispatch; documented per Task 3
 *                                           controller amendment)
 *        op:'tokenUrl' + {origin}          → `{tokenUrl}` — the caller's
 *                                           origin tokenized with the process's
 *                                           live launch token via the connection
 *                                           face's public `authenticatedUrl`
 *                                           (spec hub-roster-identity §3); the
 *                                           GET projection still carries no secret
 *        otherwise `{name, tokenUrl}` → pairMachine → 201 `{machine}`;
 *                                           any failure → 400 `{error}` (the
 *                                           message is mesh-link's own,
 *                                           already token-redacted)
 *   DELETE /api/superd/machines?id=<m4>    → `{removed: true|false}`
 *   DELETE /api/superd/machines?id=<m4>    → `{removed: true|false}`; a successful
 *                                           removal ALSO announces `emitMachineRemoved`
 *                                           on mesh-link's federation bus (mesh P2
 *                                           Task 3) — the registrar defederates the
 *                                           machine's rows; this module stays
 *                                           route+handler only (no mesh-federate import)
 * `DELETE` note: upstream's declared `ConnectionFetchMethod` union is
 * `GET | HEAD | POST`, but the runtime route table dispatches through an
 * untyped `methods.has(method)` set and `assertFetchRoute` never inspects
 * method names (packages/client/connection/src/rpc-host.ts, verified against
 * dsh-v0.1.7-rc.1) — DELETE rides the same exact-path dispatch. If a future
 * upstream tightens that, remove folds into a POST op like reprobe.
 */
import type { Context } from '@deepseek-ai/cordis'
import { hostname } from 'node:os'
import { type MachineRow, ensureSelf, listRemotes, removeRemote } from './machines.js'
import { machineStatus, pairMachine, receivePairing, reprobeMachine, emitMachineRemoved, type MutualPairing, type ProbeResult, type MachineStatusEntry } from './mesh-link.js'
import { type A2aIngest } from './a2a-ingest.js'
import { A2A_ENDPOINT_PATH, A2A_OUTBOX_PATH, A2A_WIRE_VERSION, decodeA2aWireFrame } from './a2a-wire.js'
import type { A2aLogFn } from './a2a-log.js'
import { EXEC_API_BASE, parseOneShotExecBody, runOneShotExec } from './exec.js'

/** The shared-channel Fetch route path this API owns. */
export const MESH_API_BASE = '/api/superd/machines'

/** Injection seam: the hub home (registry + pairing live under it) and an
 *  optional fetch override for tests. `home` is resolved by the caller
 *  (gateway.ts passes `resolveDshHome()` at registration time); this module
 *  stays free of home-resolution logic. `tokenUrlOf` tokenizes an origin with
 *  the process's live launch token — built from the connection face's
 *  `authenticatedUrl` at registration; tests inject a fake (and may omit it
 *  to pin the missing-face 400). */
export interface MeshDeps {
  home: string
  fetchImpl?: typeof fetch
  tokenUrlOf?: (origin: string) => string
}

/** The GET/POST row shape as it crosses the wire — the persisted MachineRow
 *  minus its two secrets (`token`, `cookie`), plus the joined status (and,
 *  additively since I2/mesh P3 5a, the version-mismatch warning when the
 *  mesh-link status entry carries one). `name` is the machine's sole display
 *  identity (spec hub-roster-identity §4). */
export interface MachinePublicRow {
  id: string
  name: string
  origin: string
  enabled: boolean
  addedAt: number
  status: string
  lastProbeAt?: number
  error?: string
  versionWarning?: string
}

/** Structural type of `ctx.connection.fetch` (upstream: HostConnectionFetch).
 *  Methods widened with 'DELETE' | 'PUT' | 'PATCH' — see the module header's
 *  dispatch note (runtime route table dispatches an untyped method set). */
interface ConnectionFetchFace {
  register(route: {
    path: string
    methods: readonly ('GET' | 'HEAD' | 'POST' | 'DELETE' | 'PUT' | 'PATCH')[]
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
 * Truncated launch-token preview for the self row (first 10 chars + ellipsis):
 * enough for the user to SEE this is a token, never enough to mint a cookie —
 * the full token rides only the explicit `tokenUrl` op.
 * @param tokenUrl - a tokenized URL (`…/?token=<value>`), as the mint answers.
 * @returns the preview, or undefined when the URL carries no token.
 */
export function tokenPreviewOf(tokenUrl: string): string | undefined {
  const at = tokenUrl.indexOf('token=')
  if (at === -1) return undefined
  const raw = tokenUrl.slice(at + 'token='.length)
  const amp = raw.indexOf('&')
  const token = amp === -1 ? raw : raw.slice(0, amp)
  if (token === '') return undefined
  return `${token.slice(0, 10)}…`
}

/** Project one persisted row to its public wire shape (allowlist — never
 *  token, never cookie) and join the mesh-link status entry by id. */
function publicRow(row: MachineRow): MachinePublicRow {
  return projectRow(row, machineStatus())
}

function projectRow(row: MachineRow, status: ReadonlyMap<string, MachineStatusEntry>): MachinePublicRow {
  const entry = status.get(row.id)
  if (entry === undefined) return { id: row.id, name: row.name, origin: row.origin, enabled: row.enabled, addedAt: row.addedAt, status: row.incoming && !row.cookie ? 'unreachable' : 'pending' }
  const out: MachinePublicRow = { id: row.id, name: row.name, origin: row.origin, enabled: row.enabled, addedAt: row.addedAt, status: entry.status, lastProbeAt: entry.lastProbeAt }
  if (entry.error !== undefined) out.error = entry.error
  if (entry.versionWarning !== undefined) out.versionWarning = entry.versionWarning
  return out
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch (err) {
    throw new Error(`mesh-api: request body is not valid JSON — ${errMsg(err)}`)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('mesh-api: request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

/**
 * The mesh-machines handler: GET list / POST pair-or-reprobe / DELETE remove.
 * @param request - the incoming `/api/superd/machines` request.
 * @param deps - home + optional fetch override (tests inject a fixture).
 * @returns the JSON response.
 */
export async function handleMeshMachines(request: Request, deps: MeshDeps): Promise<Response> {
  const method = request.method
  if (method === 'GET') return handleList(deps)
  if (method === 'POST') return handlePost(request, deps)
  if (method === 'DELETE') return handleRemove(request, deps)
  return json(405, { error: `mesh-api: method ${method} is not supported on ${MESH_API_BASE}` })
}

/** GET: self (lazily minted on first need, spec §3.1) + every remote row in
 *  its public projection, status joined from the mesh-link table. The self
 *  block carries a truncated token preview (see {@link tokenPreviewOf}) when
 *  the mint face is available — display aid for the copy affordance, never
 *  the token itself. */
function handleList(deps: MeshDeps): Response {
  const self = ensureSelf(deps.home, 'local')
  const status = machineStatus()
  const machines = listRemotes(deps.home).map((row) => projectRow(row, status))
  // Cosmetic leg: a throwing mint face degrades to no preview, never a failed
  // machines GET.
  let preview: string | undefined
  if (deps.tokenUrlOf !== undefined) {
    try { preview = tokenPreviewOf(deps.tokenUrlOf('http://localhost/')) } catch { /* degrade */ }
  }
  return json(200, {
    self: preview === undefined ? self : { ...self, tokenPreview: preview },
    machines,
  })
}

/**
 * Validate a token-url request origin: an absolute host-bearing URL that is ONLY
 * an origin — no path, query, hash, or credentials. The pairing URL a user
 * copies must address the server root (`authorizeIndex` answers `/` only),
 * and anything beyond the origin would smuggle parts the mint would overwrite
 * or drop anyway.
 * @param origin - the client-supplied origin (trim before calling).
 * @returns the normalized origin, or the failure reason.
 */
export function parsePairingOrigin(origin: string): { ok: true; origin: string } | { ok: false; error: string } {
  if (origin === '') return { ok: false, error: 'mesh-api: tokenUrl body must be {op: "tokenUrl", origin} with a non-empty origin' }
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return { ok: false, error: 'mesh-api: tokenUrl origin is not a parseable absolute URL' }
  }
  if (url.host === '') return { ok: false, error: 'mesh-api: tokenUrl origin must name a host' }
  if (url.username !== '' || url.password !== '') return { ok: false, error: 'mesh-api: tokenUrl origin must not carry credentials' }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    return { ok: false, error: 'mesh-api: tokenUrl origin must be a bare origin (no path, query or hash)' }
  }
  return { ok: true, origin: url.protocol + '//' + url.host }
}

/** POST op `tokenUrl`: tokenize the caller's origin with the live launch
 *  token (spec hub-roster-identity §3). The answer rides a POST the user
 *  explicitly clicks — the GET projection still carries no secret. */
function handleTokenUrl(body: Record<string, unknown>, deps: MeshDeps): Response {
  const raw = typeof body.origin === 'string' ? body.origin.trim() : ''
  const parsed = parsePairingOrigin(raw)
  if (!parsed.ok) return json(400, { error: parsed.error })
  if (deps.tokenUrlOf === undefined) {
    return json(400, { error: 'mesh-api: the host connection face exposes no authenticatedUrl — this hub cannot mint pairing URLs' })
  }
  return json(200, { tokenUrl: deps.tokenUrlOf(parsed.origin) })
}

/**
 * The initiator's self-description for the mutual-pairing reverse leg: the
 * authority the user reached us by (the request's Host header — the
 * dispatched Request's URL carries only the carrier's internal placeholder
 * origin, while the headers survive `http-bridge.ts` verbatim), tokenized,
 * plus this host's name port-qualified so two instances of one machine stay
 * distinguishable. `x-forwarded-proto` upgrades the scheme behind a TLS
 * proxy; everything else dials http. Undefined when we cannot self-describe
 * (no mint face, no Host header) — the peer can then only be paired
 * manually from its own UI.
 */
function buildMutual(request: Request, deps: MeshDeps, pageOrigin?: unknown): MutualPairing | undefined {
  if (deps.tokenUrlOf === undefined) return undefined
  const host = request.headers.get('host')
  if ((host === null || host === '') && typeof pageOrigin !== 'string') return undefined
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? 'http'
  const raw = typeof pageOrigin === 'string' ? pageOrigin : `${proto}://${host}`
  const parsed = parsePairingOrigin(raw)
  if (!parsed.ok) return undefined
  const origin = parsed.origin
  const port = new URL(origin).port
  const name = hostname()
  return {
    selfTokenUrl: deps.tokenUrlOf(origin),
    selfName: port === '' ? name : `${name}:${port}`,
  }
}

/** POST: body-dispatched — `{op: 'reprobe', id}` re-probes, `{op: 'tokenUrl',
 *  origin}` tokenizes the pairing URL, anything else is
 *  a pairing input `{name, tokenUrl}`. A user-initiated pair carries the
 *  mutual-pairing reverse leg (the peer is offered our own pairing input, so
 *  one action pairs both machines); an offer that arrived WITH
 *  `mutual: true` pairs WITHOUT its own reverse leg — the recursion stops by
 *  construction. */
async function handlePost(request: Request, deps: MeshDeps): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(request)
  } catch (err) {
    return json(400, { error: errMsg(err) })
  }
  if (typeof body.op === 'string' && body.op !== '') {
    if (body.op === 'tokenUrl') return handleTokenUrl(body, deps)
    if (body.op !== 'reprobe') return json(400, { error: `mesh-api: unknown op "${body.op}"` })
    const id = typeof body.id === 'string' && body.id !== '' ? body.id : ''
    if (id === '') return json(400, { error: 'mesh-api: reprobe body must be {op: "reprobe", id} with a non-empty id' })
    let probe: ProbeResult
    try {
      probe = await reprobeMachine(deps.home, id, { fetchImpl: deps.fetchImpl })
    } catch (err) {
      return json(400, { error: errMsg(err) })
    }
    // A settled probe outcome (even unreachable/auth-expired) is an answer,
    // not an operation failure — the status table records it either way.
    return json(200, { probe })
  }
  const name = typeof body.name === 'string' && body.name !== '' ? body.name : ''
  const tokenUrl = typeof body.tokenUrl === 'string' && body.tokenUrl !== '' ? body.tokenUrl : ''
  if (name === '' || tokenUrl === '') {
    return json(400, { error: 'mesh-api: pair body must be {name, tokenUrl} with non-empty name and tokenUrl' })
  }
  if (body.mutual === true && typeof body.machineId === 'string' && body.machineId !== '') {
    const received = await receivePairing(deps.home, { machineId: body.machineId, name, tokenUrl }, { fetchImpl: deps.fetchImpl })
    const { row, ...reciprocal } = received
    return json(201, { ...(row === undefined ? {} : { machine: publicRow(row) }), reciprocal })
  }
  // The reverse leg rides USER-initiated pairs only: an offer that arrived
  // with `mutual: true` (the peer's own reverse leg) pairs without one.
  const mutual = body.mutual === true ? undefined : buildMutual(request, deps, body.origin)
  let outcome: Awaited<ReturnType<typeof pairMachine>>
  try {
    outcome = await pairMachine(
      deps.home,
      { name, tokenUrl, ...(mutual === undefined ? {} : { mutual }) },
      { fetchImpl: deps.fetchImpl },
    )
  } catch (err) {
    // mesh-link errors are actionable and token-redacted (Task 2 fix round 1).
    return json(400, { error: errMsg(err) })
  }
  return json(201, {
    machine: publicRow(outcome.row),
    ...(outcome.mutual === undefined ? {} : { mutual: outcome.mutual }),
  })
}

/** DELETE: drop one remote row by `?id=`; `{removed: false}` for unknown ids. */
function handleRemove(request: Request, deps: MeshDeps): Response {
  const id = new URL(request.url).searchParams.get('id') ?? ''
  if (id === '') return json(400, { error: `mesh-api: DELETE on ${MESH_API_BASE} requires a non-empty ?id= query parameter` })
  const removed = removeRemote(deps.home, id)
  if (removed) emitMachineRemoved(id) // federation bus: the registrar drops every row of the machine
  return json(200, { removed })
}

/**
 * Register the mesh-machines API on the shared `/api` connection channel
 * (behind the standard browser-trust + auth fence). No-op when the
 * `connection` service is absent (e.g. fake-ctx unit tests). The connection
 * face also backs the `tokenUrl` op: its public `authenticatedUrl` is the
 * ONLY sanctioned way to attach the process's live launch token (spec
 * hub-roster-identity §3 — the token is random per process, never derived
 * from the stored credential seed).
 */
export function registerMeshRpc(ctx: Context, deps: MeshDeps): void {
  ctx.inject(['connection'], (connCtx) => {
    const connection = Reflect.get(connCtx, 'connection') as {
      fetch?: ConnectionFetchFace
      authenticatedUrl?: (baseUrl: string) => string
    } | undefined
    const fetchFace = connection?.fetch
    if (connection === undefined || fetchFace === undefined) return // connection not actually present (test ctx)
    // Bound method capture: `authenticatedUrl` reads the process's launch
    // token off `this`, so the closure must keep the face as receiver.
    const authenticatedUrl = typeof connection.authenticatedUrl === 'function'
      ? connection.authenticatedUrl.bind(connection)
      : undefined
    const tokenUrlOf = authenticatedUrl === undefined ? undefined : (origin: string) => authenticatedUrl(origin)
    connCtx.effect(() => fetchFace.register({
      path: MESH_API_BASE,
      methods: [...ROUTE_METHODS],
      requestBody: 'buffered',
      fetch: (request) => handleMeshMachines(request, { ...deps, ...(tokenUrlOf === undefined ? {} : { tokenUrlOf }) }),
    }), 'superd-hub: /api/superd/machines route')
  })
}

/** Every method our exact paths claim on the shared `/api` channel — unknown
 * methods land in the HANDLER's honest 405 (a PUT on a known path is "method
 * not supported", not a fall-through host 404; 2026-09-29 field finding:
 * PUT /api/superd/machines answered 404 because the registration only
 * claimed GET/POST/DELETE). */
const ROUTE_METHODS = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD'] as const

// ---------------------------------------------------------------- a2a (postoffice R3)

// (A2aRpcDeps retired in R4 — registerA2aRpc takes the SHARED ingest instance)

/**
 * POST /api/superd/a2a — body = one v1 wire frame `{v: 1, envelope}` → the
 * envelope's receipt (new/message: send receipt; stop: stop receipt;
 * reply/notice: the local delivery outcome). Malformed frames are 400s with
 * the decoder's named reason.
 */
export async function handleA2aIngestPost(request: Request, ingest: A2aIngest): Promise<Response> {
  if (request.method !== 'POST') {
    return json(405, { error: `mesh-api: method ${request.method} is not supported on ${A2A_ENDPOINT_PATH} (use POST)` })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch (err) {
    return json(400, { error: `mesh-api: a2a body is not valid JSON — ${err instanceof Error ? err.message : String(err)}` })
  }
  const decoded = decodeA2aWireFrame(body)
  if (!decoded.ok) return json(400, { error: decoded.error })
  const receipt = await ingest.ingest(decoded.envelope)
  return json(200, receipt)
}

/**
 * GET /api/superd/a2a/outbox?machine=<m4> — claim & clear the buffered
 * envelopes addressed to the claiming machine (declarative claim, D1).
 */
export function handleA2aOutboxGet(request: Request, ingest: A2aIngest): Response {
  if (request.method !== 'GET') {
    return json(405, { error: `mesh-api: method ${request.method} is not supported on ${A2A_OUTBOX_PATH} (use GET)` })
  }
  const machine = new URL(request.url).searchParams.get('machine') ?? ''
  if (machine === '') {
    return json(400, { error: 'mesh-api: a2a outbox claim requires a non-empty ?machine= query parameter' })
  }
  return json(200, { v: A2A_WIRE_VERSION, envelopes: ingest.claimOutbox(machine) })
}

/**
 * Register the a2a endpoints (POST /api/superd/a2a + GET .../outbox) on the
 * shared `/api` connection channel — same fence as the machines route. The
 * ingest instance is SHARED (R4): the initiator service's self-routing leg
 * calls the very same handler these routes call. No-op when `connection` is
 * absent.
 */
export function registerA2aRpc(ctx: Context, ingest: A2aIngest): void {
  ctx.inject(['connection'], (connCtx) => {
    const fetchFace = (Reflect.get(connCtx, 'connection') as { fetch?: ConnectionFetchFace } | undefined)?.fetch
    if (fetchFace === undefined) return // connection not actually present (test ctx)
    // (the ingest instance is injected — one instance shared with the service)
    connCtx.effect(() => fetchFace.register({
      path: A2A_ENDPOINT_PATH,
      methods: [...ROUTE_METHODS],
      requestBody: 'buffered',
      fetch: (request) => handleA2aIngestPost(request, ingest),
    }), 'superd-hub: /api/superd/a2a route')
    connCtx.effect(() => fetchFace.register({
      path: A2A_OUTBOX_PATH,
      methods: [...ROUTE_METHODS],
      requestBody: 'buffered',
      fetch: (request) => Promise.resolve(handleA2aOutboxGet(request, ingest)),
    }), 'superd-hub: /api/superd/a2a/outbox route')
  })
}

// ---------------------------------------------------------------- exec (P4, spec §8.1)

/**
 * POST /api/superd/exec — one-shot `bash -lc <cmd>` on THIS machine (spec
 * §8.1): tail-windowed stdout/stderr, two-stage group kill on timeout. The
 * auth trust boundary is the shared `/api` fence (same as machines/a2a);
 * the initiator-side per-machine knob (`execEnabled`) lives on the CALLER's
 * registry row, not here.
 */
export async function handleExecPost(request: Request, log?: A2aLogFn): Promise<Response> {
  if (request.method !== 'POST') {
    return json(405, { error: `mesh-api: method ${request.method} is not supported on ${EXEC_API_BASE} (use POST)` })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch (err) {
    return json(400, { error: `mesh-api: exec body is not valid JSON — ${err instanceof Error ? err.message : String(err)}` })
  }
  const parsed = parseOneShotExecBody(body)
  if (!parsed.ok) return json(400, { error: `mesh-api: ${parsed.error}` })
  const result = await runOneShotExec(parsed.value, log)
  return json(200, result)
}

/** Register the exec endpoint on the shared `/api` connection channel. */
export function registerExecRpc(ctx: Context, log?: A2aLogFn): void {
  ctx.inject(['connection'], (connCtx) => {
    const fetchFace = (Reflect.get(connCtx, 'connection') as { fetch?: ConnectionFetchFace } | undefined)?.fetch
    if (fetchFace === undefined) return // connection not actually present (test ctx)
    connCtx.effect(() => fetchFace.register({
      path: EXEC_API_BASE,
      methods: [...ROUTE_METHODS],
      requestBody: 'buffered',
      fetch: (request) => handleExecPost(request, log),
    }), 'superd-hub: /api/superd/exec route')
  })
}
