/** The lifecycle owner serves only its own namespace and leaves native acknowledgement untouched. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { boot, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import * as General from '@deepseek-ai/dsh-client-ui-settings-general'
import * as Welcome from '../src/welcome-notice.ts'

it('serves the welcome owner only while enabled, without changing native welcome settings', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dashr-welcome-'))
  const dir = join(home, 'profiles/test'); const bundle = join(dir, 'node_modules/test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['test-bundle'] } } }))
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'ui-settings-general', name: 'cordis:general', config: { welcomeNoticeVersion: 'user-version' } },
    { id: 'dashr-welcome-notice', name: 'cordis:welcome' },
  ] }]))
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n'); writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', dir, home, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: resolve('../upstream/deepseek-harness/apps/cli/package.json'), cwd: home,
    startedBundles: ['test-bundle'], overlays: [], telemetryDisabledEnv: undefined }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), ctx => {
    ctx.provide('profileContext', profile)
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, general: General, welcome: Welcome })
  })
  try {
    const general = () => ctx.settings.describe().find(row => row.ns === 'ui-settings-general')!.value
    const policy = () => ctx.settings.describe().find(row => row.ns === 'dashr-welcome-notice')
    expect(general()).toEqual({ welcomeNoticeVersion: 'user-version' })
    expect(policy()).toMatchObject({ value: {}, autoGenerate: false })
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'dashr-welcome-notice')!
    await row.update({ disabled: true })
    await row.fiber!.dispose()
    expect(policy()).toBeUndefined()
    expect(general()).toEqual({ welcomeNoticeVersion: 'user-version' })
    await row.update({ disabled: false })
    await row.fiber!.await()
    expect(policy()).toMatchObject({ value: {}, autoGenerate: false })
    expect(general()).toEqual({ welcomeNoticeVersion: 'user-version' })
  } finally { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) }
})
