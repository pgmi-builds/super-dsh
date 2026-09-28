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
 * absent; a non-string is dropped).
 */
export interface MeshMachineView {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly origin: string
  readonly status: MeshMachineStatus
  readonly lastProbeAt?: number
  /** I2: present exactly when the hub's probe found the peer's superd
   *  version incompatible with ours (diff major/minor, or unparsable). */
  readonly versionWarning?: string
  readonly self: boolean
}

/** The response's self block: this machine's minted m4 id + label. */
export interface MeshSelfView {
  readonly id: string
  readonly label: string
}

/** The coerced GET answer: self (when the wire carried a usable one) + the remote rows. */
export interface MeshList {
  readonly self?: MeshSelfView
  readonly machines: readonly MeshMachineView[]
}

/** The pairing input — origin is parsed out of the token URL SERVER-side (mesh-link), never a separate field. */
export interface AddMachineInput {
  readonly name: string
  readonly label?: string
  readonly tokenUrl: string
}

/** Coerce the self block; a shape without a non-empty string id + string label is simply absent. */
function coerceSelf(raw: unknown): MeshSelfView | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { id, label } = raw as Partial<MeshSelfView>
  if (typeof id !== 'string' || id === '' || typeof label !== 'string') return undefined
  return { id, label }
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
        label: typeof row.label === 'string' && row.label !== '' ? row.label : row.name,
        origin: row.origin,
        status,
        self: self !== undefined && row.id === self.id,
      }
      const withProbe = typeof row.lastProbeAt === 'number' ? { ...base, lastProbeAt: row.lastProbeAt } : base
      machines.push(typeof row.versionWarning === 'string' && row.versionWarning !== ''
        ? { ...withProbe, versionWarning: row.versionWarning }
        : withProbe)
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

/**
 * POST a pairing `{name, label?, tokenUrl}` (label omitted → the server
 * collapses it to the name).
 *
 * @throws Error(body.error) when the face answers non-2xx — the message is
 * mesh-link's own, already token-redacted.
 */
export async function addMachine(input: AddMachineInput): Promise<void> {
  const body: Record<string, string> = { name: input.name, tokenUrl: input.tokenUrl }
  if (typeof input.label === 'string' && input.label !== '') body.label = input.label
  const response = await fetch(MESH_API_BASE, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await errorText(response))
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
 * The per-machine last-fetch line, shaped from the row's `lastProbeAt`
 * (the hub's status table stamp — mesh-rpc joins it on every GET).
 * Pure by design (the UI passes its own `now`): headless-testable without
 * jsdom, same presence contract as {@link machineVersionChip} — absent or
 * non-finite stamp means "never probed" and the panel omits the line.
 *
 * @param lastProbeAt - epoch ms of the machine's last recorded probe.
 * @param now - epoch ms the panel renders at.
 * @returns "Updated 2m ago" / "Updated just now" / … , or undefined.
 */
export function lastFetchLabel(lastProbeAt: number | undefined, now: number): string | undefined {
  if (typeof lastProbeAt !== 'number' || !Number.isFinite(lastProbeAt)) return undefined
  const seconds = Math.max(0, Math.floor((now - lastProbeAt) / 1000))
  if (seconds < 60) return 'Updated just now'
  if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `Updated ${Math.floor(seconds / 3600)}h ago`
  return `Updated ${Math.floor(seconds / 86_400)}d ago`
}

/**
 * Client-side pre-check before a pairing submit: a parseable absolute
 * http(s) URL carrying a non-empty `token` query param. The server re-parses
 * authoritatively (mesh-link's parseTokenUrl); this only keeps obviously
 * dead drafts off the wire.
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
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const token = url.searchParams.get('token')
  return token !== null && token !== ''
}
