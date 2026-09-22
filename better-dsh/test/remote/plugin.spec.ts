/**
 * `dashr-remote` 行装配单测（plan Task 9，brief Step 2）。真实 Context + SystemPrompt +
 * ToolRuntime + host-fiber + agent scope 假件（对齐 test/helpers.ts 的 boot 形态——
 * `schemas()` 必须带 agent 才有可见性视图，见 presentation.spec 的断言先例）；`vi.mock`
 * 掉 backend.ts（计数 close），engine 走 degraded-exec 路径，避免任何真实拨号。覆盖：
 * 行挂载即注册 `ssh`、Config 默认可省（patch 行无 config 的真实部署路径）、targets
 * 配置贯通 buildRegistry（新 target 缺 host fail-loud）、fiber dispose 触发
 * engine.dispose → 已物化 backend close。
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import RemoteRow, { Config, type RemoteRowConfig } from '../../src/remote/plugin.ts'
import { toolCallId } from '../../src/tool-call-id.ts'

const mocks = vi.hoisted(() => ({ closeCalls: [] as string[] }))

/** backend 全量替身：exec 恒成、openShellSession 报 E_EXEC_FALLBACK（engine 永久降级）、close 计数。 */
vi.mock('../../src/remote/backend.ts', () => ({
  createSshBackend: (spec: { name: string }) => ({
    targetName: spec.name,
    connState: () => 'ready',
    exec: () => Promise.resolve({ exitCode: 0, output: `ok-from-${spec.name}\n`, durationMs: 5 }),
    openShellSession: () =>
      Promise.reject(Object.assign(new Error('[E_EXEC_FALLBACK] no pty in tests'), { code: 'E_EXEC_FALLBACK' })),
    probe: () => Promise.resolve({ rttMs: 1 }),
    snapshotRestore: () => Promise.resolve(),
    close: () => {
      mocks.closeCalls.push(spec.name)
      return Promise.resolve()
    },
  }),
}))

/** 可见性断言用的最小 agent（session.append 吞掉 audit；scope 挂在 host 上）。 */
function scopeAgent(host: Context): { agent: Agent; dispose(): void } {
  const agent = {
    id: SessionId('remote-agent'),
    session: { header: { cwd: process.cwd() }, append: () => {} },
  } as unknown as Agent
  const scope = createScope(host, agent)
  return { agent, dispose: () => scope.dispose() }
}

/** 最小可执行装配：SystemPrompt + ToolRuntime + host-fiber + 被测行 + 一个 agent scope。 */
async function bootRow(
  config?: Partial<RemoteRowConfig>,
): Promise<{ host: Context; fiber: Awaited<ReturnType<Context['plugin']>>; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  let host!: Context
  await ctx.plugin(Object.assign((inner: Context) => { host = inner }, { inject: ['tools'] }))
  const fiber = await ctx.plugin(RemoteRow, config as RemoteRowConfig | undefined)
  const { agent, dispose } = scopeAgent(host)
  onTestFinished(() => {
    dispose()
    void fiber.dispose()
  })
  return { host, fiber, agent }
}

describe('dashr-remote row', () => {
  it('Config({}) fills every default (targets {}, 120/300/30000)', () => {
    expect(Config({} as RemoteRowConfig)).toEqual({ targets: {}, execTimeoutSec: 120, idleTtlSec: 300, maxOutputChars: 30_000 })
  })

  it('mounts without config and registers the ssh tool', async () => {
    const { host, agent } = await bootRow()
    // The row arms through ctx.inject(['tools'], …) — a child fiber loading a
    // few microtasks after apply returns, so visibility must be awaited.
    await expect
      .poll(() => host.tools.schemas(agent).map((schema) => schema.name))
      .toContain('ssh')
  })

  it('targets config flows into the registry — unknown target errors list the configured name', async () => {
    const { host, agent } = await bootRow({ targets: { dev3: { host: '127.0.0.1' } } })
    await expect
      .poll(() => host.tools.schemas(agent).map((schema) => schema.name))
      .toContain('ssh')
    // A status call on an unknown name must list `dev3` among known targets
    // (engine Ruling 2: status never dials — the misnamed target fails loud).
    // tools.execute folds thrown tool errors into an isError result.
    const result = (await host.tools.execute({
      signal: new AbortController().signal,
      callId: toolCallId('call-1'),
      name: 'ssh',
      arguments: { target: 'nope' },
      agent,
    })) as { isError: boolean; content: { text: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content.map((block) => block.text).join('\n')).toMatch(/dev3/)
  })

  it('new-target override without host fails loud at mount', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    // A real Promise (not the fiber thenable) so vitest's `.rejects` can probe it.
    // Deliberately partial config: {dev9:{}} is missing `host` — the mount must fail loud.
    const mounting = Promise.resolve(ctx.plugin(RemoteRow, { targets: { dev9: {} } } as unknown as RemoteRowConfig))
    await expect(mounting).rejects.toThrow(/missing required field/)
  })

  it('exec materializes a pooled backend; fiber dispose closes it through engine.dispose', async () => {
    const { host, fiber, agent } = await bootRow({ targets: { dev3: { host: '127.0.0.1' } } })
    await expect
      .poll(() => host.tools.schemas(agent).map((schema) => schema.name))
      .toContain('ssh')
    await host.tools.execute({
      signal: new AbortController().signal,
      callId: toolCallId('call-1'),
      name: 'ssh',
      arguments: { target: 'dev3', cmd: 'echo ok' },
      agent,
    })
    expect(mocks.closeCalls).toEqual([])
    await fiber.dispose()
    // The row's dispose hook fires engine.dispose() (Promise.all of backend
    // closes) fire-and-forget — await its landing via poll.
    await expect.poll(() => mocks.closeCalls).toEqual(['dev3'])
  })
})
