import type { SshConnection } from './ssh-targets.ts'
/** Owned structural boundary. Better never imports or depends on Super. */
export interface RemoteInput {
  target?: string; spawn?: string; ssh?: SshConnection; cmd?: string; scriptPath?: string; stdin?: string
  mode?: 'oneshot' | 'pty'; timeout?: number
}
export interface PreparedRemoteInput {
  target?: string; spawn?: string; ssh?: SshConnection; cmd: string; stdin?: string; mode?: 'oneshot' | 'pty'; timeout?: number
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
  /** Hub PTY 端点（0.3.2-c）：url = ws(s)://<origin>/api/superd/exec/pty；cookie = pairing 凭据；
   *  wsPath = transport 侧（superd-hub 上下文，分叉的 proven 解析链）解析好的 ws 模块绝对路径。 */
  ptyEndpoint(machine: string): { url: string; cookie: string; wsPath: string }
  fileEndpoint(machine: string): BinaryFileEndpoint
  releaseOwner(owner: string): Promise<void>
}
