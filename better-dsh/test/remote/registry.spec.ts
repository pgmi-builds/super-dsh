import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRegistry } from '../../src/remote/registry.ts'

// 每个用例独立的临时目录，afterEach 统一清理
let dir: string | undefined
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function writeConfig(build: (dir: string) => string): string {
  dir = mkdtempSync(join(tmpdir(), 'dashr-registry-'))
  writeFileSync(join(dir, 'config'), build(dir))
  return join(dir, 'config')
}

// Host dev3 全参数 + 通配块（含不支持指令）
const CFG = (keyPath?: string) => `
Host dev3
  HostName dev3.example.com
  User u1
  Port 2201
  IdentityFile /nonexistent/dashr-key-a
  IdentityFile ${keyPath ?? '/nonexistent/dashr-key-b'}

Host * !dev3
  User fallback
  ServerAliveInterval 30
`

describe('buildRegistry', () => {
  it('seeds declared aliases from ssh_config; wildcard blocks fabricate no target', () => {
    const { targets, seedSkipped } = buildRegistry({ sshConfigPath: writeConfig(() => CFG()) })
    expect(targets.size).toBe(1)
    expect(targets.get('dev3')).toEqual({
      name: 'dev3',
      backend: 'ssh',
      host: 'dev3.example.com',       // host 取 HostName
      port: 2201,
      user: 'u1',
      identityFile: undefined,        // 两个候选都不存在 → undefined，不报错
      proxyJump: undefined,
    })
    expect(targets.has('*')).toBe(false)  // 通配块只是默认值来源，不造目标
    expect(seedSkipped).toContain('ServerAliveInterval')
  })

  it('picks the first existing identityFile at build time', () => {
    const path = writeConfig((d) => {
      writeFileSync(join(d, 'real_key'), 'k')
      return CFG(join(d, 'real_key'))
    })
    const { targets } = buildRegistry({ sshConfigPath: path })
    expect(targets.get('dev3')!.identityFile).toBe(join(dir!, 'real_key'))
  })

  it('override merges field-wise onto the seeded target', () => {
    const { targets } = buildRegistry({
      sshConfigPath: writeConfig(() => CFG()),
      overrides: { dev3: { port: 2202, defaultCwd: '/srv/app', env: { FOO: 'bar' } } },
    })
    expect(targets.get('dev3')).toEqual({
      name: 'dev3',
      backend: 'ssh',
      host: 'dev3.example.com',       // 未覆盖字段保留 seed 值
      port: 2202,
      user: 'u1',
      identityFile: undefined,
      proxyJump: undefined,
      defaultCwd: '/srv/app',
      env: { FOO: 'bar' },
    })
  })

  it('same-name override env is wholesale replacement, not deep merge', () => {
    const { targets } = buildRegistry({
      sshConfigPath: writeConfig(() => CFG()),
      overrides: { dev3: { env: { ONLY: 'yes' } } },
    })
    expect(targets.get('dev3')!.env).toEqual({ ONLY: 'yes' })
  })

  it('new override target without host throws at build time, message naming the missing field', () => {
    expect(() =>
      buildRegistry({ sshConfigPath: writeConfig(() => CFG()), overrides: { box: { user: 'u1' } } }),
    ).toThrowError(/"box".*\bhost\b/)
  })

  it('missing ssh_config → empty seed; overrides still build targets (port defaults 22)', () => {
    dir = mkdtempSync(join(tmpdir(), 'dashr-registry-'))  // 只为拿到一个必然不存在的 config 路径
    const { targets, seedSkipped } = buildRegistry({
      sshConfigPath: join(dir, 'absent'),
      overrides: {
        box: { host: '10.1.2.3', port: 2203 },
        bare: { host: 'bare.example.com' },
      },
    })
    expect(seedSkipped).toEqual([])
    expect(targets.size).toBe(2)
    expect(targets.get('box')).toEqual({
      name: 'box', backend: 'ssh', host: '10.1.2.3', port: 2203,
      identityFile: undefined, proxyJump: undefined,
    })
    expect(targets.get('bare')).toEqual({
      name: 'bare', backend: 'ssh', host: 'bare.example.com', port: 22,  // port 默认 22
      identityFile: undefined, proxyJump: undefined,
    })
  })
})
