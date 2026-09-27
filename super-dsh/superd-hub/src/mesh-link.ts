/**
 * Mesh link (mesh P1, spec §4/§6.3): remote connection management —
 * token-URL parsing, cookie mint, roster probe, and the pairing /
 * reprobe orchestration that adopts the remote machine id (D4) into
 * the machine registry from `./machines.js`.
 *
 * Pure module — no cordis dependencies. Outbound calls use the global
 * fetch (injectable via `fetchImpl` / `deps.fetchImpl` for tests) with
 * a 10s AbortSignal timeout. Cookies live in an in-process jar keyed by
 * a 10s AbortSignal timeout. The minted cookie is persisted on the machine
 * row (`MachineRow.cookie`, D1 sensitivity, §3.3/§4) so hub restarts keep the
 * remote's 30-day session; an in-process jar fronts the row as a write-through
 * cache of the same value. Probe outcomes land
 * in the module-level status table exported read-only via
 * `machineStatus()` (mesh API consumes; `resetMachineStatus()` is the
 * test hook). No retry loops, no background probing — P1 is explicit
 * probe-on-demand only.
 */
import { type MachineRow, loadMachines, saveMachines, upsertRemote, listRemotes } from './machines.js'

/** One roster agent as seen through a successful probe (§6.2 additive fields). */
interface ProbeAgent {
  id: string
  key: string
  label: string
  ready: boolean
  failed: boolean
}

/** Roster probe outcome: 200+hub → ok with adopted machineId; 401 → auth-expired; network/peer-shape errors → unreachable. */
export type ProbeResult =
  | { ok: true; machineId: string; version?: string; agents: ProbeAgent[] }
  | { ok: false; status: 'unreachable' | 'auth-expired'; error: string }

/** Result of a full pairing: the adopted id, the persisted row, and the probe that vouched for it. */
export interface PairOutcome {
  machineId: string
  row: MachineRow
  probe: ProbeResult
}

/** Test injection seam: fetch + registry load/save overrides. */
export interface LinkDeps {
  fetchImpl?: typeof fetch
  load?: typeof loadMachines
  save?: typeof saveMachines
}

/** Machine health entry in the module-level status table. */
export interface MachineStatusEntry {
  status: string
  lastProbeAt: number
  error?: string
}

const FETCH_TIMEOUT_MS = 10_000

/** <machineId, cookie> — in-process jar, a front for the persisted `MachineRow.cookie` (same value; write-through on every mint). */
const cookieJar = new Map<string, string>()

const machineStatusTable = new Map<string, MachineStatusEntry>()

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Validate a pasted token URL: absolute http(s) origin + non-empty `?token=`.
 *  Error copy never echoes the raw input — a typo'd paste may still carry a live
 *  token, so messages carry at most the (userinfo-free) origin. */
export function parseTokenUrl(tokenUrl: string): { origin: string; token: string } {
  let url: URL
  try {
    url = new URL(tokenUrl)
  } catch {
    throw new Error('mesh-link: invalid token url — not a parseable absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`mesh-link: invalid token url — origin must be http(s), got "${url.origin}"`)
  }
  const token = url.searchParams.get('token') ?? ''
  if (token === '') {
    throw new Error(`mesh-link: invalid token url at "${url.origin}" — missing ?token= query parameter`)
  }
  return { origin: url.origin, token }
}

/** Fallback Set-Cookie splitter for header environments without `getSetCookie()`. */
function splitSetCookieHeader(joined: string | null): string[] {
  if (!joined) return []
  return joined.split(/,(?=\s*[^;=\s]+\s*=)/)
}

/** First `name=value` pair of a Set-Cookie value (attributes stripped). */
function firstCookiePair(raw: string): string | null {
  const m = /^\s*([^=;\s]+=[^;]*)/.exec(raw)
  return m ? m[1].trim() : null
}

/**
 * Mint a request cookie from a launch token: `GET <origin>/?token=<t>` with
 * `redirect: 'manual'`, taking the first `dsh-auth-*` name=value pair from
 * Set-Cookie. Non-303/2xx, a missing cookie, or a network failure throws
 * with the status/cause attached.
 */
export async function mintCookie(origin: string, token: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(`${origin}/?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(`mesh-link: token mint to ${origin} failed — ${errMsg(err)}`)
  }
  if (res.status !== 303 && !(res.status >= 200 && res.status < 300)) {
    throw new Error(`mesh-link: token mint failed — unexpected status ${res.status} from ${origin}`)
  }
  const rawCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : splitSetCookieHeader(res.headers.get('set-cookie'))
  for (const raw of rawCookies) {
    const pair = firstCookiePair(raw)
    if (pair !== null && pair.startsWith('dsh-auth-')) return pair
  }
  throw new Error(`mesh-link: token mint failed — no dsh-auth-* Set-Cookie in response (status ${res.status}) from ${origin}`)
}

function coerceAgent(v: unknown): ProbeAgent {
  const a = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  return {
    id: typeof a.id === 'string' ? a.id : '',
    key: typeof a.key === 'string' ? a.key : '',
    label: typeof a.label === 'string' ? a.label : '',
    ready: a.ready === true,
    failed: a.failed === true,
  }
}

/**
 * Probe a remote hub's roster: `GET <origin>/api/agent-runtime` with the
 * cookie riding along. 401 → `auth-expired`; network error → `unreachable`;
 * 200 without a `hub.machineId` block is a non-superdsh 0.1.6+ peer →
 * `unreachable` with `peer roster has no hub block`.
 */
export async function probeMachine(origin: string, cookie: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<ProbeResult> {
  let res: Response
  try {
    res = await fetchImpl(`${origin}/api/agent-runtime`, {
      headers: cookie === '' ? {} : { cookie },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    return { ok: false, status: 'unreachable', error: `probe fetch to ${origin} failed — ${errMsg(err)}` }
  }
  if (res.status === 401) {
    return { ok: false, status: 'auth-expired', error: `probe got 401 from ${origin} — cookie rejected` }
  }
  if (res.status !== 200) {
    return { ok: false, status: 'unreachable', error: `probe got status ${res.status} from ${origin}` }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    return { ok: false, status: 'unreachable', error: `probe roster from ${origin} is not JSON — ${errMsg(err)}` }
  }
  const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const hub = (typeof o.hub === 'object' && o.hub !== null ? o.hub : {}) as Record<string, unknown>
  if (typeof hub.machineId !== 'string' || hub.machineId === '') {
    return { ok: false, status: 'unreachable', error: 'peer roster has no hub block' }
  }
  const agents = Array.isArray(o.agents) ? o.agents.map(coerceAgent) : []
  return {
    ok: true,
    machineId: hub.machineId,
    version: typeof hub.version === 'string' ? hub.version : undefined,
    agents,
  }
}

/** Read-only snapshot copy of the status table — callers can hold/mutate it freely. */
export function machineStatus(): Map<string, MachineStatusEntry> {
  return new Map(Array.from(machineStatusTable, ([id, e]) => [id, { ...e }]))
}

/** Test hook: drop all status entries. */
export function resetMachineStatus(): void {
  machineStatusTable.clear()
}

function recordStatus(id: string, status: string, error?: string): void {
  machineStatusTable.set(id, error === undefined ? { status, lastProbeAt: Date.now() } : { status, lastProbeAt: Date.now(), error })
}

/** Persist one remote row; uses `upsertRemote` unless a load/save seam is injected (test isolation). */
function persistRow(home: string, row: MachineRow, deps?: LinkDeps): void {
  if (!deps?.load && !deps?.save) {
    upsertRemote(home, row)
    return
  }
  const file = (deps.load ?? loadMachines)(home)
  const idx = file.remotes.findIndex((r) => r.id === row.id)
  if (idx === -1) file.remotes.push({ ...row })
  else file.remotes[idx] = { ...row }
    ; (deps.save ?? saveMachines)(home, file)
}

/**
 * Full pairing: parse the pasted token URL → mint a cookie → probe the roster
 * → adopt the remote machine id (fail-loud on collision with self or an
 * existing remote) → persist the row with the retained token and minted
 * cookie → jar the cookie and mark the machine reachable. A failed mint/probe throws before
 * anything is persisted.
 */
export async function pairMachine(home: string, input: { name: string; label?: string; tokenUrl: string }, deps?: LinkDeps): Promise<PairOutcome> {
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch
  const load = deps?.load ?? loadMachines
  const { origin, token } = parseTokenUrl(input.tokenUrl)
  const cookie = await mintCookie(origin, token, fetchImpl)
  const probe = await probeMachine(origin, cookie, fetchImpl)
  if (!probe.ok) {
    throw new Error(`mesh-link: pairing ${origin} failed — ${probe.status}: ${probe.error}`)
  }
  const file = load(home)
  if (probe.machineId === file.self.id || file.remotes.some((r) => r.id === probe.machineId)) {
    throw new Error(`mesh-link: duplicate-machine-id ${probe.machineId} — collides with self or an existing remote row; remove the stale row before re-pairing`)
  }
  const row: MachineRow = {
    id: probe.machineId,
    name: input.name,
    label: input.label ?? input.name,
    origin,
    token,
    cookie,
    enabled: true,
    addedAt: Date.now(),
  }
  persistRow(home, row, deps)
  cookieJar.set(row.id, cookie)
  recordStatus(row.id, 'reachable')
  return { machineId: row.id, row, probe }
}

/**
 * Re-probe a paired machine: the jar's cookie, falling back to the cookie
 * persisted on the row (cold jar after a hub restart), rides the probe. On
 * `auth-expired`, if the row retains a token, re-mint once and probe again; a
 * successful re-mint writes the new cookie back into the jar AND the row. Every
 * outcome lands in the status table
 * (`reachable` / `auth-expired` / `unreachable`, the latter two with the error).
 */
export async function reprobeMachine(home: string, id: string, deps?: LinkDeps): Promise<ProbeResult> {
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch
  const remotes = deps?.load ? deps.load(home).remotes : listRemotes(home)
  const row = remotes.find((r) => r.id === id)
  if (!row) {
    throw new Error(`mesh-link: unknown machine id "${id}" — no remote row in the registry`)
  }
  const origin = row.origin
  let cookie = cookieJar.get(id) ?? row.cookie ?? ''
  let probe = await probeMachine(origin, cookie, fetchImpl)
  if (!probe.ok && probe.status === 'auth-expired' && row.token) {
    try {
      cookie = await mintCookie(origin, row.token, fetchImpl)
      cookieJar.set(id, cookie)
      persistRow(home, { ...row, cookie }, deps)
      probe = await probeMachine(origin, cookie, fetchImpl)
    } catch (err) {
      probe = { ok: false, status: 'auth-expired', error: `re-mint failed — ${errMsg(err)}` }
    }
  }
  if (probe.ok) {
    cookieJar.set(id, cookie)
    recordStatus(id, 'reachable')
  } else if (probe.status === 'auth-expired') {
    recordStatus(id, 'auth-expired', probe.error)
  } else {
    recordStatus(id, 'unreachable', probe.error)
  }
  return probe
}
