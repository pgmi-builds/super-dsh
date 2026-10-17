// The host's native Plugin Manager must still refresh after worlds widen its table.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createRuntimeResolution, loadProfileDirectory, PluginPackages } from '@deepseek-ai/dsh-app-boot'
import { widenWorldResolution } from '../dist/world-resolution.js'

function file(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function json(path, value) { file(path, JSON.stringify(value)) }

test('world publication preserves native refresh, world imports, and disk package removal', async (t) => {
  const testRoot = new URL('../../../.tests/', import.meta.url).pathname
  mkdirSync(testRoot, { recursive: true })
  const home = mkdtempSync(join(testRoot, 'world-resolution-refresh-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const installAnchor = join(home, 'install', 'package.json')
  json(installAnchor, { name: '@deepseek-ai/dsh', version: '0.0.0' })
  const profileDir = join(home, 'profiles', 'test')
  const profileManifest = join(profileDir, 'package.json')
  const select = (enabled) => json(profileManifest, {
    name: 'test', private: true,
    dependencies: enabled ? { extra: '1.0.0' } : {},
    dsh: { profile: { bundles: enabled ? ['extra'] : [] } },
  })
  select(false)
  const source = { installAnchor, home, profileDir }
  const base = await createRuntimeResolution({ installAnchor, home, profile: loadProfileDirectory('dsh', profileDir, installAnchor) })
  await ctx.plugin(PluginPackages, { resolution: base })
  const worldHome = join(home, 'agents', 'fixture')
  json(join(worldHome, 'package.json'), { name: 'world', peerDependencies: { 'native-lib': '*' } })
  file(join(worldHome, 'caller.cjs'), '')
  const worldPackage = join(home, 'pack', 'world-runtime')
  json(join(worldPackage, 'package.json'), { name: '@pgmi-builds/world-fixture', version: '1.0.0', main: './index.cjs' })
  file(join(worldPackage, 'index.cjs'), 'module.exports = "world"')
  const worldEntry = {
    name: '@pgmi-builds/world-fixture', packageDir: worldPackage, version: '1.0.0',
    declarer: join(worldPackage, 'package.json'), scope: 'profile',
  }
  ctx.pluginPackages.replace(widenWorldResolution(base, source, [worldEntry], [{ name: 'world-fixture', realPath: worldHome }]))
  const parentURL = pathToFileURL(join(profileDir, 'caller.cjs')).href
  const worldRequire = createRequire(join(worldHome, 'caller.cjs'))
  const bundle = join(profileDir, 'node_modules', 'extra')
  json(join(bundle, 'package.json'), {
    name: 'extra', version: '1.0.0', dependencies: { 'native-lib': '1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  file(join(bundle, 'cordis.patch.yml'), '[]\n')
  const nativePackage = join(bundle, 'node_modules', 'native-lib')
  const nativeManifest = join(nativePackage, 'package.json')
  json(nativeManifest, { name: 'native-lib', version: '1.0.0', main: './index.cjs' })
  file(join(nativePackage, 'index.cjs'), 'module.exports = "native"')
  select(true)

  await ctx.pluginPackages.refresh()
  assert.equal(ctx.pluginPackages.packageOf('native-lib', parentURL)?.dir, nativePackage)
  assert.equal(worldRequire.resolve('native-lib'), join(nativePackage, 'index.cjs'), 'world linked root survives refresh')
  assert.equal(ctx.pluginPackages.packageOf(worldEntry.name, parentURL)?.dir, worldPackage)

  // 0.2.1 resolver: a same-directory version change of a loaded profile package
  // is adopted in place (realDir unchanged) — refresh succeeds and keeps the
  // mapping. A link retarget to another directory still requires a restart.
  json(nativeManifest, { name: 'native-lib', version: '2.0.0', main: './index.cjs' })
  await ctx.pluginPackages.refresh()
  assert.equal(ctx.pluginPackages.packageOf('native-lib', parentURL)?.dir, nativePackage, 'in-place version bump keeps the mapping')
  json(nativeManifest, { name: 'native-lib', version: '1.0.0', main: './index.cjs' })
  await ctx.pluginPackages.refresh()
  const retargetDir = join(bundle, 'node_modules', 'native-lib-real')
  mkdirSync(retargetDir, { recursive: true })
  writeFileSync(join(retargetDir, 'index.cjs'), 'module.exports = "native"')
  json(join(retargetDir, 'package.json'), { name: 'native-lib', version: '1.0.0', main: './index.cjs' })
  rmSync(nativePackage, { recursive: true, force: true })
  symlinkSync(retargetDir, nativePackage)
  // Refresh must retain upstream rejection of a retargeted loaded package.
  await assert.rejects(ctx.pluginPackages.refresh(), /requires a process restart/)
  // Restore the real directory so later refreshes can adopt it again.
  rmSync(nativePackage, { force: true })
  cpSync(retargetDir, nativePackage, { recursive: true })
  json(nativeManifest, { name: 'native-lib', version: '1.0.0', main: './index.cjs' })
  select(false)
  await ctx.pluginPackages.refresh()
  assert.equal(ctx.pluginPackages.packageOf('native-lib', parentURL), undefined, 'removed native mapping is not accumulated')
  assert.equal(ctx.pluginPackages.packageOf(worldEntry.name, parentURL)?.dir, worldPackage)
  assert.throws(() => worldRequire.resolve('native-lib'), /Cannot find module/)

  select(true)
  await ctx.pluginPackages.refresh()
  assert.equal(worldRequire.resolve('native-lib'), join(nativePackage, 'index.cjs'), 'repeated refresh remains computable')
})

test('a native mapping takes precedence over a previously published world alias', async (t) => {
  const testRoot = new URL('../../../.tests/', import.meta.url).pathname
  mkdirSync(testRoot, { recursive: true })
  const home = mkdtempSync(join(testRoot, 'world-resolution-alias-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const installAnchor = join(home, 'install', 'package.json')
  json(installAnchor, { name: '@deepseek-ai/dsh', version: '0.0.0', dependencies: { 'runtime-alias': '1.0.0' } })
  const packageDir = join(home, 'install', 'node_modules', 'runtime-alias')
  json(join(packageDir, 'package.json'), { name: 'runtime-alias', version: '1.0.0', main: './index.cjs' })
  file(join(packageDir, 'index.cjs'), '')
  const base = await createRuntimeResolution({ installAnchor, home })
  await ctx.plugin(PluginPackages, { resolution: base })
  const staleDir = join(home, 'stale-world-alias')
  json(join(staleDir, 'package.json'), { name: 'runtime-alias', version: '0.0.1' })
  ctx.pluginPackages.replace(widenWorldResolution(base, { installAnchor, home, profileDir: undefined }, [{
    name: 'runtime-alias', packageDir: staleDir, version: '0.0.1',
    declarer: join(staleDir, 'package.json'), scope: 'profile',
  }], []))
  await ctx.pluginPackages.refresh()
  const caller = pathToFileURL(join(home, 'profiles', 'test', 'caller.cjs')).href
  assert.equal(ctx.pluginPackages.packageOf('runtime-alias', caller)?.dir, packageDir)
})

test('the compiled world helper loads against a real pre-refresh host API', {
  skip: process.env.SUPERD_PRE_REFRESH_APP_BOOT === undefined ? 'provide a prior supported app-boot entry to check compatibility' : false,
}, async (t) => {
  const entry = process.env.SUPERD_PRE_REFRESH_APP_BOOT
  const prior = await import(pathToFileURL(entry).href)
  assert.equal(prior.ProfileRuntimeResolution, undefined, 'fixture is the historical data-generation API')
  // Only host import routing changes; the compiled product code runs unchanged.
  const compiled = readFileSync(new URL('../dist/world-resolution.js', import.meta.url), 'utf8')
    .replace("'@deepseek-ai/dsh-app-boot'", JSON.stringify(pathToFileURL(entry).href))
  const { widenWorldResolution: widen } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))
  const { Context: PriorContext } = await import(pathToFileURL(createRequire(entry).resolve('@deepseek-ai/cordis')).href)
  const testRoot = new URL('../../../.tests/', import.meta.url).pathname
  mkdirSync(testRoot, { recursive: true })
  const home = mkdtempSync(join(testRoot, 'world-resolution-prior-'))
  const ctx = new PriorContext()
  t.after(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const installAnchor = join(home, 'install', 'package.json')
  json(installAnchor, { name: '@deepseek-ai/dsh', version: '0.0.0' })
  const profileDir = join(home, 'profiles', 'test')
  json(join(profileDir, 'package.json'), { name: 'test', private: true, dsh: { profile: { bundles: [] } } })
  const profile = prior.loadProfileDirectory('dsh', profileDir, installAnchor)
  const base = await prior.createRuntimeResolution({ installAnchor, home, profile })
  await ctx.plugin(prior.PluginPackages, { resolution: base })
  const packageDir = join(home, 'world-runtime')
  json(join(packageDir, 'package.json'), { name: 'prior-world-runtime', version: '1.0.0', main: './index.cjs' })
  file(join(packageDir, 'index.cjs'), '')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  symlinkSync(packageDir, join(profileDir, 'node_modules', 'prior-world-runtime'))
  const worldHome = join(home, 'agents', 'prior')
  json(join(worldHome, 'package.json'), { name: 'prior-world', peerDependencies: { 'prior-world-runtime': '*' } })
  ctx.pluginPackages.replace(widen(base, { installAnchor, home, profileDir }, [{
    name: 'prior-world-runtime', packageDir, version: '1.0.0',
    declarer: join(profileDir, 'package.json'), scope: 'profile',
  }], [{ name: 'prior-world-root', realPath: worldHome }]))
  const caller = pathToFileURL(join(profileDir, 'caller.cjs')).href
  assert.equal(realpathSync(ctx.pluginPackages.packageOf('prior-world-runtime', caller).dir), packageDir)
  assert.equal(createRequire(join(worldHome, 'caller.cjs')).resolve('prior-world-runtime'), join(packageDir, 'index.cjs'))
})
