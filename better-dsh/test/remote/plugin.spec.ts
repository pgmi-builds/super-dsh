import { describe, expect, it } from 'vitest'
import { apply, Config, name } from '../../src/remote/plugin.ts'
import type { Context } from '@deepseek-ai/cordis'

describe('dashr-remote row', () => {
  it('Config defaults: 120s exec, 15-min PTY TTL, 30000 chars (R2: one TTL source)', () => {
    const c = Config(undefined) as { execTimeoutSec: number; idleTtlSec: number; maxOutputChars: number }
    expect(c).toMatchObject({ execTimeoutSec: 120, idleTtlSec: 900, maxOutputChars: 30_000 })
  })
  it('mounts dormant and installs only an Agent creation listener', () => {
    expect(name).toBe('dashr-remote')
    const events: string[] = []
    const fakeCtx = { on: (event: string) => { events.push(event); return () => {} } } as unknown as Context
    const disposer = apply(fakeCtx, Config(undefined) as never)
    expect(events).toEqual(['agent/created'])
    expect(() => disposer()).not.toThrow()
  })
  it('patch row and build wiring are in place', async () => {
    const patch = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'))
    expect(patch).toContain('- id: dashr-remote')
    expect(patch).toContain("name: 'better-dsh/remote'")
    const pkg = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')))
    expect(pkg.exports['./remote']).toEqual({ types: './lib/remote/plugin.d.ts', default: './lib/remote/plugin.js' })
    const tsd = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../tsdown.config.ts', import.meta.url), 'utf8'))
    expect(tsd).toContain("'src/remote/plugin.ts'")
  })
})
