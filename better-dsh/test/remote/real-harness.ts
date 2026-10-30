import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteDriverOptions } from '../../src/remote/driver.ts'
import Remote from '../../src/remote/plugin.ts'

/** Real registry enter/announce and real scoped tools; no LLM or network is needed. */
export async function createRealRemoteHarness({ copies = 2, driverOptions = {} as RemoteDriverOptions, plugins = Array.from({ length: copies }, () => ({ ...Remote, apply: (ctx: Context, config: Parameters<typeof Remote.apply>[1]) => Remote.apply(ctx, { ...config, ...driverOptions }) })) } = {}) {
  const ctx = new Context()
  // 0.2.2: mount the real native executor beside the registry (as the shipped host does) — batch execute and prompt assembly select it.
  const services = [await ctx.plugin(SystemPrompt, {}), await ctx.plugin(ToolRuntime, {}), await ctx.plugin(NativeToolExecutor), await ctx.plugin(SessionProjectionRegistry), await ctx.plugin(AgentRegistry)]
  let host!: Context
  // 0.2.2: capture the host via an object plugin declaring its injects, and
  // gate createAgent on the plugin's ACTUAL activation — alpha.2 cordis
  // defers an inject-waiting plugin's apply past `await ctx.plugin()` (and a
  // bare function plugin can't carry inject: its apply then runs without
  // service access, since service reads now require the declaring inject).
  let signalHostReady!: () => void
  const hostReady = new Promise<void>(resolve => { signalHostReady = resolve })
  services.push(await ctx.plugin({ name: 'host-capture', inject: ['tools', 'agents'], apply: (c: Context) => { host = c; signalHostReady() } }))
  const rows: Awaited<ReturnType<Context['plugin']>>[] = []
  for (const plugin of plugins) rows.push(await ctx.plugin(plugin, Remote.Config(undefined) as Parameters<typeof Remote.apply>[1]))
  const agents: Agent[] = []
  const disposers = new Map<Agent, () => Promise<void>>()
  return {
    ctx, host, rows,
    async createAgent(id: string, source: 'startup' | 'resume' = 'startup') {
      await hostReady
      const agent = { id: SessionId(id), session: { id: SessionId(id), header: { cwd: process.cwd() } }, status: 'idle' } as Agent
      const scope = createScope(host, agent)
      Object.assign(agent, { ctx: scope.ctx })
      const detach = host.agents.enter(agent, undefined)
      disposers.set(agent, async () => { detach(); await scope.dispose() })
      agents.push(agent)
      try { await host.agents.announce(agent, source); return agent }
      catch (error) { await disposers.get(agent)!(); throw error }
    },
    visibleTools: (agent: Agent) => host.tools.schemas(agent),
    async invoke(agent: Agent, args: Record<string, unknown>, name: 'remote' | 'remote_transfer' = 'remote') {
      // 0.2.2: the staged pipeline directly (batch execute needs a mounted executor).
      const result = await executeToolFixture(agent.ctx, {
        callId: `${name}-test` as never,
        name,
        arguments: args,
        agent,
        signal: new AbortController().signal,
      })
      if (result.isError) throw new Error(JSON.stringify(result))
      return result.value as { text: string; cwd?: string }
    },
    disposeAgent: (agent: Agent) => disposers.get(agent)!(),
    async dispose() {
      for (const agent of agents) await disposers.get(agent)!()
      for (const row of rows) await row.dispose()
      for (const service of services.reverse()) await service.dispose()
    },
  }
}
