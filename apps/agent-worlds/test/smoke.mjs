// AW-A smoke (Task 7): CTX0 = web face on the line port + aw-routing gateway
// + the adapter's WORLD PLUGIN (ctx0 does NOT compose the adapter bundle —
// omp rows belong to the world). The plugin spawns ctx-omp itself (S2).
// SUPERD_KEEP: process stays up for first-person acceptance.
import { loadProfile, boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = '/home/u1/workspaces/superd'
const HOME = process.env.DSH_HOME ?? join(REPO, '.superd-test', 'aw')
const ANCHOR = process.env.SUPERD_DSH_ANCHOR ?? join(REPO, 'upstream/deepseek-harness/package.json')
const BARE = pathToFileURL(process.env.AW_BARE_BASE ?? join(HOME, 'profiles/node_modules') + '/').href
const PORT = process.env.AW_PORT ?? '4998'

// ---- provision the ctx0 profile + @pgmi-builds links (idempotent) ----
const profDir = join(HOME, 'profiles')
mkdirSync(join(profDir, 'aw-ctx0'), { recursive: true })
writeFileSync(join(profDir, 'aw-ctx0/package.json'), JSON.stringify({
  name: 'aw-ctx0-profile', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@pgmi-builds/aw-routing'] } },
  dependencies: { '@pgmi-builds/aw-routing': `file:${join(REPO, 'apps/agent-worlds/aw-routing')}` },
}, null, 2))
writeFileSync(join(profDir, 'aw-ctx0/cordis.patch.yml'), `# ctx0 web face on the line port (loopback; LAN only via socat/Caddy, per repo port discipline)
- id: webserver
  config:
    host: 127.0.0.1
    port: ${PORT}
- insert:
    - id: aw-agent-adapter-omp-world
      name: '@pgmi-builds/agent-adapter-omp/world'
`)
const pgmb = join(profDir, 'node_modules', '@pgmi-builds')
mkdirSync(pgmb, { recursive: true })
for (const pkg of ['aw-routing', 'agent-adapter-omp']) {
  const dst = join(pgmb, pkg)
  if (!existsSync(dst)) symlinkSync(join(REPO, 'apps/agent-worlds', pkg), dst)
}

// ---- boot ctx0 ----
const profile = loadProfile('aw-ctx0', 'aw-ctx0', ANCHOR, HOME)
writeFileSync(join(profile.dir, 'cordis.yml'), '[]\n')
const patches = [...profile.layers.flatMap((l) => l.patches), ...profile.patches]
// Embedding-host facts for ctx0 too (same public API as spawnWorld): worlds
// and ctx0 alike take no flags and never open a browser.
let fiber0
const ctx0 = await boot('aw-ctx0', join(profile.dir, 'cordis.yml'), patches, (ctx) => {
  provideCmdline(ctx, { args: ['--no-open'], exit: () => { void fiber0?.dispose() } })
}, BARE)
fiber0 = ctx0.fiber

// ---- wait for the omp world target (spawned by the world plugin) ----
const routing = await import('../aw-routing/dist/index.js')
let world = false
for (let i = 0; i < 240; i++) {
  if (routing.getTarget('omp') !== undefined) { world = true; break }
  await new Promise((r) => setTimeout(r, 500))
}
console.log(`[aw-smoke] roster=${JSON.stringify(routing.listAgents())} ompWorld=${world}`)
console.log('[aw-smoke] SUPERD_KEEP=1 — servers stay up for acceptance')
