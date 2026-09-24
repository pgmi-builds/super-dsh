/**
 * spawnWorld (S2): spawn a sibling ROOT context for a foreign agent world
 * from the CTX0 tree — the library form of the PoC (ADR 0008 mechanism,
 * .scratch/multi-context-poc/spawner2.mjs collapsed into a function).
 *
 * AW-A posture: SHARED home (ADR 0008 constraint 2 fallback). The ctxN
 * `dshHomePath` service override is an AW-C1 item (spec §三/§十一.2) — the
 * boot() provide/prepare ordering fact is pinned by
 * test/boot-prepare-ordering.test.mjs. Data detachment at this stage comes
 * from the adapter side (foreign app-home redirection, spec §七).
 *
 * Profile resolution (2026-09-25 upstream alignment —
 * docs/specs/world-resolution-upstream): loadProfile(name, profileName,
 * installAnchor, home) reads profiles under `<home>/profiles/<profileName>`
 * and writes nothing to disk. Before boot imports a single row, spawnWorld
 * publishes THIS world into the HOST's live resolution table (the successor
 * contract's sanctioned surface: an added linkedRoot covering the world
 * tree + added table entries for the world's own `@pgmi-builds` packages +
 * a generated peerDependencies block in the world profile manifest for
 * routeLinked's peer gate). The world config's bare row names then resolve
 * through the same interception the launcher uses; the per-world bare-URL
 * farms and bareModuleBaseUrl are gone.
 */
import { loadProfile, boot, composeEntries, createRuntimeResolution, type ProfileContext, type RuntimeResolution } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { dump } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { existsSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The host (ctx0) surface spawnWorld needs: cordis `ctx.get`, which locates
 * the launcher's `pluginPackages` table and `profileContext` facts. Structural
 * on purpose — adapters pass their own minimal host context.
 */
export interface WorldHostSurface {
  get(name: string): unknown
}
import { pathToFileURL } from 'node:url'

export interface SpawnWorldOptions {
  /** App name for the spawned root (also its fiber label). */
  appName: string
  /** Profile directory name under `<home>/profiles/`. */
  profileName: string
  /** package.json of the @deepseek-ai installation that owns the bundle closure. */
  installAnchor: string
  /**
   * The world's own home root: profiles resolve from `<home>/profiles/<name>`.
   * The caller passes the NESTED root (`<line home>/agents/<label>`) — every
   * runtime owns one root, nothing is shared between runtimes.
   */
  home: string
  /**
   * The world's DSH data root (sessions / settings / workspaces). Defaults to
   * {@link home}. When it differs from `home`, the child tree's `dshHomePath`
   * service is overridden in the boot `prepare` slot — which runs AFTER boot's
   * own provide and BEFORE the plugin tree mounts, so every `!!js
   * dshHomePath(...)` expression in the composition resolves inside this root
   * (ADR 0008 constraint 2: per-context home can only be an in-tree service
   * override; `process.env` is a shared resolver).
   */
  dataHome?: string
  /** Extra patch layers appended after the profile's own (e.g. an adapter's insert row). */
  extraPatches?: Parameters<typeof boot>[2]
  /**
   * The host (ctx0) context. When it carries the launcher's `pluginPackages`
   * table, spawnWorld republishes a widened successor so this world's tree
   * resolves through the host table exactly like a launcher profile (spec
   * §2.1). Table-less harnesses (unit tests, embedders) omit it and keep
   * native resolution.
   */
  host?: WorldHostSurface
}

/**
 * Republish the host's live resolution with THIS world added as a linked
 * root (spec §2.1, contract-legal form): `profilesDir`/`profileDir` are
 * frozen per process ("a successor cannot change its profile scope"), so
 * the world tree joins the table the way the successor contract sanctions —
 * an added linkedRoot covering `<worldHome>`, added entries for the world's
 * own `@pgmi-builds` packages (routeLinked resolves names from the table),
 * and a generated `peerDependencies` block in the world profile manifest
 * (routeLinked's peer gate reads the importer's ancestor manifests; the
 * peers are the composed rows' bare names — deterministic, regenerated on
 * every spawn, so upstream row additions self-heal on the next boot).
 *
 * Faithful reconstruction — reload the launcher's profile from
 * `profileContext` facts and recompute: the service exposes no `current`,
 * and a plugin add between host boot and now is picked up for free (each
 * spawn re-publishes; worlds are spawn-time facts and never recompose, so a
 * later host-side replace can only affect the next spawn).
 */
async function publishWorldInHostResolution(
  host: WorldHostSurface,
  opts: SpawnWorldOptions,
  worldProfileDir: string,
  peerNames: ReadonlySet<string>,
): Promise<void> {
  const packages = host.get('pluginPackages') as { replace(successor: RuntimeResolution): void } | undefined
  const launcher = host.get('profileContext') as ProfileContext | undefined
  if (packages === undefined || launcher?.installAnchor === undefined || launcher.home === undefined || launcher.name === undefined) return
  const profile = loadProfile('dsh', launcher.name, launcher.installAnchor, launcher.home)
  const base = await createRuntimeResolution({ installAnchor: launcher.installAnchor, profile, home: launcher.home })
  // routeLinked's peer gate: the gate reads ancestor manifests of the
  // IMPORTER — and ctx.baseUrl is a DIRECTORY URL with a trailing slash, so
  // the resolver's dirname() lands on `<worldHome>/profiles`, one level
  // above the profile itself. Peers therefore go into BOTH manifests (the
  // world profile's own and the profiles-level directory), regenerated
  // idempotently on every spawn — upstream row additions self-heal next boot.
  const peers = Object.fromEntries([...peerNames].sort().map((name) => [name, '*']))
  for (const manifestDir of [worldProfileDir, join(opts.home, 'profiles')]) {
    const manifestPath = join(manifestDir, 'package.json')
    const manifest = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      : { name: `superd-${opts.appName}-profiles`, private: true }
    manifest.peerDependencies = peers
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  // The world's own packages become table entries (targets = the realpaths of
  // the profile-local links provisionWorldProfile wrote). declarer MUST be a
  // manifest PATH: the ESM interception rewrites the resolve parent to it
  // (pathToFileURL(route.entry.declarer)).
  const declarer = join(worldProfileDir, 'package.json')
  const worldScope = join(worldProfileDir, 'node_modules', '@pgmi-builds')
  const added: RuntimeResolution['entries'][number][] = []
  for (const name of readdirSync(worldScope, { withFileTypes: true })) {
    if (!name.isDirectory() && !name.isSymbolicLink()) continue
    const pkgName = `@pgmi-builds/${name.name}`
    const packageDir = realpathSync(join(worldScope, name.name))
    const pkgManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: string }
    added.push({ name: pkgName, packageDir, version: pkgManifest.version, declarer, scope: 'profile' as const })
  }
  packages.replace({
    ...base,
    entries: [...base.entries, ...added],
    linkedRoots: [...base.linkedRoots, { name: `superd-world-${opts.appName}`, realPath: opts.home }],
  })
}

/** Bare package name of a module specifier (`@scope/pkg/sub` → `@scope/pkg`). */
function barePackageNameOf(specifier: string): string | undefined {
  if (!specifier || specifier[0] === '.' || specifier[0] === '/' || specifier[0] === '#' || specifier.includes(':')) return undefined
  const first = specifier.indexOf('/')
  if (specifier[0] !== '@') return first < 0 ? specifier : specifier.slice(0, first)
  if (first < 0) return
  const second = specifier.indexOf('/', first + 1)
  return second < 0 ? specifier : specifier.slice(0, second)
}


export async function spawnWorld(opts: SpawnWorldOptions) {
  const profile = loadProfile(opts.appName, opts.profileName, opts.installAnchor, opts.home)
  // THE FILE IS THE COMPOSITION (0.1.7 alignment): compose every layer
  // (bundle patches in profile order + profile patch + spawn extras like
  // worldMountPatches) ONCE here and write the FINAL row list into the
  // include file. Boot mounts it with NO patch stream. Rationale: the
  // include's runtime patch application provably dropped the spawn-time
  // worldMountPatches in nested boots (webserver re-enabled on 3080, world
  // rows gone — 2026-09-24 alignment evidence), while the composition itself
  // is deterministic and dumpable with the loader's own dialect (`!!js`
  // preserved via entryListSchema).
  const composed = composeEntries(profile.layers.map((l) => l.patches).concat([profile.patches, ...(opts.extraPatches ?? [])]), () => {})
  writeFileSync(
    join(profile.dir, 'cordis.yml'),
    dump(composed, { schema: entryListSchema, noRefs: true, lineWidth: -1 }) + '\n',
  )
  const patches: Parameters<typeof boot>[2] = []
  if (process.env.SUPERD_TRACE === '1') {
    // Alignment diagnostics: what the world tree will actually compose.
    try {
      const rows = composed
      const pick = (id: string) => rows.find((r) => r.id === id)
      for (const id of ['webserver', 'hmr', 'modules', 'superd-world-mount', 'superd-hub', 'agent-preset-registry']) {
        const row = pick(id)
        process.stderr.write(`[spawn-world:${opts.appName}] ${id}: ${row === undefined ? 'ABSENT' : JSON.stringify({ disabled: row.disabled, inject: 'inject' in row ? row.inject : undefined, name: row.name })}\n`)
      }
      process.stderr.write(`[spawn-world:${opts.appName}] composed rows: ${rows.length}\n`)
      process.stderr.write(`[spawn-world:${opts.appName}] patches tail: ${JSON.stringify(patches.slice(-3).map((p) => p.id ?? (Array.isArray(p.insert) ? `insert(${p.insert.length})` : '?')))}\n`)
    } catch (cause) {
      process.stderr.write(`[spawn-world:${opts.appName}] trace compose failed: ${String(cause)}\n`)
    }
  }
  // Host table first (spec §2.1): publish this world as a linked root of the
  // live resolution BEFORE boot() mounts the root include — the world config's
  // bare row names then resolve through the same interception the launcher
  // uses. Fail-soft: a table-less or hostile host degrades to native
  // resolution (the world fails loudly on its first missing import, never the
  // host).
  if (opts.host !== undefined) {
    try {
      const peerNames = new Set<string>()
      for (const row of composed as ReadonlyArray<{ name?: unknown; inject?: unknown }>) {
        for (const specifier of [
          ...(typeof row.name === 'string' ? [row.name] : []),
          ...(Array.isArray(row.inject) ? row.inject.filter((s): s is string => typeof s === 'string') : []),
        ]) {
          const bare = barePackageNameOf(specifier)
          if (bare !== undefined) peerNames.add(bare)
        }
      }
      await publishWorldInHostResolution(opts.host, opts, profile.dir, peerNames)
    } catch (cause) {
      process.stderr.write(`[spawn-world:${opts.appName}] host table publishing failed (${String(cause)}) — falling back to native resolution\n`)
    }
  }
  // Embedding-host facts via the PUBLIC cmdline API (risk-2 probe: boot owns
  // dshHomePath, so the prepare slot is for OUR provides — cmdlineArgs is not
  // boot-provided and upstream documents the empty-args embedding path).
  // Worlds take no flags and never open a browser; exit = dispose own fiber.
  // LAN authorities for the world's trust fence (deploy-level, env-driven):
  // the world webserver must accept the Host the browser actually sends.
  const trusted = (process.env.SUPERD_TRUSTED_HOSTS ?? '')
    .split(/[\s,]+/).filter(Boolean)
    .flatMap((h) => ['--trusted-host', h])
  let fiber: { dispose(): unknown } | undefined
  // Launcher parity (0.1.7): a profileContext-carrying tree runs the profile
  // HMR row, whose init REQUIRES the appReady service (otherwise "Profile HMR
  // requires application readiness"). The launcher owns the readiness signal
  // and commits it after boot settles — worlds do the same inline.
  let appReadyCommitted = false
  const appReadyListeners = new Set<() => void>()
  const appReady = {
    service: {
      onReady(listener: () => void): () => void {
        if (appReadyCommitted) {
          listener()
          return () => {}
        }
        appReadyListeners.add(listener)
        return () => { appReadyListeners.delete(listener) }
      },
    },
    commit(): void {
      if (appReadyCommitted) return
      appReadyCommitted = true
      for (const listener of [...appReadyListeners]) listener()
      appReadyListeners.clear()
    },
  }
  const ctxW = await boot(opts.appName, join(profile.dir, 'cordis.yml'), patches, (ctx) => {
    provideCmdline(ctx, {
      args: ['--no-open', ...trusted],
      exit: () => { void fiber?.dispose() },
      ready: appReady.service,
    })
    // This tree reads its own home from here on: sessions, settings.yaml,
    // workspace store — all under the world's nested root.
    //
    // `set` (not `provide`): boot already registered `dshHomePath` on this
    // root, and cordis refuses a second `provide` in the same scope
    // ("service … has been registered at <root>"). `set` is the documented
    // "overwrite a provided service's value" path for the owning fiber, which
    // the prepare slot is — and ADR 0008 constraint 2 prescribes exactly this
    // in-tree override (process.env is a shared resolver and must not change).
    if (opts.dataHome !== undefined) {
      const dataHome = opts.dataHome
      ctx.set('dshHomePath', (...segments: string[]) => join(dataHome, ...segments))
    }
    // 0.1.7: profile-mounted services (settings …) inject `profileContext`,
    // which only runProfile's prepare slot used to provide. Worlds boot
    // directly, so provide the equivalent here — without it every world's
    // provider row pends on `waiting for service: settings`. This also arms
    // the row-admission compatibility preflight inside world trees (it no-ops
    // without a profileContext, which would leave world rows unjudged).
    ctx.provide('profileContext', {
      name: opts.appName,
      dir: profile.dir,
      patchPath: profile.patchPath,
      installAnchor: opts.installAnchor,
      cwd: process.cwd(),
      home: opts.home,
      startedBundles: profile.layers.map((l) => l.packageName),
      overlays: profile.patches,
      telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    })
  })
  fiber = ctxW.fiber
  // Launcher parity: commit readiness only when the world tree actually
  // settled with a Loader (runProfile's same condition).
  if (ctxW.get('loader') !== undefined) appReady.commit()
  return ctxW
}
