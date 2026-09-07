import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '..')

function runSuperd(args: string[]): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx/esm', 'src/bin.ts', ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  )
}

describe('superd CLI', () => {
  it('usage fails loud on unknown subcommand', () => {
    expect(() => runSuperd(['wat']))
      .toThrow(/unknown command|usage/si)
  })

  it('web --dump-config composes the bundle layer without booting', () => {
    const home = mkdtempSync(join(tmpdir(), 'superd-launcher-'))
    const out = runSuperd(['web', '--dump-config', '--home', home])
    const entries = JSON.parse(out) as Array<{ id?: string }>
    const ids = entries.map(row => row.id)
    expect(ids).toContain('webserver')
    expect(ids).toContain('superd-runtime')
    expect(ids).not.toContain('ui-chat')
    // profile 被初始化在 superd home 下
    const manifest = JSON.parse(readFileSync(join(home, 'profiles/web/package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual(['@pgmi-builds/superd-web-bundle'])
  })
})
