import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtySession } from '../../src/remote/session.ts'
import { FakeChannel } from './fixtures/fake-channel.ts'

// OSC 133 / OSC 7 标记片段（BEL 终止；framing 栈同样接受 ST，此处用最常见形态）
const C = '\x1b]133;C\x07'
const D = (exitCode: number): string => `\x1b]133;D;${exitCode}\x07`
const OSC7 = (cwd: string): string => `\x1b]7;file://${cwd}\x07`

interface SessionOpts {
  timeoutMsDefault: number
  maxOutputChars: number
  graceMs?: number
}

const BASE_OPTS: SessionOpts = { timeoutMsDefault: 5000, maxOutputChars: 1000 }

/** 建会话并喂 boot 孤儿 D（首 prompt，cwd /start）。 */
async function bootSession(channel: FakeChannel, overrides: Partial<SessionOpts> = {}): Promise<PtySession> {
  const session = new PtySession(channel, { timeoutMsDefault: 5000, maxOutputChars: 1000, ...overrides })
  channel.feed(D(0) + OSC7('/start'))
  await session.ready()
  return session
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PtySession.ready (boot)', () => {
  it('resolves only on the first orphan D frame (initial prompt) and records its cwd', async () => {
    vi.useFakeTimers()
    const channel = new FakeChannel()
    const session = new PtySession(channel, BASE_OPTS)
    let resolved = false
    const ready = session.ready().then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(false) // 首个 D 未到，不 resolve
    channel.feed(D(0) + OSC7('/home/u'))
    await ready
    expect(resolved).toBe(true)
    expect(session.cwd()).toBe('/home/u')
    await session.ready() // 已 boot：幂等 resolve
  })

  it('rejects E_BOOT when no D frame arrives within timeoutMsDefault', async () => {
    vi.useFakeTimers()
    const channel = new FakeChannel()
    const session = new PtySession(channel, BASE_OPTS)
    const failure = session.ready().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5000)
    const error = await failure
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('[E_BOOT]')
    expect(channel.writes).toEqual([]) // boot 无命令可打断，不发 \x03
  })
})

describe('PtySession.run', () => {
  it('writes cmd + \\n and returns the C→D output stripAnsi’d, exitCode from D, cwd from OSC 7', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel)
    const pending = session.run('echo hello world')
    channel.feed(C + 'hello \x1b[31mworld\x1b[0m' + D(3) + OSC7('/next'))
    const result = await pending
    expect(channel.writes).toEqual(['echo hello world\n'])
    expect(result).toEqual({
      exitCode: 3,
      output: 'hello world',
      interrupted: false,
      durationMs: expect.any(Number),
    })
    expect(session.cwd()).toBe('/next')
    expect(session.snapshot()).toEqual({ cwd: '/next' })
  })

  it('assembles output and D arriving in separate chunks', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel)
    const pending = session.run('cat big')
    channel.feed(C + 'first half ')
    channel.feed('second half' + D(0) + OSC7('/w'))
    const result = await pending
    expect(result.output).toBe('first half second half')
    expect(result.exitCode).toBe(0)
    expect(result.interrupted).toBe(false)
  })

  it('decodes a multibyte character split across two data chunks (no U+FFFD)', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel)
    const pending = session.run('echo 你好')
    const bytes = Buffer.from('你好', 'utf8') // e4 bd a0 | e5 a5 bd
    // 断在 好 的首字节之后：逐 chunk toString 会把两半各自变成 U+FFFD
    channel.feedBytes(Buffer.concat([Buffer.from(C, 'utf8'), bytes.subarray(0, 4)]))
    channel.feedBytes(Buffer.concat([bytes.subarray(4), Buffer.from(D(0) + OSC7('/w'), 'utf8')]))
    const result = await pending
    expect(result.output).toBe('你好')
    expect(result.output).not.toContain('\uFFFD')
  })

  it('rejects a concurrent run with E_BUSY (queueing is the engine’s job)', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel)
    const first = session.run('long')
    await expect(session.run('other')).rejects.toThrow('[E_BUSY]')
    channel.feed(C + 'x' + D(0) + OSC7('/w'))
    await first
  })

  it('marks cwd unknown when a D frame carries no OSC 7 (never retains the old cwd)', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel)
    expect(session.cwd()).toBe('/start')
    const pending = session.run('maybe-cd')
    channel.feed(C + 'out' + D(2)) // D 悬置等 OSC 7
    channel.feed(C) // 下一个 C 冲刷悬置 D：无 cwd 键放行
    const result = await pending
    expect(result.exitCode).toBe(2)
    expect(session.cwd()).toBeUndefined() // 未知 ≠ 沿用 '/start'
  })

  it('rejects run() before ready() with E_BOOT', async () => {
    const channel = new FakeChannel()
    const session = new PtySession(channel, BASE_OPTS)
    await expect(session.run('x')).rejects.toThrow('[E_BOOT]')
    expect(channel.writes).toEqual([])
  })

  it('resolves exitCode null when the channel closes mid-run (outcome unknown)', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel)
    const pending = session.run('long')
    channel.feed(C + 'partial')
    channel.close(new Error('connection lost'))
    const result = await pending
    expect(result.exitCode).toBeNull()
    expect(result.output).toBe('partial')
    expect(result.interrupted).toBe(false)
    await expect(session.run('again')).rejects.toThrow('[E_CLOSED]')
  })
})

describe('PtySession watchdog (Ctrl-C + grace)', () => {
  it('writes \\x03 at timeoutMs and returns interrupted:true + exitCode when D lands within grace', async () => {
    vi.useFakeTimers()
    const channel = new FakeChannel()
    const session = await bootSession(channel, { graceMs: 500 })
    const pending = session.run('sleep 999', { timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(channel.writes).toContain('\x03')
    channel.feed(C + 'partial' + D(130) + OSC7('/w'))
    const result = await pending
    expect(result.interrupted).toBe(true)
    expect(result.exitCode).toBe(130)
    expect(result.output).toBe('partial')
  })

  it('does not send \\x03 before timeoutMs elapses', async () => {
    vi.useFakeTimers()
    const channel = new FakeChannel()
    const session = await bootSession(channel, { graceMs: 500 })
    const pending = session.run('sleep 999', { timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(999)
    expect(channel.writes).not.toContain('\x03')
    channel.feed(C + 'done' + D(0) + OSC7('/w'))
    const result = await pending
    expect(result.interrupted).toBe(false)
    expect(result.output).toBe('done')
  })

  it('throws E_WEDGED and ends the channel when no D arrives within grace', async () => {
    vi.useFakeTimers()
    const channel = new FakeChannel()
    const session = await bootSession(channel, { graceMs: 500 })
    // catch 先于 timer 推进挂上：拒绝发生在 advanceTimersByTimeAsync 的 tick 内，
    // 后挂 handler 会踩 Node unhandledRejection 窗口
    const settled = session.run('sleep 999', { timeoutMs: 1000 }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1000 + 500)
    const error = await settled
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('[E_WEDGED]')
    expect(channel.ended).toBe(true) // 调用方负责 reset 重建
    await expect(session.run('again')).rejects.toThrow('[E_CLOSED]')
  })
})

describe('PtySession abort signal', () => {
  it('takes the same Ctrl-C path when the signal aborts mid-run', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel)
    const ac = new AbortController()
    const pending = session.run('sleep 999', { signal: ac.signal, timeoutMs: 60_000 })
    ac.abort()
    expect(channel.writes).toContain('\x03')
    channel.feed(C + 'killed' + D(130) + OSC7('/w'))
    const result = await pending
    expect(result.interrupted).toBe(true)
    expect(result.exitCode).toBe(130)
  })

  it('rejects a pre-aborted signal without writing anything', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel)
    const ac = new AbortController()
    ac.abort()
    await expect(session.run('x', { signal: ac.signal })).rejects.toThrow('[E_ABORTED]')
    expect(channel.writes).toEqual([])
  })
})

describe('PtySession output cap', () => {
  it('keeps the tail window with a truncation marker over maxOutputChars', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel, { maxOutputChars: 10 })
    const pending = session.run('big')
    channel.feed(C + '0123456789ABCDEF' + D(0) + OSC7('/w'))
    const result = await pending
    expect(result.output).toBe('[truncated: showing last 10 of 16 chars]\n6789ABCDEF')
  })
})

describe('PtySession.dispose', () => {
  it('ends the channel and is idempotent', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel)
    await session.dispose()
    expect(channel.ended).toBe(true)
    await expect(session.dispose()).resolves.toBeUndefined()
  })

  it('rejects an in-flight run with E_CLOSED', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel)
    const failure = session.run('long').catch((error: unknown) => error)
    await session.dispose()
    const error = await failure
    expect((error as Error).message).toContain('[E_CLOSED]')
    expect(channel.ended).toBe(true)
  })
})
