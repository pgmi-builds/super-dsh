import type { HubRemoteTransport } from './hub-contract.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { RemoteDriver } from './driver.ts'
import { createRemoteTool } from './tool.ts'
import { createRemoteTransferTool } from './transfer-tool.ts'
import type { RemoteRowConfig } from './plugin.ts'

/** The pair a row contributes: execution/PTY and file transfer are separate tools. */
const TOOL_NAMES = ['remote', 'remote_transfer'] as const

/** Host listeners attempt once per official creation edge, never on vacancy. */
export function installAgentRemote(ctx: Context, config: RemoteRowConfig): () => void {
  return ctx.on('agent/created', ({ agent }): undefined => {
    const tools = agent.ctx.get('tools')
    if (!tools) return
    const driver = new RemoteDriver({ ...config, getHub: () => agent.ctx.get('superdRemoteTransport') as HubRemoteTransport | undefined })
    const registered: (() => void)[] = []
    try {
      registered.push(tools.register(createRemoteTool(driver, { getSessionKey: () => agent.id })))
      registered.push(tools.register(createRemoteTransferTool(driver, { getSessionKey: () => agent.id })))
    } catch (error) {
      for (const undo of registered.splice(0)) undo()
      void driver.dispose()
      // Native diagnostic AND occupied registry: unrelated failures still reject creation.
      // All-or-nothing per row: a same-name win means the whole pair belongs to the other row.
      const occupied = TOOL_NAMES.find(name => error instanceof Error
        && error.message === `tool "${name}" is already registered in this scope`
        && tools.get(name, agent) !== undefined)
      if (occupied !== undefined) return
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
      for (const undo of registered.splice(0)) undo()
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
