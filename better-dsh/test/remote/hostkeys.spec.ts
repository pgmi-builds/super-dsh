/**
 * TOFU host-key pin store（plan docs/10_plans/2026-09-22-dashr-remote-tool-rm0.md, Task 4）。
 * 指纹 fixture 经 `ssh-keygen -lf` 交叉验证：同一 key blob，ssh-keygen 与 node:crypto
 * 的 SHA256 + 无 padding base64 完全一致。
 *
 * @module dashr/remote/hostkeys (spec)
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createFileHostKeyStore,
  createMemoryHostKeyStore,
  fingerprintOfKey,
} from '../../src/remote/hostkeys.ts'

// 真实 ed25519 公钥 blob（OpenSSH wire 格式）；其指纹已知且经 ssh-keygen 验证
const KEY_BLOB = Buffer.from(
  'AAAAC3NzaC1lZDI1NTE5AAAAINxHTPu+X9yZzQDWDsIMNjSnfFckhZNop+uMbe85Ip/J',
  'base64',
)
const KNOWN_FP = 'SHA256:5hnqE7I57eWOAYDCFyZ6PDR7IUlrbpapST7cbxBrAcA'

// 每个用例独立的临时目录，afterEach 统一清理
let dir: string | undefined
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('fingerprintOfKey', () => {
  it('matches the known ssh-keygen fingerprint: SHA256 prefix, unpadded base64', () => {
    const fp = fingerprintOfKey(KEY_BLOB)
    expect(fp).toBe(KNOWN_FP)
    expect(fp.startsWith('SHA256:')).toBe(true)
    expect(fp.includes('=')).toBe(false) // base64 padding 剥除
    expect(fp.slice('SHA256:'.length)).toHaveLength(43) // 32 字节 → 44 字符 − 1 个 '='
  })
})

describe('createMemoryHostKeyStore', () => {
  it('set then get reads the pin back', () => {
    const store = createMemoryHostKeyStore()
    expect(store.get('dev3')).toBeUndefined()
    store.set('dev3', KNOWN_FP)
    expect(store.get('dev3')).toBe(KNOWN_FP)
  })

  it('set overwrites a previous pin', () => {
    const store = createMemoryHostKeyStore()
    store.set('dev3', KNOWN_FP)
    store.set('dev3', 'SHA256:other')
    expect(store.get('dev3')).toBe('SHA256:other')
  })
})

describe('createFileHostKeyStore', () => {
  it('persists the first pin: set then get reads it back', () => {
    dir = mkdtempSync(join(tmpdir(), 'dashr-hostkeys-'))
    const path = join(dir, 'host-keys.json')
    const store = createFileHostKeyStore(path)
    expect(store.get('dev3')).toBeUndefined() // 未 pin 过 → undefined
    store.set('dev3', KNOWN_FP)
    expect(store.get('dev3')).toBe(KNOWN_FP)
  })

  it('a re-created instance (file reopened) still has the pin', () => {
    dir = mkdtempSync(join(tmpdir(), 'dashr-hostkeys-'))
    const path = join(dir, 'host-keys.json')
    createFileHostKeyStore(path).set('dev3', KNOWN_FP)
    const reopened = createFileHostKeyStore(path)
    expect(reopened.get('dev3')).toBe(KNOWN_FP)
  })

  it('creates missing parent directories on write', () => {
    dir = mkdtempSync(join(tmpdir(), 'dashr-hostkeys-'))
    const path = join(dir, 'a', 'b', 'host-keys.json') // 父目录不存在
    const store = createFileHostKeyStore(path)
    store.set('dev3', KNOWN_FP)
    expect(store.get('dev3')).toBe(KNOWN_FP)
  })

  it('stores JSON {target: fingerprint} and leaves no temp files behind', () => {
    dir = mkdtempSync(join(tmpdir(), 'dashr-hostkeys-'))
    const path = join(dir, 'host-keys.json')
    createFileHostKeyStore(path).set('dev3', KNOWN_FP)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ dev3: KNOWN_FP })
    expect(readdirSync(dir)).toEqual(['host-keys.json']) // 原子写（tmp+rename）无残留
  })

  it('throws on a corrupt pin file (fail loud — never silently reads as empty)', () => {
    dir = mkdtempSync(join(tmpdir(), 'dashr-hostkeys-'))
    const path = join(dir, 'host-keys.json')
    writeFileSync(path, '{not json') // 损坏：静默当空库 = 替攻击者重新 pin
    expect(() => createFileHostKeyStore(path).get('dev3')).toThrow()
  })

  it('throws when the pin file is valid JSON but not an object ([] / null)', () => {
    dir = mkdtempSync(join(tmpdir(), 'dashr-hostkeys-'))
    const path = join(dir, 'host-keys.json')
    for (const garbage of ['[]', 'null']) {
      writeFileSync(path, garbage) // 形状不对：get 恒 undefined = 同样的 TOFU 洞
      expect(() => createFileHostKeyStore(path).get('dev3')).toThrow()
    }
  })
})
