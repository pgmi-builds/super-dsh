/** superd-run helper bootstrap (spec: docs/specs/remote-rescope/spec.md §5).
 * Per-target probe → miss → upload (cat-over-exec, stdin is raw binary bytes) → verify.
 * Any failure is STICKY-null for the driver lifetime: the POSIX shim stays the default
 * path everywhere the helper cannot be proven present. The runner receipt distinguishes
 * `superd-run <ver> (<triple>)` from `posix-shim` — honesty over capability claims. */
import { readFile } from 'node:fs/promises'
import { readFileSync as readSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TargetPlan } from './target.ts'

export interface HelperManifest {
  format: 1
  name: string
  ver: string
  protocol: number
  targets: Record<string, { file: string; bytes: number; sha256: string }>
}

export interface HelperAssets {
  dir: string
  manifest: HelperManifest
}

export interface HelperRunnerInfo {
  binPath: string
  triple: string
  ver: string
  protocol: number
}

export type HelperExecResult = { exit: number | null; stdout: string }
export type HelperExec = (argv: string[], options?: { stdin?: Buffer; timeoutSec?: number }) => Promise<HelperExecResult>

/** Reads helper-bin/MANIFEST.json next to the compiled module (lib/remote in the npm
 * package, super-dsh/remote in the Super closure — same relative layout). Missing or
 * malformed assets ⇒ null ⇒ shim-only mode; never throws. */
export function helperAssets(baseDir?: string): HelperAssets | null {
  const dir = baseDir ?? join(dirname(fileURLToPath(import.meta.url)), 'helper-bin')
  try {
    const manifest = JSON.parse(readSync(join(dir, 'MANIFEST.json'), 'utf8')) as HelperManifest
    if (manifest?.format !== 1 || typeof manifest.ver !== 'string' || typeof manifest.protocol !== 'number' || !manifest.targets || typeof manifest.targets !== 'object') return null
    return { dir, manifest }
  } catch {
    return null
  }
}

/** `uname -s`/`uname -m` → shipped target triple. Unknown combos ⇒ null (shim). */
export function archTriple(sys: string, machine: string, shipped: ReadonlySet<string>): string | null {
  const s = sys.trim().toLowerCase(), m = machine.trim().toLowerCase()
  const candidates = s === 'linux'
    ? (m === 'x86_64' || m === 'amd64') ? 'x86_64-unknown-linux-musl' : (m === 'aarch64' || m === 'arm64') ? 'aarch64-unknown-linux-musl' : null
    : s === 'darwin'
      ? (m === 'arm64' || m === 'aarch64') ? 'aarch64-apple-darwin' : null
      : null
  if (candidates === null) return null
  return shipped.has(candidates) ? candidates : null
}

function planKey(plan: TargetPlan): string {
  switch (plan.kind) {
    case 'ssh': {
      const c = plan.connection
      const host = c?.host ?? plan.host
      return `ssh|${c?.user ? c.user + '@' : ''}${host}${c?.port ? ':' + c.port : ''}${c?.proxyJump ? '|' + c.proxyJump : ''}`
    }
    case 'docker': return `docker|${plan.container}`
    case 'incus': return `incus|${plan.container}`
  }
}

const PROBE_RE = /^SUPERD-PROBE (\S+) (\S+)$/m
const READY_RE = /^SUPERD-READY (\S+)$/m

export class HelperRegistry {
  private readonly states = new Map<string, Promise<HelperRunnerInfo | null>>()

  constructor(
    private readonly assets: HelperAssets,
    private readonly exec: HelperExec,
    private readonly probeArgv: (plan: TargetPlan, assets: HelperAssets, muxArgv: readonly string[]) => string[],
    private readonly uploadArgv: (plan: TargetPlan, triple: string, file: string, assets: HelperAssets, muxArgv: readonly string[]) => string[],
  ) {}

  /** Never throws: any bootstrap failure resolves null (sticky) and the caller stays on the shim. */
  ensure(plan: TargetPlan, muxArgv: readonly string[] = []): Promise<HelperRunnerInfo | null> {
    if (plan.kind !== 'ssh' && plan.kind !== 'docker' && plan.kind !== 'incus') return Promise.resolve(null)
    const key = planKey(plan)
    let entry = this.states.get(key)
    if (entry === undefined) {
      entry = this.bootstrap(plan, muxArgv).catch(() => null)
      // Sticky outcome; swallow for any waiter that never awaits.
      entry.catch(() => {})
      this.states.set(key, entry)
    }
    return entry
  }

  private async bootstrap(plan: TargetPlan, muxArgv: readonly string[]): Promise<HelperRunnerInfo | null> {
    const { manifest } = this.assets
    const first = await this.exec(this.probeArgv(plan, this.assets, muxArgv), { timeoutSec: 15 })
    const ready = this.parseReady(first.stdout, manifest.ver, manifest.protocol)
    if (ready !== null) return ready
    const probe = PROBE_RE.exec(first.stdout)
    if (probe === null || (first.exit !== 90 && first.exit !== 0)) return null
    const triple = archTriple(probe[1]!, probe[2]!, new Set(Object.keys(manifest.targets)))
    if (triple === null) return null
    const target = manifest.targets[triple]!
    // Upload over the same exec lane: remote `cat > tmp && chmod && mv` with the raw
    // binary on stdin — no base64 inflation, no scp identity plumbing.
    const binary = await readFile(join(this.assets.dir, triple, target.file))
    const upload = await this.exec(this.uploadArgv(plan, triple, target.file, this.assets, muxArgv), { stdin: binary, timeoutSec: 60 })
    if (upload.exit !== 0) return null
    const second = await this.exec(this.probeArgv(plan, this.assets, muxArgv), { timeoutSec: 15 })
    return this.parseReady(second.stdout, manifest.ver, manifest.protocol)
  }

  private parseReady(stdout: string, ver: string, protocol: number): HelperRunnerInfo | null {
    const ready = READY_RE.exec(stdout)
    const banner = /^SUPERD-RUN proto=(\d+) name=superd-run ver=(\S+) target=(\S+)/m.exec(stdout)
    if (ready === null || banner === null) return null
    if (banner[1] !== String(protocol) || banner[2] !== ver) return null // stale/mismatched cache
    return { binPath: ready[1]!, triple: banner[3]!, ver, protocol }
  }
}
