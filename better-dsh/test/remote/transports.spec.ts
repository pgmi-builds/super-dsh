import { describe, expect, it } from 'vitest'
import { buildHubPtyArgv, buildOneShotArgv, buildPtyArgv, buildSpawnArgv, shQuote } from '../../src/remote/transports.ts'

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

describe('buildHubPtyArgv (hub PTY; 0.3.2-d F4: local half goes raw)', () => {
  it('script hosts the pump with stty raw -echo — control bytes cross the local line discipline verbatim', () => {
    const argv = buildHubPtyArgv({ url: 'https://hub.example/ws', cookie: '', wsPath: '/x/ws.js' }, { pumpPath: '/opt/pump/hub-pty-pump.mjs', nodePath: '/usr/bin/node' })
    expect(argv).toEqual(['script', '-qfec', `stty raw -echo 2>/dev/null ; export SUPERD_HUB_PTY_URL='https://hub.example/ws' SUPERD_HUB_PTY_COOKIE='' SUPERD_HUB_PTY_WS='/x/ws.js' ; exec '/usr/bin/node' '/opt/pump/hub-pty-pump.mjs'`, '/dev/null'])
    // F4 pin: the wrapper must set the LOCAL line discipline raw. A canonical+ISIG pty turns
    // 0x03 into a local SIGINT (kills the pump) and 0x04 into EOF before any byte reaches
    // the WebSocket — input ^C/^D and job_kill then kill the whole session (retest §4).
    expect(argv[2]!.startsWith('stty raw -echo')).toBe(true)
    expect(argv[2]!.includes('stty -echo ')).toBe(false)
  })
  it('node defaults to process.execPath; connection facts ride env assignments, never argv', () => {
    const argv = buildHubPtyArgv({ url: 'u', cookie: 'k', wsPath: 'w' }, { pumpPath: '/p.mjs' })
    expect(argv[2]!).toContain(`exec '${process.execPath}' '/p.mjs'`)
    expect(argv.slice(0, 2)).toEqual(['script', '-qfec'])
    expect(argv.at(-1)).toBe('/dev/null')
  })
})
