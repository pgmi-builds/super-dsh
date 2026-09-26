// World mount integration (AW-B Task 9 → path-separation T-C/T-D): the world
// root runs with NO listener and, since T-D, NO webui rows either —
// `web-runtime`/`client-hmr` are disabled, the page-trust row is gone, and
// the only web-ish facts left are the VIRTUAL `webServer` the mount row
// provides (a silent sink, T-C) plus the neutral `webRuntime` the
// `connection` row injects. The world is a pure data plane; `/hub` is the
// sole entry (`?agent=<label>` demux).
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnWorld, registerHostMount, worldServerOf, worldMountPatches } from '../dist/index.js'
import { WorldWebServer } from '../dist/world-web-server.js'

const REPO = join(new URL('../../..', import.meta.url).pathname)
const HOME = process.env.SUPERD_TEST_HOME ?? join(REPO, '.tests', 'superd')
// The world's webRuntime trusted-host extras derive from this env (world-entry);
// pin the neutral no-extras shape for the deterministic assertion below.
delete process.env.SUPERD_TRUSTED_HOSTS
const FIXTURE = new URL('./fixtures/superd-omp-world/', import.meta.url).pathname
const ANCHOR = process.env.SUPERD_DSH_ANCHOR ?? join(REPO, 'upstream/deepseek-harness/apps/cli/package.json')
const PROFILE = 'superd-omp-world-mounted'

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (; ;) {
    if (check()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('a world composes as a webui-less data plane — webui rows disabled, virtual server silent, data plane intact', async () => {
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
  // T-D: the host mount record is the world's addressability entry ONLY — no
  // real webServer, no authorize leg (both retired with the world pages).
  const dropMount = registerHostMount({ key: 'omp', labelPath: '/omp' })

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

  // DATA PLANE INTACT: the connection row resolved (through the mount row's
  // neutral webRuntime) and the gateway the /hub family dispatches into is up.
  await waitFor(() => ctxW.get('connection') !== undefined)
  assert.notEqual(ctxW.get('connection'), undefined, 'the world connection (data plane) is live')
  assert.notEqual(ctxW.get('typertGateway'), undefined, 'the world gateway is live')
  const webRuntime = ctxW.get('webRuntime')
  assert.deepEqual(webRuntime, { lanAddresses: [], trustedHosts: [] }, 'neutral webRuntime facts (loopback bind ⇒ no LAN literals)')

  // T-D COMPOSITION: the FINAL row list spawnWorld wrote carries the webui
  // rows disabled and no page-trust row — the world tree has no web surface.
  const composed = readFileSync(join(WORLD_HOME, 'profiles', PROFILE, 'cordis.yml'), 'utf8')
  const lines = composed.split('\n')
  // One row block = from its `- id:` line up to (not including) the next row.
  const rowBlock = (id) => {
    const at = lines.findIndex((line) => line.trim() === `- id: ${id}`)
    if (at === -1) return undefined
    let end = at + 1
    while (end < lines.length && !lines[end].startsWith('- id: ')) end++
    return lines.slice(at, end).join('\n')
  }
  assert.match(rowBlock('web-runtime'), /disabled: true/, 'web-runtime (frontend-static mount) is disabled')
  assert.match(rowBlock('client-hmr'), /disabled: true/, 'client-hmr (reload chain) is disabled')
  assert.match(rowBlock('superd-world-mount'), /name: '@pgmi-builds\/superd-hub\/world'/, 'the mount row is present')
  assert.equal(composed.includes('superd-web-trust'), false, 'the world page-trust row is gone')

  // Give the world tree time to compose (the retired machinery used to land
  // page translations within this window), then pin the negatives: the
  // virtual server served nothing and stored nothing.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await ctxW.fiber.dispose()
  dropMount()
})
