/**
 * Foreign agent roster (S2: plugin-presence IS the roster).
 *
 * No config file: an agent is in the roster exactly while its adapter
 * plugin is loaded and registered. Adapter plugins self-register on
 * activation (key/label/ready) and the Hub UI consumes the snapshot.
 * Roster entries are inventory only: they carry NO selection —
 * the addressed world is the request's mount path (`DL7`, 2026-09-16).
 * one authority.
 */
/** The canonical runtime identifier of the NATIVE DSH runtime (not an adapter — no package). */
export const NATIVE_RUNTIME_ID = 'native'

/**
 * The unified runtime identifier convention: an adapter's roster key MUST be
 * its package name's `agent-` suffix (`omp` ↔ `agent-omp`, `omp-sdk` ↔
 * `agent-omp-sdk`), so one derivation IS the cross-machine agreement — the
 * same ID travels on local rows and on every federated row (spec
 * hub-roster-identity §1). `native` is the reserved DSH spelling.
 * @param key - the roster key (`native`, or the adapter's runtime key).
 * @returns the adapter package identifier (`agent-omp`, …) or `native`.
 */
export function runtimeIdOf(key: string): string {
  return key === 'native' ? NATIVE_RUNTIME_ID : `agent-${key}`
}

export interface RosterEntry {
  /** Runtime key (`omp`, `codex`, …) — what the selector addresses. */
  key: string
  /** Human label for the selector chip. */
  label: string
  /**
   * The unified runtime identifier (adapter package name, `runtimeIdOf(key)`).
   * Optional at registration — adapters registered before this field existed
   * (and the generic joiner) are materialized at projection time; explicit
   * values win so a future adapter whose package name drifts from the key
   * convention can declare its identity.
   */
  runtimeId?: string
  /** True once the adapter's world context is spawned and its target registered. */
  ready: boolean
  /**
   * Owning machine id (m4) for FEDERATED rows (mesh P2 Task 3); absent = this
   * machine's local world. The a6-keyed row's owner; `agentLinks` projects it
   * onto AgentLink.machine and derives remote grouping/ordering from it.
   */
  machine?: string
  /** True once the world's spawn REJECTED (world-join catch) — stays mounted for diagnosis. */
  failed?: boolean
}

const entries = new Map<string, RosterEntry>()
const listeners = new Set<(entries: RosterEntry[]) => void>()

function emit(): void {
  const snap = listAgents()
  for (const fn of listeners) fn(snap)
}

/** Register an agent. Duplicate keys are a plugin bug — throw loud. */
export function registerAgent(entry: RosterEntry): void {
  if (entries.has(entry.key)) throw new Error(`roster: duplicate agent key ${entry.key}`)
  entries.set(entry.key, { ...entry, failed: entry.failed ?? false })
  emit()
}

/** Drop an agent (adapter plugin disposed). */
export function unregisterAgent(key: string): void {
  entries.delete(key)
  emit()
}

/** Flip readiness (world spawned / disposed). Unknown keys are a plugin bug. */
export function setReady(key: string, ready: boolean): void {
  const e = entries.get(key)
  if (!e) throw new Error(`roster: unknown agent ${key}`)
  e.ready = ready
  emit()
}

/** Flip failure (world spawn rejected). Unknown keys are a plugin bug. */
export function setFailed(key: string, failed: boolean): void {
  const e = entries.get(key)
  if (!e) throw new Error(`roster: unknown agent ${key}`)
  e.failed = failed
  emit()
}

/** Snapshot copy — callers can hold it without aliasing the roster. */
export function listAgents(): RosterEntry[] {
  return [...entries.values()].map((e) => ({ ...e }))
}

/** Subscribe to roster changes; returns an unsubscribe function. */
export function onRosterChanged(fn: (entries: RosterEntry[]) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
