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
  it('writes the cmd wrapped as one `{…}` compound + \\n and returns the C→D output stripAnsi’d, exitCode from D, cwd from OSC 7', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel)
    const pending = session.run('echo hello world')
    channel.feed(C + 'hello \x1b[31mworld\x1b[0m' + D(3) + OSC7('/next'))
    const result = await pending
    expect(channel.writes).toEqual(['{\necho hello world\n}\n'])
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

  // ── 多行命令 = 单复合帧（DEV2 复测 §4.1 HIGH 回归位）───────────────────────
  // 修复前：多行 cmd 原样写入 PTY，每个换行各是一轮 PS0(C)/PROMPT_COMMAND(D)，
  // run 在首个 D 提前 resolve（只见首行输出、exit 只反映首行），余下输出滞留
  // pending、前挂到下一次调用的结果上（DEV2 ①②：静默错帧），末行失败谎报
  // 成功（DEV2 ③：exit 0 假阳性）。
  describe('multi-line compound framing', () => {
    it('resolves a 3-line echo cmd as ONE RunResult carrying ALL lines (DEV2 ①/② no early-resolve split)', async () => {
      const channel = new FakeChannel()
      const session = await bootSession(channel)
      const pending = session.run('echo L1\necho L2\necho L3')
      // 真实 bash 行为（wrapPtyCommand 后）：整包复合命令一次读取 → 恰好一轮
      // C…D，D 带复合命令（= 最后一条命令）的退出码
      channel.feed(C + 'L1\r\nL2\r\nL3' + D(0) + OSC7('/w'))
      const result = await pending
      expect(result.exitCode).toBe(0)
      expect(result.output).toBe('L1\r\nL2\r\nL3')
      expect(result.interrupted).toBe(false)
    })

    it('carries the LAST line’s exit code — `echo ok\\nfalse` must not report success (DEV2 ③)', async () => {
      const channel = new FakeChannel()
      const session = await bootSession(channel)
      const pending = session.run('echo ok\nfalse')
      channel.feed(C + 'ok' + D(1) + OSC7('/w'))
      const result = await pending
      expect(result.exitCode).toBe(1) // 修复前：D 只等首行 → exit 0 假阳性
      expect(result.output).toBe('ok')
    })

    it('leaves NO residual output for the follow-up run (next result is not prepended with leftovers)', async () => {
      const channel = new FakeChannel()
      const session = await bootSession(channel)
      const first = session.run('echo L1\necho L2')
      channel.feed(C + 'L1\r\nL2' + D(0) + OSC7('/w'))
      await first
      // 修复前症状 ②：后续 D 轮次的输出滞留 pending，前挂到下一次调用的 output
      const second = session.run('echo MARKER')
      channel.feed(C + 'MARKER' + D(0) + OSC7('/w'))
      const result = await second
      expect(result.output).toBe('MARKER') // 纯净 — 无 'L2' 残前缀
      expect(result.exitCode).toBe(0)
    })
  })

  // ── stdin = 复合命令后的裸写（DEV2 修复后续裁：不再在 tool 层拼进 cmd）─────
  // 复合命令先占住整条输入缓冲，stdin 原样跟写——由复合命令启动的进程（REPL 式）
  // 从 PTY 缓冲读到这些行。
  describe('stdin raw write', () => {
    it('writes the compound first, then stdin verbatim — `head -1` consumes the line, ONE frame, exit 0', async () => {
      const channel = new FakeChannel()
      const session = await bootSession(channel)
      const pending = session.run('head -1', { stdin: 'hello\n' })
      expect(channel.writes).toEqual(['{\nhead -1\n}\n', 'hello\n']) // 裸写：无帧、无包装
      // head -1 从 PTY 读到该行、打印、退出 → 恰好一轮 C…D
      channel.feed(C + 'hello' + D(0) + OSC7('/w'))
      const result = await pending
      expect(result.output).toBe('hello')
      expect(result.exitCode).toBe(0)
    })

    it('appends a newline only when stdin lacks one (last line must arrive as a line)', async () => {
      const channel = new FakeChannel()
      const session = await bootSession(channel)
      const pending = session.run('head -1', { stdin: 'hello' })
      expect(channel.writes).toEqual(['{\nhead -1\n}\n', 'hello\n'])
      channel.feed(C + 'hello' + D(0) + OSC7('/w'))
      const result = await pending
      expect(result.output).toBe('hello')
    })

    it('no stdin opt → no follow-up write (plain-call wire shape unchanged)', async () => {
      const channel = new FakeChannel()
      const session = await bootSession(channel)
      const pending = session.run('true')
      expect(channel.writes).toEqual(['{\ntrue\n}\n'])
      channel.feed(C + D(0) + OSC7('/w'))
      const result = await pending
      expect(result.output).toBe('')
    })
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

  it('bounds runaway C→D output: 3 MiB still resolves with the TRUE-total marker (parser discard-head)', async () => {
    const channel = new FakeChannel()
    const session = await bootSession(channel, { maxOutputChars: 1000 })
    const pending = session.run('cat big.log')
    const mib = 'x'.repeat(1024 * 1024)
    channel.feed(C + mib)
    channel.feed(mib)
    channel.feed(mib + D(0) + OSC7('/w')) // 3 MiB 输出（> 2 MiB 缓冲界）
    const result = await pending
    // 标记报真实总量 3 MiB，不是 2 MiB 缓冲尾窗或 1000 帽的长度
    expect(result.output.startsWith('[truncated: showing last 1000 of 3145728 chars]\n')).toBe(true)
    expect(result.output.length).toBeLessThan(2_000)
    expect(result.truncated).toBe(3_145_728)
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
