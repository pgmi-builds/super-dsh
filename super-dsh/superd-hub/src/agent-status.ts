/**
 * Agent status cache + the sweep's dual responsibility legs (postoffice R5;
 * D18, plan 2026-09-28-machine-mesh-postoffice-rework task board).
 *
 * THE CACHE (`<home>/superd/agent-status.json`, 0600 atomic writes —
 * machines.ts discipline): per machine `{collectedAt, agents: [{a6, rows}]}`,
 * flat and additive. Rows carry EXACTLY what the session-list payload
 * exposes — upstream `SessionSummary`
 * (packages/api/session-controller/src/types.ts:177) is
 * `{agentAvailable, sessionId, updatedAt, running, blank, parentSessionId?,
 * origin?, cwd?, projections?}`: status maps `running` directly (true →
 * 'busy', false → 'idle'), anything else → 'unknown' (Orchestra unknown
 * discipline — never guess). NOTE: session/list carries NO title — the D18
 * title overlay is a QUERY-time concern (R6), not a collection fact.
 *
 * THE LEGS (both ride the EXISTING reprobe sweep — mesh-link's single timer,
 * no second probing path):
 *   - OUTBOX PULL: after each SUCCESSFUL reprobe, claim the peer's buffered
 *     envelopes (`GET /api/superd/a2a/outbox?machine=<selfId>`, cookie 随行)
 *     and feed each into the SAME ingest handler the HTTP endpoint uses —
 *     claim&clear semantics, in order, no dedupe layer. A pull failure
 *     degrades (log, keep sweeping).
 *   - SESSION-LIST COLLECTION: per reachable machine, every roster agent's
 *     session list through the PRESENTATION lane (the federation memo's wire
 *     faces — D16 presentation exemption, the same lane the /hub family
 *     browses); local agents (worlds + native) collect the same shape through
 *     their in-process faces. Failure retention: a machine's rows are only
 *     replaced by a SUCCESSFUL collection (empty included); a failure keeps
 *     the previous snapshot and records an error note.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureSelf, type MachineRow } from './machines.js'
import { cookieOf, type ProbeResult } from './mesh-link.js'
import { agentIdMap } from './agent-ids.js'
import { fetchA2aOutbox } from './a2a-wire.js'
import { WIRE } from './wire-endpoints.js'
import { sessionRpc, type A2aAddress, type A2aGateway } from './a2a-service.js'
import type { A2aIngest } from './a2a-ingest.js'
import { federatedGatewayOf } from './mesh-federate.js'
import { getTarget } from './targets.js'

// ---------------------------------------------------------------- cache shape

/** One collected session row — exactly what session/list exposes (see the header's upstream anchor). */
export interface AgentStatusRow {
  /** Full DSH session id (the wire identity; R6 truncates for display). */
  sessionId: string
  /** `SessionSummary.updatedAt` (epoch ms). */
  mtime: number
  /** `running` mapped directly: true → 'busy', false → 'idle', unobservable → 'unknown'. */
  status: 'busy' | 'idle' | 'unknown'
  /** `SessionSummary.agentAvailable` — whether the session owns a live Agent. */
  agentAvailable: boolean
}

/** One agent's collected window (bounded, payload order kept). */
export interface AgentStatusAgent {
  a6: string
  rows: AgentStatusRow[]
  /** Per-agent collection failure (face miss / session-list rejection). */
  error?: string
}

/** One machine's snapshot. */
export interface AgentStatusMachine {
  /** Epoch ms of the LAST SUCCESSFUL collection (kept on failure — the data's age, not the attempt's). */
  collectedAt: number
  agents: AgentStatusAgent[]
  /** Machine-level collection failure note (set on failure, cleared on success). */
  error?: string
}

/** The whole cache file. */
export interface AgentStatusFile {
  machines: Record<string, AgentStatusMachine>
}

/** Rows kept per agent (payload order; the D18 ≤5 window is R6's query-time concern). */
export const AGENT_STATUS_ROWS_MAX = 32

function statusPath(home: string): string {
  return join(home, 'superd', 'agent-status.json')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function coerceFile(v: unknown): AgentStatusFile {
  const out: AgentStatusFile = { machines: {} }
  const machines = isRecord(v) ? v['machines'] : undefined
  if (!isRecord(machines)) return out
  for (const [m4, raw] of Object.entries(machines)) {
    if (m4 === '' || !isRecord(raw) || !Array.isArray(raw['agents'])) continue
    const agents: AgentStatusAgent[] = []
    for (const a of raw['agents']) {
      if (!isRecord(a) || typeof a['a6'] !== 'string' || a['a6'] === '' || !Array.isArray(a['rows'])) continue
      const rows: AgentStatusRow[] = []
      for (const r of a['rows']) {
        if (!isRecord(r) || typeof r['sessionId'] !== 'string' || r['sessionId'] === '') continue
        const status = r['status'] === 'busy' || r['status'] === 'idle' || r['status'] === 'unknown' ? r['status'] : 'unknown'
        rows.push({
          sessionId: r['sessionId'],
          mtime: typeof r['mtime'] === 'number' ? r['mtime'] : 0,
          status,
          agentAvailable: r['agentAvailable'] === true,
        })
      }
      agents.push({ a6: a['a6'], rows, ...(typeof a['error'] === 'string' && a['error'] !== '' ? { error: a['error'] } : {}) })
    }
    const machine: AgentStatusMachine = {
      collectedAt: typeof raw['collectedAt'] === 'number' ? raw['collectedAt'] : 0,
      agents,
    }
    if (typeof raw['error'] === 'string' && raw['error'] !== '') machine.error = raw['error']
    out.machines[m4] = machine
  }
  return out
}

/** Read the cache; a missing or unreadable/corrupt file degrades to empty (never throws). */
export function loadAgentStatus(home: string): AgentStatusFile {
  let raw: string
  try {
    raw = readFileSync(statusPath(home), 'utf8')
  } catch {
    return { machines: {} }
  }
  try {
    return coerceFile(JSON.parse(raw))
  } catch {
    return { machines: {} }
  }
}

/** Persist the cache: recursive mkdir, tmp write, chmod 0600, atomic rename. */
function saveAgentStatus(home: string, file: AgentStatusFile): void {
  const dir = join(home, 'superd')
  mkdirSync(dir, { recursive: true })
  const target = statusPath(home)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, target)
}

/** Record a SUCCESSFUL machine collection — replaces the rows wholesale (empty included), clears the error. */
export function recordMachineCollection(home: string, machine: string, agents: AgentStatusAgent[], now: () => number = Date.now): void {
  if (machine === '') return
  const file = loadAgentStatus(home)
  file.machines[machine] = { collectedAt: now(), agents }
  saveAgentStatus(home, file)
}

/**
 * Record a machine-level collection FAILURE — the previous snapshot stays
 * (rows AND its collectedAt: the data's age is what it is) and the error
 * note says what happened.
 */
export function recordMachineFailure(home: string, machine: string, error: string): void {
  if (machine === '') return
  const file = loadAgentStatus(home)
  const prior = file.machines[machine]
  if (prior === undefined) {
    file.machines[machine] = { collectedAt: 0, agents: [], error }
  } else {
    file.machines[machine] = { ...prior, error }
  }
  saveAgentStatus(home, file)
}

// ---------------------------------------------------------------- collection

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One session-list item → the honest cache row (unknown when the payload doesn't say). */
function rowOf(item: unknown): AgentStatusRow | undefined {
  if (!isRecord(item) || typeof item['sessionId'] !== 'string' || item['sessionId'] === '') return undefined
  const running = item['running']
  return {
    sessionId: item['sessionId'],
    mtime: typeof item['updatedAt'] === 'number' ? item['updatedAt'] : 0,
    status: running === true ? 'busy' : running === false ? 'idle' : 'unknown',
    agentAvailable: item['agentAvailable'] === true,
  }
}

/** One agent's session list over one face (sessionRpc unwraps {ok,value} and applies wireArgsOf's `_request` key). */
async function collectAgentRows(face: A2aGateway): Promise<AgentStatusRow[]> {
  const value = await sessionRpc<{ items?: unknown }>(face, WIRE.sessionList, {})
  const items = isRecord(value) && Array.isArray(value['items']) ? value['items'] : []
  const rows: AgentStatusRow[] = []
  for (const item of items) {
    const row = rowOf(item)
    if (row !== undefined) rows.push(row)
    if (rows.length >= AGENT_STATUS_ROWS_MAX) break
  }
  return rows
}

/** How a remote agent's presentation-lane face is resolved (injectable for tests). */
export type RemoteFaceOf = (a6: string) => A2aGateway | undefined

/** The production resolver: the federation memo first, the shared target registry second (the /hub demux order). */
export function federatedFaceOf(a6: string): A2aGateway | undefined {
  return federatedGatewayOf(a6) ?? getTarget(a6)?.gateway
}

/**
 * Collect one REACHABLE machine's session lists over the presentation lane.
 * Never throws: a machine-level failure records the error and keeps the
 * previous snapshot; a per-agent failure (no face, rejected list) marks that
 * agent with an error and empty rows — an honest miss, never a guess.
 */
export async function collectRemoteMachine(
  home: string,
  remote: MachineRow,
  probe: ProbeResult,
  opts: { faceOf?: RemoteFaceOf } = {},
): Promise<void> {
  const faceOf = opts.faceOf ?? federatedFaceOf
  if (!probe.ok || !Array.isArray(probe.agents)) {
    // (unreachable probes never reach the collector — the sweep only calls it
    // after a SUCCESSFUL reprobe — but the guard stays honest for direct callers)
    recordMachineFailure(home, remote.id, 'probe did not carry a roster')
    return
  }
  const agents: AgentStatusAgent[] = []
  for (const agent of probe.agents) {
    if (typeof agent?.id !== 'string' || agent.id === '') continue
    try {
      const face = faceOf(agent.id)
      if (face === undefined) {
        agents.push({ a6: agent.id, rows: [], error: 'no gateway face for the session list' })
        continue
      }
      agents.push({ a6: agent.id, rows: await collectAgentRows(face) })
    } catch (error) {
      agents.push({ a6: agent.id, rows: [], error: errMsg(error) })
    }
  }
  recordMachineCollection(home, remote.id, agents)
}

/**
 * Collect the LOCAL machine's agents (worlds + native — every a6 in the id
 * store) through their in-process faces, resolved by the a2a-host local leg.
 */
export async function collectLocalMachine(
  home: string,
  gatewayFor: (addr: A2aAddress) => A2aGateway,
): Promise<void> {
  const self = ensureSelf(home, 'local')
  const agents: AgentStatusAgent[] = []
  for (const [, a6] of Object.entries(agentIdMap(home))) {
    try {
      const face = gatewayFor({ machine: self.id, id: a6 })
      agents.push({ a6, rows: await collectAgentRows(face) })
    } catch (error) {
      agents.push({ a6, rows: [], error: errMsg(error) })
    }
  }
  recordMachineCollection(home, self.id, agents)
}

// ---------------------------------------------------------------- outbox pull

/**
 * Claim (and clear, peer-side) the envelopes buffered for THIS machine and
 * deliver each through the SAME ingest handler the HTTP endpoint uses — in
 * order, no dedupe layer (claim&clear is the peer's guarantee). A per-
 * envelope failure degrades; the claim itself throwing propagates to the
 * sweep's leg-level swallow.
 */
export async function pullOutboxFor(
  home: string,
  remote: MachineRow,
  ingest: A2aIngest,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const self = ensureSelf(home, 'local')
  const envelopes = await fetchA2aOutbox(remote.origin, self.id, {
    cookie: cookieOf(remote.id, home),
    fetchImpl: opts.fetchImpl,
  })
  let delivered = 0
  for (const envelope of envelopes) {
    try {
      await ingest.ingest(envelope)
      delivered += 1
    } catch {
      // per-envelope degradation — the claim already consumed it peer-side
    }
  }
  return delivered
}

// ---------------------------------------------------------------- sweep legs

/** The assembled legs a sweep runs (the shape mesh-link's SweepCollectors takes). */
export interface StatusSweepLegs {
  onLocalCollect(): Promise<void>
  onRemoteProbed(info: { remote: MachineRow; probe: ProbeResult }): Promise<void>
}

/**
 * Compose the dual-responsibility legs over one assembly (a2a-row's single
 * resolver + shared ingest). Every leg degrades internally — a failure never
 * breaks probe accounting or the sweep loop.
 */
export function statusSweepLegs(deps: {
  home: string
  gatewayFor: (addr: A2aAddress) => A2aGateway
  ingest: A2aIngest
  remoteFaceOf?: RemoteFaceOf
  fetchImpl?: typeof fetch
}): StatusSweepLegs {
  return {
    async onLocalCollect() {
      try {
        await collectLocalMachine(deps.home, deps.gatewayFor)
      } catch {
        // the local leg degrades — the sweep keeps probing remotes
      }
    },
    async onRemoteProbed({ remote, probe }) {
      try {
        await pullOutboxFor(deps.home, remote, deps.ingest, { fetchImpl: deps.fetchImpl })
      } catch {
        // pull failure degrades — never breaks probe accounting
      }
      try {
        await collectRemoteMachine(deps.home, remote, probe, { faceOf: deps.remoteFaceOf })
      } catch (error) {
        recordMachineFailure(deps.home, remote.id, errMsg(error))
      }
    },
  }
}
