import { startOneShot } from './process.ts'
import { buildOneShotArgv } from './transports.ts'
import type { TargetPlan } from './target.ts'
import type { RemoteProcess } from './hub-contract.ts'

type Options = { stdin?: string; timeoutSec?: number; signal?: AbortSignal; argvFor?: (plan: TargetPlan, cmd: string, options: { cleanupTag?: string }) => string[] }

/** One-shot native exec: plain `ssh <host>` / `docker exec` / `incus exec` argv
 * (buildOneShotArgv) — the wrapper there kills the whole remote process group
 * when the session is torn down (HUP/TERM), so daemonized children cannot
 * outlive the command. No remote Python, no owner/lease protocol: local
 * lifecycle (timeout/cancel/killpg) is startOneShot's own. */
export function startOwnedNativeProcess(plan: TargetPlan, cmd: string, options: Options = {}): Promise<RemoteProcess> {
  return Promise.resolve(startOneShot((options.argvFor ?? buildOneShotArgv)(plan, cmd, {}), { stdin: options.stdin, timeoutSec: options.timeoutSec }))
}
