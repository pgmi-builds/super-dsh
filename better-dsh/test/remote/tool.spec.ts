/**
 * `ssh` 工具面单测（plan docs/10_plans/2026-09-22-dashr-remote-tool-rm0.md Task 9，
 * brief Step 1）。engine 用内存 fake（同 RemoteEngine 接口，记录调用序列）；四路分派、
 * bind-before-status 顺序、Ruling 10 的 session append（fake agent events 断言）、
 * output.render 的 `[exit N · Xs]` 页脚全部在此覆盖。engine 本体的行为归 engine.spec。
 */
import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ExecOutcome } from '../../src/remote/backend.ts'
import type { RemoteEngine } from '../../src/remote/engine.ts'
import { createSshTool } from '../../src/remote/tool.ts'

/** 内存 fake engine：与 RemoteEngine 公共面同形，记录调用序列供断言。 */
class FakeEngine {
  readonly calls: string[] = []
  readonly execs: Array<{ name: string; cmd: string; timeoutMs?: number; signal?: AbortSignal; stdin?: string }> = []
  readonly bindings: Array<{ sessionKey: string; target: string }> = []
  private readonly bound = new Map<string, string>()
  outcome: ExecOutcome = { exitCode: 0, output: 'hello\n', cwdAfter: '/srv/app', durationMs: 1_500 }
  failure: Error | undefined
  bindFailure: Error | undefined

  targetNames(): string[] {
    return ['dev3', 'staging']
  }

  summary(): Array<{ name: string; host: string; port: number; user?: string; alive: boolean; defaultCwd?: string }> {
    this.calls.push('summary')
    return [{ name: 'dev3', host: 'dev3.example', port: 22, user: 'u1', alive: false, defaultCwd: '/srv/app' }]
  }

  status(name: string): Promise<string> {
    this.calls.push(`status:${name}`)
    return Promise.resolve(`target : ${name} → u1@dev3.example:22`)
  }

  exec(name: string, cmd: string, opts?: { timeoutMs?: number; signal?: AbortSignal; stdin?: string }): Promise<ExecOutcome> {
    this.calls.push(`exec:${name}`)
    this.execs.push({ name, cmd, timeoutMs: opts?.timeoutMs, signal: opts?.signal, stdin: opts?.stdin })
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve(this.outcome)
  }

  bind(sessionKey: string, name: string): void {
    if (this.bindFailure !== undefined) throw this.bindFailure
    this.calls.push(`bind:${name}`)
    this.bindings.push({ sessionKey, target: name })
    this.bound.set(sessionKey, name)
  }

  boundTarget(sessionKey: string): string | undefined {
    return this.bound.get(sessionKey)
  }

  async dispose(): Promise<void> {
    this.calls.push('dispose')
  }
}

/** 结构化 fake agent：session.append 捕获进 events（audit 断言用）。 */
function fakeAgent(): { agent: Agent; events: Array<{ type: string; data: unknown }> } {
  const events: Array<{ type: string; data: unknown }> = []
  const agent = {
    id: 'audit-agent',
    session: { append: (type: string, data: unknown) => { events.push({ type, data }) } },
  }
  return { agent: agent as unknown as Agent, events }
}

/** 最小 ToolRunContext 形状（工具只消费 signal 与 agent）。 */
function makeExec(agent?: Agent, signal = new AbortController().signal): ToolRunContext {
  return { signal, ...(agent === undefined ? {} : { agent }) } as unknown as ToolRunContext
}

/** 一个 it 一套 fake：返回 engine 与挂在该 engine 上的工具。 */
function make() {
  const engine = new FakeEngine()
  const tool = createSshTool(engine as unknown as RemoteEngine)
  return { engine, tool }
}

describe('createSshTool — dispatch', () => {
  it('empty call renders the targets summary without dialing', async () => {
    const { engine, tool } = make()
    const value = await tool.execute({}, makeExec()) as { kind: string; text: string }
    expect(engine.calls).toEqual(['summary'])
    expect(value.kind).toBe('targets')
    expect(value.text).toContain('dev3.example')
  })

  it('cmd without a bound target fails loud with the bind hint', async () => {
    const { engine, tool } = make()
    await expect(tool.execute({ cmd: 'echo hi' }, makeExec())).rejects.toThrow(/bind: true/)
    expect(engine.calls).toEqual([])
  })

  it('bind:true with target-only binds the session default, then reports status', async () => {
    const { engine, tool } = make()
    const { agent } = fakeAgent()
    await tool.execute({ target: 'dev3', bind: true }, makeExec(agent))
    expect(engine.calls).toEqual(['bind:dev3', 'status:dev3'])
    expect(engine.execs).toHaveLength(0)
    expect(engine.bindings[0]).toEqual({ sessionKey: 'audit-agent', target: 'dev3' })
  })

  it('cmd-only exec rides the bound target (R5 zero-routing)', async () => {
    const { engine, tool } = make()
    await tool.execute({ target: 'dev3', bind: true }, makeExec())
    await tool.execute({ cmd: 'echo hi' }, makeExec())
    expect(engine.execs).toEqual([{ name: 'dev3', cmd: 'echo hi', timeoutMs: undefined, signal: expect.any(AbortSignal) }])
  })

  it('agent-less calls share one fallback binding key', async () => {
    const { engine, tool } = make()
    await tool.execute({ target: 'dev3', bind: true }, makeExec())
    await tool.execute({ cmd: 'echo hi' }, makeExec())
    expect(engine.bindings[0]!.sessionKey).toBe('dashr-remote:no-session')
    expect(engine.execs[0]!.name).toBe('dev3')
  })

  it('explicit target + cmd execs that target without a prior binding', async () => {
    const { engine, tool } = make()
    await tool.execute({ target: 'staging', cmd: 'echo hi' }, makeExec())
    expect(engine.calls).toEqual(['exec:staging'])
  })

  it('timeout seconds convert to engine timeoutMs', async () => {
    const { engine, tool } = make()
    await tool.execute({ target: 'dev3', cmd: 'x', timeout: 30 }, makeExec())
    expect(engine.execs[0]!.timeoutMs).toBe(30_000)
    await tool.execute({ target: 'dev3', cmd: 'y' }, makeExec())
    expect(engine.execs[1]!.timeoutMs).toBeUndefined()
  })

  it('exec forwards the caller abort signal to the engine', async () => {
    const { engine, tool } = make()
    const controller = new AbortController()
    await tool.execute({ target: 'dev3', cmd: 'x' }, makeExec(undefined, controller.signal))
    expect(engine.execs[0]!.signal).toBe(controller.signal)
  })

  it('unknown target with bind:true fails loud (engine error passthrough)', async () => {
    const { engine, tool } = make()
    engine.bindFailure = new Error('[E_UNKNOWN_TARGET] unknown remote target "nope"; known targets: dev3, staging')
    await expect(tool.execute({ target: 'nope', bind: true }, makeExec())).rejects.toThrow(/unknown remote target/)
  })
})

describe('createSshTool — Ruling 10 session append', () => {
  it('successful exec appends the dashr/remote-exec audit event', async () => {
    const { tool } = make()
    const { agent, events } = fakeAgent()
    await tool.execute({ target: 'dev3', cmd: 'echo hi' }, makeExec(agent))
    expect(events).toEqual([
      { type: 'dashr/remote-exec', data: { target: 'dev3', cmd: 'echo hi', cwd: '/srv/app', exit: 0, durationMs: 1_500 } },
    ])
  })

  it('failed exec appends an errored audit event and rethrows', async () => {
    const { engine, tool } = make()
    engine.failure = new Error('[E_AUTH] permission denied (publickey)')
    const { agent, events } = fakeAgent()
    await expect(tool.execute({ target: 'dev3', cmd: 'cat /etc/shadow' }, makeExec(agent))).rejects.toThrow(/E_AUTH/)
    expect(events).toEqual([
      { type: 'dashr/remote-exec', data: { target: 'dev3', cmd: 'cat /etc/shadow', error: '[E_AUTH] permission denied (publickey)' } },
    ])
  })

  it('no-binding failure is audited too (target absent, hint present)', async () => {
    const { tool } = make()
    const { agent, events } = fakeAgent()
    await expect(tool.execute({ cmd: 'echo hi' }, makeExec(agent))).rejects.toThrow(/bind: true/)
    expect(events).toEqual([
      { type: 'dashr/remote-exec', data: { cmd: 'echo hi', error: expect.stringContaining('bind: true') } },
    ])
  })
})

describe('createSshTool — render', () => {
  it('exec render carries output, [exit N · Xs] footer, and a stderr block when present', async () => {
    const { engine, tool } = make()
    engine.outcome = { exitCode: 0, output: 'hello\n', stderr: 'warn: deprecated\n', cwdAfter: '/srv/app', durationMs: 1_500 }
    const args = { target: 'dev3', cmd: 'echo hello' }
    const value = await tool.execute(args, makeExec()) as { kind: string }
    const [block] = tool.output.render(args, value)
    expect(block!.type).toBe('text')
    const text = (block as { text: string }).text
    expect(text).toContain('hello')
    expect(text).toContain('[exit 0 · 1.5s]')
    expect(text).toContain('[stderr]')
    expect(text).toContain('warn: deprecated')
  })

  it('status render passes the formatted block through verbatim', async () => {
    const { tool } = make()
    const args = { target: 'dev3' }
    const value = await tool.execute(args, makeExec()) as { kind: string; text: string }
    expect(value.kind).toBe('status')
    const [block] = tool.output.render(args, value)
    expect((block as { text: string }).text).toBe(value.text)
  })

  it('targets render passes the summary block through verbatim', async () => {
    const { tool } = make()
    const value = await tool.execute({}, makeExec()) as { kind: string; text: string }
    const [block] = tool.output.render({}, value)
    expect((block as { text: string }).text).toBe(value.text)
    expect(value.text).toContain('dev3.example')
  })

  it('interrupted and truncated outcomes surface in the footer', async () => {
    const { engine, tool } = make()
    engine.outcome = { exitCode: null, output: 'partial\n', interrupted: true, truncated: 40_000, durationMs: 120_000 }
    const args = { target: 'dev3', cmd: 'tail -f /dev/null' }
    const value = await tool.execute(args, makeExec()) as { kind: string }
    const [block] = tool.output.render(args, value)
    const text = (block as { text: string }).text
    expect(text).toContain('[exit null · 120.0s · interrupted · truncated, original 40000 chars]')
  })
})

describe('createSshTool — stdin', () => {
  it('stdin is threaded to the engine uncomposed (raw post-compound write lives at the session layer)', async () => {
    const { engine, tool } = make()
    await tool.execute({ target: 'dev3', cmd: 'python3', stdin: 'print(1+1)\nexit()\n' }, makeExec())
    expect(engine.execs[0]!.cmd).toBe('python3')
    expect(engine.execs[0]!.stdin).toBe('print(1+1)\nexit()\n')
  })

  it('stdin without cmd fails loud', async () => {
    const { engine, tool } = make()
    await expect(tool.execute({ stdin: 'x' }, makeExec())).rejects.toThrow(/stdin requires cmd/)
    expect(engine.calls).toEqual([])
  })
})

describe('createSshTool — timeout validation', () => {
  it('rejects zero / negative timeout loudly BEFORE dispatch (E_BAD_TIMEOUT)', async () => {
    const { engine, tool } = make()
    await expect(tool.execute({ target: 'dev3', cmd: 'x', timeout: 0 }, makeExec())).rejects.toThrow(
      /E_BAD_TIMEOUT.*positive number of seconds.*0/s,
    )
    await expect(tool.execute({ target: 'dev3', cmd: 'x', timeout: -5 }, makeExec())).rejects.toThrow(/E_BAD_TIMEOUT/)
    expect(engine.execs).toEqual([]) // 未拨号、未执行
    expect(engine.calls).toEqual([])
  })

  it('non-finite timeout never reaches dispatch (defineTool arg gate: finite JSON number)', async () => {
    // 真实 wire 上 JSON 无法携带 NaN/Infinity —— harness 的 defineTool 参数校验
    // 先于 execute 拒绝非有限数；这里验证该分层成立（响亮、且引擎未被触碰）。
    const { engine, tool } = make()
    await expect(tool.execute({ target: 'dev3', cmd: 'x', timeout: Number.POSITIVE_INFINITY }, makeExec())).rejects.toThrow(
      /must be a finite JSON number/,
    )
    expect(engine.execs).toEqual([])
    expect(engine.calls).toEqual([])
  })

  it('positive fractional timeout still dispatches (30.5s → 30500ms)', async () => {
    const { engine, tool } = make()
    await tool.execute({ target: 'dev3', cmd: 'x', timeout: 30.5 }, makeExec())
    expect(engine.execs[0]!.timeoutMs).toBe(30_500)
  })
})
