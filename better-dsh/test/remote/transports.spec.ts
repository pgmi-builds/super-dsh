import { describe, expect, it } from 'vitest'
import { buildOneShotArgv, buildPtyArgv, buildSpawnArgv, shQuote } from '../../src/remote/transports.ts'

describe('shQuote', () => {
  it('wraps in single quotes and escapes embedded quotes POSIX-style', () => {
    expect(shQuote('ls -la')).toBe(`'ls -la'`)
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
    expect(shQuote('a\nb')).toBe(`'a\nb'`)
  })
})

describe('buildOneShotArgv (pure-CLI one-shot with group-kill wrapper)', () => {
  it('ssh: BatchMode, no tty, wrapper carries the mechanically-quoted cmd', () => {
    const argv = buildOneShotArgv({ kind: 'ssh', host: 'dev4' }, "git status | head -1")
    expect(argv.slice(0, 5)).toEqual(['ssh', '-o', 'BatchMode=yes', '-T', '--'])
    expect(argv).toHaveLength(7)
    expect(argv[5]).toBe('dev4')
    expect(argv[6]!).toContain('kill -TERM 0')
        expect(argv[6]!).toContain(String.raw`bash -lc '\''git status | head -1'\''`)
    expect(argv[6]!.startsWith('setsid --wait bash -c ')).toBe(true)
    expect(argv[6]!.toLowerCase()).not.toContain('python')
  })
  it('ssh survives a cmd containing single quotes (one mechanical layer)', () => {
    const argv = buildOneShotArgv({ kind: 'ssh', host: 'dev4' }, "echo 'hi'")
    const remote = argv.at(-1)!
    expect(remote).toContain('kill -TERM 0')
    expect(remote).toContain(`'\\''hi'\\''`)
    // The whole remote command line stays syntactically valid shell (quoting round-trips).
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    expect(() => execFileSync('bash', ['-n', '-c', remote], { stdio: 'pipe' })).not.toThrow()
  })
  it('docker: exec -i, argv-direct (no -t, no re-parse), same wrapper', () => {
    const argv = buildOneShotArgv({ kind: 'docker', container: 'c1' }, 'echo x')
    expect(argv.slice(0, 8)).toEqual(['docker', 'exec', '-i', '--', 'c1', 'setsid', '--wait', 'bash'])
    expect(argv[8]).toBe('-c')
    expect(argv[9]!).toContain('kill -TERM 0')
    expect(argv[9]!).toContain(`bash -lc 'echo x'`)
  })
  it('incus: exec without -t semantics (--force-noninteractive), same wrapper', () => {
    const argv = buildOneShotArgv({ kind: 'incus', container: 'ctr-1' }, 'echo x')
    expect(argv.slice(0, 8)).toEqual(['incus', 'exec', '--force-noninteractive', 'ctr-1', '--', 'setsid', '--wait', 'bash'])
    expect(argv[8]).toBe('-c')
    expect(argv[9]!).toContain(`bash -lc 'echo x'`)
  })
})

describe('buildPtyArgv', () => {
  it('ssh: force-tty over host pipes, BatchMode, fixed client-owned keepalive (P-keepalive 2026-10-19)', () => {
    expect(buildPtyArgv({ kind: 'ssh', host: 'dev4' }))
      .toEqual(['ssh', '-tt', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=180', '-o', 'ServerAliveCountMax=2', '--', 'dev4', 'bash'])
  })
  it('docker: script(1) hosts the PTY, local echo pre-silenced, exec replaces the shell', () => {
    expect(buildPtyArgv({ kind: 'docker', container: 'my c' }))
      .toEqual(['script', '-qfec', `stty -echo 2>/dev/null ; exec docker exec -it -- 'my c' bash`, '/dev/null'])
  })
  it('incus: force-interactive over host pipes', () => {
    expect(buildPtyArgv({ kind: 'incus', container: 'ctr-1' }))
      .toEqual(['incus', 'exec', '--force-interactive', 'ctr-1', '--', 'bash'])
  })
})

describe('buildSpawnArgv (BYO-PTY)', () => {
  it('hosts any spawn command under script with echo pre-silenced', () => {
    expect(buildSpawnArgv('docker exec -it temp-worker bash'))
      .toEqual(['script', '-qfec', 'stty -echo 2>/dev/null ; exec docker exec -it temp-worker bash', '/dev/null'])
  })
})
