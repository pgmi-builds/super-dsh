/**
 * Roster — the attention entry point (plan Ruling P19 + workbench §2.5):
 * `remote({})` scans local sources only (zero dialing, zero reachability checks)
 * and REFRESHES the unified label pool (ssh → docker → incus → hub; a late
 * collision is prefixed `<transport>-<name>`). Machine names are public static
 * config; pty sessions are the caller's operating environment (agent-scoped).
 * Each section degrades independently and honestly (native error one-liner).
 *
 * @module dashr/remote/roster
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runOneShot, type OneShotOptions, type OneShotResult } from './oneshot.ts'
import { parseSshConfig } from './ssh-config.ts'
import type { PoolEntry } from './labels.ts'
import type { PtySession } from './pty-session.ts'

export interface RosterOptions {
  /** 测试缝：替代 runOneShot 的容器扫描执行器。 */
  runner?: (argv: string[], opts?: OneShotOptions) => Promise<OneShotResult>
  /** 测试缝：替代 ~/.ssh/config 读取。 */
  readSshConfig?: () => Promise<string>
  hardTimeoutSec?: number
}

export interface LocalScan {
  ssh: { hosts: string[]; wildcardBlocks: number; error?: string }
  docker: { rows: Array<{ name: string; state: string }>; error?: string; timedOut?: boolean }
  incus: { rows: Array<{ name: string; state: string }>; error?: string; timedOut?: boolean }
}

function oneLine(s: string): string {
  return s.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''
}

/** ssh config 里的字面别名（无通配、非否定的首个模式）；通配块是默认值来源不是目标。 */
export function literalHosts(text: string): { hosts: string[]; wildcardBlocks: number } {
  const { entries } = parseSshConfig(text)
  const hosts: string[] = []
  let wildcardBlocks = 0
  for (const entry of entries) {
    if (/[*?]/.test(entry.host) || entry.host.startsWith('!')) wildcardBlocks++
    else hosts.push(entry.host)
  }
  return { hosts, wildcardBlocks }
}

/** 三段本地扫描（各自独立降级，错误如实带回给 roster 呈现）。 */
export async function scanLocal(opts: RosterOptions = {}): Promise<LocalScan> {
  const runner = opts.runner ?? runOneShot
  const readSshConfig = opts.readSshConfig ?? (async () => await readFile(join(homedir(), '.ssh', 'config'), 'utf8'))
  const hard = opts.hardTimeoutSec ?? 10

  let ssh: LocalScan['ssh'] = { hosts: [], wildcardBlocks: 0 }
  try {
    const text = await readSshConfig()
    ssh = literalHosts(text)
  } catch (error) {
    ssh = { hosts: [], wildcardBlocks: 0, error: error instanceof Error ? error.message : String(error) }
  }

  const docker = await runner(['docker', 'ps', '-a', '--format', '{{.Names}}\t{{.State}}'], { timeoutSec: hard })
  const incus = await runner(['incus', 'list', '--format', 'csv', '--columns', 'ns'], { timeoutSec: hard })

  return {
    ssh,
    docker: docker.exit === 0
      ? { rows: docker.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [name, state] = l.split('\t'); return { name: (name ?? '').trim(), state: (state ?? '').trim() } }).filter((r) => r.name.length > 0) }
      : { rows: [], error: oneLine(docker.stderr) || `docker exited ${docker.exit}`, ...(docker.timedOut ? { timedOut: true } : {}) },
    incus: incus.exit === 0
      ? { rows: incus.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [name, state] = l.split(','); return { name: (name ?? '').trim(), state: (state ?? '').trim() } }).filter((r) => r.name.length > 0) }
      : { rows: [], error: oneLine(incus.stderr) || `incus exited ${incus.exit}`, ...(incus.timedOut ? { timedOut: true } : {}) },
  }
}

/** 统一池视图的 roster 呈现：机器三段 + BYO ssh 同位（built on）+ pty 会话段（caller-scoped）。 */
export function renderRoster(
  scan: LocalScan,
  entries: readonly PoolEntry[],
  sessions: readonly PtySession[],
  hubTargets: ReadonlyArray<{ id: string; label: string; execEnabled: boolean }> | null,
  /** 默认 PTY 槽标注（spec remote-default-pty）：session id → 归一 machineKey；未传 = 无默认槽展示。 */
  defaults?: ReadonlyMap<string, string>,
): string {
  const lines: string[] = []
  if (hubTargets !== null)
    lines.push(`hub machines: ${hubTargets.map(t => `hub:${t.id} (${t.label}${t.execEnabled ? '' : '; exec disabled'})`).join(', ') || 'none'}`)

  if (scan.ssh.error !== undefined) lines.push(`ssh hosts: no readable ~/.ssh/config (${scan.ssh.error})`)
  else {
    const sshNames = entries.filter((e) => e.kind === 'ssh').map((e) => e.name)
    const byoNames = entries.filter((e) => e.kind === 'ssh-byo').map((e) => `${e.name} (built on)`)
    const all = [...sshNames, ...byoNames]
    lines.push(`ssh hosts (~/.ssh/config + registered): ${all.length > 0 ? all.join(', ') : '(none)'}${scan.ssh.wildcardBlocks > 0 ? ` (+${scan.ssh.wildcardBlocks} wildcard default blocks, not listed)` : ''}`)
  }

  const dockerStates = new Map(scan.docker.rows.map((r) => [r.name, r.state]))
  const dockerEntries = entries.filter((e) => e.kind === 'docker')
  if (scan.docker.error !== undefined) lines.push(`docker containers: unavailable — ${scan.docker.timedOut ? `scan timed out` : scan.docker.error}`)
  else lines.push(`docker containers: ${dockerEntries.length > 0 ? dockerEntries.map((e) => e.kind === 'docker' && `${e.name}${e.name !== e.container ? ` (= docker:${e.container}${dockerStates.get(e.container) ? `, ${dockerStates.get(e.container)}` : ''})` : dockerStates.get(e.container) !== undefined && dockerStates.get(e.container) !== '' ? ` (${dockerStates.get(e.container)})` : ''}`).join(', ') : '(none)'}`)

  const incusStates = new Map(scan.incus.rows.map((r) => [r.name, r.state]))
  const incusEntries = entries.filter((e) => e.kind === 'incus')
  if (scan.incus.error !== undefined) lines.push(`incus containers: unavailable — ${scan.incus.timedOut ? `scan timed out` : scan.incus.error}`)
  else lines.push(`incus containers: ${incusEntries.length > 0 ? incusEntries.map((e) => e.kind === 'incus' && `${e.name}${e.name !== e.container ? ` (= incus:${e.container}${incusStates.get(e.container) ? `, ${incusStates.get(e.container)}` : ''})` : incusStates.get(e.container) !== undefined && incusStates.get(e.container) !== '' ? ` (${incusStates.get(e.container)})` : ''}`).join(', ') : '(none)'}`)

    lines.push(sessions.length > 0
    ? `pty sessions: ${sessions.map((s) => {
        const id = s.identity
        const snap = s.snapshot
        const state = snap.busy ? 'busy' : snap.state === 'dead' ? 'died' : `idle ${Math.round((snap.idleMs ?? 0) / 1000)}s`
        return `pty:${id.id}${id.label !== undefined ? ` (label ${id.label})` : ''} ${id.connection}${id.byo ? ' (byo-pty)' : ''} [${state}${defaults?.get(id.id) !== undefined ? `; default on ${defaults.get(id.id)}` : ''}]`
      }).join(' · ')}`
    : 'pty sessions: none')

  return lines.join('\n')
}
