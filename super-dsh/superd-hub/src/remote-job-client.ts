import { randomUUID } from 'node:crypto'
import { ByteTailRing, readUtf8Tail, type PreparedRemoteInput, type RemoteProcess, type OutputStats } from '../../remote/plugin.js'
import { REMOTE_JOB_PATH, TASK_LEASE_MS, TASK_RENEW_STEP_MS, TASK_CLEANUP_MS, TASK_CONTROL_TIMEOUT_MS, TASK_LEASE_PROTOCOL, type RemoteTaskSnapshot } from './remote-job-rpc.js'

type Result = Awaited<RemoteProcess['done']>
interface Lease { protocol: number; token: string; leaseMs: number; renewStepMs: number; cleanupMs: number }

/** Event-driven output; the only periodic operation renews this task's bounded resource lease. */
export function startRemoteProcess(origin: string, cookie: string, input: PreparedRemoteInput, owner: string): RemoteProcess {
  const id = randomUUID(), started = performance.now()
  const rings = { stdout: new ByteTailRing(), stderr: new ByteTailRing() }
  const offsets = { stdout: 0, stderr: 0 }
  const stats: Partial<Record<'stdout' | 'stderr', OutputStats>> = {}
  const streamAbort = new AbortController()
  let diagnostic: string | undefined, cancelled = false, finished = false, stopping = false
  let lease: Lease | undefined, cleanupDeadline = 0, nextRenewAt = 0
  let renewTimer: NodeJS.Timeout | undefined, renewal: Promise<void> | undefined
  let stopWork: Promise<void> | undefined, result: Result | undefined
  let prepared!: () => void, acknowledge!: () => void
  const preparation = new Promise<void>(resolve => { prepared = resolve })
  const cleaned = new Promise<void>(resolve => { acknowledge = resolve })
  let acknowledged = false, startDispatched = false, outputComplete = false
  const confirm = () => { acknowledged = true; acknowledge() }
  const note = (error: unknown) => { const text = error instanceof Error ? error.message : String(error); diagnostic = diagnostic ? `${diagnostic}; ${text}` : text }
  const headers = { 'content-type': 'application/json', cookie }

  // Header/control time bounds stop new ownership extension; they never prove process cleanup.
  const request = async (body: unknown, controller: AbortController, consumeJson: boolean, timeoutMs = TASK_CONTROL_TIMEOUT_MS): Promise<Response | unknown> => {
    const timer = setTimeout(() => controller.abort(new Error('remote task control timeout')), timeoutMs)
    try {
      const response = await fetch(`${origin}${REMOTE_JOB_PATH}`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
      if (!response.ok) throw new Error(`remote task: ${response.status} ${await response.text()}`)
      return consumeJson ? await response.json() : response
    } finally { clearTimeout(timer) }
  }
  const control = (op: string, extra: Record<string, unknown> = {}) => request({ op, owner, id, ...extra }, new AbortController(), true, op === 'cancel' ? TASK_CLEANUP_MS + TASK_CONTROL_TIMEOUT_MS : TASK_CONTROL_TIMEOUT_MS)
  const parseLease = (value: unknown): Lease => {
    const l = (value as { lease?: Lease } | undefined)?.lease
    if (!l || l.protocol !== TASK_LEASE_PROTOCOL || l.leaseMs !== TASK_LEASE_MS || l.renewStepMs !== TASK_RENEW_STEP_MS || l.cleanupMs !== TASK_CLEANUP_MS || typeof l.token !== 'string') throw new Error('remote task: bounded lease protocol unsupported')
    return l
  }
  // Full cancel snapshots and incremental stream frames share absolute byte coordinates.
  // Append only the unseen suffix; stale/overlapping frames cannot rewind or duplicate output.
  const mergeOutput = (channel: 'stdout' | 'stderr', read: ReturnType<RemoteProcess['read']>) => {
    if (read.nextOffset < offsets[channel]) return
    const delta = readUtf8Tail(Buffer.from(read.text), read.nextOffset, offsets[channel])
    if (delta.lossy) rings[channel] = new ByteTailRing()
    rings[channel].push(Buffer.from(delta.text)); offsets[channel] = delta.nextOffset
    stats[channel] = read.stats
    if (read.diagnostic) diagnostic = read.diagnostic
  }
  const stopRenewing = () => { stopping = true; clearTimeout(renewTimer) }
  const waitForCleanup = async () => {
    if (acknowledged || !lease) return
    // Monotonic upper bound: prepare receipt + initial lease + every dispatched renewal step
    // + canonical group cleanup. In-flight renewals were accounted BEFORE sending, so loss is safe.
    let timer: NodeJS.Timeout | undefined
    await Promise.race([cleaned, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, cleanupDeadline - performance.now())) })])
    clearTimeout(timer)
    if (!acknowledged) note('remote task lease expired; receiver cleanup bound elapsed')
  }
  const stop = (): Promise<void> => {
    stopRenewing()
    return stopWork ??= (async () => {
      await preparation
      if (!lease || acknowledged) return
      try {
        const response = await control('cancel') as { done?: unknown; snapshot?: RemoteTaskSnapshot; notStarted?: boolean }
        if (response.done !== true) throw new Error('remote task: invalid cleanup acknowledgement')
        if (response.snapshot) {
          mergeOutput('stdout', response.snapshot.stdout); mergeOutput('stderr', response.snapshot.stderr)
          result = response.snapshot.result; outputComplete = true
        } else if (response.notStarted) outputComplete = true
        confirm()
      } catch (error) { note(error) }
      // Closing the reader helps a reachable receiver observe disconnection. The lease/ack barrier,
      // NOT this abort, determines completion even if the receiver has not observed that close.
      streamAbort.abort()
      await waitForCleanup()
    })()
  }
  const scheduleRenewal = () => {
    if (stopping || finished) return
    renewTimer = setTimeout(() => {
      if (stopping || finished || !lease) return
      cleanupDeadline += TASK_RENEW_STEP_MS // include possibly-applied renewal even when its response is lost
      const token = lease.token
      renewal = (async () => {
        try { lease = parseLease(await control('renew', { token })) }
        catch (error) {
          if (!stopping && !acknowledged) { note(error); void stop() }
        } finally {
          nextRenewAt += TASK_RENEW_STEP_MS
          scheduleRenewal()
        }
      })()
    }, Math.max(0, nextRenewAt - performance.now()))
  }
  const done: Promise<Result> = (async () => {
    try {
      lease = parseLease(await control('prepare'))
      cleanupDeadline = performance.now() + TASK_LEASE_MS + TASK_CLEANUP_MS
      nextRenewAt = performance.now() + TASK_RENEW_STEP_MS
      prepared()
      if (cancelled) { await stop(); return { exit: null, timedOut: false, cancelled: true, durationMs: Math.round(performance.now() - started) } }
      // No start may be admitted without the bounded token received above. Delayed starts cannot
      // outlive that token or resurrect a cancelled/expired record.
      startDispatched = true
      const response = await request({ op: 'start', owner, id, token: lease.token, input: { cmd: input.cmd, stdin: input.stdin, timeoutSec: input.timeout } }, streamAbort, false) as Response
      scheduleRenewal()
      if (!response.body) throw new Error('remote task: missing output stream')
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let pending = ''
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          pending += decoder.decode(chunk.value, { stream: true })
          let newline: number
          while ((newline = pending.indexOf('\n')) >= 0) {
            const frame = JSON.parse(pending.slice(0, newline)) as { stdout: ReturnType<RemoteProcess['read']>; stderr: ReturnType<RemoteProcess['read']>; done?: Result }
            pending = pending.slice(newline + 1)
            mergeOutput('stdout', frame.stdout); mergeOutput('stderr', frame.stderr)
            if (frame.done) { result = frame.done; outputComplete = true; stopRenewing(); confirm() }
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      if (!result) throw new Error('remote task stream ended before cleanup acknowledgement')
      await stopWork
      return result
    } catch (error) {
      if (!stopping) note(error)
      prepared() // A failed prepare never spawned anything; any successful prepare is bounded above.
      await stop()
      return result ?? { exit: null, timedOut: false, cancelled, durationMs: Math.round(performance.now() - started) }
    } finally {
      finished = true; stopRenewing(); prepared()
      await renewal // no in-flight transport resource or lease extension survives done
      if (startDispatched && !outputComplete) note('remote task final output unavailable; returned output and counters may be incomplete')
    }
  })()
  return {
    cancel() { if (cancelled || finished) return; cancelled = true; void stop() }, done,
    read(channel, fromByte) {
      const read = readUtf8Tail(rings[channel].tail(), offsets[channel], fromByte)
      const incomplete = finished && startDispatched && !outputComplete
      const metric = incomplete ? undefined : stats[channel]
      return { ...read, lossy: read.lossy || incomplete, ...(metric ? { stats: { ...metric, returned: Buffer.byteLength(read.text) } } : {}), ...(channel === 'stderr' && diagnostic ? { diagnostic } : {}) }
    },
  }
}
