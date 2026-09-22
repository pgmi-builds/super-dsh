/**
 * Remote target registry — seeds ssh targets from `~/.ssh/config` (via the
 * Task 1 parser) and merges row-config overrides on top (plan
 * docs/10_plans/2026-09-22-dashr-remote-tool-rm0.md, Task 2).
 *
 * - Seed = the aliases each Host block literally declares (the block's first
 *   pattern, resolved through {@link resolveSshHost}): wildcard and
 *   negation-only blocks contribute defaults but never fabricate a target.
 * - Overrides merge field-wise (`override ?? seed`); `env` is replaced
 *   wholesale, never deep-merged. An override naming an unknown target must
 *   declare `host` — otherwise {@link buildRegistry} throws at build time,
 *   listing the missing field(s).
 * - A missing ssh_config is an empty seed (overrides still apply); the
 *   parser's skipped directives surface as `seedSkipped`.
 *
 * @module dashr/remote/registry
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseSshConfig, resolveSshHost } from './ssh-config.ts'
import type { ParsedSshConfig } from './ssh-config.ts'

export interface RemoteTargetSpec {
  name: string
  backend: 'ssh'
  host: string            // hostName ?? name
  port: number            // 默认 22
  user?: string           // 缺省 = 本地当前用户（ssh 默认）
  identityFile?: string   // 首个存在的文件（存在性启动时探测，不存在不报错）
  proxyJump?: string      // RM0 不支持，connect 时 fail loud（Ruling 5）
  defaultCwd?: string
  env?: Record<string, string>
}
export interface TargetOverride {
  host?: string
  user?: string
  port?: number
  identityFile?: string
  defaultCwd?: string
  env?: Record<string, string>
}
export interface RegistryInput {
  overrides?: Record<string, TargetOverride>   // 行配置 targets：覆盖 seed / 新增（新增必须给 host，缺省 → 构造期 throw，消息列缺失字段）
  sshConfigPath?: string                       // 缺省 ~/.ssh/config；文件不存在 = 空 seed
}

/** 读取并解析 seed 配置；文件不存在 = 空 seed（其它读取错误照常抛出） */
function parseSeed(path: string): ParsedSshConfig {
  try {
    return parseSshConfig(readFileSync(path, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], skipped: [] }
    throw err
  }
}

function seedFrom(parsed: ParsedSshConfig): Map<string, RemoteTargetSpec> {
  const targets = new Map<string, RemoteTargetSpec>()
  for (const entry of parsed.entries) {
    // resolveSshHost 只认字面声明的别名：通配/否定模式块返回 undefined → 不造目标
    const resolved = resolveSshHost(parsed.entries, entry.host)
    if (resolved === undefined) continue
    targets.set(entry.host, {
      name: entry.host,
      backend: 'ssh',
      host: resolved.hostName ?? entry.host,
      port: resolved.port ?? 22,
      user: resolved.user,
      identityFile: resolved.identityFiles.find((file) => existsSync(file)),
      proxyJump: resolved.proxyJump,
    })
  }
  return targets
}

export function buildRegistry(input: RegistryInput): { targets: Map<string, RemoteTargetSpec>; seedSkipped: string[] } {
  const parsed = parseSeed(input.sshConfigPath ?? join(homedir(), '.ssh', 'config'))
  const targets = seedFrom(parsed)

  for (const [name, override] of Object.entries(input.overrides ?? {})) {
    const seed = targets.get(name)
    if (seed === undefined) {
      // 新增 target：唯一必填字段是 host
      if (override.host === undefined) {
        throw new Error(`remote target override "${name}": missing required field(s): host (new target must declare host)`)
      }
      targets.set(name, {
        name,
        backend: 'ssh',
        host: override.host,
        port: override.port ?? 22,
        user: override.user,
        identityFile: override.identityFile,
        defaultCwd: override.defaultCwd,
        env: override.env,
      })
    } else {
      // 覆盖已有 seed：逐字段 `override ?? seed`
      targets.set(name, {
        name,
        backend: 'ssh',
        host: override.host ?? seed.host,
        port: override.port ?? seed.port,
        user: override.user ?? seed.user,
        identityFile: override.identityFile ?? seed.identityFile,
        proxyJump: seed.proxyJump,
        defaultCwd: override.defaultCwd ?? seed.defaultCwd,
        env: override.env ?? seed.env, // 整体替换，不深合并
      })
    }
  }

  return { targets, seedSkipped: parsed.skipped }
}
