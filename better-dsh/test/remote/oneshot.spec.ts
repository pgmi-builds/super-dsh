import { describe, expect, it } from 'vitest'
import { runOneShot } from '../../src/remote/oneshot.ts'

const BASH = (cmd: string): string[] => ['bash', '-c', cmd]

describe('runOneShot', () => {
  it('retains the final sentinel beyond the native hard cap and reports real per-stream counts', async () => {
    const r = await runOneShot(BASH(`head -c 4000005 /dev/zero | tr '\\0' x; printf LAST; printf ERR >&2`))
    expect(r.stdout).toHaveLength(4_000_000)
    expect(r.stdout.endsWith('LAST')).toBe(true)
    expect(r.stderr).toBe('ERR')
    expect(r).toMatchObject({ outputStats: {
      stdout: { unit: 'utf16', total: 4_000_009, retained: 4_000_000, dropped: 9, returned: 4_000_000, retentionLimit: 4_000_000 },
      stderr: { unit: 'utf16', total: 3, retained: 3, dropped: 0, returned: 3, retentionLimit: 4_000_000 },
    } })
  })
  it('captures stdout, stderr and the binary exit code', async () => {
    const r = await runOneShot(BASH('echo out; echo err >&2; exit 42'))
    expect(r.exit).toBe(42)
    expect(r.stdout).toBe('out\n')
    expect(r.stderr).toBe('err\n')
    expect(r.timedOut).toBe(false)
  })
  it('pipes stdin and closes it', async () => {
    const r = await runOneShot(BASH('cat'), { stdin: 'line1\nline2\n' })
    expect(r.exit).toBe(0)
    expect(r.stdout).toBe('line1\nline2\n')
  })
  it('preserves utf8 across chunk boundaries', async () => {
    const r = await runOneShot(BASH("printf '中%.0s' $(seq 1 20000); echo"))
    expect(r.stdout).toBe('中'.repeat(20_000) + '\n')
    expect(r.exit).toBe(0)
  })
  it('timeout: TERM ignored -> KILL escalation observable (exit null, >2s), flagged, bounded', async () => {
    const r = await runOneShot(BASH('trap "" TERM; sleep 30'), { timeoutSec: 1 })
    expect(r.timedOut).toBe(true)
    expect(r.exit).toBe(null)
    expect(r.durationMs).toBeGreaterThan(2_500)
    expect(r.durationMs).toBeLessThan(8_000)
  })
  it('timeout bounds completion when a background descendant holds the pipes (process-group kill)', async () => {
    const r = await runOneShot(BASH('sleep 8 & sleep 8'), { timeoutSec: 1 })
    expect(r.timedOut).toBe(true)
    expect(r.durationMs).toBeLessThan(5_000)
  })
  it('spawn failure surfaces the OS error verbatim (error transparency)', async () => {
    const r = await runOneShot(['definitely-not-a-real-cli-xyz', '--version'])
    expect(r.exit).toBe(null)
    expect(r.stderr).toContain('spawn failed')
    expect(r.stderr).toContain('ENOENT')
  })
})
