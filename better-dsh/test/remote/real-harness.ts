import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteDriverOptions } from '../../src/remote/driver.ts'
import Remote from '../../src/remote/plugin.ts'

/** Real registry enter/announce and real scoped tools; no LLM or network is needed. */
export async function createRealRemoteHarness({ copies = 2, driverOptions = {} as RemoteDriverOptions, plugins = Array.from({ length: copies }, () => ({ ...Remote, apply: (ctx: Context, config: Parameters<typeof Remote.apply>[1]) => Remote.apply(ctx, { ...config, ...driverOptions }) })) } = {}) {
  const ctx = new Context()
  const services = [await ctx.plugin(SystemPrompt, {}), await ctx.plugin(ToolRuntime, {}), await ctx.plugin(AgentRegistry)]
  let host!: Context
  services.push(await ctx.plugin(Object.assign((c: Context) => { host = c }, { inject: ['tools', 'agents'] })))
  const rows: Awaited<ReturnType<Context['plugin']>>[] = []
  for (const plugin of plugins) rows.push(await ctx.plugin(plugin, Remote.Config(undefined) as Parameters<typeof Remote.apply>[1]))
  const agents: Agent[] = []
  const disposers = new Map<Agent, () => Promise<void>>()
  return {
    ctx, host, rows,
    async createAgent(id: string, source: 'startup' | 'resume' = 'startup') {
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
    async invoke(agent: Agent, args: Record<string, unknown>) {
      const result = await agent.ctx.tools.execute({ name: 'remote', arguments: args, agent, signal: new AbortController().signal, callId: 'remote-test' as never })
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
