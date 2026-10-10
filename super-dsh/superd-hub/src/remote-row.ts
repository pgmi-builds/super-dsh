import { registerRemoteJobRpc } from './remote-job-rpc.js'
export { createRemoteJobExecutor } from './remote-job-rpc.js'
/** Hub-body capability, deliberately independent of model tool rows. */
import type { Context } from '@deepseek-ai/cordis'
import { createHubRemoteTransport } from './remote-provider.js'
import { registerExecRpc } from './mesh-rpc.js'
import { consoleA2aLog } from './a2a-log.js'

export function installHubRemoteTransport(ctx: Context, options: { home: string }): void {
  const log = consoleA2aLog()
  const transport = createHubRemoteTransport(options.home, log)
  ctx.effect(() => () => transport.dispose(), 'superd-hub: remote transport cleanup')
  ctx.provide('superdRemoteTransport', transport)
  registerExecRpc(ctx, log)
  registerRemoteJobRpc(ctx)
}
