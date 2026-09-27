// Task 1 (native-ui-fusion): ctx0's native page composes the hub client half
// under the entry id `super-dsh` (the bare composite row `- id: superd-hub,
// name: 'super-dsh'` maps through exactPackageSpecifier to the composite
// package manifest, whose dsh.client + ./client export carry the bundle).
// P0 probe ① read ctx0's 63-entry graph as MISSING the half because it looked
// for the world-side spelling `@pgmi-builds/superd-hub`; this test pins the
// actual contract — row present, id-paired with the burned registration id,
// served in the index graph.
//
// Minimal in-process boot replica of ctx0 (world-mount / api-wrap-probe
// recipe): a profile whose bundles = ['super-dsh'] with the composite
// physically present in the profile node_modules (consumer install shape),
// booted through the launcher's own surfaces (loadProfile → empty root
// config → composed patch layers → PluginPackages resolution), then the
// served index is fetched and its `__DSH_BOOT__` graph inspected.
//
// The adapter rows are disabled in the user layer: their activation spawns
// whole world trees, which no unit test should carry; the client-row
// composition under test happens above that layer (Task 6's pack-line
// acceptance covers the full shape).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntimeResolution, loadProfile, PluginPackages, boot } from '@deepseek-ai/dsh-app-boot'
import { Context } from '@deepseek-ai/cordis'

const HERE = dirname(fileURLToPath(import.meta.url))
const LINE = join(HERE, '..', '..') // super-dsh composite root
const REPO_WT = dirname(LINE) // worktree root
const ANCHOR = join(REPO_WT, 'upstream', 'deepseek-harness', 'apps', 'cli', 'package.json')

/** The composite rows whose activation spawns a world or needs a scene. */
const DISABLED_ROWS = [
  'agent-omp', 'agent-codex', 'agent-pi', 'agent-hermes', 'agent-agy',
  'superd-join-claude', 'directory-picker-browse', 'directory-picker-browse-surface',
]

function ctx0Home() {
  const home = mkdtempSync(join(tmpdir(), 'superd-ctx0row-'))
  const profile = join(home, 'profiles', 'ctx0')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  // Consumer install shape: the composite is a physical profile package
  // (what `pnpm add file:super-dsh.tgz` / `dsh plugin add` materialize).
  symlinkSync(LINE, join(profile, 'node_modules', 'super-dsh'), 'dir')
  writeFileSync(join(profile, 'index.html'), '<!doctype html><html><head></head><body></body></html>\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'ctx0-replica',
    private: true,
    dsh: { profile: { bundles: ['super-dsh'] } },
  }) + '\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '# Minimal ctx0 web face (the launcher profile pins only deployment values;',
    '# here the upstream rows are inserted directly because the replica carries',
    '# no dsh-base/dsh-web-app bundle layer).',
    '- insert:',
    "    - id: webserver",
    "      name: '@deepseek-ai/dsh-host-webserver'",
    '      config:',
    '        host: 127.0.0.1',
    '        port: 0',
    "    - id: client-connection",
    "      name: '@deepseek-ai/dsh-client-connection'",
    "    - id: frontend-static",
    "      name: '@deepseek-ai/dsh-host-frontend-static'",
    '      config:',
    `        distIndex: ${join(profile, 'index.html')}`,
    "    - id: credentials",
    "      name: '@deepseek-ai/dsh-credentials-local'",
    '      config:',
    `        dshHome: ${home}`,
    "    - id: modules",
    "      name: '@deepseek-ai/dsh-client-modules'",
    '# World-spawning rows stay off in the unit replica (see file header).',
    ...DISABLED_ROWS.flatMap((id) => [`- id: ${id}`, '  disabled: true']),
    '',
  ].join('\n'))
  // The launcher rewrites this root every boot; `[]` = the tree is composed
  // entirely from the patch layers.
  writeFileSync(join(profile, 'cordis.yml'), [
    '# dsh profile root — an empty entry list. The tree is composed as patches.',
    '[]',
    '',
  ].join('\n'))
  return { home, profile }
}

async function bootCtx0Replica() {
  const { home, profile } = ctx0Home()
  // Session envs of agents running inside dsh.service carry DSH_HOME=prod —
  // every home-resolving row in this process must land on the replica home.
  process.env.DSH_HOME = home
  const loaded = loadProfile('dsh', 'ctx0', ANCHOR, home)
  const patches = [...loaded.layers.flatMap(layer => layer.patches), ...loaded.patches]
  const host = new Context()
  await host.plugin(PluginPackages, {
    resolution: await createRuntimeResolution({ installAnchor: ANCHOR, profile: loaded, home }),
  })
  host.provide('profileContext', {
    name: 'ctx0',
    dir: profile,
    patchPath: join(profile, 'cordis.patch.yml'),
    installAnchor: ANCHOR,
    cwd: process.cwd(),
    home,
    startedBundles: ['super-dsh'],
    overlays: [],
  })
  const ctx = await boot('superd-ctx0row', join(profile, 'cordis.yml'), patches, () => { })
  return { home, host, ctx }
}

/** Extract the `__DSH_BOOT__` graph the served index carries. */
function bootGraphOf(html) {
  const match = /globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/s.exec(html)
  assert.ok(match !== null, 'the served index carries the __DSH_BOOT__ global')
  return JSON.parse(match[1])
}

test('ctx0 index composes the hub client half (probe-① follow-up)', async () => {
  const { home, host, ctx } = await bootCtx0Replica()
  try {
    // The composed graph: the scan of ctx0's loader entries must map the bare
    // composite row (`- id: superd-hub, name: 'super-dsh'`) to the package's
    // own client bundle.
    const ids = ctx.clientModules.graph().entries.map(entry => entry.id)
    assert.ok(
      ids.includes('super-dsh'),
      `ctx0 boot graph misses the super-dsh client row (saw: ${ids.length} entries${ids.some(id => id.startsWith('super')) ? `, super rows: ${ids.filter(id => id.startsWith('super')).join(', ')}` : ''})`,
    )
    assert.equal(
      ctx.clientModules.clientPath('super-dsh'),
      join(LINE, 'client', 'index.js'),
      'the super-dsh graph row maps to the composite package client bundle',
    )
    // The browser pairs registrations with graph rows by id, and the id is
    // burned into the bundle at build time (build-superd-client.mjs): the row
    // id the scan emits must equal the id the artifact registers with.
    const burned = /^window\.__ModuleLoader__\.load\(\{ id: "([^"]+)"/.exec(
      readFileSync(join(LINE, 'client', 'index.js'), 'utf8'),
    )?.[1]
    assert.equal(burned, 'super-dsh', 'the served client bundle registers under the graph row id')

    // The acceptance face: the index the browser actually receives.
    const port = ctx.webServer.port
    const authed = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}/`)
    const r0 = await fetch(authed, { redirect: 'manual' })
    const cookie = (r0.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie.length > 0, 'ctx0 auth cookie minted')
    const index = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } })
    assert.equal(index.status, 200)
    const graph = bootGraphOf(await index.text())
    assert.ok(
      graph.entries.some(entry => entry.id === 'super-dsh'),
      `served __DSH_BOOT__ misses the super-dsh client row (saw ${graph.entries.length} entries)`,
    )
  } finally {
    await ctx.fiber.dispose()
    await host.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
