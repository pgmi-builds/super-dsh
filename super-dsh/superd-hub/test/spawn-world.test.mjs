// spawnWorld (Task 3): real dsh-base sibling root from a profile — distinct
// roots, full service face, no web surface (dsh-base has none).
//
// Fixture contract (2026-09-28 rewrite): NO checked-in seed profile, NO farm.
// The profile is synthesized inline under the isolated home — a bare
// `@deepseek-ai/dsh-base` bundle list — and every row import resolves through
// the standard consumer paths: `@deepseek-ai/*` via the install anchor (the
// checkout build under test); profile-local `node_modules` would exist only
// for non-native deps (file: tarballs) and this profile has none. If a plugin
// cannot survive that arrangement, it is on its own. (The old
// `.tests/profiles/ctx1-min` seed carried a self-referential farm link set —
// deleted in the 2026-09-26 sweep; nothing here misses it.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnWorld } from '../dist/index.js'
import { boot } from '@deepseek-ai/dsh-app-boot'

// Repo-line contract: the anchor is the checkout build (consumers derive it ambiently).
process.env.SUPERD_DSH_ANCHOR ??= new URL('../../../upstream/deepseek-harness/apps/cli/package.json', import.meta.url).pathname
const { resolveInstallAnchor } = await import('../dist/index.js')
const ANCHOR = resolveInstallAnchor()
const REPO = join(new URL('../../..', import.meta.url).pathname) // super-dsh/superd-hub/test → repo root
// Isolated home (never the live 4999 line's .tests/superd — this test used to
// bootstrap profiles straight into the running line's home).
const HOME = process.env.SUPERD_TEST_HOME ?? join(REPO, '.tests', 'hub-test-home')
const PROFILE = 'ctx1-min'

// The whole fixture, synthesized: clean profile dir + a one-bundle manifest.
const profileDir = join(HOME, 'profiles', PROFILE)
rmSync(profileDir, { recursive: true, force: true })
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  join(profileDir, 'package.json'),
  JSON.stringify({ name: PROFILE, private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2) + '\n',
)

// 0.1.7 alignment: the heal family is GONE — the launcher computes a runtime
// resolution table and intercepts imports in-process, writing no links. This
// test drives boot() directly (no launcher), so it stands up the SAME host
// surface the launcher does — a mini context with PluginPackages (the base
// table) + profileContext facts — and lets spawnWorld widen the table itself
// (spec §2.1 end-to-end: the world's bare rows must resolve through the
// interception, not a farm).
const { createRuntimeResolution, loadProfile, PluginPackages } = await import('@deepseek-ai/dsh-app-boot')
const { Context } = await import('@deepseek-ai/cordis')
const hostProfile = loadProfile('dsh', PROFILE, ANCHOR, HOME)
const host = new Context()
await host.plugin(PluginPackages, {
  resolution: await createRuntimeResolution({ installAnchor: ANCHOR, profile: hostProfile, home: HOME }),
})
host.provide('profileContext', {
  name: PROFILE,
  dir: profileDir,
  patchPath: join(profileDir, 'cordis.patch.yml'),
  installAnchor: ANCHOR,
  cwd: process.cwd(),
  home: HOME,
  startedBundles: hostProfile.layers.map((l) => l.packageName),
  overlays: hostProfile.patches,
})
// minimal cordis.yml for ctx0
mkdirSync(join(HOME, 'profiles', 'ctx0-min'), { recursive: true })
writeFileSync(join(HOME, 'profiles', 'ctx0-min', 'cordis.yml'), '[]\n')

test('spawnWorld: dsh-base sibling root, full service face, no web surface', async () => {
  const ctx0 = await boot('superd-test-ctx0', join(HOME, 'profiles', 'ctx0-min', 'cordis.yml'), [])
  const ctxW = await spawnWorld({
    appName: 'superd-test-world',
    profileName: PROFILE,
    installAnchor: ANCHOR,
    home: HOME,
    host,
  })
  assert.notEqual(ctx0, ctxW)
  for (const name of ['llm', 'sessions', 'agents', 'sessionQuery', 'typert']) {
    assert.notEqual(ctxW.get(name), undefined, `${name} present`)
  }
  for (const name of ['webServer', 'sessionController', 'frontendStatic']) {
    assert.equal(ctxW.get(name), undefined, `${name} absent (dsh-base has none)`)
  }
  await ctxW.fiber.dispose()
  await ctx0.fiber.dispose()
})
