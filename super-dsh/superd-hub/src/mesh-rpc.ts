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
 *                                           projection — NEVER token/cookie,
 *                                           D1 + Task 2 review's deferred
 *                                           finding: the row carries two
 *                                           secrets and the wire carries
 *                                           none; since mesh P3 5a (I2) a
 *                                           row may also carry
 *                                           `versionWarning` — additive,
 *                                           present only when the peer's
 *                                           superd version differs from
 *                                           ours by more than patch)
 *   POST   /api/superd/machines            → `{op?: 'reprobe', ...}`:
 *        op:'reprobe' + {id}               → `{probe: ProbeResult}` (the
 *                                           brief's `/machines/reprobe` path
 *                                           variant is FOLDED here because
 *                                           connection.fetch matches by exact
 *                                           path — one registration, body
 *                                           dispatch; documented per Task 3
 *                                           controller amendment)
 *        otherwise `{name, label?, tokenUrl}` → pairMachine → 201 `{machine}`;
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
import { type MachineRow, ensureSelf, listRemotes, removeRemote } from './machines.js'
import { machineStatus, pairMachine, reprobeMachine, emitMachineRemoved, type ProbeResult, type MachineStatusEntry } from './mesh-link.js'
import { createA2aIngest, type A2aIngest, type A2aIngestDeps } from './a2a-ingest.js'
import { A2A_ENDPOINT_PATH, A2A_OUTBOX_PATH, A2A_WIRE_VERSION, decodeA2aWireFrame } from './a2a-wire.js'

/** The shared-channel Fetch route path this API owns. */
export const MESH_API_BASE = '/api/superd/machines'

/** Injection seam: the hub home (registry + pairing live under it) and an
 *  optional fetch override for tests. `home` is resolved by the caller
 *  (gateway.ts passes `resolveDshHome()` at registration time); this module
 *  stays free of home-resolution logic. */
export interface MeshDeps {
  home: string
  fetchImpl?: typeof fetch
}

/** The GET/POST row shape as it crosses the wire — the persisted MachineRow
 *  minus its two secrets (`token`, `cookie`), plus the joined status (and,
 *  additively since I2/mesh P3 5a, the version-mismatch warning when the
 *  mesh-link status entry carries one). */
export interface MachinePublicRow {
  id: string
  name: string
  label: string
  origin: string
  enabled: boolean
  addedAt: number
  status: string
  lastProbeAt?: number
  error?: string
  versionWarning?: string
}

/** Structural type of `ctx.connection.fetch` (upstream: HostConnectionFetch).
 *  Methods widened with 'DELETE' — see the module header's dispatch note. */
interface ConnectionFetchFace {
  register(route: {
    path: string
    methods: readonly ('GET' | 'HEAD' | 'POST' | 'DELETE')[]
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

/** Project one persisted row to its public wire shape (allowlist — never
 *  token, never cookie) and join the mesh-link status entry by id. */
function publicRow(row: MachineRow): MachinePublicRow {
  return projectRow(row, machineStatus())
}

function projectRow(row: MachineRow, status: ReadonlyMap<string, MachineStatusEntry>): MachinePublicRow {
  const entry = status.get(row.id)
  if (entry === undefined) return { id: row.id, name: row.name, label: row.label, origin: row.origin, enabled: row.enabled, addedAt: row.addedAt, status: 'pending' }
  const out: MachinePublicRow = { id: row.id, name: row.name, label: row.label, origin: row.origin, enabled: row.enabled, addedAt: row.addedAt, status: entry.status, lastProbeAt: entry.lastProbeAt }
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
 *  its public projection, status joined from the mesh-link table. */
function handleList(deps: MeshDeps): Response {
  const self = ensureSelf(deps.home, 'local')
  const status = machineStatus()
  const machines = listRemotes(deps.home).map((row) => projectRow(row, status))
  return json(200, { self, machines })
}

/** POST: body-dispatched — `{op: 'reprobe', id}` re-probes, anything else is
 *  a pairing input `{name, label?, tokenUrl}`. */
async function handlePost(request: Request, deps: MeshDeps): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(request)
  } catch (err) {
    return json(400, { error: errMsg(err) })
  }
  if (typeof body.op === 'string' && body.op !== '') {
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
    return json(400, { error: 'mesh-api: pair body must be {name, label?, tokenUrl} with non-empty name and tokenUrl' })
  }
  const label = typeof body.label === 'string' && body.label !== '' ? body.label : undefined
  let outcome: Awaited<ReturnType<typeof pairMachine>>
  try {
    outcome = await pairMachine(deps.home, { name, label, tokenUrl }, { fetchImpl: deps.fetchImpl })
  } catch (err) {
    // mesh-link errors are actionable and token-redacted (Task 2 fix round 1).
    return json(400, { error: errMsg(err) })
  }
  return json(201, { machine: publicRow(outcome.row) })
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
 * `connection` service is absent (e.g. fake-ctx unit tests).
 */
export function registerMeshRpc(ctx: Context, deps: MeshDeps): void {
  ctx.inject(['connection'], (connCtx) => {
    const fetchFace = (Reflect.get(connCtx, 'connection') as { fetch?: ConnectionFetchFace } | undefined)?.fetch
    if (fetchFace === undefined) return // connection not actually present (test ctx)
    connCtx.effect(() => fetchFace.register({
      path: MESH_API_BASE,
      methods: ['GET', 'POST', 'DELETE'],
      requestBody: 'buffered',
      fetch: (request) => handleMeshMachines(request, deps),
    }), 'superd-hub: /api/superd/machines route')
  })
}

// ---------------------------------------------------------------- a2a (postoffice R3)

/** The a2a ingest endpoint's deps — exactly the ingest assembly inputs. */
export type A2aRpcDeps = A2aIngestDeps

/**
 * POST /api/superd/a2a — body = one v1 wire frame `{v: 1, envelope}` → the
 * envelope's receipt (new/message: send receipt; stop: stop receipt;
 * reply/notice: the local delivery outcome). Malformed frames are 400s with
 * the decoder's named reason.
 */
export async function handleA2aIngestPost(request: Request, ingest: A2aIngest): Promise<Response> {
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
  const machine = new URL(request.url).searchParams.get('machine') ?? ''
  if (machine === '') {
    return json(400, { error: 'mesh-api: a2a outbox claim requires a non-empty ?machine= query parameter' })
  }
  return json(200, { v: A2A_WIRE_VERSION, envelopes: ingest.claimOutbox(machine) })
}

/**
 * Register the a2a endpoints (POST /api/superd/a2a + GET .../outbox) on the
 * shared `/api` connection channel — same fence as the machines route. The
 * ingest instance is built here ONCE per registration (the outbox and the
 * mirror registry are its state). No-op when `connection` is absent.
 */
export function registerA2aRpc(ctx: Context, deps: A2aRpcDeps): void {
  ctx.inject(['connection'], (connCtx) => {
    const fetchFace = (Reflect.get(connCtx, 'connection') as { fetch?: ConnectionFetchFace } | undefined)?.fetch
    if (fetchFace === undefined) return // connection not actually present (test ctx)
    const ingest = createA2aIngest(deps)
    connCtx.effect(() => fetchFace.register({
      path: A2A_ENDPOINT_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleA2aIngestPost(request, ingest),
    }), 'superd-hub: /api/superd/a2a route')
    connCtx.effect(() => fetchFace.register({
      path: A2A_OUTBOX_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => Promise.resolve(handleA2aOutboxGet(request, ingest)),
    }), 'superd-hub: /api/superd/a2a/outbox route')
  })
}
