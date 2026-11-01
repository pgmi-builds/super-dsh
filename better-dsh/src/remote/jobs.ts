import type { JobRegistry, JobId, JobOutcome, JobOutputSource } from '@deepseek-ai/dsh-jobs'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RemoteInput, RemoteProcess } from './hub-contract.ts'
import type { PtyRunningJob } from './pty-session.ts'
import type { RemoteDriver } from './driver.ts'
import { parseTargetForm } from './target.ts'

declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { remote: 'remote' } }

/** PTY job 的单通道输出：流在 PTY 里天然合并，无独立 stderr 通道（P5 如实披露）。
 * read 是 byte-cursor 增量（Utf16TailRing.read 语义：逐字节游标 + lossy 报尾环逐出）。 */
const ptyOutputSources = (holder: { job?: PtyRunningJob }): JobOutputSource[] => [{
  channel: 'stdout',
  read: (fromByte) => holder.job?.read(fromByte) ?? { text: '', nextOffset: fromByte, lossy: false },
}]

/** 0.3.2-d CF：timedOut=true 且 aborted=false = 会话侧主动收束（close force / 行回收走的
 * dispose→interrupt 两段路）——同为 killed；exit 到手用 exit，只剩会话死亡时写 session closed。 */
const ptyOutcome = (aborted: boolean, result: { exit: number | null; timedOut?: boolean }): JobOutcome => {
  const interrupted = aborted || result.timedOut === true
  return { status: interrupted ? 'killed' : result.exit === null ? 'failed' : 'completed', detail: interrupted ? `interrupted: ${result.exit === null ? (aborted ? 'session died' : 'session closed') : `exit ${result.exit}`}` : result.exit === null ? 'session died' : `exit code: ${result.exit}` }
}

/** No preparation or discovery before the official registry's admission. */
export function startRemoteJob(registry: JobRegistry, input: RemoteInput, exec: ToolRunContext, driver: RemoteDriver): JobId {
  if (!exec.agent) throw new Error('remote: background jobs require a live Agent owner')
  // P5（2026-10-19）：pty（含 byop）获得与 oneshot 同形的 background 通道；0.3.2-c 起 hub
  // 机器同样入列（hub PTY = canonical 会话，handoff/后台与其他 transport 同形）。
  const form = parseTargetForm(input.target)
  // spec remote-default-pty §1：machine target 默认走 PTY 槽 lane（run_in_background = 提交 framed cmd 的同一操作内
  // handoff）；mode:"oneshot" 显式走无状态 oneshot job。bare pty 认领由 driver 侧 preparePtyLane 沿旧语义拒绝。
  const machineForm = form.form === 'direct' || form.form === 'bare' || form.form === 'hub'
  const ptyLane = form.form === 'pty-selector' || input.spawn !== undefined || input.mode === 'pty' || (machineForm && input.mode !== 'oneshot')
  if (ptyLane) {
    const holder: { job?: PtyRunningJob } = {}
    return registry.start({
      kind: 'remote', owner: exec.agent.id, label: `${input.target}: ${input.cmd}`,
      output: ptyOutputSources(holder),
      run(job) {
        const controller = new AbortController()
        const done: Promise<JobOutcome> = (async () => {
          try {
            const r = await driver.call({ ...input, mode: 'pty' }, { ptyBackground: true, commandId: job.id, sessionKey: exec.agent?.id ?? 'no-session' })
            if (r.running !== true || r.ptyJob === undefined) return { status: 'failed', detail: 'pty dispatch did not hand off a running job' }
            holder.job = r.ptyJob
            if (controller.signal.aborted) r.ptyJob.interrupt()
            const outcome = await r.ptyJob.done
            return ptyOutcome(controller.signal.aborted, outcome) // aborted MUST be sampled after the await — argument evaluation would read it before suspension
          } catch (error) { return { status: controller.signal.aborted ? 'killed' : 'failed', detail: error instanceof Error ? error.message : String(error) } }
        })()
        return { done, cancel(reason) { if (controller.signal.aborted) return; controller.abort(reason); holder.job?.interrupt() } }
      },
    })
  }
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
    kind: 'remote', owner: exec.agent.id, label: `${input.target}: ${input.cmd}`, output,
    run() {
      const controller = new AbortController()
      const done: Promise<JobOutcome> = (async () => {
        try {
          process = await driver.start({ ...input, mode: 'oneshot' }, controller.signal, { sessionKey: exec.agent?.id ?? 'no-session' })
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

/** P4（2026-10-19）handoff 收养：同步 pty dispatch 超时后命令仍在跑——注册成 job，
 * job_output 即增量轮询、job_kill 即显式中断（P8 ^C+130-marker，会话存活）。 */
export function adoptRunningPtyJob(registry: JobRegistry, exec: ToolRunContext, label: string, job: PtyRunningJob): JobId {
  if (!exec.agent) throw new Error('remote: background jobs require a live Agent owner')
  return registry.start({
    kind: 'remote', owner: exec.agent.id, label,
    output: ptyOutputSources({ job }),
    run() {
      const controller = new AbortController()
      const done: Promise<JobOutcome> = (async () => {
        if (controller.signal.aborted) job.interrupt()
        const outcome = await job.done
        return ptyOutcome(controller.signal.aborted, outcome) // sampled after the await, same reason
      })()
      return { done, cancel(reason) { if (controller.signal.aborted) return; controller.abort(reason); job.interrupt() } }
    },
  })
}
