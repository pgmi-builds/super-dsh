// World mount integration (AW-B Task 9): the world root runs with NO listener
// (`webserver` disabled), provides the virtual `webServer` from our world
// entry, and every route its plugins register lands translated on ctx0's real
// webServer — while the RPC channel (/api*) stays with the hub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnWorld, registerHostMount, worldServerOf, worldMountPatches } from '../dist/index.js'
import { WorldWebServer } from '../dist/world-web-server.js'

const REPO = join(new URL('../../..', import.meta.url).pathname)
const HOME = process.env.AW_TEST_HOME ?? join(REPO, '.tests', 'aw')
const FIXTURE = new URL('./fixtures/aw-omp-world/', import.meta.url).pathname
const ANCHOR = process.env.SUPERD_DSH_ANCHOR ?? join(REPO, 'upstream/deepseek-harness/apps/cli/package.json')
const BARE = join(HOME, 'profiles', 'node_modules') + '/'
const PROFILE = 'aw-omp-world-mounted'

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
  mkdirSync(join(HOME, 'profiles'), { recursive: true })
  cpSync(FIXTURE, join(HOME, 'profiles', PROFILE), { recursive: true })
  // 0.1.7: resolveBundleDir consults only the installation anchor and the
  // profile's own directory — materialize the fixture's `file:` dependency
  // profile-locally (what `dsh plugin --profile X install` would do).
  const scopeDir = join(HOME, 'profiles', PROFILE, 'node_modules', '@pgmi-builds')
  mkdirSync(scopeDir, { recursive: true })
  const adapterLink = join(scopeDir, 'agent-adapter-omp')
  rmSync(adapterLink, { recursive: true, force: true })
  symlinkSync(join(REPO, 'super-dsh', 'agent-omp'), adapterLink, 'dir')
  // 0.1.7 boots the credentials file eagerly — pin every home-reading row to
  // the test home (the same list provisionWorldProfile writes for real
  // worlds; without this the world root would touch the PROD ~/.dsh).
  appendFileSync(
    join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'),
    ['# test-home pinning (provision parity): keep the world out of prod homes.',
     ...['settings', 'credentials', 'attachment-local', 'shell-env', 'skill-filesystem']
       .flatMap((id) => [`- id: ${id}`, '  config:', `    dshHome: ${HOME}`]),
     '',
    ].join('\n'),
  )
  // The row imports (`@pgmi-builds/agent-hub[/world]`, the adapter) resolve as
  // URLs under the bare module base — the profiles-level farm provisionWorld
  // maintains on the real line; this test bypasses provision, so link here.
  const bareScope = join(HOME, 'profiles', 'node_modules', '@pgmi-builds')
  mkdirSync(bareScope, { recursive: true })
  for (const [name, target] of [
    ['agent-adapter-omp', join(REPO, 'super-dsh', 'agent-omp')],
    ['agent-hub', join(REPO, 'super-dsh', 'agent-hub')],
  ]) {
    const dst = join(bareScope, name)
    rmSync(dst, { recursive: true, force: true })
    symlinkSync(target, dst, 'dir')
  }
  // 0.1.7: the launcher no longer heals a profiles-level @deepseek-ai farm
  // (healProfilesModuleFallback is gone; interception replaced it), but this
  // test's spawnWorld resolves bare plugin names as URLs under
  // HOME/profiles/node_modules — project the runtime resolution there.
  const { createRuntimeResolution } = await import('@deepseek-ai/dsh-app-boot')
  const resolution = await createRuntimeResolution({ installAnchor: ANCHOR, home: HOME })
  for (const entry of resolution.entries) {
    const dest = join(HOME, 'profiles', 'node_modules', entry.name)
    if (existsSync(dest)) rmSync(dest, { force: true })
    mkdirSync(dirname(dest), { recursive: true })
    symlinkSync(entry.packageDir, dest, 'dir')
  }
  const real = fakeReal()
  const dropMount = registerHostMount({ key: 'omp', labelPath: '/omp', real })

  const ctxW = await spawnWorld({
    appName: PROFILE,
    profileName: PROFILE,
    installAnchor: ANCHOR,
    home: HOME,
    bareModuleBaseUrl: BARE,
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
