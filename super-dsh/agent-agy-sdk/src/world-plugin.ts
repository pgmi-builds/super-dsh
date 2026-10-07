/**
 * agent-agy — the Antigravity (agy) adapter's WORLD plugin (spec S2):
 * activation IS roster membership.
 *
 * AW-B data-plane shape (DL1–DL5 → path-separation T-D), mirroring
 * `@pgmi-builds/agent-omp/world` and `@pgmi-builds/agent-codex/world` so the
 * hub sees every foreign runtime through one shape: the world is spawned as a
 * sibling ROOT context with NO listener and NO webui composition
 * (`worldMountPatches`) — a pure data plane behind the hub's `/hub` family.
 *
 *   1. ctx0 publishes the host mount record (the world's addressability
 *      entry — no webServer, no fence: those legs retired with the world
 *      pages) before spawn;
 *   2. the world's entry row provides the virtual `webServer` (a silent
 *      sink) plus the neutral `webRuntime` facts its connection row injects;
 *   3. the hub's `/hub` family answers `?agent=agy` traffic in ctx0's auth
 *      domain and dispatches into this world's gateway instance (the
 *      per-label `/<label>/api` + `/<label>/api/remote.mux` mounts retired
 *      in T-C, `mountWorld` deleted in T-D).
 */
import { mkdirSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import {
  spawnWorld, registerAgent, setReady, registerForeignTarget,
  registerHostMount, worldMountPatches, provisionWorldProfile, resolveInstallAnchor,
} from '../../superd-hub/dist/index.js'

export const name = 'agent-agy-sdk'

/**
 * Runtime key — also the mount label. Deliberately NOT `agy`: the hub's roster
 * (registerAgent) hard-throws on a duplicate key, and this row ships alongside
 * the CLI row in the same composite. Distinct keys keep both independently
 * toggleable and make the "both enabled" mistake survivable.
 */
const KEY = 'agy-sdk'


/** Structural slice of the ctx0 services the mount needs. */
interface HostContext {
  provide(name: string, value: unknown): void
  inject(deps: string[], callback: (ctx: unknown) => void): unknown
  effect?(callback: () => () => void, label?: string): unknown
  get(name: string): unknown
}

export function apply(ctx: HostContext): void {
  registerAgent({ key: KEY, label: 'Antigravity (SDK)', ready: false })
  // Harness resolver (env → ~/.dsh): a consumer install has no DSH_HOME and
  // no cwd contract — deriving the world root from cwd spawns worlds into a
  // garbage tree or throws inside apply() and kills the whole host boot.
  const root = resolveDshHome()
  // Nested home: the world's DSH data lives INSIDE `agents/<label>` (sessions
  // / settings / workspaces, and the adapter's dsh-sessions.json mapping).
  // agy-sdk: the world home carries the DSH-side state AND the lazily fetched
  // durable Python venv (sdk-venv.ts); nothing is nested for the SDK itself.
  const worldHome = join(root, 'agents', KEY)
  mkdirSync(join(worldHome, 'profiles'), { recursive: true })
  // Publish story: a foreign install has no line bootstrap, so the nested
  // profile + @pgmi-builds links are provisioned HERE (idempotent).
  provisionWorldProfile({
    key: KEY,
    adapterPkg: '@pgmi-builds/agent-agy-sdk',
    worldHome,
  })
  const world = (async () => {
    // T-D: no ctx0 listening-stack wait — the mount record is addressability
    // only and the /hub family wires its own gate in ctx0 (gateway.ts).
    const dropHostMount = registerHostMount({ key: KEY, labelPath: `/${KEY}` })
    const ctxW = await spawnWorld({
      appName: `superd-${KEY}`,
      profileName: 'web',
      installAnchor: resolveInstallAnchor(ctx), // lazy: never at module scope — import must stay side-effect-free
      home: worldHome,
      dataHome: worldHome,
      // The host's live table carries this world: spawnWorld republishes a
      // widened successor before boot imports anything (spec §2.1), and
      // @pgmi-builds rows resolve from the profile-local links written above.
      host: ctx,
      extraPatches: worldMountPatches(KEY) as never,
    })
    const gateway = ctxW.get('typertGateway') as never
    registerForeignTarget({ key: KEY, gateway })
    setReady(KEY, true)
    ctx.effect?.(() => () => {
      dropHostMount()
    }, `agent-${KEY}: mount`)
    return ctxW
  })().catch((cause: unknown) => {
    // A failed world degrades to a not-ready roster row; a rejected provided
    // promise would fail the entire host boot (loader entry apply).
    console.error(`[super-dsh] ${KEY} world failed:`, cause)
    return null
  })
  ctx.provide(`superd.world.${KEY}`, world)
}
