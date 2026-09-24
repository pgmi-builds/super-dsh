/**
 * Nested-world profile provisioning — the publish story.
 *
 * The dev line (test/smoke.mjs) hand-provisions every world's nested profile
 * (`<home>/agents/<label>/profiles/web`) and the `@pgmi-builds/*` links its
 * resolution needs. A foreign install has NO line bootstrap:
 *
 *   dsh plugin --profile <name> add super-dsh
 *
 * mounts the hub + adapter world plugins into the consumer's profile, and the
 * spawn call sites (adapter world-plugins, hub join) must provision the same
 * layout THEMSELVES or every world spawn fails on a missing profile.
 *
 * This module is the library form of that bootstrap, called by all six spawn
 * sites. Layout invariants (super-dsh/AGENTS.md S7):
 *
 *   - `<worldHome>/profiles/web/package.json` — bundles `[dsh-base, dsh-web-app,
 *     adapterPkg]`; the world tree is a full sibling root, nothing shared.
 *   - `<worldHome>/profiles/web/cordis.patch.yml` — per-world home pinning:
 *     every home-resolving DSH plugin reads THIS tree's nested root.
 *   - `<worldHome>/profiles/web/node_modules/@pgmi-builds/{adapter,hub}` —
 *     the plugin-add shape: with the host table widened (spawnWorld, spec
 *     §2.1), these profile-local links serve the local-physical leg for the
 *     world's own packages. No `@deepseek-ai` scope anywhere — those names
 *     ride the host's installation entries.
 *
 * Link identity rule: both links point INSIDE the running line tree — the hub
 * at this module's own package root, the adapter at its sibling
 * `agent-<key>` directory — identical in the dev repo layout and inside the
 * published single `super-dsh` package, so ctx0 and every world root share
 * one hub/adapter instance with zero registry involvement.
 *
 * Returns whether the layout was provisioned; false (logged) when the
 * adapter sibling does not exist next to the hub — a foreign composition
 * this module does not own.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HUB_SCOPE = '@pgmi-builds'

/** The profile bundles every world tree composes besides its adapter. */
const WORLD_BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

/**
 * Resolve the running dsh installation's package.json — the anchor worlds
 * resolve `@deepseek-ai` bundles and the fallback closure from.
 *
 * Precedence: `$SUPERD_DSH_ANCHOR` (the repo dev lines' contract — the
 * launcher pins the checkout build), then a walk UP from the
 * `@deepseek-ai/dsh-app-boot` this module resolved (the host always provides
 * it) to the nearest ancestor package named `@deepseek-ai/dsh` — the
 * packaged-install layout (`<install>/@deepseek-ai/dsh/node_modules/
 * @deepseek-ai/dsh-app-boot`) lands on the install root in two hops. No
 * machine-specific path ships in code.
 * @throws when neither yields an installation (mis-launched composition).
 */
export function resolveInstallAnchor(host?: { get(name: string): unknown }): string {
  // Spec §2.3: the host's launcher facts win — a world plugin runs in ctx0,
  // where `profileContext` carries the exact anchor the live table was
  // computed from. Env and the realpath walk remain for table-less harnesses.
  const launcher = host?.get('profileContext') as { installAnchor?: string } | undefined
  if (launcher?.installAnchor !== undefined) return launcher.installAnchor
  const fromEnv = process.env.SUPERD_DSH_ANCHOR
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  let dir = dirname(resolveHostPackageDir('@deepseek-ai/dsh-app-boot'))
  while (true) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name
        if (name === '@deepseek-ai/dsh') return manifest
      } catch { /* malformed intermediate manifest — keep walking */ }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error('super-dsh: cannot derive the dsh installation anchor (set SUPERD_DSH_ANCHOR)')
    }
    dir = parent
  }
}

/** First `node_modules` search-path candidate that exists for a specifier,
 *  resolved to its REALPATH — farm and pnpm links must not leak into the
 *  ancestor walk (the install tree only exists behind the symlink). */
function resolveHostPackageDir(spec: string): string {
  const require = createRequire(import.meta.url)
  // Interception first: under the launcher's resolution table the profile
  // tree holds NO physical @deepseek-ai, but require.resolve goes through
  // the patched Module._resolveFilename and lands on the installation's
  // copy directly. resolve.paths() cannot see the table — it only lists
  // physical walk-up candidates (the retired profiles-level farm is what
  // used to plug this gap on consumer machines; 0.1.3-r prod evidence).
  try {
    return realpathSync(dirname(require.resolve(`${spec}/package.json`)))
  } catch { /* not intercepted or ./package.json not exported — walk */ }
  for (const searchPath of require.resolve.paths(`${spec}/x`) ?? []) {
    const candidate = join(searchPath, spec)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
  }
  throw new Error(`super-dsh: cannot resolve ${spec} from the running host (set SUPERD_DSH_ANCHOR)`)
}

export interface ProvisionWorldOptions {
  /** Runtime key — also the mount label and the `agents/<key>` home segment. */
  key: string
  /** The adapter's own package name (the world profile's third bundle). */
  adapterPkg: string
  /** Nested home root: `<DSH_HOME>/agents/<key>`. */
  worldHome: string
  /** Profile directory name under `<worldHome>/profiles`. Default `'web'`. */
  profileName?: string
}

/**
 * Provision one world's nested profile (idempotent: rewrites profile files,
 * re-links packages — lstat-safe against dangling links). Returns whether
 * the layout landed.
 *
 * Never throws: any provisioning failure is logged and returns false so the
 * calling world plugin degrades to a not-ready roster row instead of failing
 * the loader entry — a failed apply would take down the whole host boot.
 */
export function provisionWorldProfile(opts: ProvisionWorldOptions): boolean {
  try {
    return provisionWorldProfileUnchecked(opts)
  } catch (cause) {
    console.error(`[super-dsh] provisioning world '${opts.key}' failed:`, cause)
    return false
  }
}

function provisionWorldProfileUnchecked(opts: ProvisionWorldOptions): boolean {
  // Single-pack topology: this module lives at `<line>/superd-hub/dist/`, and
  // every adapter is a SIBLING directory (`<line>/agent-<key>`) — the same
  // layout in the repo (dev link: lines) and inside the published `super-dsh`
  // package. The adapter link therefore points at the sibling; no registry
  // resolution is involved anywhere.
  const hubRoot = dirname(dirname(fileURLToPath(import.meta.url))) // <line>/superd-hub
  const lineRoot = dirname(hubRoot) // monolith root / repo super-dsh/
  const adapterDir = join(lineRoot, `agent-${opts.key}`)
  if (!existsSync(join(adapterDir, 'package.json'))) return false
  const profileName = opts.profileName ?? 'web'
  const profDir = join(opts.worldHome, 'profiles', profileName)
  mkdirSync(profDir, { recursive: true })
  writeFileSync(
    join(profDir, 'package.json'),
    JSON.stringify(
      {
        name: `superd-${opts.key}-world-profile`,
        private: true,
        dsh: { profile: { bundles: [...WORLD_BASE_BUNDLES, opts.adapterPkg] } },
      },
      null,
      2,
    ) + '\n',
  )
  // Per-world home pinning (smoke.mjs parity): settings, credentials,
  // attachments, shell env and skills all land inside `agents/<key>/`.
  // (`agent-instructions` keeps its base `maxBytes` home — instruction
  // discovery root, not agent data.)
  //
  // 0.1.7: the profile hmr row arms itself wherever a profileContext exists,
  // and its config reload recomposes the tree from THE PROFILE LAYERS ALONE —
  // spawn-time extraPatches do not survive it. The zero-listener posture is
  // therefore PERSISTED in this layer (webserver disabled + ephemeral port,
  // hmr itself off — a world's composition is a spawn-time fact and must not
  // be re-derived), exactly mirroring worldMountPatches.
  writeFileSync(
    join(profDir, 'cordis.patch.yml'),
    [
      '# Per-world home pinning (dshHomePath is this tree\'s nested home).',
      ...['settings', 'credentials', 'attachment-local', 'shell-env', 'skill-filesystem'].flatMap(
        (id) => [`- id: ${id}`, '  config:', '    dshHome: !!js dshHomePath()'],
      ),
      '# Zero-listener posture (0.1.7): persisted so hmr/launcher recomposition',
      '# cannot re-enable the world\'s own listener (default port 3080).',
      '- id: webserver',
      '  disabled: true',
      '  config:',
      '    host: 127.0.0.1',
      '    port: 0',
      '- id: hmr',
      '  disabled: true',
      '',
    ].join('\n'),
  )
  // @pgmi-builds links, plugin-add shape: adapter + hub into the world
  // profile's OWN node_modules (resolveBundleDir consults the profile
  // directory; the local-physical leg of the widened host table consumes
  // the same links for row imports — spec §2.1). Dangling links first
  // (lstat: existsSync is false for them, which skipped rmSync and crashed
  // symlinkSync with EEXIST after repo moves).
  const links: ReadonlyArray<readonly [string, string]> = [
    [opts.adapterPkg.slice(HUB_SCOPE.length + 1), adapterDir],
    ['superd-hub', hubRoot],
  ]
  const linkRoot = join(profDir, 'node_modules')
  mkdirSync(join(linkRoot, HUB_SCOPE), { recursive: true })
  for (const [name, target] of links) {
    const dst = join(linkRoot, HUB_SCOPE, name)
    const st = lstatSync(dst, { throwIfNoEntry: false })
    if (st) rmSync(dst, { recursive: true, force: true })
    symlinkSync(target, dst)
  }
  // Retired machinery (spec §3): scrub the profiles-level farm this function
  // wrote before 2026-09-25. Stale links there sit inside the widened
  // local-physical walk and would shadow the host table's installation
  // entries with frozen-generation targets.
  const staleFarm = join(opts.worldHome, 'profiles', 'node_modules')
  rmSync(join(staleFarm, '@deepseek-ai'), { recursive: true, force: true })
  rmSync(join(staleFarm, HUB_SCOPE), { recursive: true, force: true })
  return true
}
