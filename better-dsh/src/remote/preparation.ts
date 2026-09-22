/**
 * Preparation layer / status assembly — pure module, zero runtime imports
 * (plan docs/10_plans/2026-09-22-dashr-remote-tool-rm0.md, Task 7; design §3.2/§3.3).
 *
 * Three responsibilities, all pure so the engine (Task 8) can compose them:
 *
 * - **{@link buildProbeCommand}**: ONE bash command that emits machine-parseable
 *   `key=value` lines (user/host, per-tool `command -v` + version, sudo -n
 *   three-state, $BASH_VERSION). Run through Task 6's degraded exec — framing
 *   (cd guard + tail sentinel) is the engine's business; this command only
 *   prints facts. Exact syntax here is free; the contract is that
 *   {@link parseProbeOutput} reads back what this prints.
 * - **{@link parseProbeOutput}**: line parser for the probe output. Partial
 *   output yields partial facts and never throws — unrecognized lines (motd
 *   noise, login banners, stray sentinels) are skipped. A missing `sudo` line
 *   defaults to the most conservative `'no'`.
 * - **{@link formatStatus} / {@link formatTargets}**: the §3.3 status document
 *   block and the targets list rendering. Values are engine-known state
 *   (target spec, pooled-conn state, session, probe facts); nothing here dials.
 *
 * @module dashr/remote/preparation
 */

import type { ConnState } from './backend.ts'
import type { RemoteTargetSpec } from './registry.ts'

export interface StatusFacts {
  user?: string; host?: string; rttMs?: number
  tools: Array<{ name: string; path?: string; version?: string }>
  bashVersion?: string
  sudo: 'nopasswd' | 'password' | 'no'
}

/** 探针覆盖的工具（canonical 顺序；探测循环与此保持一致）。 */
const TOOL_ORDER: readonly string[] = ['node', 'pnpm', 'python', 'python3', 'pip', 'git']

/**
 * 一条 degraded exec 批量探测命令：whoami/hostname + 逐工具 `command -v` +
 * 版本 + sudo -n true 三态 + bash 版本；行格式 `key=value` 便于解析。
 * 经 `bash -lc` 执行（login shell 修正 PATH，nvm/pyenv shim 才找得到）。
 */
export function buildProbeCommand(): string {
  return [
    `printf 'user=%s\\n' "$(id -un 2>/dev/null)"`,
    `printf 'host=%s\\n' "$(hostname 2>/dev/null)"`,
    `for c in node pnpm python python3 pip git; do`,
    `  if p=$(command -v "$c" 2>/dev/null); then`,
    `    printf 'path-%s=%s\\n' "$c" "$p"`,
    `    case "$c" in`,
    `      node) v=$(node --version 2>&1) ;;`,
    `      pnpm) v=$(pnpm --version 2>&1) ;;`,
    `      *) v=$("$c" --version 2>&1) ;;`,
    `    esac`,
    `    printf 'ver-%s=%s\\n' "$c" "$v"`,
    `  fi`,
    `done`,
    `if ! command -v sudo >/dev/null 2>&1; then s=no`,
    `elif sudo -n true >/dev/null 2>&1; then s=nopasswd`,
    `else s=password`,
    `fi`,
    `printf 'sudo=%s\\n' "$s"`,
    `printf 'bash=%s\\n' "$BASH_VERSION"`,
  ].join('\n')
}

/** 按工具归一化版本串（探针抓的是各工具原生命令的原始输出）。 */
function normalizeVersion(name: string, raw: string | undefined): string | undefined {
  const v = raw?.trim()
  if (v === undefined || v === '') return undefined
  switch (name) {
    case 'python':
    case 'python3':
      return v.replace(/^python\s+/i, '')
    case 'pip': {
      const m = /^pip\s+(\S+)/i.exec(v) // "pip 23.0.1 from /usr/lib/..." → "23.0.1"
      return m !== null ? m[1]! : v
    }
    case 'git':
      return v.replace(/^git\s+version\s+/i, '')
    default:
      return v
  }
}

/**
 * 解析探针输出（`key=value` 行，按首个 `=` 切分；value 可含空格）。
 * 缺行 → 缺字段（partial facts）；噪点行一律跳过；绝不抛错。
 * `sudo` 行缺席 → 最保守的 `'no'`（sudo 真要用时 `sudo -n` 仍会 fail-fast）。
 */
export function parseProbeOutput(raw: string): StatusFacts {
  const facts: StatusFacts = { tools: [], sudo: 'no' }
  const paths = new Map<string, string>()
  const versions = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue // 无 `=` 或空 key（motd 噪点）→ 跳过
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'user' && value !== '') facts.user = value
    else if (key === 'host' && value !== '') facts.host = value
    else if (key === 'sudo' && (value === 'nopasswd' || value === 'password' || value === 'no')) facts.sudo = value
    else if (key === 'bash' && value !== '') facts.bashVersion = value
    else if (key.startsWith('path-') && value !== '') paths.set(key.slice('path-'.length), value)
    else if (key.startsWith('ver-') && value !== '') versions.set(key.slice('ver-'.length), value)
  }
  const names = new Set<string>([...paths.keys(), ...versions.keys()])
  const ordered = [
    ...TOOL_ORDER.filter((n) => names.has(n)),
    ...[...names].filter((n) => !TOOL_ORDER.includes(n)).sort(), // 未知工具（未来扩展）排后
  ]
  for (const name of ordered) {
    const tool: StatusFacts['tools'][number] = { name }
    const path = paths.get(name)
    const version = normalizeVersion(name, versions.get(name))
    if (path !== undefined) tool.path = path
    if (version !== undefined) tool.version = version
    facts.tools.push(tool)
  }
  return facts
}

export interface StatusLine {
  target: RemoteTargetSpec
  facts?: StatusFacts
  conn?: { state: ConnState; sinceMs?: number }
  session?: { mode: 'pty' | 'exec'; cwd?: string }
  error?: string
}

/** 池化连接存活时长的人类可读形式（§3.3 示例 `1m32s`）。 */
function formatDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000)
  if (total < 1) return '<1s'
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

function toolLabel(t: StatusFacts['tools'][number]): string {
  let s = t.name
  if (t.version !== undefined && t.version !== '') s += ` ${t.version}`
  if (t.path !== undefined && t.path !== '') s += ` (${t.path})`
  return s
}

function sudoLabel(sudo: StatusFacts['sudo']): string {
  if (sudo === 'nopasswd') return 'NOPASSWD ✓'
  return sudo === 'password' ? 'password-required' : 'no sudo'
}

function sessionLine(s: NonNullable<StatusLine['session']>): string {
  const mode = s.mode === 'pty' ? 'pty' : 'exec (degraded)'
  return s.cwd !== undefined && s.cwd !== '' ? `session : ${mode} · cwd ${s.cwd}` : `session : ${mode}`
}

function hasText(v: string | undefined): v is string {
  return v !== undefined && v !== ''
}

/** §3.3 status 文档块；error 在场时替代全部事实行（拨号失败的诚实形态）。 */
export function formatStatus(line: StatusLine): string {
  const t = line.target
  const who = `${hasText(t.user) ? `${t.user}@` : ''}${t.host}:${t.port}`
  const keyNote = hasText(t.identityFile) ? `  (key ${t.identityFile}, via ~/.ssh/config)` : ''
  const lines = [`target : ${t.name} → ${who}${keyNote}`]

  if (hasText(line.error)) {
    // 拨号/探测失败：facts 不可信，error 行替代（session 是引擎已知真实状态，保留）
    if (line.session !== undefined) lines.push(sessionLine(line.session))
    lines.push(`error : ${line.error}`)
    return lines.join('\n')
  }

  if (line.conn?.state === 'ready') {
    let conn = `alive ${formatDuration(line.conn.sinceMs ?? 0)}`
    if (line.facts?.rttMs !== undefined) conn += `   rtt ${line.facts.rttMs}ms`
    lines.push(`conn   : ${conn}`)
  } else if (line.conn?.state === 'closed') {
    lines.push('conn   : not connected (closed)')
  } else {
    // 未连接，不再承诺拨号时机（Minor 8：建连策略后续可变，状态行不绑实现）
    lines.push('conn   : not connected')
  }

  const sessionCwd = line.session?.cwd
  if (hasText(sessionCwd)) lines.push(`cwd    : ${sessionCwd}`)
  else if (hasText(t.defaultCwd)) lines.push(`cwd    : ${t.defaultCwd}   (default, registry)`)
  else lines.push('cwd    : (unset)')

  let env = 'login-shell (bash -lc)'
  for (const [k, v] of Object.entries(t.env ?? {})) env += ` + ${k}=${v}`
  lines.push(`env    : ${env}`)

  if (line.facts !== undefined) {
    const tools = line.facts.tools
    lines.push(`tools  : ${tools.length === 0 ? '(none found)' : tools.map(toolLabel).join(' · ')}`)
    lines.push(`sudo   : ${sudoLabel(line.facts.sudo)}`)
  }

  if (line.session !== undefined) lines.push(sessionLine(line.session))
  return lines.join('\n')
}

/** targets 列表（Ruling 8：只列注册表 + 池化 alive 标记，绝不拨号）。 */
export function formatTargets(list: Array<{ name: string; host: string; port: number; user?: string; alive: boolean; defaultCwd?: string }>): string {
  if (list.length === 0) return '(no targets)'
  const width = Math.max(...list.map((t) => t.name.length))
  return list
    .map((t) => {
      const who = `${hasText(t.user) ? `${t.user}@` : ''}${t.host}:${t.port}`
      const cwd = hasText(t.defaultCwd) ? `  (default cwd ${t.defaultCwd})` : ''
      return `${t.name.padEnd(width)} : ${who}  ${t.alive ? '✓ alive' : '· offline'}${cwd}`
    })
    .join('\n')
}
