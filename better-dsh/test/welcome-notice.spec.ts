import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { boot, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import * as General from '@deepseek-ai/dsh-client-ui-settings-general'

const homes: string[] = []
const contexts: Awaited<ReturnType<typeof boot>>[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('welcome acknowledgement policy', () => {
  it('reads version bumps from the installed client and rejects an unknown layout', async () => {
    const module = await import('../src/welcome-notice.ts')
    expect(typeof module.parseWelcomeVersion).toBe('function')
    expect(module.parseWelcomeVersion('const WELCOME_NOTICE_VERSION = "2030-01-01.1";')).toBe('2030-01-01.1')
    expect(module.parseWelcomeVersion("const WELCOME_NOTICE_VERSION = '2030-02-01.2';")).toBe('2030-02-01.2')
    expect(() => module.parseWelcomeVersion('const RENAMED = "version";')).toThrow()
    expect(() => module.parseWelcomeVersion('const WELCOME_NOTICE_VERSION = "a"; const WELCOME_NOTICE_VERSION = "b";')).toThrow()
  })

  it('has the current version in the first settled settings snapshot and restores on disable', async () => {
    const module = await import('../src/welcome-notice.ts')
    expect(typeof module.apply).toBe('function')
    const web = await import('../src/webserver.ts')
    const home = mkdtempSync(join(tmpdir(), 'dashr-welcome-')); homes.push(home)
    const dir = join(home, 'profiles/test'); const bundle = join(dir, 'node_modules/test-bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['test-bundle'] } } }))
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
      { id: 'webserver', name: 'cordis:webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'probe', name: 'cordis:probe' },
      { id: 'ui-settings-general', name: 'cordis:general', config: { welcomeNoticeVersion: 'old-version' } },
      { id: 'dashr-welcome-notice', name: 'cordis:welcome' },
    ] }]))
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n'); writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const profile: ProfileContext = { name: 'test', dir, home, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: resolve('../upstream/deepseek-harness/apps/cli/package.json'), cwd: home,
      startedBundles: ['test-bundle'], overlays: [], telemetryDisabledEnv: undefined }
    let generalMounts = 0
    const general = { ...General, async apply(ctx: Parameters<typeof General.apply>[0]) { generalMounts++; await new Promise(resolve => setTimeout(resolve, 30)); return General.apply(ctx) } }
    let live: Awaited<ReturnType<typeof boot>> | undefined
    const probe = { inject: ['webServer', 'settings'], apply(ctx: Awaited<ReturnType<typeof boot>>) {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/snapshot', handler(_req, res) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(ctx.settings.describe().find(row => row.ns === 'ui-settings-general')?.value ?? null))
      } }))
    } }
    const booting = boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), ctx => {
      live = ctx; contexts.push(ctx)
      ctx.provide('profileContext', profile)
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, general, welcome: module, webserver: web.default, probe })
    })
    const firstHttp = (async () => {
      for (let attempt = 0; attempt < 500; attempt++) {
        const port = live?.get('webServer')?.port
        if (port) {
          const response = await fetch(`http://127.0.0.1:${port}/snapshot`)
          if (response.ok) return response.json()
        }
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      throw new Error('first HTTP settings snapshot never became available')
    })()
    const ctx = await booting
    expect(await firstHttp).toEqual({ welcomeNoticeVersion: module.readHostWelcomeVersion(profile.installAnchor) })
    const first = ctx.settings.describe().find(row => row.ns === 'ui-settings-general')!
    expect(generalMounts).toBe(1)
    expect(first.value).toEqual({ welcomeNoticeVersion: module.readHostWelcomeVersion(profile.installAnchor) })
    const welcome = [...ctx.loader.entries()].find(entry => entry.options.id === 'dashr-welcome-notice')!
    const generalFiber = [...ctx.loader.entries()].find(entry => entry.options.id === 'ui-settings-general')!.fiber
    await welcome.update({ disabled: true })
    await welcome.fiber!.dispose()
    expect(ctx.settings.describe().find(row => row.ns === 'ui-settings-general')!.value).toEqual({ welcomeNoticeVersion: 'old-version' })
    await welcome.update({ disabled: false })
    await welcome.fiber!.await()
    expect(generalMounts).toBe(1)
    expect([...ctx.loader.entries()].find(entry => entry.options.id === 'ui-settings-general')!.fiber).toBe(generalFiber)
    expect(ctx.settings.describe().find(row => row.ns === 'ui-settings-general')!.value).toEqual({ welcomeNoticeVersion: module.readHostWelcomeVersion(profile.installAnchor) })
  })
})
