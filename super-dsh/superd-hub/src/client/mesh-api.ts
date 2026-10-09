/**
 * Machine-mesh data access for the Hub machines panel (mesh P1, Task 5):
 * the client half of `/api/superd/machines` (host side: mesh-rpc.ts) —
 * same-origin fetch behind the standard browser-trust + cookie fence, the
 * roster face's house style (`credentials: 'same-origin'`). The localStorage
 * ledger era (machines-store.ts, retired with this module) ended: the hub's
 * registry is the single source of truth, this file only fetches it and
 * coerces the wire answer into row views.
 *
 * Node-safe by construction — no DOM, no react, no @deepseek-ai imports —
 * so the host tsc emits it to `dist/client/mesh-api.js` and
 * test/client-mesh-view.test.mjs runs the pure halves (coercion, token-URL
 * pre-check) under `node --test` without jsdom: the switch-core/toast-core
 * precedent in reverse (pure logic kept beside the fetch wrappers, all under
 * src/client). No fetch happens at import time.
 *
 * @module superd-hub/client/mesh-api
 */

/**
 * Base path of the mesh machines API — the client-side spelling of the
 * host's `MESH_API_BASE` (mesh-rpc.ts). Duplicated deliberately: importing
 * the host module would drag its node:fs-backed dependencies into the
 * browser bundle; a path literal cannot drift silently because the mesh-rpc
 * route registration and this file are reviewed together.
 */
const MESH_API_BASE = '/api/superd/machines'

/** Machine health as the hub reports it (mesh-rpc joins `'pending'` when the mesh-link status table has no entry for the row). */
export type MeshMachineStatus = 'pending' | 'reachable' | 'unreachable' | 'auth-expired'

/** The statuses the wire may carry; anything else coerces to `'pending'`. */
const STATUSES: readonly MeshMachineStatus[] = ['pending', 'reachable', 'unreachable', 'auth-expired']

/**
 * One machine row for the panel: the wire's public projection (never token,
 * never cookie) with `self` DERIVED from the response's self block — never
 * stored per-row (the server's machines array carries remotes only; the
 * flag exists so a self row surfacing in it still renders as self). Since
 * I2 (mesh P3 5a) a reachable row may also carry `versionWarning` — the
 * host's version-mismatch computation, coerced additively (absent stays
 * absent; a non-string is dropped). `name` is the machine's sole display
 * identity (spec hub-roster-identity §4).
 */
export interface MeshMachineView {
  readonly id: string
  readonly name: string
  readonly origin: string
  readonly status: MeshMachineStatus
  /** I2: present exactly when the hub's probe found the peer's superd
   *  version incompatible with ours (diff major/minor, or unparsable). */
  readonly versionWarning?: string
  readonly self: boolean
}

/** The response's self block: this machine's minted m4 id + label, plus a
 *  truncated launch-token preview (`'d_3txYKhc_…'`) when the host can mint —
 *  display aid for the self row's copy affordance, never the token itself. */
export interface MeshSelfView {
  readonly id: string
  readonly label: string
  readonly tokenPreview?: string
}

/** The coerced GET answer: self (when the wire carried a usable one) + the remote rows. */
export interface MeshList {
  readonly self?: MeshSelfView
  readonly machines: readonly MeshMachineView[]
}

/** The pairing input — origin is parsed out of the token URL SERVER-side (mesh-link), never a separate field. */
export interface AddMachineInput {
  readonly name: string
  readonly tokenUrl: string
}

/** Coerce the self block; a shape without a non-empty string id + string label is simply absent. */
function coerceSelf(raw: unknown): MeshSelfView | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { id, label, tokenPreview } = raw as Partial<MeshSelfView>
  if (typeof id !== 'string' || id === '' || typeof label !== 'string') return undefined
  return {
    id,
    label,
    ...(typeof tokenPreview === 'string' && tokenPreview !== '' ? { tokenPreview } : {}),
  }
}

/**
 * Coerce a raw GET body into the panel's view list. Any bad shape degrades
 * to the empty list (rows dropped individually, self dropped as a block) —
 * the UI never crashes on a malformed answer.
 *
 * @param raw - the parsed JSON body (or anything else the wire produced).
 * @returns self (when usable) + the coerced remote rows.
 */
export function coerceMachineList(raw: unknown): MeshList {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { machines: [] }
  const record = raw as { self?: unknown; machines?: unknown }
  const self = coerceSelf(record.self)
  const machines: MeshMachineView[] = []
  if (Array.isArray(record.machines)) {
    for (const entry of record.machines) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const row = entry as Record<string, unknown>
      if (typeof row.id !== 'string' || row.id === '') continue
      if (typeof row.name !== 'string' || row.name === '') continue
      if (typeof row.origin !== 'string' || row.origin === '') continue
      const status = typeof row.status === 'string' && (STATUSES as readonly string[]).includes(row.status)
        ? row.status as MeshMachineStatus
        : 'pending'
      const base: MeshMachineView = {
        id: row.id,
        name: row.name,
        origin: row.origin,
        status,
        self: self !== undefined && row.id === self.id,
      }
      machines.push(typeof row.versionWarning === 'string' && row.versionWarning !== ''
        ? { ...base, versionWarning: row.versionWarning }
        : base)
    }
  }
  return self === undefined ? { machines } : { self, machines }
}

/**
 * The version-warning chip for one machine row (I2): present EXACTLY when the
 * coerced row carries a `versionWarning` — the Hub machines panel renders
 * the chip iff this returns a value. Kept here beside the coercion so the
 * presence contract stays unit-testable without jsdom (the HubPage seat is
 * a one-line consumer following the existing chip patterns).
 */
export function machineVersionChip(machine: Pick<MeshMachineView, 'versionWarning'>): { text: string } | undefined {
  return machine.versionWarning === undefined ? undefined : { text: machine.versionWarning }
}

/** Read a non-2xx body's `{error}` message; degrade to the bare status line. */
async function errorText(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body?.error === 'string' && body.error !== '') return body.error
  } catch {
    /* not JSON — the status line below is the message */
  }
  return `HTTP ${response.status}`
}

/**
 * GET the machine list (self + remotes).
 *
 * @returns the coerced list — a malformed body degrades to the empty list, never a throw.
 * @throws when the request fails or the face answers non-2xx.
 */
export async function fetchMachines(): Promise<MeshList> {
  const response = await fetch(MESH_API_BASE, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(await errorText(response))
  return coerceMachineList(await response.json().catch(() => undefined))
}

/** How the mutual-pairing reverse leg went on a successful pair (`ok` also
 *  covers "the peer already held us"; `error` names any real failure — the
 *  pairing itself succeeded either way and the row is in). */
export interface MutualPairingOutcome {
  readonly ok: boolean
  readonly skipped?: 'self' | 'already-paired'
  readonly error?: string
}

/**
 * POST a pairing `{name, tokenUrl}` — mutual by design: the peer is offered
 * our own pairing input, so one action pairs both machines.
 *
 * @returns the reverse leg's outcome when the answer carried one.
 * @throws Error(body.error) when the face answers non-2xx — the message is
 * mesh-link's own, already token-redacted.
 */
export async function addMachine(input: AddMachineInput): Promise<{ mutual?: MutualPairingOutcome }> {
  const response = await fetch(MESH_API_BASE, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: input.name, tokenUrl: input.tokenUrl, ...(pageOrigin() === '' ? {} : { origin: pageOrigin() }) }),
  })
  if (!response.ok) throw new Error(await errorText(response))
  const body = await response.json().catch(() => undefined) as { mutual?: unknown } | undefined
  if (typeof body?.mutual !== 'object' || body.mutual === null) return {}
  const raw = body.mutual as { ok?: unknown; error?: unknown; skipped?: unknown }
  return {
    mutual: {
      ok: raw.ok === true,
      ...(raw.skipped === 'self' || raw.skipped === 'already-paired' ? { skipped: raw.skipped } : {}),
      ...(typeof raw.error === 'string' && raw.error !== '' ? { error: raw.error } : {}),
    },
  }
}

/** Preserve shell schemes whose WHATWG origin is opaque; this is an address, not a reachability verdict. */
export function pageOrigin(): string {
  if (typeof location === 'undefined') return ''
  if (location.origin !== 'null' && location.origin !== '') return location.origin
  try {
    const url = new URL(location.href)
    return url.protocol + '//' + url.host
  } catch { return '' }
}

/**
 * DELETE one remote row by id (`{removed: boolean}` answers even for
 * unknown ids — a false removal is a reload, not an error).
 *
 * @throws Error(body.error) on a non-2xx answer.
 */
export async function removeMachine(id: string): Promise<void> {
  const response = await fetch(`${MESH_API_BASE}?id=${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok) throw new Error(await errorText(response))
}

/**
 * POST `{op: 'reprobe', id}` — a fresh probe of one remote; the outcome
 * (even unreachable/auth-expired) lands in the status table server-side, so
 * the caller reloads rather than interpreting the probe body.
 *
 * @throws Error(body.error) on a non-2xx answer (the op itself failed).
 */
export async function reprobeMachine(id: string): Promise<void> {
  const response = await fetch(MESH_API_BASE, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'reprobe', id }),
  })
  if (!response.ok) throw new Error(await errorText(response))
}

/**
 * The standing cadence note (D18): machine status refresh rides the hub's
 * 5-minute sweep — the panel renders this verbatim beside its live-fetch
 * control. English copy to match the DSH UI.
 */
export const AUTO_REFRESH_NOTE = 'auto-refreshes every 5 min'

/**
 * Ask the hub to tokenize the caller's origin with the process's live launch
 * token (spec hub-roster-identity §3): the pairing URL a user copies onto
 * another machine's Add-machine form. The host mints through the connection
 * face's public `authenticatedUrl` — this client never sees the raw token
 * anywhere else.
 *
 * @param origin - the page's own host address, including a desktop scheme.
 * @returns the tokenized pairing URL.
 * @throws Error(body.error) on a non-2xx answer (validation or missing host face).
 */
export async function fetchPairingUrl(origin: string): Promise<string> {
  const response = await fetch(MESH_API_BASE, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'tokenUrl', origin }),
  })
  if (!response.ok) throw new Error(await errorText(response))
  const body = await response.json().catch(() => undefined) as { tokenUrl?: unknown } | undefined
  if (typeof body?.tokenUrl !== 'string' || body.tokenUrl === '') {
    throw new Error('mesh-api: tokenUrl op answered no tokenUrl')
  }
  return body.tokenUrl
}

/**
 * Client-side pre-check before a pairing submit: a parseable absolute
 * host-bearing URL carrying a non-empty `token` query param. The server re-parses
 * authoritatively (mesh-link's parseTokenUrl); this only keeps obviously
 * malformed drafts off the wire.
 *
 * @param input - the raw token-URL draft (trim before calling).
 * @returns whether the draft is submit-shaped.
 */
export function validTokenUrl(input: string): boolean {
  if (typeof input !== 'string' || input === '') return false
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return false
  }
  if (url.host === '') return false
  const token = url.searchParams.get('token')
  return token !== null && token !== ''
}
