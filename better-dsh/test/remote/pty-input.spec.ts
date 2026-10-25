import { describe, expect, it, vi } from 'vitest'
import { PtySession } from '../../src/remote/pty-session.ts'

/** 真实终端夹具（计划 Task 1）：script(1) 承载的 pty bash，不用管道 bash 冒充终端。 */
const PTY_ARGV = ['script', '-qfec', 'bash --noprofile --norc -i', '/dev/null']
const OPTS = { idleTtlSec: 600 }

const wait = (ms: number): Promise<'tick'> => new Promise((resolve) => setTimeout(() => resolve('tick'), ms))

/** 两道提示的登录形夹具：Password: → OTP: → ACCEPTED；read -s 禁回显，凭据不进输出。 */
const TWO_PROMPTS = `printf 'Password:'; IFS= read -s -r pw; printf '\\nOTP:'; IFS= read -s -r otp; [ "$pw" = demo ] && [ "$otp" = 123456 ] && printf '\\nACCEPTED\\n'`

describe('PtySession.input (interactive stdin, 2026-10-25)', () => {
  it('answers two prompts inside one command and retains the shell', async () => {
    const session = new PtySession({ key: 'input-owner|p:input-test', id: 'input-test', connection: 'fixture', argv: PTY_ARGV, ...OPTS })
    try {
      const commandId = 'input-command'
      const started = await session.dispatch(TWO_PROMPTS, { commandId, background: true })
      expect(started.running).toBe(true)
      const job = started.job!
      await vi.waitFor(() => expect(job.read(0).text).toContain('Password:'))
      await expect(session.dispatch('echo must-not-run', { commandId: 'other' })).rejects.toThrow('E_SESSION_BUSY')
      await session.input({ commandId, stdin: 'demo\n' })
      await vi.waitFor(() => expect(job.read(0).text).toContain('OTP:'))
      await session.input({ commandId, stdin: '123456\n' })
      const result = await job.done
      expect(result.exit).toBe(0)
      expect(result.output).toContain('ACCEPTED')
      expect(result.output).not.toContain('demo')
      expect(result.output).not.toContain('123456')
      expect(session.ledgerSnapshot()).toHaveLength(1) // input 新建零账本条目
      const next = await session.dispatch('pwd', { commandId: 'next' })
      expect(next.exit).toBe(0)
      expect(next.reconnected).toBe(false)
    } finally {
      await session.dispose()
    }
  }, 15_000)

  it('a second cmd is rejected busy while the first is still in its synchronous window (no FIFO queueing); input does not wait for command end', async () => {
    const s = new PtySession({ key: 'k|p:busy-sync', id: 'busy-sync', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    try {
      const first = s.dispatch(`printf 'P:'; IFS= read -s -r v; sleep 1; printf 'GOT:%s' "$v"`, { commandId: 'c-sync', timeoutSec: 30 })
      await expect(s.dispatch('echo nope', { commandId: 'c-nope' })).rejects.toThrow('E_SESSION_BUSY') // busy from the synchronous placeholder, even while still initializing
      await vi.waitFor(() => expect(s.snapshot.state).toBe('ready')) // init done → the first command is now the running command; input before this point is honestly E_SESSION_NOT_READY
      const t0 = Date.now()
      await s.input({ commandId: 'c-sync', stdin: 'val\n' })
      expect(Date.now() - t0).toBeLessThan(600) // input 立即回执，不等命令结束
      const r = await first
      expect(r.exit).toBe(0)
      expect(r.output).toContain('GOT:val')
      const after = await s.dispatch('echo after', { commandId: 'c-after' })
      expect(after.output.trim()).toBe('after')
    } finally {
      await s.dispose()
    }
  }, 15_000)

  it('feeds a detached job with multiple ordered inputs; whole stdin segments never interleave', async () => {
    const s = new PtySession({ key: 'k|p:order', id: 'order', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    try {
      const r = await s.dispatch(`for i in 1 2 3; do IFS= read -s -r line; printf '[%s]' "$line"; done; echo`, { commandId: 'c-detach', background: true })
      await s.input({ stdin: 'one\n' })
      await s.input({ stdin: 'two\n' })
      await s.input({ stdin: 'three\n' })
      const res = await r.job!.done
      expect(res.exit).toBe(0)
      expect(res.output).toContain('[one][two][three]')
    } finally {
      await s.dispose()
    }
  }, 15_000)

  it('receipt carries session/commandId/jobId (registry id via dispatch) and writtenBytes; no ledger growth', async () => {
    const s = new PtySession({ key: 'k|p:receipt', id: 'receipt', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    try {
      const r = await s.dispatch(`IFS= read -s -r v; printf 'OK:%s' "$v"`, { commandId: 'remote-receipt', background: true, jobId: 'remote-receipt' })
      const receipt = await s.input({ stdin: 'go\n' })
      expect(receipt).toMatchObject({ session: 'pty:receipt', commandId: 'remote-receipt', jobId: 'remote-receipt', writtenBytes: 3 })
      const res = await r.job!.done
      expect(res.output).toContain('OK:go')
      expect(s.ledgerSnapshot()).toHaveLength(1)
    } finally {
      await s.dispose()
    }
  }, 15_000)

  it('attachJob backfills the adopted registry id onto later input receipts', async () => {
    const s = new PtySession({ key: 'k|p:adopt', id: 'adopt', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    try {
      const r = await s.dispatch(`printf 'P:'; IFS= read -s -r v; printf 'OK:%s' "$v"`, { commandId: 'c-adopt', background: true })
      s.attachJob('c-adopt', 'registry-99')
      const receipt = await s.input({ stdin: 'x\n' })
      expect(receipt.jobId).toBe('registry-99')
      const res = await r.job!.done
      expect(res.output).toContain('OK:x')
    } finally {
      await s.dispose()
    }
  }, 15_000)
})

describe('PtySession.input failure rules (§3.2)', () => {
  it('idle session: E_SESSION_NOT_RUNNING, also for stdin "" — input is never an implicit shell command', async () => {
    const s = new PtySession({ key: 'k|p:idle', id: 'idle', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    try {
      await s.warm()
      await expect(s.input({ stdin: 'x\n' })).rejects.toThrow('E_SESSION_NOT_RUNNING')
      await expect(s.input({ stdin: '' })).rejects.toThrow('E_SESSION_NOT_RUNNING')
    } finally {
      await s.dispose()
    }
  })

  it('dead session: rejected without reconnect or replay; state stays dead', async () => {
    const s = new PtySession({ key: 'k|p:dead', id: 'dead', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    try {
      const r = await s.dispatch('kill -9 $$', { commandId: 'c-die' })
      expect(r.exit).toBe(null)
      expect(s.sessionState).toBe('dead')
      await expect(s.input({ commandId: 'c-die', stdin: 'x\n' })).rejects.toThrow(/E_SESSION_NOT_RUNNING/)
      expect(s.sessionState).toBe('dead')
    } finally {
      await s.dispose()
    }
  }, 15_000)

  it('disposed session: E_SESSION_DISPOSED', async () => {
    const s = new PtySession({ key: 'k|p:gone', id: 'gone', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    await s.dispatch('echo hi', { commandId: 'c-hi' })
    await s.dispose()
    await expect(s.input({ stdin: 'x\n' })).rejects.toThrow('E_SESSION_DISPOSED')
  }, 15_000)

  it('commandId mismatch refuses the write; the matching id proceeds', async () => {
    const s = new PtySession({ key: 'k|p:mism', id: 'mism', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    try {
      const r = await s.dispatch(`IFS= read -s -r v; printf 'OK:%s' "$v"`, { commandId: 'c-cur', background: true })
      await expect(s.input({ commandId: 'c-old', stdin: 'x\n' })).rejects.toThrow('E_COMMAND_MISMATCH')
      await s.input({ commandId: 'c-cur', stdin: 'yes\n' })
      const res = await r.job!.done
      expect(res.output).toContain('OK:yes')
    } finally {
      await s.dispose()
    }
  }, 15_000)

  it('stdin "" on a running command is an explicit zero-byte write, not EOF and not a new poll entry', async () => {
    const s = new PtySession({ key: 'k|p:empty', id: 'empty', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    try {
      const r = await s.dispatch(`IFS= read -s -r v; printf 'OK:%s' "$v"`, { commandId: 'c-empty', background: true })
      const receipt = await s.input({ commandId: 'c-empty', stdin: '' })
      expect(receipt.writtenBytes).toBe(0)
      const state = await Promise.race([r.job!.done.then(() => 'done' as const), wait(400)])
      expect(state).toBe('tick') // zero bytes delivered: command still waiting for its line
      await s.input({ commandId: 'c-empty', stdin: 'go\n' })
      const res = await r.job!.done
      expect(res.output).toContain('OK:go')
    } finally {
      await s.dispose()
    }
  }, 15_000)

  it('write failures surface as errors instead of silent success', async () => {
    const s = new PtySession({ key: 'k|p:wfail', id: 'wfail', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    const r = await s.dispatch('sleep 5', { commandId: 'c-wfail', background: true })
    const proc = (s as unknown as { proc: { stdin: unknown } | null }).proc
    Object.defineProperty(proc, 'stdin', { value: { writable: false, destroy() {}, end() {} }, configurable: true }) // destroy/end: Node's child-exit path calls them on the stub
    await expect(s.input({ stdin: 'x\n' })).rejects.toThrow('E_SESSION_WRITE_FAILED')
    await s.dispose()
    await r.job!.done // dispose settles the running command (death path), no orphan promise
  }, 15_000)
})

describe('PtySession.input over a real terminal: EOF and control bytes (§3.4)', () => {
  it('Ctrl+D ends a ready cat; the shell stays usable afterwards', async () => {
    const s = new PtySession({ key: 'k|p:cat', id: 'cat', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    try {
      const r = await s.dispatch('echo begin; cat; echo after', { commandId: 'c-cat', background: true })
      const job = r.job!
      await vi.waitFor(() => expect(job.read(0).text).toContain('begin'))
      await s.input({ commandId: 'c-cat', stdin: 'hello\n' })
      await s.input({ commandId: 'c-cat', stdin: '\u0004' }) // empty line buffer → immediate EOF for cat
      const res = await job.done
      expect(res.exit).toBe(0)
      expect(res.output).toContain('after')
      const next = await s.dispatch('echo alive', { commandId: 'c-next' })
      expect(next.exit).toBe(0)
    } finally {
      await s.dispose()
    }
  }, 15_000)

  it('Ctrl+D without a trailing newline needs the documented two steps (deliver the line, then EOF)', async () => {
    const s = new PtySession({ key: 'k|p:cat2', id: 'cat2', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    try {
      const r = await s.dispatch('echo begin; cat; echo after', { commandId: 'c-cat2', background: true })
      const job = r.job!
      await vi.waitFor(() => expect(job.read(0).text).toContain('begin'))
      await s.input({ commandId: 'c-cat2', stdin: 'abc' }) // no newline
      await s.input({ commandId: 'c-cat2', stdin: '\u0004' }) // delivers 'abc' without EOF — cat keeps running
      const state = await Promise.race([job.done.then(() => 'done' as const), wait(500)])
      expect(state).toBe('tick')
      await s.input({ commandId: 'c-cat2', stdin: '\u0004' }) // buffer now empty → real EOF
      const res = await job.done
      expect(res.exit).toBe(0)
      expect(res.output).toContain('after')
    } finally {
      await s.dispose()
    }
  }, 15_000)

  it('passes the literal characters backslash-x-0-4 through without decoding them', async () => {
    const s = new PtySession({ key: 'k|p:literal', id: 'literal', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    try {
      const r = await s.dispatch(`IFS= read -s -r v; printf '[%s]' "$v"`, { commandId: 'c-lit', background: true })
      await s.input({ stdin: '\\x04\n' })
      const res = await r.job!.done
      expect(res.exit).toBe(0)
      expect(res.output).toContain('[\\x04]') // four literal characters, not the 0x04 byte
    } finally {
      await s.dispose()
    }
  }, 15_000)

  it('delivers actual 0x03/0x04 bytes when tty special processing is off (stty raw)', async () => {
    const s = new PtySession({ key: 'k|p:raw', id: 'raw', connection: 'spec', argv: PTY_ARGV, ...OPTS })
    try {
      const r = await s.dispatch(`stty raw -echo; printf RDY; head -c 2 | od -An -tx1; stty sane`, { commandId: 'c-raw', background: true })
      const job = r.job!
      await vi.waitFor(() => expect(job.read(0).text).toContain('RDY'))
      await s.input({ commandId: 'c-raw', stdin: '\u0003\u0004' })
      const res = await job.done
      expect(res.exit).toBe(0)
      expect(res.output).toContain('03')
      expect(res.output).toContain('04')
    } finally {
      await s.dispose()
    }
  }, 15_000)
})
