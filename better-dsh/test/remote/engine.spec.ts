/**
 * RemoteEngine 单测（plan docs/10_plans/2026-09-22-dashr-remote-tool-rm0.md Task 8，
 * brief Step 1）。fake backend 记录调用、脚本化 exec/openShellSession 行为；PTY 会话
 * 用 `ScriptedSession extends PtySession`（覆写 run/snapshot，保留类型契约），通道细节
 * 由 fixtures/fake-channel 承担。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteEngine, type EngineOptions } from '../../src/remote/engine.ts'
import type { ConnState, ExecOutcome, SshBackend } from '../../src/remote/backend.ts'
import type { RemoteTargetSpec } from '../../src/remote/registry.ts'
import type { HostKeyStore } from '../../src/remote/hostkeys.ts'
import { PtySession, type RunResult } from '../../src/remote/session.ts'
import { shellQuote } from '../../src/remote/framing.ts'
import { buildProbeCommand } from '../../src/remote/preparation.ts'
import { FakeChannel } from './fixtures/fake-channel.ts'

/** `[CODE] message` 形态 + `.code` 裸码（对齐 RemoteError 形态）。 */
function coded(code: string, message: string): Error & { code: string } {
  const error = new Error(`[${code}] ${message}`) as Error & { code: string }
  error.code = code
  return error
}

/** ScriptedSession.run 的单步脚本。 */
type SessionStep =
  | { kind: 'result'; result?: Partial<RunResult>; cwd?: string }
  | { kind: 'error'; error: Error }
  | { kind: 'dead'; output?: string } // 通道半路死掉 → exitCode null 的部分结果

const DEFAULT_RUN: RunResult = { exitCode: 0, output: '', interrupted: false, durationMs: 3 }

class ScriptedSession extends PtySession {
  /** 本会话的 enter/exit 序（trace 是跨会话共享的全局序）。 */
  readonly log: string[] = []
  readonly seenRuns: Array<{ cmd: string; timeoutMs?: number; signal?: AbortSignal }> = []
  cwdFake: string | undefined = undefined
  private readonly trace: string[]
  private readonly steps: SessionStep[]

  constructor(trace: string[], steps: SessionStep[]) {
    super(new FakeChannel(), { timeoutMsDefault: 30_000, maxOutputChars: 100_000 })
    this.trace = trace
    this.steps = steps // 共享数组、全局消费：脚本跨会话续接（重建的会话不会重放旧步）
  }

  override async run(cmd: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    this.log.push(`enter:${cmd}`)
    this.trace.push(`enter:${cmd}`)
    this.seenRuns.push({ cmd, timeoutMs: opts.timeoutMs, signal: opts.signal })
    const step: SessionStep = this.steps.shift() ?? { kind: 'result' }
    let out: RunResult
    if (step.kind === 'error') {
      out = DEFAULT_RUN
    } else if (step.kind === 'dead') {
      out = { ...DEFAULT_RUN, exitCode: null, output: step.output ?? '' }
    } else {
      out = { ...DEFAULT_RUN, ...step.result }
      if (step.cwd !== undefined) this.cwdFake = step.cwd
    }
    this.log.push(`exit:${cmd}`)
    this.trace.push(`exit:${cmd}`)
    if (step.kind === 'error') throw step.error
    return out
  }

  override snapshot(): { cwd?: string } {
    return { cwd: this.cwdFake }
  }
}

class FakeBackend implements SshBackend {
  readonly targetName: string
  state: ConnState = 'idle'
  readonly execCalls: Array<{ cmd: string; cwd: string; timeoutMs: number; signal?: AbortSignal }> = []
  readonly restored: string[] = []
  readonly sessions: ScriptedSession[] = []
  closeCount = 0
  openCount = 0
  openError: Error | undefined
  execError: Error | undefined
  restoreError: Error | undefined
  execResult: Partial<ExecOutcome> = { exitCode: 0, output: '', durationMs: 5 }

  constructor(name: string, private readonly trace: string[], private readonly steps: SessionStep[]) {
    this.targetName = name
  }

  connState(): ConnState {
    return this.state
  }

  async exec(cmd: string, opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<ExecOutcome> {
    this.execCalls.push({ cmd, cwd: opts.cwd, timeoutMs: opts.timeoutMs, signal: opts.signal })
    this.state = 'ready'
    if (this.execError !== undefined) throw this.execError
    return { exitCode: 0, output: '', durationMs: 5, ...this.execResult }
  }

  async openShellSession(): Promise<PtySession> {
    this.openCount++
    this.state = 'ready'
    if (this.openError !== undefined) throw this.openError
    const session = new ScriptedSession(this.trace, this.steps)
    this.sessions.push(session)
    return session
  }

  async probe(): Promise<{ rttMs: number }> {
    this.state = 'ready'
    return { rttMs: 1 }
  }

  async snapshotRestore(cwd: string): Promise<void> {
    this.restored.push(cwd)
    if (this.restoreError !== undefined) throw this.restoreError
  }

  async close(): Promise<void> {
    this.closeCount++
    this.state = 'closed'
  }
}

class FakeFactory {
  readonly created: FakeBackend[] = []
  private readonly pending: FakeBackend[] = []
  readonly trace: string[] = []
  readonly steps: SessionStep[] = []

  seed(backend: FakeBackend): void {
    this.pending.push(backend)
  }

  make = (target: RemoteTargetSpec): SshBackend => {
    const backend = this.pending.shift() ?? new FakeBackend(target.name, this.trace, this.steps)
    this.created.push(backend)
    return backend
  }
}

const hostKeyStore: HostKeyStore = { get: () => undefined, set: () => {} }

type AuditRow = Parameters<NonNullable<EngineOptions['onAudit']>>[0]

const engines: RemoteEngine[] = []

function makeRegistry(names: string[]): Map<string, RemoteTargetSpec> {
  const map = new Map<string, RemoteTargetSpec>()
  for (const name of names) {
    map.set(name, { name, backend: 'ssh', host: `${name}.test`, port: 22 })
  }
  return map
}

function rig(opts: Partial<EngineOptions> = {}, names: string[] = ['t1', 't2']): {
  engine: RemoteEngine
  factory: FakeFactory
  audits: AuditRow[]
} {
  const audits: AuditRow[] = []
  const factory = new FakeFactory()
  const engine = new RemoteEngine({
    registry: makeRegistry(names),
    hostKeyStore,
    backendFactory: factory.make,
    onAudit: (event) => {
      audits.push(event)
    },
    ...opts,
  })
  engines.push(engine)
  return { engine, factory, audits }
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()))
  vi.useRealTimers()
})

describe('RemoteEngine.exec — 队列 / 会话 / 审计', () => {
  it('首次 exec 建 PTY 会话并 run；同 target 并发 3 个串行；审计每命令一条', async () => {
    const { engine, factory, audits } = rig()
    const results = await Promise.all([engine.exec('t1', 'a'), engine.exec('t1', 'b'), engine.exec('t1', 'c')])

    expect(results).toHaveLength(3)
    expect(results.every((r) => r.exitCode === 0)).toBe(true)
    expect(factory.created).toHaveLength(1) // 单连接池化
    const backend = factory.created[0]!
    expect(backend.openCount).toBe(1) // 单会话复用
    expect(factory.trace).toEqual(['enter:a', 'exit:a', 'enter:b', 'exit:b', 'enter:c', 'exit:c']) // 严格串行，无交错
    expect(audits).toEqual([
      { target: 't1', cmd: 'a', cwd: undefined, exit: 0, durationMs: 3 },
      { target: 't1', cmd: 'b', cwd: undefined, exit: 0, durationMs: 3 },
      { target: 't1', cmd: 'c', cwd: undefined, exit: 0, durationMs: 3 },
    ])
  })

  it('openShellSession throw E_EXEC_FALLBACK → 永久降级 degraded backend.exec（含当前调用）', async () => {
    const { engine, factory } = rig()
    const backend = new FakeBackend('t1', factory.trace, [])
    backend.openError = coded('E_EXEC_FALLBACK', 'remote bash too old for OSC 133 session')
    factory.seed(backend)

    const first = await engine.exec('t1', 'x')
    expect(first.exitCode).toBe(0) // 当前调用即降级执行
    expect(backend.openCount).toBe(1)
    expect(backend.execCalls.map((c) => c.cmd)).toEqual(['x'])
    expect(backend.execCalls[0]!.timeoutMs).toBe(120_000) // 默认 execTimeoutSec=120

    await engine.exec('t1', 'y', { timeoutMs: 5_000 })
    expect(backend.openCount).toBe(1) // 绝不重试建会话
    expect(backend.execCalls.map((c) => c.cmd)).toEqual(['x', 'y'])
    expect(backend.execCalls[1]!.timeoutMs).toBe(5_000)

    const doc = await engine.status('t1')
    expect(doc).toContain('exec (degraded)') // session.mode = exec
    expect(engine.summary()[0]).not.toHaveProperty('session') // summary 行保持 verbatim 形状
  })

  it('E_CONNECT 不毒化：错误上抛、target 标 closed；下次 exec 重新 factory（计数 2）', async () => {
    const { engine, factory } = rig()
    const bad = new FakeBackend('t1', factory.trace, [])
    bad.openError = coded('E_CONNECT', 'ssh: connection refused')
    factory.seed(bad)

    await expect(engine.exec('t1', 'x')).rejects.toMatchObject({ code: 'E_CONNECT' })
    expect(factory.created).toHaveLength(1)
    expect(bad.closeCount).toBe(1) // 失败连接被关闭
    expect(engine.summary()[0]!.alive).toBe(false)

    const good = new FakeBackend('t1', factory.trace, [])
    factory.seed(good)
    const outcome = await engine.exec('t1', 'y')
    expect(outcome.exitCode).toBe(0)
    expect(factory.created).toHaveLength(2) // 重新 factory
    expect(good.openCount).toBe(1)
    expect(good.sessions[0]!.log).toEqual(['enter:y', 'exit:y'])
  })

  it('通道半路死（exitCode null）→ 当前调用交部分结果，下次 exec 重建会话（backend 不动）', async () => {
    const { engine, factory } = rig()
    const backend = new FakeBackend('t1', factory.trace, [
      { kind: 'result', cwd: '/proj' },
      { kind: 'dead', output: 'partial' },
      { kind: 'result', cwd: '/proj' },
    ])
    factory.seed(backend)

    await engine.exec('t1', 'pre')
    const dead = await engine.exec('t1', 'a')
    expect(dead.exitCode).toBeNull() // 部分结果如实上交
    expect(dead.output).toBe('partial')
    expect(backend.openCount).toBe(1)

    await engine.exec('t1', 'b')
    expect(backend.openCount).toBe(2) // 会话重建
    expect(backend.restored).toEqual([]) // backend 存活：不重放 snapshotRestore
    // 新会话先用内部 cd 回放上次已知 cwd，再跑用户命令
    const cd = `cd -- ${shellQuote('/proj')}`
    expect(backend.sessions[1]!.log).toEqual([`enter:${cd}`, `exit:${cd}`, 'enter:b', 'exit:b'])
  })

  it('E_WEDGED → 当前调用报错；下次 exec 重建会话', async () => {
    const { engine, factory, audits } = rig()
    const backend = new FakeBackend('t1', factory.trace, [
      { kind: 'error', error: coded('E_WEDGED', 'no D after Ctrl-C — shell is wedged') },
    ])
    factory.seed(backend)

    await expect(engine.exec('t1', 'a')).rejects.toThrow('E_WEDGED')
    expect(backend.openCount).toBe(1)

    const outcome = await engine.exec('t1', 'b')
    expect(outcome.exitCode).toBe(0)
    expect(backend.openCount).toBe(2)
    expect(audits.map((a) => a.cmd)).toEqual(['b']) // 报错的命令不产生审计
  })
})

describe('RemoteEngine — 空闲回收与 cwd 快照回放', () => {
  it("fake timer 推进 idleTtlSec → backend.close 被调；再 exec → 重建 + snapshotRestore(上次 cwd) + 内部 cd", async () => {
    vi.useFakeTimers()
    const { engine, factory, audits } = rig({ idleTtlSec: 2 })
    factory.seed(new FakeBackend('t1', factory.trace, [{ kind: 'result', cwd: '/proj' }]))
    await engine.exec('t1', 'a')
    expect(engine.summary()[0]!.alive).toBe(true)
    expect(audits[0]).toMatchObject({ cmd: 'a', cwd: '/proj', exit: 0 })

    await vi.advanceTimersByTimeAsync(2_000)
    const first = factory.created[0]!
    expect(first.closeCount).toBe(1) // 空闲回收
    expect(engine.summary()[0]!.alive).toBe(false)

    const second = new FakeBackend('t1', factory.trace, [{ kind: 'result', cwd: '/proj' }])
    factory.seed(second)
    await engine.exec('t1', 'b')
    expect(factory.created).toHaveLength(2)
    expect(second.restored).toEqual(['/proj']) // 断线前快照回放给新 backend
    const cd = `cd -- ${shellQuote('/proj')}`
    expect(second.sessions[0]!.log).toEqual([
      `enter:${cd}`, // 新会话定位到回放 cwd
      `exit:${cd}`,
      'enter:b',
      'exit:b',
    ])
    expect(audits.map((a) => a.cmd)).toEqual(['a', 'b']) // 内部 cd 不进审计
  })

  it('snapshotRestore throw E_CWD_GONE → exec 报错含 cwd 原文；下次 exec 从 defaultCwd 重来', async () => {
    vi.useFakeTimers()
    const { engine, factory, audits } = rig()
    factory.seed(new FakeBackend('t1', factory.trace, [{ kind: 'result', cwd: '/gone' }]))
    await engine.exec('t1', 'a')
    await vi.advanceTimersByTimeAsync(300_000) // 默认 idleTtlSec=300 触发回收

    const second = new FakeBackend('t1', factory.trace, [])
    second.restoreError = coded('E_CWD_GONE', 'working directory no longer exists: /gone')
    factory.seed(second)
    await expect(engine.exec('t1', 'b')).rejects.toThrow('/gone') // 大声报错，绝不静默回落 HOME
    expect(second.openCount).toBe(0) // 回放失败先于建会话
    expect(second.closeCount).toBe(0) // backend 本身是新鲜的：不丢弃

    await engine.exec('t1', 'c') // 快照失效已清：不再回放、不再内部 cd
    expect(second.restored).toEqual(['/gone'])
    expect(second.sessions[0]!.log).toEqual(['enter:c', 'exit:c'])
    expect(audits.map((a) => a.cmd)).toEqual(['a', 'c']) // 'b' 报错无审计
  })
})

describe('RemoteEngine.bind — LRU 绑定', () => {
  it('bind 回读；未知名 throw E_UNKNOWN_TARGET 列全部名字；>64 逐最旧（LRU 触碰续命）', () => {
    const { engine } = rig({}, ['t1', 't2', 't3'])
    engine.bind('s1', 't1')
    expect(engine.boundTarget('s1')).toBe('t1')
    expect(engine.boundTarget('sX')).toBeUndefined()

    try {
      engine.bind('sX', 'nope')
      expect.unreachable('bind unknown target must throw')
    } catch (error) {
      expect((error as Error & { code: string }).code).toBe('E_UNKNOWN_TARGET')
      expect((error as Error).message).toContain('t1, t2, t3')
    }

    for (let i = 1; i <= 64; i++) engine.bind(`k${i}`, 't1')
    engine.bind('k65', 't2')
    expect(engine.boundTarget('k1')).toBeUndefined() // 最旧被逐
    expect(engine.boundTarget('k65')).toBe('t2')
    expect(engine.boundTarget('k2')).toBe('t1') // 触碰 = 续命

    engine.bind('k66', 't3')
    expect(engine.boundTarget('k3')).toBeUndefined() // 被逐的是未触碰的 k3，不是 k2
    expect(engine.boundTarget('k2')).toBe('t1')
  })
})

describe('RemoteEngine.status — Ruling 2（RM0 修订）：一次调用拿全块，永不建会话', () => {
  const PROBE_OUT = ['user=root', 'host=h1', 'sudo=nopasswd', 'bash=5.1.0', 'path-node=/usr/bin/node', 'ver-node=v20.3.1', ''].join('\n')

  it('冷 target 懒拨号（factory 建连接、绝不开会话）并渲染 tools/sudo/rtt 全块', async () => {
    let clock = 1_000
    const { engine, factory } = rig({ now: () => clock })
    const backend = new FakeBackend('t1', factory.trace, [{ kind: 'result', cwd: '/proj' }])
    backend.execResult = { exitCode: 0, durationMs: 7, output: PROBE_OUT }
    factory.seed(backend)

    const cold = await engine.status('t1')
    expect(factory.created).toHaveLength(1) // 冷 status 也拨号（lazy factory）
    expect(backend.openCount).toBe(0) // 但绝不建 PTY 会话
    expect(backend.execCalls[0]!.cmd).toBe(buildProbeCommand())
    expect(backend.execCalls[0]!.timeoutMs).toBe(10_000) // 独立 probe 超时
    expect(cold).toContain('rtt 7ms')
    expect(cold).toContain('NOPASSWD ✓')
    expect(cold).toContain('v20.3.1')
    expect(engine.summary()[0]!.alive).toBe(true) // 拨号即活动：池化连接生效

    await engine.exec('t1', 'a')
    clock = 66_000
    const doc = await engine.status('t1')
    expect(backend.openCount).toBe(1) // probe 依旧不建会话
    expect(doc).toContain('alive 1m5s') // connSince=1000 → 存活 65s
    expect(doc).toContain('rtt 7ms')
    expect(doc).toContain('session : pty · cwd /proj')
  })

  it('拨号/探测失败 → error 行替代事实行，status resolve 不 throw；连接层码丢弃 backend（与 exec 同规）', async () => {
    const { engine, factory } = rig()
    const bad = new FakeBackend('t1', factory.trace, [])
    bad.execError = coded('E_AUTH', 'permission denied (publickey)')
    factory.seed(bad)

    const doc = await engine.status('t1')
    expect(doc).toContain('error :')
    expect(doc).toContain('E_AUTH')
    expect(doc).not.toContain('tools')
    expect(doc).not.toContain('sudo')
    expect(bad.closeCount).toBe(1) // 连接层码 → 掉线重连路径（下次重 factory）
    expect(engine.summary()[0]!.alive).toBe(false)
  })
})

describe('RemoteEngine — 杂项契约', () => {
  it('maxOutputChars 尾窗截断（带标记）', async () => {
    const { engine, factory } = rig({ maxOutputChars: 10 })
    factory.seed(new FakeBackend('t1', factory.trace, [{ kind: 'result', result: { output: 'x'.repeat(50) } }]))
    const outcome = await engine.exec('t1', 'a')
    expect(outcome.output).toBe(`[truncated: showing last 10 of 50 chars]\n${'x'.repeat(10)}`)
  })

  it('未知名（exec/status 同为 rejection，bind 同步 throw）→ E_UNKNOWN_TARGET 列全部名字', async () => {
    const { engine } = rig({}, ['t1', 't2'])
    await expect(engine.exec('nope', 'x')).rejects.toMatchObject({ code: 'E_UNKNOWN_TARGET' })
    await expect(engine.status('nope')).rejects.toMatchObject({ code: 'E_UNKNOWN_TARGET' })
    await expect(engine.exec('nope', 'x')).rejects.toThrowError(/t1, t2/)
    expect(() => engine.bind('sX', 'nope')).toThrowError(/t1, t2/)
  })

  it('timeoutMs/signal 透传到 session.run', async () => {
    const { engine, factory } = rig()
    factory.seed(new FakeBackend('t1', factory.trace, []))
    const controller = new AbortController()
    await engine.exec('t1', 'a', { timeoutMs: 5_000, signal: controller.signal })
    const backend = factory.created[0]!
    expect(backend.sessions[0]!.seenRuns[0]).toMatchObject({ cmd: 'a', timeoutMs: 5_000, signal: controller.signal })
  })

  it('dispose：关闭全部 backend、清 idle timer', async () => {
    vi.useFakeTimers()
    const { engine, factory } = rig({ idleTtlSec: 60 })
    factory.seed(new FakeBackend('t1', factory.trace, []))
    factory.seed(new FakeBackend('t2', factory.trace, []))
    await engine.exec('t1', 'a')
    await engine.exec('t2', 'b')
    expect(engine.summary().map((row) => row.alive)).toEqual([true, true])

    await engine.dispose()
    expect(engine.summary().map((row) => row.alive)).toEqual([false, false])
    expect(factory.created.map((backend) => backend.closeCount)).toEqual([1, 1])

    await vi.advanceTimersByTimeAsync(600_000)
    expect(factory.created.map((backend) => backend.closeCount)).toEqual([1, 1]) // timer 已清，无二次 close
  })
})

describe('RemoteEngine capOutcome — stderr cap + 真原长 threading', () => {
  function degradedRig(maxOutputChars: number, execResult: Partial<ExecOutcome>): { engine: RemoteEngine; factory: FakeFactory } {
    const r = rig({ maxOutputChars })
    const backend = new FakeBackend('t1', r.factory.trace, [])
    backend.openError = coded('E_EXEC_FALLBACK', 'degraded path for the cap test')
    backend.execResult = execResult
    r.factory.seed(backend)
    return { engine: r.engine, factory: r.factory }
  }

  it('caps huge stderr with the same maxOutputChars and embeds the marker', async () => {
    const { engine } = degradedRig(100, { exitCode: 0, output: 'ok', stderr: 'e'.repeat(500), durationMs: 5 })
    const outcome = await engine.exec('t1', 'x')
    expect(outcome.output).toBe('ok')
    expect(outcome.stderr).toBe(`[truncated: showing last 100 of 500 chars]\n${'e'.repeat(100)}`)
  })

  it('keeps the TRUE original total when the backend already truncated (no re-measuring the 100k tail)', async () => {
    const { engine } = degradedRig(1_000, { exitCode: 0, output: 'x'.repeat(100_000), truncated: 250_000, durationMs: 5 })
    const outcome = await engine.exec('t1', 'x')
    expect(outcome.truncated).toBe(250_000)
    expect(outcome.output.startsWith('[truncated: showing last 1000 of 250000 chars]\n')).toBe(true)
  })

  it('threads the PTY session-run truncation total through to the outcome', async () => {
    const r = rig({ maxOutputChars: 30 })
    r.factory.seed(
      new FakeBackend('t1', r.factory.trace, [
        { kind: 'result', result: { output: `[truncated: showing last 100 of 5000 chars]\n${'y'.repeat(100)}`, truncated: 5_000 } },
      ]),
    )
    const outcome = await r.engine.exec('t1', 'x')
    expect(outcome.truncated).toBe(5_000)
    expect(outcome.output.startsWith('[truncated: showing last 30 of 5000 chars]\n')).toBe(true)
  })
})
