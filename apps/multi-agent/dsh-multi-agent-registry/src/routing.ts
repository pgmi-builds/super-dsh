/**
 * Runtime-key side table (M1 Task 2 ruling: registry-owned storage).
 *
 * Storage backend decision (spec §四-勘注, 2026-09-09): a registry-owned side
 * table — plain JSON, atomically written (tmp+rename) — inside the plugin's
 * writable data area. It is anchored on the resolved DeepSeek Harness home
 * via `dshHomePath()` because no cordis `Context` surface exposes the home
 * path; `dsh-home-paths` resolves it purely from `DSH_HOME` (falling back to
 * `~/.dsh` only when the env is unset — in this repo the bin always sets
 * `DSH_HOME`, and tests isolate through the same env / `setKeyStorePath`).
 * The known cost (keys do not migrate with session logs) is accepted in the
 * spec. Corrupt or missing file degrades to an empty table: routing then
 * fails safe to the `native` slot.
 *
 * Dependency-free by design: node:fs/node:path + the pinned home-paths helper.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** File name of the side table inside the resolved harness home. */
export const KEY_STORE_FILE_NAME = 'agent-runtime-keys.json'

// Test seam: when set, overrides the derived store path entirely (and drops
// the cache so the next read re-loads from the injected location).
let storePathOverride: string | undefined
let cache: Map<string, string> | undefined

/**
 * Override (or clear) the side-table location. Test seam only — production
 * code always derives the path from the harness home.
 */
export function setKeyStorePath(path: string | undefined): void {
  storePathOverride = path
  cache = undefined
}

/** Current side-table path (injectable override first, then harness home). */
export function keyStorePath(): string {
  return storePathOverride ?? dshHomePath(KEY_STORE_FILE_NAME)
}

/** Drop the in-memory cache (used on override and by tests). */
export function resetKeyCache(): void {
  cache = undefined
}

function loadTable(): Map<string, string> {
  const path = keyStorePath()
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    // Fail-safe shape check: anything that is not a string→string record is
    // treated as corrupt → empty table (routing degrades to native).
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    const table = new Map<string, string>()
    for (const [sessionId, key] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === 'string') table.set(sessionId, key)
    }
    return table
  } catch {
    // Missing or corrupt file: empty table.
    return new Map()
  }
}

function flushTable(table: Map<string, string>): void {
  const path = keyStorePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${KEY_STORE_FILE_NAME}.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(table), null, 2))
  renameSync(tmp, path)
}

/**
 * Read the routing key for a session. `undefined` means "no key" — callers
 * treat that as the `native` slot. Lazy-loads the table on first use and
 * keeps it cached; writes go through {@link writeKey}.
 */
export function readKey(sessionId: string): string | undefined {
  cache ??= loadTable()
  return cache.get(sessionId)
}

/** Write (or overwrite) the routing key for a session; write-through. */
export function writeKey(sessionId: string, key: string): void {
  cache ??= loadTable()
  if (cache.get(sessionId) === key) return
  cache.set(sessionId, key)
  flushTable(cache)
}

/** Remove the routing key for a session (absent key is a no-op). */
export function clearKey(sessionId: string): void {
  cache ??= loadTable()
  if (!cache.has(sessionId)) return
  cache.delete(sessionId)
  flushTable(cache)
}
