/**
 * agent-omp — the adapter's world plugin (spec S2): activation IS
 * roster membership.
 *
 * AW-B (DL1–DL5) → path-separation T-D: the world is spawned as a sibling
 * ROOT context with NO listener and NO webui composition (see
 * `worldMountPatches`) — a pure data plane behind the hub's `/hub` family:
 *
 *   1. ctx0 publishes the host mount record (the world's addressability
 *      entry — no webServer, no fence: those legs retired with the world
 *      pages) before spawn.
 *   2. the world's entry row provides the virtual `webServer` (a silent
 *      sink) plus the neutral `webRuntime` facts its connection row injects.
 *   3. the hub's `/hub` family answers `?agent=omp` traffic in ctx0's auth
 *      domain and dispatches into this world's gateway instance (the
 *      per-label `/<label>/api` + `/<label>/api/remote.mux` mounts retired
 *      in T-C, `mountWorld` deleted in T-D).
 */
import { existsSync, mkdirSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import {
  spawnWorld,
  worldMountPatches, provisionWorldProfile, resolveInstallAnchor,
} from '../../superd-hub/dist/index.js'
import { ownWorld } from '../../superd-hub/dist/world-lifecycle.js'
import { resolveOmpExecutable } from './rpc-client.js'

export const name = 'agent-omp'

/** Runtime key — also the mount label. */
const KEY = 'omp'


/** Structural slice of the ctx0 services the mount needs. */
interface HostContext {
  provide(name: string, value: unknown): void
  inject(deps: string[], callback: (ctx: unknown) => void): unknown
  effect(callback: () => () => Promise<void>, label?: string): unknown
  get(name: string): unknown
}

/**
 * Startup diagnostic (spec §3.5): the OMP world runs the operator's own `omp`
 * binary over `omp --mode rpc` — the adapter bundles no OMP copy, so a missing
 * binary fails at the FIRST PROMPT, not at boot. Probe the resolution order
 * once and say so explicitly instead of mounting silently; readiness semantics
 * are unchanged (they follow the world mount, not this probe).
 */
function diagnoseOmpBinary(): void {
  const executable = resolveOmpExecutable()
  // A bare name is what the resolver yields for BOTH a PATH hit and "nothing
  // installed" — walk PATH to tell those apart. A slashed candidate is already
  // a concrete path and is checked directly.
  const present = executable.includes('/')
    ? existsSync(executable)
    : (process.env.PATH ?? '').split(':').filter(Boolean).some((dir) => existsSync(join(dir, executable)))
  if (!present) {
    console.error('[super-dsh] omp binary not found (checked $OMP_EXECUTABLE, PATH, ~/.local/bin/omp) — the OMP world will fail at first prompt')
  }
}

export function apply(ctx: HostContext): void {
  diagnoseOmpBinary()
  // Harness resolver (env → ~/.dsh): a consumer install has no DSH_HOME and
  // no cwd contract — deriving the world root from cwd spawns worlds into a
  // garbage tree or throws inside apply() and kills the whole host boot.
  const root = resolveDshHome()
  // S7 nested home: every runtime owns one root under `agents/<label>`, and the
  // world's DSH data lives INSIDE it (sessions / settings / workspaces), so no
  // two runtimes ever share a session list. The foreign app's own store sits in
  // the same root (adapter-owned app home, see AW-C0).
  const worldHome = join(root, 'agents', KEY)
  mkdirSync(join(worldHome, 'profiles'), { recursive: true })
  // Publish story: a foreign install has no line bootstrap, so the nested
  // profile + @pgmi-builds links are provisioned HERE (idempotent).
  provisionWorldProfile({
    key: KEY,
    adapterPkg: '@pgmi-builds/agent-omp',
    worldHome,
  })
  const world = ownWorld(ctx, { key: KEY, label: 'OMP' }, (ownerId) => spawnWorld({
    appName: `superd-${KEY}`,
    profileName: 'web',
    installAnchor: resolveInstallAnchor(ctx), // lazy: never at module scope — import must stay side-effect-free
    home: worldHome,
    dataHome: worldHome,
    // The host's live table carries this world: spawnWorld republishes a
    // widened successor before boot imports anything (spec §2.1), and
    // @pgmi-builds rows resolve from the profile-local links written above.
    host: ctx,
    extraPatches: worldMountPatches(KEY, ownerId) as never,
  }), (cause) => {
    // A failed world degrades to a not-ready roster row; a rejected provided
    // promise would fail the entire host boot (loader entry apply).
    console.error(`[super-dsh] ${KEY} world failed:`, cause)
    // Startup diagnostics: the collector's warn/error records include the
    // loader's own patch/import diagnostics for this world's include.
    const startup = (cause as { startup?: { messages?: unknown } }).startup
    if (startup?.messages !== undefined) {
      for (const message of startup.messages as unknown[]) {
        console.error(`[super-dsh] ${KEY} startup:`, JSON.stringify(message))
      }
    }
  })
  ctx.provide(`superd.world.${KEY}`, world)
}
