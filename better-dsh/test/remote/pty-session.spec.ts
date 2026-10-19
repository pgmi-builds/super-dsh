import { describe, expect, it } from 'vitest'
import { descendantIsLive, killFixtureDescendant } from './disposal-fixture.ts'
import { PtyPool, PtySession } from '../../src/remote/pty-session.ts'

const OPTS = { idleTtlSec: 600 }

describe('PtySession over plain local bash', () => {
  it('counts the whole oversized dispatch, retains its sentinel and resets counts for the next dispatch', async () => {
    const s = new PtySession({ key: 'tail-counts', argv: ['bash'], ...OPTS })
    try {
      const r = await s.dispatch(`head -c 4000005 /dev/zero | tr '\\0' x; printf LAST`)
      expect(r.output.endsWith('LAST')).toBe(true)
      expect(r).toMatchObject({ outputStats: { stdout: { unit: 'utf16', total: 4_000_009, retained: 4_000_000, dropped: 9 } } })
      expect(await s.dispatch('printf NEXT')).toMatchObject({ output: 'NEXT', outputStats: { stdout: { total: 4, retained: 4, dropped: 0 } } })
    } finally { await s.dispose() }
  })
  it('cold starts, frames output/exit/cwd', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    const r = await s.dispatch('echo hello && cd /tmp && pwd')
    expect(r.output.trim()).toBe('hello\n/tmp')
    expect(r.exit).toBe(0)
    expect(r.cwd).toBe('/tmp')
    expect(r.reconnected).toBe(false)
    await s.dispose()
  })
  it('multi-line cmd = one compound frame, exit is the last command\'s', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    const r = await s.dispatch('echo a\necho b\nfalse')
    expect(r.output).toBe('a\nb\n')
    expect(r.exit).toBe(1)
    await s.dispose()
  })
  it('state persists across dispatches (cwd/env)', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    await s.dispatch('export FOO=bar && cd /tmp')
    const r = await s.dispatch('echo "$FOO" && pwd')
    expect(r.output).toBe('bar\n/tmp\n')
    await s.dispose()
  })
  it('snapshot feeds the status face: ready+idle after dispatch, disposed after dispose', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    await s.dispatch('echo hi')
    expect(s.snapshot).toMatchObject({ state: 'ready', busy: false })
    expect(s.snapshot.idleMs).toBeGreaterThanOrEqual(0)
    const pool = new PtyPool({ idleTtlSec: 600 })
    const s2 = pool.getOrCreate('t:x', ['bash'])
    expect(pool.inspect('t:x')?.state).toBe('cold')
    expect(pool.inspect('missing')).toBeUndefined()
    await s2.dispatch('echo y')
    expect(pool.inspect('t:x')).toMatchObject({ state: 'ready', busy: false })
    await s.dispose(); await pool.disposeAll()
  })
  it('serializes concurrent dispatches on one session (clean A/B output = no stdin interleave)', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    const [r1, r2] = await Promise.all([
      s.dispatch('sleep 0.4 ; echo A'),
      s.dispatch('echo B'),
    ])
    expect(r1.output.trim()).toBe('A')
    expect(r2.output.trim()).toBe('B')
    expect(r1.durationMs).toBeGreaterThan(300)
    await s.dispose()
  })
  it('unexpected shell death: partial + null exit; next dispatch reconnects with the notice', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    const r1 = await s.dispatch('kill -9 $$')
    expect(r1.exit).toBe(null)
    const r2 = await s.dispatch('echo back')
    expect(r2.reconnected).toBe(true)
    expect(r2.output.trim()).toBe('back')
    expect(r2.exit).toBe(0)
    await s.dispose()
  })
  it('idle TTL disposes the session and drops it from the pool (transparent cold start, no notice)', async () => {
    const pool = new PtyPool({ idleTtlSec: 1 })
    const s = pool.getOrCreate('t:x', ['bash'])
    await s.dispatch('echo hi')
    await new Promise((r) => setTimeout(r, 1_800))
    expect(s.sessionState).toBe('disposed')
    expect(pool.size).toBe(0)
    const s2 = pool.getOrCreate('t:x', ['bash'])
    const r = await s2.dispatch('echo again')
    expect(r.reconnected).toBe(false)
    await pool.disposeAll()
  })
})

describe('PtySession over script(1)-hosted PTY (BYO-PTY shape)', () => {
  it('sync timeout hands off instead of auto-interrupting: running receipt, job completes, session survives (P4)', async () => {
    const s = new PtySession({ key: 'k', argv: ['script', '-qfec', 'bash', '/dev/null'], ...OPTS })
    const r = await s.dispatch('sleep 1 ; echo late', { timeoutSec: 1 })
    expect(r.running).toBe(true)
    expect(r.timedOut).toBe(false)
    expect(r.exit).toBe(null)
    expect(r.job).toBeDefined()
    const res = await r.job!.done
    expect(res.exit).toBe(0)
    expect(res.output).toContain('late')
    const r2 = await s.dispatch('echo alive') // handoff never interrupted the shell
    expect(r2.exit).toBe(0)
    await s.dispose()
  }, 20_000)
  it('job.interrupt(): ^C through the pty line discipline — framed exit 130, session survives (P8 unchanged)', async () => {
    const s = new PtySession({ key: 'k', argv: ['script', '-qfec', 'bash', '/dev/null'], ...OPTS })
    const r = await s.dispatch('echo begin; sleep 30', { background: true })
    for (let i = 0; i < 100 && !r.job!.read(0).text.includes('begin'); i++) await new Promise(res => setTimeout(res, 20)) // wait until the shell consumed the command — ^C before consumption flushes the unread tty line (input-queue race, not a supervision gap)
    r.job!.interrupt()
    const res = await r.job!.done
    expect(res.exit).toBe(130)
    const r2 = await s.dispatch('echo alive')
    expect(r2.exit).toBe(0)
    await s.dispose()
  }, 20_000)
  it('interrupt kill fallback on a transport without interrupt (plain bash over pipes)', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    const r = await s.dispatch('trap "" INT; sleep 30', { background: true })
    r.job!.interrupt()
    const res = await r.job!.done
    expect(res.exit).toBe(null)
    expect(res.timedOut).toBe(true)
    expect(r.durationMs).toBeLessThan(10_000)
    await s.dispose()
  }, 20_000)
  it('forged static 133-D marker with wrong nonce never truncates the stream', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    const r = await s.dispatch(`printf '\\x1b]133;D;deadbeefdeadbeef;99;/pwn\\x07' ; echo real`)
    expect(r.exit).toBe(0)
    expect(r.output.trim()).toBe('real')
    await s.dispose()
  })
  it('caps dispatch output collection (tail ring) — runaway output cannot eat host memory', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    const r = await s.dispatch("printf 'x%.0s' $(seq 1 5000000) ; echo ; echo TAILMARK")
    expect(r.output.length).toBeLessThanOrEqual(4_000_001)
    expect(r.output.trim().endsWith('TAILMARK')).toBe(true)
    await s.dispose()
  }, 30_000)
  it('grace-expiry kill fallback reaps the process group (snapshot pid null, group gone)', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    await s.dispatch('echo warm')
    const pid = s.snapshot.pid
    expect(pid).toBeTypeOf('number')
    const r = await s.dispatch('trap "" INT; sleep 30', { background: true })
    r.job!.interrupt()
    const res = await r.job!.done
    expect(res.exit).toBe(null)
    expect(res.timedOut).toBe(true)
    expect(s.snapshot.pid).toBe(null)
    // killTimer 在发送 SIGTERM 的同一 tick 内结算 dispatch，僵尸组要等事件循环轮转 +
    // node/init 收尸后才消失——与下一测试「等 dispose 的 killTree 兑现」同一机制。
    await new Promise((r2) => setTimeout(r2, 1_200))
    expect(() => process.kill(-pid!, 0)).toThrow()
    await s.dispose()
  }, 20_000)
  it.each(['sleep 30', "bash -c 'trap \"\" TERM; exec sleep 30'"])('disposal reaps redirected background descendants running %s', async command => {
    const s = new PtySession({ key: 'background-child', argv: ['bash'], ...OPTS })
    let child: number | undefined
    let group: number | null = null
    try {
      const result = await s.dispatch(`${command} </dev/null >/dev/null 2>&1 & printf %s "$!"`)
      child = Number(result.output)
      group = s.snapshot.pid
      expect(descendantIsLive(child)).toBe(true)
      await s.dispose()
      expect(descendantIsLive(child)).toBe(false)
      expect(s.dispose()).toBe(s.dispose())
    } finally {
      killFixtureDescendant(child)
      if (group) { try { process.kill(-group, 'SIGKILL') } catch { /* already cleaned */ } }
      await s.dispose()
    }
  })
  it('cleanup also settles after the session child process has already closed', async () => {
    const s = new PtySession({ key: 'already-closed', argv: ['bash'], ...OPTS })
    await s.dispatch('echo ready')
    await s.dispatch('exit 3')
    const completion = await Promise.race([
      s.dispose().then(() => 'closed'),
      new Promise(resolve => setTimeout(() => resolve('hung'), 500)),
    ])
    expect(completion).toBe('closed')
  })
  it('dispose is terminal: stale-reference dispatch rejects E_SESSION_DISPOSED', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    await s.dispatch('echo hi')
    await s.dispose()
    await expect(s.dispatch('echo late')).rejects.toThrow(/E_SESSION_DISPOSED/)
  })
  it('dispose mid-flight settles the in-flight dispatch promptly (exit null, not timedOut)', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    const p = s.dispatch('sleep 30', { timeoutSec: 30 })
    await new Promise((r) => setTimeout(r, 300))
    await s.dispose()
    const r = await p
    expect(r.exit).toBe(null)
    expect(r.timedOut).toBe(false)
    expect(r.durationMs).toBeLessThan(5_000)
    await new Promise((r2) => setTimeout(r2, 1_200)) // 等 dispose 的 killTree 兑现，防组泄漏到下一测试
  }, 20_000)
})

describe('PTY background & handoff (P4/P5, 2026-10-19)', () => {
  it('background dispatch returns immediately with a running receipt; job.done frames exit/cwd; read() is byte-cursor increments', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    const started = Date.now()
    const r = await s.dispatch('sleep 0.5 ; echo done ; cd /tmp', { background: true })
    expect(r.running).toBe(true)
    expect(r.exit).toBe(null)
    expect(r.cwd).toBe(null)
    expect(r.job).toBeDefined()
    expect(Date.now() - started).toBeLessThan(400)
    const cursor0 = r.job!.read(0)
    const res = await r.job!.done
    expect(res.exit).toBe(0)
    expect(res.cwd).toBe('/tmp')
    expect(res.output).toContain('done')
    expect(r.job!.read(cursor0.nextOffset).text).toContain('done')
    await s.dispose()
  }, 20_000)
  it('busy shell rejects new commands while a background job runs, accepts after settle (Q6)', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], ...OPTS })
    const r = await s.dispatch('sleep 1 ; echo ok', { background: true })
    await expect(s.dispatch('echo nope')).rejects.toThrow(/E_SESSION_BUSY/)
    const res = await r.job!.done
    expect(res.output).toContain('ok')
    const after = await s.dispatch('echo after')
    expect(after.output.trim()).toBe('after')
    await s.dispose()
  }, 20_000)
  it('idle TTL never reaps a session whose command is still running (R1 dual condition)', async () => {
    const pool = new PtyPool({ idleTtlSec: 1 })
    const s = pool.getOrCreate('t:x', ['bash'])
    const r = await s.dispatch('sleep 1.6 ; echo long', { background: true })
    await new Promise((res) => setTimeout(res, 1_400)) // past the idle TTL, job still running
    expect(s.sessionState).not.toBe('disposed')
    const res = await r.job!.done
    expect(res.output).toContain('long')
    await pool.disposeAll()
  }, 20_000)
})
