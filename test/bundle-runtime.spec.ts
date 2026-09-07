import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDistIndex, resolveLanTrust } from '@pgmi-builds/superd-web-bundle'

describe('resolveLanTrust', () => {
  it('loopback bind carries no LAN addresses', () => {
    const trust = resolveLanTrust('127.0.0.1', ['extra.example'])
    expect(trust.lanAddresses).toEqual([])
    expect(trust.trustedHosts).toEqual(['extra.example'])
  })

  it('all-interfaces bind derives LAN IPv4 literals', () => {
    const trust = resolveLanTrust('0.0.0.0', [])
    expect(trust.lanAddresses.length).toBeGreaterThan(0)
    expect(trust.trustedHosts).toEqual(trust.lanAddresses)
  })
})

describe('resolveDistIndex', () => {
  it('resolves the pinned web-frontend dist index.html', () => {
    const distIndex = resolveDistIndex()
    expect(distIndex.endsWith('dist/index.html')).toBe(true)
    expect(distIndex).toContain('dsh-web-frontend')
  })

  it('DSH_WEB_FRONTEND_DIR override wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'superd-dist-'))
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    process.env.DSH_WEB_FRONTEND_DIR = dir
    try {
      expect(resolveDistIndex()).toBe(join(dir, 'index.html'))
    } finally {
      delete process.env.DSH_WEB_FRONTEND_DIR
    }
  })
})
