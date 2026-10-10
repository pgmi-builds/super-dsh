import type { JobRegistry, JobId, JobOutcome, JobOutputSource } from '@deepseek-ai/dsh-jobs'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RemoteInput, RemoteProcess } from './hub-contract.ts'
import type { RemoteDriver } from './driver.ts'

declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { remote: 'remote' } }

/** No preparation or discovery before the official registry's admission. */
export function startRemoteJob(registry: JobRegistry, input: RemoteInput, exec: ToolRunContext, driver: RemoteDriver): JobId {
  if (input.mode === 'pty' || input.spawn !== undefined || input.target?.startsWith('byop:')) throw new Error('remote: background execution requires oneshot; PTY and BYO-PTY are unsupported')
  if (!exec.agent) throw new Error('remote: background jobs require a live Agent owner')
  let process: RemoteProcess | undefined
  const output: JobOutputSource[] = (['stdout', 'stderr'] as const).map(channel => ({
    channel,
    read: fromByte => {
      const read = process?.read(channel, fromByte)
      // Diagnostics are terminal detail, never byte-addressed pump output.
      return read ? { text: read.text, nextOffset: read.nextOffset, lossy: read.lossy } : { text: '', nextOffset: fromByte, lossy: false }
    },
  }))
  return registry.start({
    kind: 'remote', owner: exec.agent.id, label: `${input.target}: ${input.cmd ?? input.script}`, output,
    run() {
      const controller = new AbortController()
      const done: Promise<JobOutcome> = (async () => {
        try {
          process = await driver.start({ ...input, mode: 'oneshot' }, controller.signal)
          if (controller.signal.aborted) process.cancel(controller.signal.reason)
          const result = await process.done
          const diagnostic = process.read('stderr', 0).diagnostic
          return { status: controller.signal.aborted || result.cancelled ? 'killed' : diagnostic ? 'failed' : result.timedOut ? 'killed' : 'completed', detail: diagnostic ?? (result.timedOut ? 'timeout' : `exit code: ${result.exit}`) }
        } catch (error) { return { status: controller.signal.aborted ? 'killed' : 'failed', detail: error instanceof Error ? error.message : String(error) } }
      })()
      return { done, cancel(reason) { if (controller.signal.aborted) return; controller.abort(reason); process?.cancel(reason) } }
    },
  })
}
