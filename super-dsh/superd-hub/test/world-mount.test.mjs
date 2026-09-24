// World mount integration (AW-B Task 9): the world root runs with NO listener
// (`webserver` disabled), provides the virtual `webServer` from our world
// entry, and every route its plugins register lands translated on ctx0's real
// webServer — while the RPC channel (/api*) stays with the hub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnWorld, registerHostMount, worldServerOf, worldMountPatches } from '../dist/index.js'
import { WorldWebServer } from '../dist/world-web-server.js'

const REPO = join(new URL('../../..', import.meta.url).pathname)
const HOME = process.env.SUPERD_TEST_HOME ?? join(REPO, '.tests', 'superd')
const FIXTURE = new URL('./fixtures/superd-omp-world/', import.meta.url).pathname
const ANCHOR = process.env.SUPERD_DSH_ANCHOR ?? join(REPO, 'upstream/deepseek-harness/apps/cli/package.json')
const PROFILE = 'superd-omp-world-mounted'

function fakeReal() {
  return {
    routes: new Map(),
    upgrades: new Map(),
    fallback: undefined,
    register(route) {
      const id = `${route.kind}:${route.path}`
      this.routes.set(id, route)
      return () => this.routes.delete(id)
    },
    registerUpgrade(route) { this.upgrades.set(route.path, route); return () => this.upgrades.delete(route.path) },
    registerFallback(handler) { this.fallback = handler; return () => { this.fallback = undefined } },
    tapIndex() { return () => { } },
    port: 4999,
    host: '127.0.0.1',
  }
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (; ;) {
    if (check()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('a world with no listener mounts its whole surface under /<label> on ctx0', async () => {
  // PROD SHAPE: the world tree lives under `<home>/agents/<label>` — OUTSIDE
  // the host table's profiles tree — so row imports must ride the linked-root
  // route (spec §2.1), exactly like a consumer machine's world.
  const WORLD_HOME = join(HOME, 'agents', 'omp')
  mkdirSync(join(WORLD_HOME, 'profiles'), { recursive: true })
  cpSync(FIXTURE, join(WORLD_HOME, 'profiles', PROFILE), { recursive: true })
  // 0.1.7: resolveBundleDir consults only the installation anchor and the
  // profile's own directory — materialize the fixture's `file:` dependency
  // profile-locally (what `dsh plugin --profile X install` would do). Both
  // rebranded names: the adapter (fixture manifest + provision shape) and
  // the hub (worldMountPatches rows inject @pgmi-builds/superd-hub/*).
  const scopeDir = join(WORLD_HOME, 'profiles', PROFILE, 'node_modules', '@pgmi-builds')
  mkdirSync(scopeDir, { recursive: true })
  for (const [name, target] of [
    ['agent-omp', join(REPO, 'super-dsh', 'agent-omp')],
    ['superd-hub', join(REPO, 'super-dsh', 'superd-hub')],
  ]) {
    const dst = join(scopeDir, name)
    rmSync(dst, { recursive: true, force: true })
    symlinkSync(target, dst, 'dir')
  }
  // 0.1.7 boots the credentials file eagerly — pin every home-reading row to
  // the test home (the same list provisionWorldProfile writes for real
  // worlds; without this the world root would touch the PROD ~/.dsh).
  appendFileSync(
    join(WORLD_HOME, 'profiles', PROFILE, 'cordis.patch.yml'),
    ['# test-home pinning (provision parity): keep the world out of prod homes.',
     ...['settings', 'credentials', 'attachment-local', 'shell-env', 'skill-filesystem']
       .flatMap((id) => [`- id: ${id}`, '  config:', `    dshHome: ${HOME}`]),
     '',
    ].join('\n'),
  )
  // The row imports (`@pgmi-builds/superd-hub[/world]`, the adapter) ride the
  // HOST TABLE now: this test stands up the launcher's own surface (a mini
  // context with PluginPackages + profileContext facts) and lets spawnWorld
  // widen it (spec §2.1) — the profiles-level farm projection is gone, and
  // the profile-local @pgmi-builds links below serve the local-physical leg.
  const { createRuntimeResolution, loadProfile, PluginPackages } = await import('@deepseek-ai/dsh-app-boot')
  const { Context } = await import('@deepseek-ai/cordis')
  // The host's OWN profile: a minimal empty-bundles profile in the host tree
  // (installation-only resolution), like a bare consumer's ctx0.
  mkdirSync(join(HOME, 'profiles', 'host-min'), { recursive: true })
  writeFileSync(
    join(HOME, 'profiles', 'host-min', 'package.json'),
    JSON.stringify({ name: 'host-min', private: true, dsh: { profile: { bundles: [] } } }, null, 2) + '\n',
  )
  const hostProfile = loadProfile('dsh', 'host-min', ANCHOR, HOME)
  const host = new Context()
  await host.plugin(PluginPackages, {
    resolution: await createRuntimeResolution({ installAnchor: ANCHOR, profile: hostProfile, home: HOME }),
  })
  host.provide('profileContext', {
    name: 'host-min',
    dir: join(HOME, 'profiles', 'host-min'),
    patchPath: join(HOME, 'profiles', 'host-min', 'cordis.patch.yml'),
    installAnchor: ANCHOR,
    cwd: process.cwd(),
    home: HOME,
    startedBundles: [],
    overlays: [],
  })
  const real = fakeReal()
  const dropMount = registerHostMount({ key: 'omp', labelPath: '/omp', real })

  const ctxW = await spawnWorld({
    appName: PROFILE,
    profileName: PROFILE,
    installAnchor: ANCHOR,
    home: WORLD_HOME,
    host,
    extraPatches: worldMountPatches('omp'),
  })

  const webServer = worldServerOf('omp')
  assert.equal(webServer instanceof WorldWebServer, true, 'the world root got the virtual webServer')
  assert.equal(webServer.labelPath, '/omp')

  const mounted = await waitFor(() => real.routes.has('prefix:/omp/plugins') && real.routes.has('prefix:/omp'))
  assert.equal(mounted, true, `world surface landed under /omp (saw: ${[...real.routes.keys()].join(', ')})`)
  assert.equal(real.routes.has('prefix:/omp/api'), false, 'the world never owns the RPC channel')
  assert.equal(real.upgrades.has('/omp/api/remote.mux'), false, 'the world never owns the mux path')

  await new Promise((resolve) => setTimeout(resolve, 200))
  await ctxW.fiber.dispose()
  dropMount()
})
