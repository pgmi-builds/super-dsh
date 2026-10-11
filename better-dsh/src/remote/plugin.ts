/** Agent-scoped remote tool; the host row owns only creation listeners. */
import { Context } from '@deepseek-ai/cordis'
import z from '#schemastery'
import type { NativeConfigSchema } from '@deepseek-ai/dsh-app-boot'
import type { StandardSchemaV1 } from '../../third_party/schemastery/node_modules/@standard-schema/spec/dist/index.d.ts'
import { installAgentRemote } from './agent-registration.ts'

export const name = 'dashr-remote'
export const inject: string[] = []

/** 运行参数旋钮（Ruling P18）：无别名表面——容器一律显式 'docker:' / 'incus:' 前缀。 */
export interface RemoteRowConfig {
  execTimeoutSec: number
  idleTtlSec: number
  maxOutputChars: number
}

// Public validation boundary only: the actual private schema stays bundled at runtime.
// Exporting schema's global augmentation types would merge two private copies.
export type RemoteConfigValidator = ((value?: unknown) => RemoteRowConfig)
  & StandardSchemaV1<unknown, RemoteRowConfig> & NativeConfigSchema

export const Config: RemoteConfigValidator = z
  .object({
    execTimeoutSec: z.natural().min(1).default(120),
    idleTtlSec: z.natural().min(1).default(600),
    maxOutputChars: z.natural().min(1).default(30_000),
  })
  .default({ execTimeoutSec: 120, idleTtlSec: 600, maxOutputChars: 30_000 }) as unknown as RemoteConfigValidator

/** MUST stay an arrow（RM0 plugin.ts 同注：function 声明会被 cordis 当构造器 new 掉，返回的 disposer 丢失）。 */
export const apply = (ctx: Context, config: RemoteRowConfig): (() => void) => {
  return installAgentRemote(ctx, config)
}

export default { name, inject, Config, apply }

export type { HubRemoteTransport, HubTarget, RemoteInput, PreparedRemoteInput, RemoteProcess, BinaryFileEndpoint, OutputStats, StreamOutputStats } from './hub-contract.ts'
export { Utf16TailRing, ByteTailRing, readUtf8Tail } from './output-ring.ts'
export { startOneShot, startBinaryProcess, PROCESS_CLEANUP_BOUND_MS } from './process.ts'
export { startRemoteJob } from './jobs.ts'

export { SshTargets, sshArgv } from './ssh-targets.ts'
export type { SshConnection } from './ssh-targets.ts'

export { localFileEndpoint, FILE_FRAME_BYTES, FILE_MAX_ENTRIES, FILE_MAX_METADATA, checkAbsolute, checkSelection } from './archive.ts'

export { runFileWorker } from './file-worker.ts'
export { runRsync } from './rsync.ts'
export type { RsyncRequest, RsyncEndpoint, RsyncReceipt } from './rsync.ts'
