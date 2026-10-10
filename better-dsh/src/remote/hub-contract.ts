import type { SshConnection } from './ssh-targets.ts'
/** Owned structural boundary. Better never imports or depends on Super. */
import type { RemoteCallResult } from './driver.ts'
export interface RemoteInput {
  target?: string; spawn?: string; ssh?: SshConnection; cmd?: string; script?: string; stdin?: string
  mode?: 'oneshot' | 'pty'; timeout?: number
}
export interface PreparedRemoteInput {
  target: string; spawn?: string; ssh?: SshConnection; cmd: string; stdin?: string; mode?: 'oneshot' | 'pty'; timeout?: number
}
/** Counters exclude diagnostic banners. dropped is ring eviction; total-returned is all omitted output. */
export type OutputStats = {
  unit: 'utf16' | 'bytes'; total: number; retained: number; dropped: number; returned: number; retentionLimit: number
}
export type StreamOutputStats = { stdout: OutputStats; stderr?: OutputStats }
export interface RemoteProcess {
  cancel(reason?: string): void
  done: Promise<{ exit: number | null; timedOut: boolean; durationMs: number; cancelled?: boolean }>
  /** diagnostic is executor-generated text, not process output; excluded from byte cursor and counters. */
  read(channel: 'stdout' | 'stderr', fromByte: number): { text: string; nextOffset: number; lossy: boolean; stats?: OutputStats; diagnostic?: string }
}
export interface BinaryFileEndpoint {
  exportTree(path: string, signal: AbortSignal): Promise<NodeJS.ReadableStream>
  importTree(path: string, source: NodeJS.ReadableStream, options: { mkdir: boolean; signal: AbortSignal }): Promise<void>
  digest(path: string, signal: AbortSignal, selection?: readonly string[]): Promise<{ sha256: string; bytes: number; entries: number }>
}
export interface HubTarget { id: string; label: string; execEnabled: boolean }
export interface HubRemoteTransport {
  protocol: 1
  listTargets(): readonly HubTarget[]
  start(machine: string, input: PreparedRemoteInput, owner: string): Promise<RemoteProcess>
  pty(machine: string, cmd: string, owner: string, options: { stdin?: string; timeout?: number }): Promise<RemoteCallResult>
  fileEndpoint(machine: string): BinaryFileEndpoint
  releaseOwner(owner: string): Promise<void>
}
