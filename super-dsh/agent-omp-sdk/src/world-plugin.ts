/**
 * agent-omp-sdk — the adapter's world plugin (spec S2): activation IS
 * roster membership.
 *
 * This is the OPT-IN sibling of `@pgmi-builds/agent-omp` (the RPC line). It
 * mounts the SAME provider shape under its own world key (`omp-sdk`), which is
 * what keeps the two independently toggleable: the hub's `registerAgent`
 * hard-throws on a duplicate key, and `provisionWorldProfile` derives the
 * adapter directory from `agent-<key>`.
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
 *   3. the hub's `/hub` family answers `?agent=omp-sdk` traffic in ctx0's auth
 *      domain and dispatches into this world's gateway instance (the
 *      per-label `/<label>/api` + `/<label>/api/mux` mounts retired in T-C,
 *      `mountWorld` deleted in T-D).
 *
 * SDK runtime discipline: mounting this row (or booting the world) fetches
 * NOTHING. The durable runtime (bun + the pinned coding-agent package + this
 * package's sidecar) is fetched into `<worldHome>/sdk-runtime/` on the first
 * real prompt; {@link diagnoseSdkRuntime} only REPORTS the current state.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import {
  spawnWorld, registerAgent, unregisterAgent, setReady, registerForeignTarget,
  registerHostMount, worldMountPatches, provisionWorldProfile, resolveInstallAnchor,
} from '../../superd-hub/dist/index.js'
import { sdkRuntimeLayout } from './sdk-runtime.js'

export const name = 'agent-omp-sdk'

/**
 * Runtime key — also the mount label and the `agents/<key>` directory. NOT
 * `omp`: this row ships alongside the RPC line in the same composite, and the
 * two are separately toggleable.
 */
const KEY = 'omp-sdk'


/** Structural slice of the ctx0 services the mount needs. */
interface HostContext {
  provide(name: string, value: unknown): void
  inject(deps: string[], callback: (ctx: unknown) => void): unknown
  effect?(callback: () => () => void, label?: string): unknown
  get(name: string): unknown
}

/**
 * Startup diagnostic (spec §2.4/§2.5): the SDK runtime is NOT a delivery
 * artifact — it is fetched into the world home when the row is first used.
 * Probe the marker once and say which state we are in; readiness semantics stay
 * "mount success ≠ runtime present" (a missing runtime fails the FIRST PROMPT
 * loudly, it does not unship the row).
 *
 * Deliberately non-fetching, non-spawning and non-importing of the runtime.
 */
function diagnoseSdkRuntime(worldHome: string): void {
  const layout = sdkRuntimeLayout(worldHome)
  // Presence, not identity: the adapter version is part of the marker's
  // identity and is re-checked inside `ensureSdkRuntime` at fetch time. Here we
  // only answer "is a complete-looking runtime on disk?".
  if (existsSync(layout.marker) && existsSync(layout.bun)) return
  console.log(
    `[super-dsh] omp-sdk runtime not fetched yet (${layout.dir}) — the first real prompt will download bun + ` +
    `the pinned coding-agent package there (~900 MB). ` +
    `Pre-warm it with \`npm run fetch-sdk-runtime\` (OMP_SDK_PACKAGE_VERSION overrides the pin).`,
  )
}

export function apply(ctx: HostContext): void {
  // Roster membership is FIBER-SCOPED (2026-10-03 acceptance finding):
  // disabling this row from the plugin manager disposes the fiber, and the
  // entry must go with it. The `/api/agent-runtime` view hides a row whose
  // host mount is gone, but the raw roster map is never pruned — so without
  // this disposer a later re-enable dies on `roster: duplicate agent key
  // omp-sdk` (reproduced live on 4997).
  ctx.effect?.(() => {
    registerAgent({ key: KEY, label: 'OMP (SDK)', ready: false })
    return () => unregisterAgent(KEY)
  }, `agent-${KEY}: roster`)
  // Harness resolver (env → ~/.dsh): a consumer install has no DSH_HOME and
  // no cwd contract — deriving the world root from cwd spawns worlds into a
  // garbage tree or throws inside apply() and kills the whole host boot.
  const root = resolveDshHome()
  // S7 nested home: every runtime owns one root under `agents/<label>`, and the
  // world's DSH data lives INSIDE it (sessions / settings / workspaces), so no
  // two runtimes ever share a session list. This world's own durable SDK
  // runtime lives in the same root (`<worldHome>/sdk-runtime/`).
  const worldHome = join(root, 'agents', KEY)
  mkdirSync(join(worldHome, 'profiles'), { recursive: true })
  // Report-only: never fetches (see the function doc).
  diagnoseSdkRuntime(worldHome)
  // Publish story: a foreign install has no line bootstrap, so the nested
  // profile + @pgmi-builds links are provisioned HERE (idempotent).
  provisionWorldProfile({
    key: KEY,
    adapterPkg: '@pgmi-builds/agent-omp-sdk',
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
    // Toggling the row off must really UNLOAD the world (2026-10-03 acceptance
    // finding): disposing the world's own fiber disposes its provider, which
    // releases every held transport, which releases the refcounted sidecar —
    // without this the bun sidecar (hundreds of MB) outlives its own row.
    ctx.effect?.(() => () => {
      void (ctxW as unknown as { fiber?: { dispose(): unknown } }).fiber?.dispose()
    }, `agent-${KEY}: world teardown`)
    return ctxW
  })().catch((cause: unknown) => {
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
    return null
  })
  ctx.provide(`superd.world.${KEY}`, world)
}
