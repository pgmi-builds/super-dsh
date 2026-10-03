/**
 * agent-codex-sdk — the Codex adapter's WORLD plugin (spec S2):
 * activation IS roster membership.
 *
 * AW-B data-plane shape (DL1–DL5 → path-separation T-D), mirroring
 * `@pgmi-builds/agent-omp/world` so the hub sees both foreign runtimes through
 * one shape: the world is spawned as a sibling ROOT context with NO listener
 * and NO webui composition (`worldMountPatches`) — a pure data plane behind
 * the hub's `/hub` family —
 *
 *   1. ctx0 publishes the host mount record (the world's addressability
 *      entry — no webServer, no fence: those legs retired with the world
 *      pages) before spawn;
 *   2. the world's entry row provides the virtual `webServer` (a silent
 *      sink) plus the neutral `webRuntime` facts its connection row injects;
 *   3. the hub's `/hub` family answers `?agent=codex-sdk` traffic in ctx0's auth
 *      domain and dispatches into this world's gateway instance (the
 *      per-label `/<label>/api` + `/<label>/api/remote.mux` mounts retired
 *      in T-C, `mountWorld` deleted in T-D).
 */
import { mkdirSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import {
  spawnWorld, registerAgent, unregisterAgent, setReady, registerForeignTarget,
  registerHostMount, worldMountPatches, provisionWorldProfile, resolveInstallAnchor,
} from '../../superd-hub/dist/index.js'

export const name = 'agent-codex-sdk'

/** Runtime key — also the mount label. */
const KEY = 'codex-sdk'


/** Structural slice of the ctx0 services the mount needs. */
interface HostContext {
  provide(name: string, value: unknown): void
  inject(deps: string[], callback: (ctx: unknown) => void): unknown
  effect?(callback: () => () => void, label?: string): unknown
  get(name: string): unknown
}

export function apply(ctx: HostContext): void {
  // Roster membership is FIBER-SCOPED (2026-10-03 acceptance finding):
  // disabling this row from the plugin manager disposes the fiber, and the
  // entry must go with it. The `/api/agent-runtime` view hides a row whose
  // host mount is gone, but the raw roster map is never pruned — so without
  // this disposer a later re-enable dies on `roster: duplicate agent key
  // codex-sdk`.
  ctx.effect?.(() => {
    registerAgent({ key: KEY, label: 'Codex (SDK)', ready: false })
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
  // Publish story: a foreign install has no line bootstrap, so the nested
  // profile + @pgmi-builds links are provisioned HERE (idempotent).
  provisionWorldProfile({
    key: KEY,
    adapterPkg: '@pgmi-builds/agent-codex-sdk',
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
    // Toggling the row off must really UNLOAD the world (2026-10-03 omp-sdk
    // acceptance finding, same shape here): disposing the world's own fiber
    // disposes its provider, which releases every transport and the refcounted
    // SDK handle — without this the world outlives its own row.
    ctx.effect?.(() => () => {
      void (ctxW as unknown as { fiber?: { dispose(): unknown } }).fiber?.dispose()
    }, `agent-${KEY}: world teardown`)
    return ctxW
  })().catch((cause: unknown) => {
    // A failed world degrades to a not-ready roster row; a rejected provided
    // promise would fail the entire host boot (loader entry apply).
    console.error(`[super-dsh] ${KEY} world failed:`, cause)
    return null
  })
  ctx.provide(`superd.world.${KEY}`, world)
}
