/**
 * Machine registry (mesh P1, spec §3.1/§3.3): the persisted identity of
 * THIS machine (`self`, owner-minted m4 per D4) plus the remote machine
 * rows created by pairing.
 *
 * Pure module — no cordis dependencies. All state lives in
 * `<home>/superd/machines.json` (0600, atomic tmp+rename writes); every
 * mutation is a read-modify-write of the whole file with no in-process
 * cache, which is sufficient at P1 machine counts. A missing or
 * unreadable file reads as the empty shape (`self.id === ''` = not yet
 * minted); `ensureSelf` mints lazily on first need and never re-mints.
 */
import { randomInt } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One remote machine added by pairing (D1: cookie-grade token kept for re-mint). */
export interface MachineRow {
  /** Machine id (m4) — minted by the owning machine, adopted as-is (D4). */
  id: string
  /** Operator-facing machine name on the remote. */
  name: string
  /** Display label for the machines UI. */
  label: string
  /** Base origin of the remote hub (`http://host:port`). */
  origin: string
  /** Retained auth token for cookie re-mint; same sensitivity as the cookie itself. */
  token?: string
  /** Last minted request cookie (spec §4): persisted so hub restarts keep the remote's 30-day session instead of forcing a re-mint on every boot. */
  cookie?: string
  enabled: boolean
  /** Epoch ms when this row was added. */
  addedAt: number
}

/** The whole registry file. `self.id === ''` means not yet minted. */
export interface MachinesFile {
  self: { id: string; label: string }
  remotes: MachineRow[]
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const MINT_MAX_ATTEMPTS = 32

function machinesPath(home: string): string {
  return join(home, 'superd', 'machines.json')
}

function emptyMachines(): MachinesFile {
  return { self: { id: '', label: '' }, remotes: [] }
}

function isMachineRow(v: unknown): v is MachineRow {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === 'string' && typeof r.name === 'string' && typeof r.label === 'string' &&
    typeof r.origin === 'string' && typeof r.enabled === 'boolean' && typeof r.addedAt === 'number' &&
    (r.token === undefined || typeof r.token === 'string') &&
    (r.cookie === undefined || typeof r.cookie === 'string')
  )
}

/** Mint a random short id over [a-z0-9], re-minting on collision with `taken`; loud after 32 attempts. */
export function mintShortId(len: 4 | 6, taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let attempt = 0; attempt < MINT_MAX_ATTEMPTS; attempt++) {
    let id = ''
    for (let i = 0; i < len; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)]
    if (!used.has(id)) return id
  }
  throw new Error(`machines: short-id space exhausted after ${MINT_MAX_ATTEMPTS} attempts (len=${len})`)
}

/** Read the registry; a missing or unreadable/corrupt file degrades to the empty shape (never throws). */
export function loadMachines(home: string): MachinesFile {
  let raw: string
  try {
    raw = readFileSync(machinesPath(home), 'utf8')
  } catch {
    return emptyMachines()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyMachines()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyMachines()
  const o = parsed as Record<string, unknown>
  const self = o.self
  if (typeof self !== 'object' || self === null) return emptyMachines()
  const s = self as Record<string, unknown>
  if (typeof s.id !== 'string' || typeof s.label !== 'string' || !Array.isArray(o.remotes)) {
    return emptyMachines()
  }
  return { self: { id: s.id, label: s.label }, remotes: o.remotes.filter(isMachineRow) }
}

/** Persist the whole registry: recursive mkdir, tmp write, chmod 0600, atomic rename. */
export function saveMachines(home: string, file: MachinesFile): void {
  if (typeof file.self?.id !== 'string' || typeof file.self?.label !== 'string' || !Array.isArray(file.remotes)) {
    throw new TypeError('machines: save rejected — file must be {self: {id, label}, remotes: []}')
  }
  for (const r of file.remotes) {
    if (typeof r?.id !== 'string' || r.id === '' || typeof r.name !== 'string' || r.name === '' ||
      typeof r.origin !== 'string' || r.origin === '') {
      throw new TypeError('machines: save rejected — row id/name/origin must be non-empty strings')
    }
  }
  const dir = join(home, 'superd')
  mkdirSync(dir, { recursive: true })
  const target = machinesPath(home)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, target)
}

/** Lazily mint + persist the self identity; an already-minted self is returned unchanged. */
export function ensureSelf(home: string, fallbackLabel: string): { id: string; label: string } {
  const file = loadMachines(home)
  if (file.self.id !== '') return file.self
  const taken = new Set<string>([...file.remotes.map((r) => r.id)])
  const self = { id: mintShortId(4, taken), label: fallbackLabel }
  saveMachines(home, { self, remotes: file.remotes })
  return self
}

/** Snapshot copy of the remote rows — callers can hold it without aliasing the store. */
export function listRemotes(home: string): MachineRow[] {
  return loadMachines(home).remotes.map((r) => ({ ...r }))
}

/** Insert or overwrite (same id) one remote row; full read-modify-write persistence. */
export function upsertRemote(home: string, row: MachineRow): void {
  const file = loadMachines(home)
  const idx = file.remotes.findIndex((r) => r.id === row.id)
  if (idx === -1) file.remotes.push({ ...row })
  else file.remotes[idx] = { ...row }
  saveMachines(home, file)
}

/** Drop one remote row; returns false when the id was not present. */
export function removeRemote(home: string, id: string): boolean {
  const file = loadMachines(home)
  const remotes = file.remotes.filter((r) => r.id !== id)
  if (remotes.length === file.remotes.length) return false
  saveMachines(home, { self: file.self, remotes })
  return true
}
