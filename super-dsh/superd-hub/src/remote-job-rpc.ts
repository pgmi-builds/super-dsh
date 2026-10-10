/** Owned execution resources, not a model job registry. Identity/lifecycle remain in native ctx.jobs. */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { startOneShot, PROCESS_CLEANUP_BOUND_MS, type RemoteProcess } from '../../remote/plugin.js'
import { parseOneShotExecBody } from './exec.js'

export const REMOTE_JOB_PATH = '/api/superd/exec/task'
// Receiver lease deadlines use monotonic time. Renewal adds a fixed step to the previous deadline,
// never to request arrival: even a delayed in-flight request has a client-accountable upper bound.
export const TASK_LEASE_MS = 6000
export const TASK_RENEW_STEP_MS = 2000
// Canonical process cleanup: TERM, 2000ms grace, KILL, 100ms settle. Include scheduling margin.
export const TASK_CLEANUP_MS = PROCESS_CLEANUP_BOUND_MS + 200
export const TASK_CONTROL_TIMEOUT_MS = 1500
export const TASK_LEASE_PROTOCOL = 1

type Result = Awaited<RemoteProcess['done']>
export interface RemoteTaskSnapshot { stdout: ReturnType<RemoteProcess['read']>; stderr: ReturnType<RemoteProcess['read']>; result: Result }
interface Lease {
  token: string; expires: number; timer?: NodeJS.Timeout; process?: RemoteProcess; stopping: boolean
}
const json = (status: number, body: unknown) => Response.json(body, { status })

export function createRemoteJobExecutor() {
  const active = new Map<string, Lease>()
  let disposed = false
  const stop = async (key: string, lease: Lease, remove = true) => {
    lease.stopping = true
    if (remove) clearTimeout(lease.timer)
    lease.process?.cancel('remote task ownership released')
    await lease.process?.done
    if (remove && active.get(key) === lease) active.delete(key)
  }
  const arm = (key: string, lease: Lease) => {
    clearTimeout(lease.timer)
    lease.timer = setTimeout(() => { void stop(key, lease) }, Math.max(0, lease.expires - performance.now()))
  }
  const metadata = (lease: Lease) => ({ protocol: TASK_LEASE_PROTOCOL, token: lease.token, leaseMs: TASK_LEASE_MS, renewStepMs: TASK_RENEW_STEP_MS, cleanupMs: TASK_CLEANUP_MS })
  return {
    async handle(request: Request): Promise<Response> {
      if (disposed) return json(503, { error: 'remote executor disposed' })
      if (request.method !== 'POST') return json(405, { error: 'use POST' })
      let body: Record<string, unknown>
      try { body = await request.json() as Record<string, unknown> } catch { return json(400, { error: 'invalid JSON' }) }
      // Buffered parsing yields. Disposal closes admission permanently before it awaits owned processes.
      if (disposed) return json(503, { error: 'remote executor disposed' })
      if (!body || typeof body.owner !== 'string' || typeof body.id !== 'string' || !/^[\w-]{1,128}$/.test(body.owner) || !/^[\w-]{1,128}$/.test(body.id)) return json(400, { error: 'owner and task id required' })
      const credential = createHash('sha256').update(request.headers.get('cookie') ?? '').digest('hex')
      const key = `${credential}:${body.owner}:${body.id}`
      if (body.op === 'cancel') {
        const lease = active.get(key)
        if (!lease) return json(200, { done: true, outputUnavailable: true }) // no foreign resource existence disclosed
        await stop(key, lease)
        const process = lease.process
        if (!process) return json(200, { done: true, notStarted: true })
        const snapshot: RemoteTaskSnapshot = { result: await process.done, stdout: process.read('stdout', 0), stderr: process.read('stderr', 0) }
        return json(200, { done: true, snapshot })
      }
      if (body.op === 'prepare') {
        if (active.has(key)) return json(409, { error: 'task already prepared' })
        if (request.signal.aborted) return json(499, { error: 'request disconnected before preparation' })
        const lease: Lease = { token: randomUUID(), expires: performance.now() + TASK_LEASE_MS, stopping: false }
        active.set(key, lease); arm(key, lease)
        // No subprocess exists yet. The client must receive this bounded token before it can send start.
        return json(200, { lease: metadata(lease) })
      }
      const lease = active.get(key)
      if (body.op === 'read') {
        if (!lease?.process) return json(404, { error: 'unknown owned task' })
        const out = body.stdout ?? 0, err = body.stderr ?? 0
        if (![out, err].every(n => Number.isSafeInteger(n) && (n as number) >= 0)) return json(400, { error: 'invalid byte cursor' })
        return json(200, { stdout: lease.process.read('stdout', out as number), stderr: lease.process.read('stderr', err as number) })
      }
      if (body.op !== 'start' && body.op !== 'renew') return json(400, { error: 'unknown task operation' })
      if (!lease || lease.stopping || lease.token !== body.token || performance.now() >= lease.expires) return json(409, { error: 'task lease absent, expired or superseded; nothing started or renewed' })
      if (body.op === 'renew') {
        if (!lease.process) return json(409, { error: 'task has not started' })
        lease.expires = Math.min(lease.expires + TASK_RENEW_STEP_MS, performance.now() + TASK_LEASE_MS)
        lease.token = randomUUID()
        arm(key, lease)
        return json(200, { lease: metadata(lease) })
      }
      if (lease.process) return json(409, { error: 'task already started' })
      const parsed = parseOneShotExecBody(body.input)
      if (!parsed.ok) return json(400, { error: parsed.error })
      if (request.signal.aborted) { await stop(key, lease); return json(499, { error: 'request disconnected before start' }) }
      let wake: (() => void) | undefined
      let changed = true, result: Result | undefined, streamClosed = false
      const notify = () => { changed = true; wake?.(); wake = undefined }
      const input = parsed.value
      const process = startOneShot(['bash', '-lc', input.cmd], { unit: 'bytes', stdin: input.stdin, cwd: input.cwd, timeoutSec: input.timeoutSec, onOutput: notify })
      lease.process = process
      const cancel = () => { void stop(key, lease, false) }
      request.signal.addEventListener('abort', cancel, { once: true })
      const detach = () => request.signal.removeEventListener('abort', cancel)
      // Keep the terminal ring available through the existing bounded lease window.
      // Stream delivery is not end-to-end receipt: a proxy may still hold the final frame.
      void process.done.then(value => { result = value; lease.stopping = true; detach(); notify() })
      let out = 0, err = 0
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (streamClosed) return
          if (!changed && !result) await new Promise<void>(resolve => { wake = resolve })
          if (streamClosed) return
          changed = false
          const stdout = process.read('stdout', out), stderr = process.read('stderr', err)
          out = stdout.nextOffset; err = stderr.nextOffset
          controller.enqueue(Buffer.from(JSON.stringify({ stdout, stderr, ...(result ? { done: result } : {}) }) + '\n'))
          if (result) { streamClosed = true; controller.close() }
        },
        async cancel() { streamClosed = true; notify(); await stop(key, lease, false); detach() },
      }, { highWaterMark: 0 })
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } })
    },
    async dispose() {
      disposed = true
      await Promise.all([...active].map(([key, lease]) => stop(key, lease)))
    },
  }
}

/** Official connection fetch bridge supplies disconnect AbortSignal and auth/trust fence. */
export function registerRemoteJobRpc(ctx: Context): void {
  ctx.inject(['connection'], connectionCtx => {
    const connection = Reflect.get(connectionCtx, 'connection') as { fetch?: { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> } } | undefined
    if (!connection?.fetch) return
    const executor = createRemoteJobExecutor()
    connectionCtx.effect(() => () => executor.dispose(), 'remote task executor cleanup')
    connectionCtx.effect(() => connection.fetch!.register({ path: REMOTE_JOB_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => executor.handle(request) }), 'remote task authenticated route')
  })
}
