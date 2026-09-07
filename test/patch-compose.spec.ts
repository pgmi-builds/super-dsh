import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const require = createRequire(import.meta.url)
const bundleDir = dirname(require.resolve('@pgmi-builds/superd-web-bundle/package.json'))
const patchPath = join(bundleDir, 'cordis.patch.yml')

describe('superd-web-bundle patch', () => {
  const patches = loadOverlayPatches('superd-test', patchPath)
  const entries = composeEntries([patches])

  it('inserts the carrier + neutral-base roster', () => {
    const ids = entries.map(row => row.id)
    expect(ids).toEqual([
      'superd-startup', 'webserver', 'superd-runtime', 'client-hmr',
      'modules', 'connection', 'api-remotes', 'cordis-host-runner',
      'cordis-client-runner', 'ui-theme', 'locale', 'ui-layout',
      'ui-renderer', 'ui-cordis', 'ui-sidebar', 'ui-settings',
    ])
  })

  it('webserver row defers to webStartup and defaults port 3090', () => {
    const row = entries.find(row => row.id === 'webserver')
    expect(row?.name).toBe('@deepseek-ai/dsh-host-webserver')
    expect(row?.inject).toEqual(['webStartup'])
  })

  it('connection row waits on webRuntime', () => {
    const row = entries.find(row => row.id === 'connection')
    expect(row?.name).toBe('@deepseek-ai/dsh-client-connection')
    expect(row?.inject).toEqual(['webRuntime'])
  })

  it('no DSH session/agent-plane rows leak in', () => {
    const ids = entries.map(row => row.id)
    for (const banned of ['session-controller', 'settings-controller', 'workspace-controller',
      'ui-chat', 'ui-conversation', 'ui-session', 'ui-workspace', 'ui-settings-general']) {
      expect(ids).not.toContain(banned)
    }
  })

  it('upstream names all resolve inside the repo node_modules', () => {
    for (const row of entries) {
      if (typeof row.name === 'string' && row.name.startsWith('@deepseek-ai/')) {
        expect(() => require.resolve(`${row.name}/package.json`), row.name).not.toThrow()
      }
    }
  })
})
