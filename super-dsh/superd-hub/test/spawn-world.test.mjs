// spawnWorld (Task 3): real dsh-base sibling root from a profile — distinct
// roots, full service face, no web surface (dsh-base has none).
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
const SRC_PROFILE = join(REPO, '.tests', 'profiles', 'ctx1-min')

// 2026-09-26 farm sweep deleted the .tests/profiles/ctx1-min seed profile (C1/rig
// reports): the fixture is structural-gone, not coming back. Skip with
// provenance instead of keeping a permanently red suite — the body below is
// preserved verbatim for the day a fixture returns.
const FIXTURE_PRESENT = existsSync(SRC_PROFILE)

if (!FIXTURE_PRESENT) {
  test('spawnWorld: dsh-base sibling root, full service face, no web surface', { skip: 'fixture .tests/profiles/ctx1-min was removed in the 2026-09-26 farm sweep — structural, not coming back' }, async () => {})
}

if (FIXTURE_PRESENT) {
  // bootstrap: ctx1-min profile into the isolated home; strip the fixture's
  // stale node_modules (self-referential farm links). 0.1.7 alignment: the
  // heal family is GONE — the launcher computes a runtime resolution table and
  // intercepts imports in-process, writing no links. This test drives boot()
  // directly (no launcher), so it stands up the SAME host surface the launcher
  // does — a mini context with PluginPackages (the base table) + profileContext
  // facts — and lets spawnWorld widen the table itself (spec §2.1 end-to-end:
  // the world's bare rows must resolve through the interception, not a farm).
  if (!existsSync(SRC_PROFILE)) throw new Error(`source profile missing: ${SRC_PROFILE}`)
  mkdirSync(join(HOME, 'profiles'), { recursive: true })
  cpSync(SRC_PROFILE, join(HOME, 'profiles', 'ctx1-min'), { recursive: true, verbatimSymlinks: true })
  const { rmSync } = await import('node:fs')
  rmSync(join(HOME, 'profiles', 'ctx1-min', 'node_modules'), { recursive: true, force: true })
  const { createRuntimeResolution, loadProfile, PluginPackages } = await import('@deepseek-ai/dsh-app-boot')
  const { Context } = await import('@deepseek-ai/cordis')
  const hostProfile = loadProfile('dsh', 'ctx1-min', ANCHOR, HOME)
  const host = new Context()
  await host.plugin(PluginPackages, {
    resolution: await createRuntimeResolution({ installAnchor: ANCHOR, profile: hostProfile, home: HOME }),
  })
  host.provide('profileContext', {
    name: 'ctx1-min',
    dir: join(HOME, 'profiles', 'ctx1-min'),
    patchPath: join(HOME, 'profiles', 'ctx1-min', 'cordis.patch.yml'),
    installAnchor: ANCHOR,
    cwd: process.cwd(),
    home: HOME,
    startedBundles: hostProfile.layers.map((l) => l.packageName),
    overlays: hostProfile.patches,
  })
  // minimal cordis.yml for ctx0
  const { writeFileSync } = await import('node:fs')
  mkdirSync(join(HOME, 'profiles', 'ctx0-min'), { recursive: true })
  writeFileSync(join(HOME, 'profiles', 'ctx0-min', 'cordis.yml'), '[]\n')

  test('spawnWorld: dsh-base sibling root, full service face, no web surface', async () => {
    const ctx0 = await boot('superd-test-ctx0', join(HOME, 'profiles', 'ctx0-min', 'cordis.yml'), [])
    const ctxW = await spawnWorld({
      appName: 'superd-test-world',
      profileName: 'ctx1-min',
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

}