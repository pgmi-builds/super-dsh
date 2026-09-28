/**
 * The super-dsh PACK version (D6 fix): `super-dsh/package.json`'s version —
 * the number `dsh plugin add` actually versions and the only one that moves
 * with releases. The hub SUBPACKAGE's own manifest is a constant 0.1.0, which
 * made both the served `hub.version` and the I2 comparator dead code exactly
 * in the case they exist for (a stale peer pack).
 *
 * Depth contract: this module compiles to `<pack root>/superd-hub/dist/`, so
 * the pack manifest is exactly two hops up — `../../package.json`. Verified
 * against the built tree in BOTH shapes: repo (`super-dsh/superd-hub/dist/`
 * → `super-dsh/package.json`) and the packed tarball (`package/superd-hub/dist/`
 * → `package/package.json`; npm always includes the root manifest).
 *
 * Unparsable or missing → 'unknown' (warn honestly: the I2 comparator treats
 * an unreadable version as a compatibility fact, which is the truth).
 */
import { createRequire } from 'node:module'

function readPackVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: unknown }
    if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** The super-dsh pack version, or 'unknown' when the manifest cannot be read. */
export const PACK_VERSION: string = readPackVersion()
