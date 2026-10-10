import type { HubRemoteTransport } from './hub-contract.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { RemoteDriver } from './driver.ts'
import { createRemoteTool } from './tool.ts'
import type { RemoteRowConfig } from './plugin.ts'

/** Host listeners attempt once per official creation edge, never on vacancy. */
export function installAgentRemote(ctx: Context, config: RemoteRowConfig): () => void {
  return ctx.on('agent/created', ({ agent }): undefined => {
    const tools = agent.ctx.get('tools')
    if (!tools) return
    const driver = new RemoteDriver({ ...config, getHub: () => agent.ctx.get('superdRemoteTransport') as HubRemoteTransport | undefined })
    let unregister: () => void
    try {
      unregister = tools.register(createRemoteTool(driver, { getSessionKey: () => agent.id }))
    } catch (error) {
      void driver.dispose()
      // Native diagnostic AND occupied registry: unrelated failures still reject creation.
      if (error instanceof Error && error.message === 'tool "remote" is already registered in this scope'
        && tools.get('remote', agent) !== undefined) return
      throw error
    }
    const stopService = agent.ctx.on('internal/service', (name) => {
      if (name === 'superdRemoteTransport') agent.ctx.emit('tools/change')
    })
    let disposal: Promise<void> | undefined
    let ownerUndo: (() => void) | undefined
    let agentUndo: (() => void) | undefined
    const cleanup = () => {
      if (disposal) return disposal
      disposal = driver.dispose() // Terminal admission before any unregister/disposal notifications.
      unregister()
      stopService()
      ownerUndo?.()
      agentUndo?.()
      return disposal
    }
    // Either owner removes the other owner's effect too; no retained Agent closures.
    agentUndo = agent.ctx.effect(() => cleanup, 'remote.agentOwner()')
    ownerUndo = ctx.effect(() => cleanup, 'remote.rowOwner()')
    return undefined
  })
}
