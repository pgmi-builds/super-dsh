import { describe, expect, it } from 'vitest'
import { descendantIsLive, killFixtureDescendant } from './disposal-fixture.ts'
import { PtyPool, PtySession } from '../../src/remote/pty-session.ts'

const OPTS = { idleTtlSec: 600 }

describe('PtySession over plain local bash', () => {
  it('counts the whole oversized dispatch, retains its sentinel and resets counts for the next dispatch', async () => {
    const s = new PtySession({ key: 'tail-counts', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    try {
      const r = await s.dispatch(`head -c 4000005 /dev/zero | tr '\\0' x; printf LAST`, { commandId: 'spec-c' })
      expect(r.output.endsWith('LAST')).toBe(true)
      expect(r).toMatchObject({ outputStats: { stdout: { unit: 'utf16', total: 4_000_009, retained: 4_000_000, dropped: 9 } } })
      expect(await s.dispatch('printf NEXT', { commandId: 'spec-c' })).toMatchObject({ output: 'NEXT', outputStats: { stdout: { total: 4, retained: 4, dropped: 0 } } })
    } finally { await s.dispose() }
  })
  it('cold starts, frames output/exit/cwd', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    const r = await s.dispatch('echo hello && cd /tmp && pwd', { commandId: 'spec-c' })
    expect(r.output.trim()).toBe('hello\n/tmp')
    expect(r.exit).toBe(0)
    expect(r.cwd).toBe('/tmp')
    expect(r.reconnected).toBe(false)
    await s.dispose()
  })
  it('multi-line cmd = one compound frame, exit is the last command\'s', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    const r = await s.dispatch('echo a\necho b\nfalse', { commandId: 'spec-c' })
    expect(r.output).toBe('a\nb\n')
    expect(r.exit).toBe(1)
    await s.dispose()
  })
  it('state persists across dispatches (cwd/env)', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    await s.dispatch('export FOO=bar && cd /tmp', { commandId: 'spec-c' })
    const r = await s.dispatch('echo "$FOO" && pwd', { commandId: 'spec-c' })
    expect(r.output).toBe('bar\n/tmp\n')
    await s.dispose()
  })
  it('snapshot feeds the status face: ready+idle after dispatch, disposed after dispose', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    await s.dispatch('echo hi', { commandId: 'spec-c' })
    expect(s.snapshot).toMatchObject({ state: 'ready', busy: false })
    expect(s.snapshot.idleMs).toBeGreaterThanOrEqual(0)
    const pool = new PtyPool({ idleTtlSec: 600 })
    const s2 = pool.create({ key: 't:x', argv: ['bash'], id: 'pty-pool', connection: 'spec' })
    expect(pool.inspect('t:x')?.state).toBe('cold')
    expect(pool.inspect('missing')).toBeUndefined()
    await s2.dispatch('echo y', { commandId: 'spec-c' })
    expect(pool.inspect('t:x')).toMatchObject({ state: 'ready', busy: false })
    await s.dispose(); await pool.disposeAll()
  })
  it('serializes concurrent dispatches on one session (clean A/B output = no stdin interleave)', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    const [r1, r2] = await Promise.all([
      s.dispatch('sleep 0.4 ; echo A', { commandId: 'spec-c' }),
      s.dispatch('echo B', { commandId: 'spec-c' }),
    ])
    expect(r1.output.trim()).toBe('A')
    expect(r2.output.trim()).toBe('B')
    expect(r1.durationMs).toBeGreaterThan(300)
    await s.dispose()
  })
  it('unexpected shell death: partial + null exit; next dispatch reconnects with the notice', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    const r1 = await s.dispatch('kill -9 $$', { commandId: 'spec-c' })
    expect(r1.exit).toBe(null)
    const r2 = await s.dispatch('echo back', { commandId: 'spec-c' })
    expect(r2.reconnected).toBe(true)
    expect(r2.output.trim()).toBe('back')
    expect(r2.exit).toBe(0)
    await s.dispose()
  })
  it('R2 P0: the init timeout does not kill a session that already initialized', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', idleTtlSec: 60, initTimeoutSec: 0.15 })
    try {
      expect((await s.dispatch('echo ready', { commandId: 'c1' })).output.trim()).toBe('ready')
      await new Promise((r) => setTimeout(r, 600))
      expect(s.snapshot.state).toBe('ready')
      const again = await s.dispatch('echo still-here', { commandId: 'c2' })
      expect(again.reconnected).toBe(false)
      expect(again.output.trim()).toBe('still-here')
    } finally { await s.dispose() }
  })
  it('R2 P0: a died session is reaped after one idle TTL instead of holding label + quota forever', async () => {
    const pool = new PtyPool({ idleTtlSec: 1 })
    const s = pool.create({ key: 't:dead', argv: ['bash'], id: 'pty-dead', connection: 'spec' })
    expect((await s.dispatch('kill -9 $$', { commandId: 'c1' })).exit).toBe(null)
    expect(s.sessionState).toBe('dead')
    expect(pool.get('t:dead')).toBeDefined()
    await new Promise((r) => setTimeout(r, 1_600))
    expect(s.sessionState).toBe('disposed')
    expect(pool.size).toBe(0)
    await pool.disposeAll()
  })
  it('warm creation dials: ready state + idle timer, so it cannot sit immortal', async () => {
    const pool = new PtyPool({ idleTtlSec: 60 })
    const s = pool.create({ key: 't:warm', argv: ['bash'], id: 'pty-warm', connection: 'spec' })
    await s.warm()
    expect(s.sessionState).toBe('ready')
    expect(pool.inspect('t:warm')?.idleMs).not.toBeNull()
    await pool.disposeAll()
  })
  it('idle TTL disposes the session and drops it from the pool (transparent cold start, no notice)', async () => {
    const pool = new PtyPool({ idleTtlSec: 1 })
    const s = pool.create({ key: 't:x', argv: ['bash'], id: 'pty-pool', connection: 'spec' })
    await s.dispatch('echo hi', { commandId: 'spec-c' })
    await new Promise((r) => setTimeout(r, 1_800))
    expect(s.sessionState).toBe('disposed')
    expect(pool.size).toBe(0)
    const s2 = pool.create({ key: 't:x', argv: ['bash'], id: 'pty-pool', connection: 'spec' })
    const r = await s2.dispatch('echo again', { commandId: 'spec-c' })
    expect(r.reconnected).toBe(false)
    await pool.disposeAll()
  })
})

describe('PtySession over script(1)-hosted PTY (BYO-PTY shape)', () => {
  it('sync timeout hands off instead of auto-interrupting: running receipt, job completes, session survives (P4)', async () => {
    const s = new PtySession({ key: 'k', argv: ['script', '-qfec', 'bash', '/dev/null'], id: 'pty-spec', connection: 'spec', ...OPTS })
    const r = await s.dispatch('sleep 1 ; echo late', { commandId: 'spec-c', ...{ timeoutSec: 1 } })
    expect(r.running).toBe(true)
    expect(r.timedOut).toBe(false)
    expect(r.exit).toBe(null)
    expect(r.job).toBeDefined()
    const res = await r.job!.done
    expect(res.exit).toBe(0)
    expect(res.output).toContain('late')
    const r2 = await s.dispatch('echo alive', { commandId: 'spec-c' }) // handoff never interrupted the shell
    expect(r2.exit).toBe(0)
    await s.dispose()
  }, 20_000)
  it('job.interrupt(): ^C through the pty line discipline — framed exit 130, session survives (P8 unchanged)', async () => {
    const s = new PtySession({ key: 'k', argv: ['script', '-qfec', 'bash', '/dev/null'], id: 'pty-spec', connection: 'spec', ...OPTS })
    const r = await s.dispatch('echo begin; sleep 30', { commandId: 'spec-c', ...{ background: true } })
    for (let i = 0; i < 100 && !r.job!.read(0).text.includes('begin'); i++) await new Promise(res => setTimeout(res, 20)) // wait until the shell consumed the command — ^C before consumption flushes the unread tty line (input-queue race, not a supervision gap)
    r.job!.interrupt()
    const res = await r.job!.done
    expect(res.exit).toBe(130)
    const r2 = await s.dispatch('echo alive', { commandId: 'spec-c' })
    expect(r2.exit).toBe(0)
    await s.dispose()
  }, 20_000)
  it('interrupt kill fallback on a transport without interrupt (plain bash over pipes)', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    const r = await s.dispatch('trap "" INT; sleep 30', { commandId: 'spec-c', ...{ background: true } })
    r.job!.interrupt()
    const res = await r.job!.done
    expect(res.exit).toBe(null)
    expect(res.timedOut).toBe(true)
    expect(r.durationMs).toBeLessThan(10_000)
    await s.dispose()
  }, 20_000)
  it('forged static 133-D marker with wrong nonce never truncates the stream', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    const r = await s.dispatch(`printf '\\x1b]133;D;deadbeefdeadbeef;99;/pwn\\x07' ; echo real`, { commandId: 'spec-c' })
    expect(r.exit).toBe(0)
    expect(r.output.trim()).toBe('real')
    await s.dispose()
  })
  it('caps dispatch output collection (tail ring) — runaway output cannot eat host memory', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    const r = await s.dispatch("printf 'x%.0s' $(seq 1 5000000) ; echo ; echo TAILMARK", { commandId: 'spec-c' })
    expect(r.output.length).toBeLessThanOrEqual(4_000_001)
    expect(r.output.trim().endsWith('TAILMARK')).toBe(true)
    await s.dispose()
  }, 30_000)
  it('grace-expiry kill fallback reaps the process group (snapshot pid null, group gone)', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    await s.dispatch('echo warm', { commandId: 'spec-c' })
    const pid = s.snapshot.pid
    expect(pid).toBeTypeOf('number')
    const r = await s.dispatch('trap "" INT; sleep 30', { commandId: 'spec-c', ...{ background: true } })
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
    const s = new PtySession({ key: 'background-child', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    let child: number | undefined
    let group: number | null = null
    try {
      const result = await s.dispatch(`${command} </dev/null >/dev/null 2>&1 & printf %s "$!"`, { commandId: 'spec-c' })
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
    const s = new PtySession({ key: 'already-closed', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    await s.dispatch('echo ready', { commandId: 'spec-c' })
    await s.dispatch('exit 3', { commandId: 'spec-c' })
    const completion = await Promise.race([
      s.dispose().then(() => 'closed'),
      new Promise(resolve => setTimeout(() => resolve('hung'), 500)),
    ])
    expect(completion).toBe('closed')
  })
  it('dispose is terminal: stale-reference dispatch rejects E_SESSION_DISPOSED', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    await s.dispatch('echo hi', { commandId: 'spec-c' })
    await s.dispose()
    await expect(s.dispatch('echo late', { commandId: 'spec-c' })).rejects.toThrow(/E_SESSION_DISPOSED/)
  })
  it('dispose mid-flight settles the in-flight dispatch promptly (exit null, not timedOut)', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    const p = s.dispatch('sleep 30', { commandId: 'spec-c', ...{ timeoutSec: 30 } })
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
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    const started = Date.now()
    const r = await s.dispatch('sleep 0.5 ; echo done ; cd /tmp', { commandId: 'spec-c', ...{ background: true } })
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
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-spec', connection: 'spec', ...OPTS })
    const r = await s.dispatch('sleep 1 ; echo ok', { commandId: 'spec-c', ...{ background: true } })
    await expect(s.dispatch('echo nope', { commandId: 'spec-c' })).rejects.toThrow(/E_SESSION_BUSY/)
    const res = await r.job!.done
    expect(res.output).toContain('ok')
    const after = await s.dispatch('echo after', { commandId: 'spec-c' })
    expect(after.output.trim()).toBe('after')
    await s.dispose()
  }, 20_000)
  it('idle TTL never reaps a session whose command is still running (R1 dual condition)', async () => {
    const pool = new PtyPool({ idleTtlSec: 1 })
    const s = pool.create({ key: 't:x', argv: ['bash'], id: 'pty-pool', connection: 'spec' })
    const r = await s.dispatch('sleep 1.6 ; echo long', { commandId: 'spec-c', ...{ background: true } })
    await new Promise((res) => setTimeout(res, 1_400)) // past the idle TTL, job still running
    expect(s.sessionState).not.toBe('disposed')
    const res = await r.job!.done
    expect(res.output).toContain('long')
    await pool.disposeAll()
  }, 20_000)
})

describe('PTY workbench: identity, ledger, env delta (2026-10-19)', () => {
  it('identity exposes id/label/connection/byo from options', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-a1b2', connection: 'ssh:dev4', ...OPTS })
    expect(s.identity).toMatchObject({ id: 'pty-a1b2', connection: 'ssh:dev4', byo: false })
    const s2 = new PtySession({ key: 'k2', argv: ['bash'], id: 'pty-c3d4', label: 'build', connection: 'BYOP', byo: true, ...OPTS })
    expect(s2.identity).toMatchObject({ id: 'pty-c3d4', label: 'build', connection: 'BYOP', byo: true })
    await s.dispose(); await s2.dispose()
  })
  it('every dispatch carries its commandId; the ledger records summary/exit/duration, capped at 20', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-l1', connection: 'spec', ...OPTS })
    const r = await s.dispatch('echo one', { commandId: 'remote-aaa' })
    expect(r.commandId).toBe('remote-aaa')
    await s.dispatch('false', { commandId: 'remote-bbb' })
    const ledger = s.ledgerSnapshot()
    expect(ledger.map((e) => e.commandId)).toEqual(['remote-aaa', 'remote-bbb'])
    expect(ledger[0]).toMatchObject({ summary: 'echo one', exit: 0, running: false })
    expect(ledger[1]!.exit).toBe(1)
    expect(ledger[1]!.durationMs).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < 21; i++) await s.dispatch(`echo n${i}`, { commandId: `remote-x${i}` })
    const capped = s.ledgerSnapshot()
    expect(capped.length).toBe(20)
    expect(capped[0]!.commandId).toBe('remote-x1') // 2+21=23 条，丢最旧 3 条
    await s.dispose()
  })
  it('env delta reports NAMES only: added/changed/removed; values never render', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-e1', connection: 'spec', ...OPTS })
    const r1 = await s.dispatch('export DELTA_NEW=1', { commandId: 'remote-e1' })
    expect(r1.envDelta).toMatchObject({ added: ['DELTA_NEW'], changed: [], removed: [] })
    expect(JSON.stringify(r1.envDelta)).not.toContain('DELTA_NEW=1')
    const r2 = await s.dispatch('export DELTA_NEW=2', { commandId: 'remote-e2' })
    expect(r2.envDelta).toMatchObject({ added: [], changed: ['DELTA_NEW'], removed: [] })
    const r3 = await s.dispatch('unset DELTA_NEW', { commandId: 'remote-e3' })
    expect(r3.envDelta).toMatchObject({ added: [], changed: [], removed: ['DELTA_NEW'] })
    const plain = await s.dispatch('echo noenv', { commandId: 'remote-e4' })
    expect(plain.envDelta).toMatchObject({ added: [], changed: [], removed: [] })
    await s.dispose()
  })
  it('lastCwd tracks the newest frame cwd; attachJob backfills the registry id into the ledger entry', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-w1', connection: 'spec', ...OPTS })
    expect(s.lastCwd).toBe(null)
    await s.dispatch('cd /tmp', { commandId: 'remote-w1' })
    expect(s.lastCwd).toBe('/tmp')
    const r = await s.dispatch('sleep 0.3 ; echo bg', { commandId: 'remote-w2', background: true })
    expect(r.job!.commandId).toBe('remote-w2')
    s.attachJob('remote-w2', 'bash-999')
    await r.job!.done
    const entry = [...s.ledgerSnapshot()].reverse().find((e) => e.commandId === 'remote-w2')
    expect(entry?.jobId).toBe('bash-999')
    await s.dispose()
  })
  it('detachedCommandId names the foreground occupant while a background job runs', async () => {
    const s = new PtySession({ key: 'k', argv: ['bash'], id: 'pty-d1', connection: 'spec', ...OPTS })
    const r = await s.dispatch('sleep 0.6', { commandId: 'remote-d1', background: true })
    expect(s.detachedCommandId).toBe('remote-d1')
    await r.job!.done
    expect(s.detachedCommandId).toBe(null)
    await s.dispose()
  })
})
