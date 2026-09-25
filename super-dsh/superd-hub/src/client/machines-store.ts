/**
 * Client-side machine ledger for the Hub page — the UI-first half of the
 * machine concept. The hub is the tool as a whole; machines are sources of
 * agent runtimes. The pairing backend lands later; until then this store owns
 * the remote list (persisted per-browser in localStorage, degraded to
 * in-memory when storage is unavailable) and the page swaps it for the real
 * service without touching its layout. The self row is derived, never stored.
 *
 * @module superd-hub/client/machines-store
 */

/** One machine row: a DSH instance with a Hub, joined or pending join. */
export interface HubMachine {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly url: string
  readonly self: boolean
  readonly addedAt: number
}

/** Storage slot for the ledger (v1 shape; bump the suffix on breaking edits). */
const STORAGE_KEY = 'superd-hub.machines.v1'

/**
 * The self row is DERIVED, never stored: this machine's label tracks the
 * product copy and its URL tracks the serving origin on every load. Only
 * remote machines persist.
 */
function selfMachine(): HubMachine {
  return {
    id: 'self',
    name: 'local',
    label: 'This machine',
    url: typeof location === 'undefined' ? '' : location.origin,
    self: true,
    addedAt: 0,
  }
}

/**
 * Read the ledger; a missing or unreadable store resets to the self row.
 *
 * @returns the machines: the derived self row first, then the stored remotes.
 */
export function loadMachines(): HubMachine[] {
  const remotes = readStoredRemotes()
  return [selfMachine(), ...remotes]
}

/** Parse the stored remote machines; storage failures degrade to none. */
function readStoredRemotes(): HubMachine[] {
  if (typeof localStorage === 'undefined') return []
  let parsed: unknown
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    parsed = JSON.parse(raw)
  } catch {
    /* an unparsable ledger is not a crash: start from the self row alone */
    return []
  }
  if (!Array.isArray(parsed)) return []
  const list: HubMachine[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, name, label, url, self, addedAt } = entry as Partial<HubMachine>
    if (self === true) continue
    if (typeof id !== 'string' || typeof name !== 'string' || typeof url !== 'string') continue
    list.push({
      id,
      name,
      label: typeof label === 'string' ? label : name,
      url,
      self: false,
      addedAt: typeof addedAt === 'number' ? addedAt : 0,
    })
  }
  return list
}

/**
 * Persist the ledger; storage failures degrade silently to in-memory state.
 *
 * @param list - the machines to store (self row included).
 */
export function saveMachines(list: readonly HubMachine[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* quota or private mode: the session keeps its in-memory copy */
  }
}

/** A fresh row id (UUID when available, time+random otherwise). */
export function freshMachineId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof cryptoRef?.randomUUID === 'function') return cryptoRef.randomUUID()
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
