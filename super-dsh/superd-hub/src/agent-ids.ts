/**
 * Agent short ids (mesh P1, spec §3.2): one stable a6 id per roster row,
 * owner-minted and persisted in `<home>/superd/agent-ids.json`.
 *
 * Pure module — no cordis dependencies. Same persistence discipline as
 * machines.ts (0600, atomic tmp+rename writes, no in-process cache): every
 * mint is a read-modify-write of the whole map, deduped against every id
 * already in the file. A missing or unreadable/corrupt file reads as `{}`
 * (never throws), so a corrupted map simply re-mints on next need. The mint
 * itself is machines.ts's `mintShortId` (shared alphabet + collision re-roll);
 * this module only adds the a6 length and its own store.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mintShortId } from './machines.js'

/** The persisted map: roster key (`native` for ctx0, else the adapter key) → a6 id. */
export type AgentIdMap = Record<string, string>

function agentIdsPath(home: string): string {
  return join(home, 'superd', 'agent-ids.json')
}

/** Read the id map; a missing or unreadable/corrupt file degrades to `{}` (never throws). */
export function agentIdMap(home: string): AgentIdMap {
  let raw: string
  try {
    raw = readFileSync(agentIdsPath(home), 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: AgentIdMap = {}
  for (const [key, id] of Object.entries(parsed)) {
    if (key !== '' && typeof id === 'string' && id !== '') out[key] = id
  }
  return out
}

/** Persist the whole map: recursive mkdir, tmp write, chmod 0600, atomic rename. */
function saveAgentIds(home: string, map: AgentIdMap): void {
  const dir = join(home, 'superd')
  mkdirSync(dir, { recursive: true })
  const target = agentIdsPath(home)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, target)
}

/**
 * Lazily mint + persist one agent's a6 id, deduped against every id already in
 * the map; an already-minted label is returned unchanged (idempotent). The
 * `native` label is minted like any other.
 */
export function ensureAgentId(home: string, label: string): string {
  const map = agentIdMap(home)
  const existing = map[label]
  if (existing !== undefined) return existing
  const id = mintShortId(6, Object.values(map))
  map[label] = id
  saveAgentIds(home, map)
  return id
}
