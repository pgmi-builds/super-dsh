import { describe, expect, it } from 'vitest'
import { scanLocal, renderRoster } from '../../src/remote/roster.ts'
import type { OneShotResult } from '../../src/remote/oneshot.ts'
import type { PoolEntry } from '../../src/remote/labels.ts'
import type { PtySession } from '../../src/remote/pty-session.ts'

const R = (over: Partial<OneShotResult>): OneShotResult =>
  ({ exit: 0, timedOut: false, stdout: '', stderr: '', durationMs: 5, ...over })

const SSH_CFG = [
  'Host dev3',
  '  HostName dev3.example.com',
  'Host * !dev3',
  '  User fallback',
  'Host mac',
  '  HostName 192.0.2.7',
].join('\n')

const runnerFor = (docker: OneShotResult, incus: OneShotResult) =>
  async (argv: string[]): Promise<OneShotResult> => {
    if (argv[0] === 'docker') return docker
    return incus
  }

const fakeSession = (id: string, label: string | undefined, connection: string, state: string, idleSec: number | null, byo = false): PtySession =>
  ({ identity: { id, ...(label !== undefined ? { label } : {}), connection, byo }, snapshot: { state, busy: false, idleMs: idleSec === null ? null : idleSec * 1_000, pid: null } }) as unknown as PtySession

const machines = (over: { ssh?: string[]; docker?: string[]; incus?: string[] } = {}): PoolEntry[] => [
  ...(over.ssh ?? ['dev3', 'mac']).map((name): PoolEntry => ({ kind: 'ssh', name, host: name })),
  ...(over.docker ?? ['corti', 'jellyfin']).map((name): PoolEntry => ({ kind: 'docker', name, container: name })),
  ...(over.incus ?? ['ctr-1']).map((name): PoolEntry => ({ kind: 'incus', name, container: name })),
]

describe('roster (Ruling P19 + workbench §2.5 pool view)', () => {
  it('lists machines from the pool and live sessions with identity', async () => {
    const scan = await scanLocal({ readSshConfig: async () => SSH_CFG, runner: runnerFor(R({ stdout: 'corti\trunning\njellyfin\texited\n' }), R({ stdout: 'ctr-1,RUNNING\n' })) })
    const text = renderRoster(scan, machines(), [fakeSession('pty-7k2m', 'build', 'ssh:dev3', 'ready', 12), fakeSession('pty-9a01', undefined, 'BYOP', 'ready', null, true)], [])
    expect(text).toContain('ssh hosts (~/.ssh/config + registered): dev3, mac (+1 wildcard default blocks, not listed)')
    expect(text).toContain('docker containers: corti (running), jellyfin (exited)')
    expect(text).toContain('incus containers: ctr-1 (RUNNING)')
    expect(text).toContain('pty sessions: pty:pty-7k2m (label build) ssh:dev3 [idle 12s] · pty:pty-9a01 BYOP (byo-pty) [idle 0s]')
  })
  it('degrades each section honestly — missing config, failed scans, timeout, empty pool', async () => {
    const scan = await scanLocal({ readSshConfig: async () => { throw new Error('ENOENT: no such file') }, runner: runnerFor(R({ exit: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n' }), R({ exit: null, timedOut: true })) })
    const text = renderRoster(scan, [], [], [])
    expect(text).toContain('ssh hosts: no readable ~/.ssh/config (ENOENT: no such file)')
    expect(text).toContain('docker containers: unavailable — Cannot connect to the Docker daemon')
    expect(text).toContain('incus containers: unavailable — scan timed out')
    expect(text).toContain('pty sessions: none')
  })
  it('renders empty rosters as (none) without fabricating', async () => {
    const scan = await scanLocal({ readSshConfig: async () => 'Host dev3\n', runner: runnerFor(R({ stdout: '' }), R({ stdout: '' })) })
    const text = renderRoster(scan, [{ kind: 'ssh', name: 'dev3', host: 'dev3' }], [], [])
    expect(text).toContain('ssh hosts (~/.ssh/config + registered): dev3')
    expect(text).toContain('docker containers: (none)')
    expect(text).toContain('incus containers: (none)')
  })
  it('a late machine collision shows the prefixed pool name with its real channel', () => {
    const scan: Parameters<typeof renderRoster>[0] = { ssh: { hosts: ['dev3'], wildcardBlocks: 0 }, docker: { rows: [{ name: 'dev3', state: 'running' }] }, incus: { rows: [] } }
    const entries: PoolEntry[] = [
      { kind: 'ssh', name: 'dev3', host: 'dev3' },
      { kind: 'docker', name: 'docker-dev3', container: 'dev3' },
    ]
    const text = renderRoster(scan, entries, [], [])
    expect(text).toContain('docker containers: docker-dev3 (= docker:dev3, running)')
  })
  it('BYO ssh identities ride the ssh section with (built on)', () => {
    const scan: Parameters<typeof renderRoster>[0] = { ssh: { hosts: [], wildcardBlocks: 0 }, docker: { rows: [] }, incus: { rows: [] } }
    const text = renderRoster(scan, [{ kind: 'ssh-byo', name: 'myhost', connection: { host: '1.2.3.4' } }], [], [])
    expect(text).toContain('ssh hosts (~/.ssh/config + registered): myhost (built on)')
  })
})
