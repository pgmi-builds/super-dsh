/**
 * aw.agent-adapter-omp — the adapter's world plugin (spec S2): activation IS
 * roster membership. Spawning the omp world (a sibling ROOT context) uses the
 * adapter's own composition (dsh-base + dsh-web-app + this bundle's rows),
 * joins the line gateway's target registry, and flips roster readiness once
 * the world's typertGateway instance is live.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  spawnWorld, registerAgent, setReady, registerForeignTarget,
} from '@pgmi-builds/aw-routing'

export const name = 'aw.agent-adapter-omp'

const ANCHOR = process.env.SUPERD_DSH_ANCHOR
  ?? '/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/package.json'

export function apply(ctx: {
  provide(name: string, value: unknown): void
}): void {
  registerAgent({ key: 'omp', label: 'OMP', ready: false })
  const home = process.env.DSH_HOME ?? join(process.cwd(), '.superd-test', 'aw')
  // S7 nested home (ruling 2026-09-14: dshHomePath is NEVER overridden —
  // per-agent storage lives at plain subpaths of the shared resolved home;
  // OMP_HOME redirection into it is the adapter's own pipe, see AW-C0).
  const ompHome = join(home, 'agents', 'omp')
  mkdirSync(ompHome, { recursive: true })
  const world = (async () => {
    const ctxW = await spawnWorld({
      appName: 'aw-omp',
      profileName: 'aw-omp-world',
      installAnchor: ANCHOR,
      home,
      // Adapter-local bundle names resolve from the profile's own
      // node_modules (heal owns @deepseek-ai there; @pgmi-builds links are
      // provisioned by the line bootstrap/test setup).
      bareModuleBaseUrl: process.env.AW_BARE_BASE,
    })
    registerForeignTarget({ key: 'omp', gateway: ctxW.get('typertGateway') })
    setReady('omp', true)
    return ctxW
  })()
  ctx.provide('aw.world.omp', world)
}
