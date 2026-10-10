import { startOneShot } from './process.ts'
import type { StreamOutputStats } from './hub-contract.ts'
export { startOneShot } from './process.ts'
export interface OneShotOptions { stdin?: string; timeoutSec?: number }
export interface OneShotResult { exit: number | null; timedOut: boolean; stdout: string; stderr: string; durationMs: number; outputStats?: StreamOutputStats }

export async function runOneShot(argv: string[], opts: OneShotOptions = {}): Promise<OneShotResult> {
  const process = startOneShot(argv, opts)
  const result = await process.done
  const stdout = process.read('stdout', 0), stderr = process.read('stderr', 0)
  return { ...result, stdout: stdout.text, stderr: [stderr.text, stderr.diagnostic].filter(Boolean).join('\n'), outputStats: { stdout: stdout.stats!, stderr: stderr.stats } }
}
