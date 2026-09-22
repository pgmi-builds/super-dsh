/**
 * TOFU host-key pin store — Trust On First Use pinning for the remote ssh
 * face (plan docs/10_plans/2026-09-22-dashr-remote-tool-rm0.md, Task 4).
 *
 * Pure module: node:crypto + node:fs + node:path only. Task 6's ssh backend
 * pins `SHA256:<unpadded b64>` on first connect and requires later connects
 * to match (变更 fail loud 属于 hostVerifier 的比较逻辑，本模块只存取)。
 *
 * - {@link fingerprintOfKey} 的指纹与 `ssh-keygen -lf` 同形（同一 key blob
 *   交叉验证）：SHA256 + base64 剥除 padding。
 * - 文件店是 JSON `{target: fingerprint}`；读盘惰性（每次 get 直读，永远
 *   新鲜）；目录不存在则 mkdir -p；写盘原子（同目录 tmp + rename）。
 * - 损坏/形状不对的 pin 库 fail loud，绝不静默当空库——那等于替攻击者重新
 *   pin。只有 ENOENT（尚无 pin）视为空。
 *
 * @module dashr/remote/hostkeys
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** host-key 指纹：`SHA256:<unpadded b64>`，格式同 `ssh-keygen -lf`。 */
export function fingerprintOfKey(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export interface HostKeyStore {
  /** target 的已 pin 指纹；未 pin 过 → undefined */
  get(target: string): string | undefined
  /** 记录/更新 target 的 pin（TOFU 首连或显式 re-pin） */
  set(target: string, fingerprint: string): void
}

/** JSON `{target: fingerprint}` 文件店；写盘原子（同目录 tmp + rename）。 */
export function createFileHostKeyStore(filePath: string): HostKeyStore {
  const readAll = (): Record<string, string> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {} // 尚无 pin
      throw error // 损坏的 pin 库 fail loud
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`host-key pin store is not a JSON object: ${filePath}`)
    }
    return parsed as Record<string, string>
  }
  return {
    get(target) {
      return readAll()[target]
    },
    set(target, fingerprint) {
      const pins = readAll()
      pins[target] = fingerprint
      mkdirSync(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp-${randomBytes(6).toString('hex')}`
      writeFileSync(tmp, JSON.stringify(pins))
      renameSync(tmp, filePath)
    },
  }
}

/** 内存店——测试用。 */
export function createMemoryHostKeyStore(): HostKeyStore {
  const pins = new Map<string, string>()
  return {
    get: (target) => pins.get(target),
    set: (target, fingerprint) => {
      pins.set(target, fingerprint)
    },
  }
}
