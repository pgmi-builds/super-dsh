// Row gate (native-ui-fusion Task 5, retuned 2026-09-27): the formal surface
// of the fusion row's on/off, on top of the gate built into
// fusion-transport.ts. The gate is ROW COMPOSITION — no environment variable.
//
// The two halves that must never disagree (spec §5 双半边):
//   - server half: ONE `webserver/index-inject` listener pushing the
//     transport script AND the `__SUPERD_UI_FUSION__` baked global — or,
//     when the row is off, NOTHING at all (评审 §5: 多一个 script 标签都不该有);
//   - client half: the Hub UI switch surfaces' fusion branch (T-B: the
//     sole switch surface since the sidebar-bottom RuntimeSeat retirement)
//     reading `__SUPERD_UI_FUSION__ === true` off the delivered client bundle.
//
// Faces pinned here, per the brief's Step 1:
//   1. the page-global contract and the row-config default (composed → on,
//      explicit row config wins — the web-trust formalization shape);
//   2. the 双半边 name contract against the DELIVERED composite client bundle
//      (super-dsh/client/index.js — the tracked artifact consumers load; the
//      ctx0-client-row precedent of pinning the delivered face);
//   3. world discipline: world mounts never carry a fusion row or the flag
//      global (world pages keep the real hyperlinks);
//   4. row OFF (explicit `enabled: false`) on the SERVED ctx0 index
//      (in-process boot replica, the ctx0-client-row recipe): zero fusion
//      rows — the equivalence bar, ruled to cover fusion INJECTIONS only (the
//      bare-name `super-dsh` client-half composition row is not gated and not
//      part of the bar). T-E closeout: OFF = NO foreign entry at all; the Hub
//      rows degrade client-side (inert + hint, never dead hrefs — pinned at
//      the delivered artifact);
//   5. row ON (the shipped default, no overlay) on the SERVED index:
//      web-trust row first, the fusion pair (transport script + flag global)
//      after it, adjacent and last among the super-dsh rows — the served-order
//      pin Task 3's review deferred here (no daemons: both replicas boot
//      in-process, port 0).
//
// Env hygiene BEFORE any dist import: the defaults bake at module load (the
// web-trust default-derivation shape), so this file fixes the env FIRST and
// imports the dist modules dynamically — one-shot per process, which is
// exactly how a launcher boot bakes them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LINE = join(HERE, '..', '..') // super-dsh composite root
const REPO_WT = dirname(LINE) // worktree root
const ANCHOR = join(REPO_WT, 'upstream', 'deepseek-harness', 'apps', 'cli', 'package.json')

// ---- the one-shot env bake (must precede the dist imports below) ----------
delete process.env.DSH_TRUSTED_HOSTS // upstream spelling must not shadow the test authority

const {
  FUSION_FLAG_GLOBAL,
  Config,
} = await import('../dist/fusion-transport.js')
const { worldMountPatches } = await import('../dist/index.js')
const { FUSION_OFF_HINT } = await import('../dist/switch-core.js')
const { createRuntimeResolution, loadProfile, PluginPackages, boot } = await import('@deepseek-ai/dsh-app-boot')
const { Context } = await import('@deepseek-ai/cordis')

// ---- 1. the flag contract: names, derivation, schema default --------------

test('the row gate contract: one page global, ON when composed, explicit config decides', () => {
  assert.equal(FUSION_FLAG_GLOBAL, '__SUPERD_UI_FUSION__')
  // Composed row = the surface is on; there is no env-derived default (the
  // gate is row composition, visible to patch layers and the plugin manager).
  assert.equal(Config({}).enabled, true, 'composed without config → on (the shipped default)')
  assert.equal(Config({ enabled: true }).enabled, true)
  assert.equal(Config({ enabled: false }).enabled, false)
})

// ---- 2. 双半边: the delivered client bundle reads what the server bakes ----

test('the delivered client half reads the exact flag global the server half bakes', () => {
  // super-dsh/client/index.js is the tracked, served artifact (the bare-name
  // `super-dsh` graph row maps here — the bundle consumers actually load).
  const delivered = readFileSync(join(LINE, 'client', 'index.js'), 'utf8')
  assert.ok(
    delivered.includes(FUSION_FLAG_GLOBAL),
    `the delivered client bundle never reads ${FUSION_FLAG_GLOBAL} — the fusion branch can never arm`,
  )
  assert.ok(
    delivered.includes(`${FUSION_FLAG_GLOBAL} === true`),
    'the client half reads the global with the exact `=== true` discriminator',
  )
})

// ---- 3. world discipline: the flag never reaches a world page -------------

test('world mounts carry no fusion row and no flag global (real hyperlinks stay)', () => {
  const patches = JSON.stringify(worldMountPatches('omp'))
  assert.ok(!patches.includes('fusion'), 'no fusion row in the world mount patches')
  assert.ok(!patches.includes(FUSION_FLAG_GLOBAL), 'world pages never carry the flag global')
})

// ---- the in-process boot replica (test/ctx0-client-row.test.mjs recipe) ----

/** The composite rows whose activation spawns a world or needs a scene. */
const DISABLED_ROWS = [
  'agent-omp', 'agent-codex', 'agent-pi', 'agent-hermes', 'agent-agy',
  'superd-join-claude', 'directory-picker-browse', 'directory-picker-browse-surface',
  // This injection fixture supplies no native tools/settings or startup service.
  'dashr-repl', 'dashr-url-schemes', 'dashr-welcome-notice', 'dashr-webserver',
]

function ctx0Home(extraProfileRows) {
  const home = mkdtempSync(join(tmpdir(), 'superd-flag-'))
  const profile = join(home, 'profiles', 'ctx0')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  // Consumer install shape: the composite is a physical profile package.
  symlinkSync(LINE, join(profile, 'node_modules', 'super-dsh'), 'dir')
  writeFileSync(join(profile, 'index.html'), '<!doctype html><html><head></head><body></body></html>\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'ctx0-replica',
    private: true,
    dsh: { profile: { bundles: ['super-dsh'] } },
  }) + '\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '# Minimal ctx0 web face: the upstream rows inserted directly (the replica',
    '# carries no dsh-base/dsh-web-app bundle layer).',
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
    '# World-spawning rows stay off in the unit replica.',
    ...DISABLED_ROWS.flatMap((id) => [`- id: ${id}`, '  disabled: true']),
    ...extraProfileRows,
    '',
  ].join('\n'))
  writeFileSync(join(profile, 'cordis.yml'), [
    '# dsh profile root — an empty entry list. The tree is composed as patches.',
    '[]',
    '',
  ].join('\n'))
  return { home, profile }
}

async function servedCtx0Index(extraProfileRows) {
  const { home, profile } = ctx0Home(extraProfileRows)
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
  const ctx = await boot('superd-flag', join(profile, 'cordis.yml'), patches, () => { })
  try {
    const port = ctx.webServer.port
    const r0 = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'admin' }),
    })
    assert.equal(r0.status, 303, 'Better Dash password entry accepts login')
    const cookie = (r0.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie.length > 0, 'ctx0 auth cookie minted')
    const index = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } })
    assert.equal(index.status, 200)
    return await index.text()
  } finally {
    await ctx.fiber.dispose()
    await host.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- 4. row OFF (explicit): the equivalence bar (zero fusion injections) ---
//
// T-E closeout semantics: with T-C (per-label URL family retired) and T-D
// (world webui rows disabled) landed, OFF means NO foreign entry at all.
// The served ctx0 index still composes the full native face — including the
// Hub UI client row, whose agent rows degrade client-side (inert + hint,
// `switchAffordance`) rather than by composition absence.

test('row off (explicit `enabled: false`): the served ctx0 index carries zero fusion rows', async () => {
  const html = await servedCtx0Index([
    '- id: superd-fusion-transport',
    "  name: 'super-dsh/fusion-transport'",
    '  config:',
    '    enabled: false',
  ])
  // The bar: NO fusion script, NO flag global — not even one extra script tag.
  assert.ok(!html.includes(FUSION_FLAG_GLOBAL), 'no __SUPERD_UI_FUSION__ anywhere on the served page')
  assert.ok(!html.includes('__SUPERD_UI_STATE__'), 'no fusion transport script (its atom marker) anywhere')
  // Controls: the emission path itself is intact — the page still carries the
  // trust row (same listener family) and the boot graph, so the absence above
  // is the gate and not a broken replica.
  assert.ok(html.includes('__DSH_TRANSPORT__'), 'the web-trust row is still served')
  assert.ok(html.includes('__DSH_BOOT__'), 'the composition graph is still served')
  // The native face is fully functional: the Hub UI client row composes
  // regardless of the flag (the bare-name row is not gated) — flag-off
  // degradation happens client-side (inert rows + hint), never by absence.
  assert.ok(html.includes('super-dsh/client.js'), 'the Hub UI client row is composed on a flag-off page too')
})

// ---- 4b. flag OFF Hub rows: inert-with-hint, never dead hrefs (T-E) --------
//
// The Hub rows are client-side, so the delivered bundle is the contract
// surface (the ctx0-client-row precedent of pinning the delivered face):
// the flag-off shape must SHIP in the artifact, and the artifact must carry
// NO hyperlink at all — no /<label>/ route exists to reach (T-C), so any
// surviving href would be a dead link.

test('flag off Hub rows: the delivered client half ships the hint and zero hrefs', () => {
  const delivered = readFileSync(join(LINE, 'client', 'index.js'), 'utf8')
  // The chosen shape ships: inert rows + the degradation hint chip.
  assert.ok(delivered.includes(FUSION_OFF_HINT), 'the flag-off hint ships in the delivered bundle')
  // The hint is flag-gated through the SAME discriminator test 2 pins.
  assert.ok(
    delivered.includes(`${FUSION_FLAG_GLOBAL} === true`),
    'the hint rendering rides the flag discriminator, never an unconditional branch',
  )
  // The dead-href red line: NO href anywhere in the bundle CODE, across all
  // four syntactic forms a reintroduction can take — the quoted object key
  // ("href": / ["href"]:), the unquoted JSX prop key this unminified build
  // emits (<a href={…}> compiles to `{href:` / `, href:`), the direct
  // `.href=` DOM write, and setAttribute('href', …). Block comments are
  // stripped first — the retained doc block legitimately mentions the
  // retired href arm and must not trip the guard.
  const code = delivered.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(
    !/["']href["']\s*[:=]|[{,]\s*href\s*:|\[\s*['"]href['"]\s*\]|\.\s*href\b\s*=|setAttribute\s*\(\s*['"]href/.test(code),
    'no href survives in the Hub UI code in any syntactic form — nothing can navigate',
  )
})

// ---- 5. row ON (the shipped default): web-trust first, fusion pair last ----

test('row on (shipped default, no overlay): trust script, then the adjacent fusion pair, last among the super-dsh rows', async () => {
  // The operator face: the composite patch composes the row with no config, so
  // the fused surface is what ships. A deployment that wants it off restates
  // the row (整行重述 — same id, same name, the config key overridden whole)
  // or drops it from the composition; that face is pinned in test 4.
  const html = await servedCtx0Index([])
  const trustAt = html.indexOf('__DSH_TRANSPORT__')
  const fusionAt = html.indexOf('__SUPERD_UI_STATE__')
  const flagAt = html.indexOf(`globalThis["${FUSION_FLAG_GLOBAL}"] = true`)
  assert.ok(trustAt !== -1, 'the trust row is served')
  assert.ok(fusionAt !== -1, 'the fusion transport script is served')
  assert.ok(flagAt !== -1, 'the flag global is served in its rendered form')
  // The served-order pin (spec §3.4, deferred from the Task 3 review):
  // the trust verdict is evaluated BEFORE the fusion script could own
  // __DSH_TRANSPORT__, and the flag global lands with the script — last
  // among the super-dsh contributed rows.
  assert.ok(trustAt < fusionAt, 'web-trust comes before the fusion script')
  assert.ok(fusionAt < flagAt, 'the fusion rows follow web-trust, flag global last')
  // Adjacency: no other script row opens between the fusion script and its
  // flag global — ONE gated listener pushed both halves together.
  const between = html.slice(fusionAt, flagAt)
  assert.equal(
    [...between.matchAll(/<script/g)].length,
    1,
    'the flag global directly follows the fusion script (one gate, both halves)',
  )
})
