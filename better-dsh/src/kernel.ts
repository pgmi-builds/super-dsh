/** One persistent, serialized OMP Python child. No Jupyter ports or dependencies. */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { KERNEL_BOOTSTRAP } from './bootstrap.ts'
import { buildQueryVarCell, buildSetVarCell, buildSnapshotCell, buildRestoreCell } from './python.ts'
import type { SnapshotSpec } from './python.ts'
import { extractStream } from './output.ts'

export interface KernelBridgeOptions {
  python: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  startupTimeoutMs: number
  disposeTimeoutMs: number
  /** Retained configuration seam; OMP interrupts with SIGINT directly. */
  interruptConfirmMs: number
  snapshotTimeoutMs: number
  username: string
  snapshotDirectory?: string
  snapshotSizeCapBytes?: number
}
export type { SnapshotSpec }
export type SnapshotOutcome =
  | { kind: 'ok', sizeBytes: number, names: string[], omitted: Record<string, string>, turn: number, warning?: string }
  | { kind: 'skipped', reason: string, estimateBytes?: number, sizeBytes?: number, capBytes: number }
  | { kind: 'failed', reason: string }
export type RestoreStateOutcome = { kind: 'restored', count: number, turn: number, omitted: Record<string, string> } | { kind: 'degraded', reason: string }
export type QueryVarOutcome = { kind: 'json' | 'repr', text: string } | { kind: 'names', names: string[] } | { kind: 'missing' } | { kind: 'failed', reason: string }
export type SetVarOutcome = { kind: 'ok' } | { kind: 'failed', reason: string }
export type HostRequestOutcome = { ok: true, result: unknown } | { ok: false, message: string }
export type HostRequestHandler = (data: Record<string, unknown>) => Promise<HostRequestOutcome>
export interface ExecuteCellOptions {
  timeoutMs: number
  interruptGraceMs: number
  interruptConfirmMs: number
  signal?: AbortSignal
  hostRequestHandler?: HostRequestHandler
}
export type CellOutcome =
  | { outcome: 'completed', status: 'ok' | 'error', streamText: string, cellError?: { ename: string, evalue: string, traceback: string[] } }
  | { outcome: 'forced', failure: { kind: 'timeout' | 'abort' | 'worker-exit', message: string }, streamText: string }
type Failure = Extract<CellOutcome, { outcome: 'forced' }>['failure']
interface Active {
  id: string
  opts: ExecuteCellOptions
  streamText: string
  started: boolean
  error?: { ename: string, evalue: string, traceback: string[] }
  pendingForce?: Failure
  resolve: (outcome: CellOutcome) => void
  timeout?: ReturnType<typeof setTimeout>
  force?: ReturnType<typeof setTimeout>
  detach?: () => void
  confirm?: ReturnType<typeof setTimeout>
  rejectCallbacks: Set<() => void>
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Historical class name retained for the runtime's private integration seam. */
export class IpyKernelBridge {
  private state: 'idle' | 'starting' | 'running' | 'shutdown' = 'idle'
  private child?: ChildProcess
  private startPromise?: Promise<void>
  private disposePromise?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private active?: Active
  private stderr = ''
  private deathFailure?: Failure
  private callbackServer?: Server
  private closePromise?: Promise<void>
  private readonly ownedReaders: ReturnType<typeof createInterface>[] = []

  constructor(private readonly options: KernelBridgeOptions) {}
  get pid(): number | undefined { return this.child?.pid }
  get isRunning(): boolean { return this.state === 'running' }
  get isDead(): boolean { return this.state === 'shutdown' }

  start(): Promise<void> {
    this.startPromise ??= this.doStart()
    return this.startPromise
  }

  private async windowsCallbacks(): Promise<Record<string, string>> {
    const token = randomBytes(32).toString('hex')
    const server = createServer((req, response) => {
      if (req.method !== 'POST' || req.url !== '/callback' || req.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(403).end()
        return
      }
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (data: string) => { body += data })
      req.on('end', () => {
        let parsed: unknown
        try { parsed = JSON.parse(body) } catch { response.writeHead(400).end(); return }
        void this.callback(parsed).then(reply => {
          if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
        })
      })
    })
    this.callbackServer = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('callback endpoint unavailable')
    return { BETTER_CALLBACK_URL: `http://127.0.0.1:${address.port}/callback`, BETTER_CALLBACK_TOKEN: token }
  }

  private async doStart(): Promise<void> {
    if (this.state !== 'idle') throw new Error('Python bridge cannot restart after shutdown')
    this.state = 'starting'
    try {
      const resources = fileURLToPath(new URL('./omp-python/', import.meta.url))
      const callbackEnv = process.platform === 'win32' ? await this.windowsCallbacks() : {}
      if (this.isDead) throw new Error('Python startup cancelled by disposal')
      const child = spawn(this.options.python, ['-u', fileURLToPath(new URL('./omp-python/runner.py', import.meta.url))], {
        ...this.options.cwd ? { cwd: this.options.cwd } : {},
        detached: process.platform !== 'win32',
        stdio: process.platform === 'win32' ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.options.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8',
          PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: [resources, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'), ...callbackEnv },
      })
      this.child = child
      this.closePromise = new Promise(resolve => child.once('close', () => resolve()))
      child.on('error', error => this.died(`Python process error: ${error.message}`))
      child.on('exit', (code, signal) => this.died(`Python process exited (${signal ?? code}); stderr: ${this.stderr.slice(-2048)}`))
      child.stdin?.on('error', error => this.died(`Python input pipe failed: ${error.message}`))
      child.stderr?.setEncoding('utf8').on('data', (data: string) => { this.stderr = (this.stderr + data).slice(-8192) })
      const frames = createInterface({ input: child.stdout! })
      this.ownedReaders.push(frames)
      frames.on('line', line => {
        try { this.frame(JSON.parse(line)) } catch { this.died('Python emitted invalid NDJSON protocol') }
      })
      if (process.platform !== 'win32') {
        const requests = createInterface({ input: child.stdio[3] as Readable })
        this.ownedReaders.push(requests)
        const replies = child.stdio[4] as Writable
        replies.on('error', () => { /* death/disposal closes callback pipes */ })
        requests.on('line', line => {
          let data: unknown
          try { data = JSON.parse(line) } catch { return }
          void this.callback(data).then(reply => {
            if (!replies.destroyed && !replies.writableEnded) replies.write(JSON.stringify(reply) + '\n')
          })
        })
      }
      const result = await this.perform(KERNEL_BOOTSTRAP + `\n__import__('better_snapshot').configure(${JSON.stringify(this.options.snapshotDirectory ?? '')}, ${this.options.snapshotSizeCapBytes ?? 268435456}, ${this.options.snapshotTimeoutMs})`, {
        timeoutMs: this.options.startupTimeoutMs, interruptGraceMs: 1_000, interruptConfirmMs: this.options.interruptConfirmMs,
      })
      if (result.outcome !== 'completed' || result.status !== 'ok') {
        throw new Error(`OMP Python initialization failed: ${JSON.stringify(result)}`)
      }
      if (this.isDead) throw new Error('Python exited during initialization')
      this.state = 'running'
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  private async callback(data: unknown): Promise<Record<string, unknown>> {
    const identity = record(data) ? { id: data.id, run: data.run } : {}
    const active = this.active
    if (!record(data) || !active || active.id !== data.run || active.pendingForce || !active.opts.hostRequestHandler) {
      return { ...identity, ok: false, message: 'host callback rejected: its cell is no longer active' }
    }
    const revoked = { ...identity, ok: false, message: 'host callback cancelled: its cell ended' }
    return new Promise(resolve => {
      let settled = false
      const finish = (reply: Record<string, unknown>): void => {
        if (settled) return
        settled = true
        active.rejectCallbacks.delete(reject)
        resolve(reply)
      }
      const reject = (): void => finish(revoked)
      active.rejectCallbacks.add(reject)
      // Calls are concurrent within the single active cell; every resolution
      // is checked again after user code or cancellation may have finished.
      void active.opts.hostRequestHandler!(data).then(reply => {
        finish(this.active === active && !active.pendingForce ? { ...identity, ...reply } : revoked)
      }, error => finish({ ...identity, ok: false, message: String(error) }))
    })
  }

  private frame(frame: unknown): void {
    if (!record(frame) || frame.id !== this.active?.id) return
    const active = this.active!
    if (frame.type === 'started') {
      active.started = true
      if (active.pendingForce) this.signal('SIGINT')
    } else if (frame.type === 'stdout' || frame.type === 'stderr') {
      if (typeof frame.data === 'string') active.streamText += frame.data
    } else if (frame.type === 'display' || frame.type === 'result') {
      // Rich displays remain explicit text when the runtime seam has no image field.
      if (record(frame.bundle)) {
        const text = frame.bundle['text/plain'] ?? frame.bundle['text/markdown'] ?? frame.bundle['text/html']
        if (typeof text === 'string') active.streamText += `${text}\n`
        else if (frame.bundle['application/json'] !== undefined) active.streamText += `${JSON.stringify(frame.bundle['application/json'])}\n`
        else active.streamText += `[Python display: ${Object.keys(frame.bundle).join(', ')}]\n`
      }
    } else if (frame.type === 'error') {
      active.error = { ename: String(frame.ename), evalue: String(frame.evalue),
        traceback: Array.isArray(frame.traceback) ? frame.traceback.map(String) : [] }
    } else if (frame.type === 'done') {
      this.settle(active.pendingForce
        ? { outcome: 'forced', failure: active.pendingForce, streamText: active.streamText }
        : { outcome: 'completed', status: frame.status === 'ok' ? 'ok' : 'error', streamText: active.streamText,
          ...active.error ? { cellError: active.error } : {} })
    }
  }

  executeCell(code: string, opts: ExecuteCellOptions): Promise<CellOutcome> {
    const task = this.queue.then(() => {
      if (!this.isRunning) return { outcome: 'forced' as const, failure: { kind: 'worker-exit' as const, message: 'Python is not running' }, streamText: '' }
      return this.perform(code, opts)
    })
    this.queue = task.catch(() => undefined)
    return task
  }

  private perform(code: string, opts: ExecuteCellOptions): Promise<CellOutcome> {
    if (opts.signal?.aborted) return Promise.resolve({ outcome: 'forced', failure: { kind: 'abort', message: String(opts.signal.reason) }, streamText: '' })
    return new Promise(resolve => {
      const active: Active = { id: randomUUID(), opts, streamText: '', started: false, resolve, rejectCallbacks: new Set() }
      this.active = active
      active.timeout = setTimeout(() => this.interrupt(active, { kind: 'timeout', message: `Python cell exceeded ${opts.timeoutMs}ms` }), opts.timeoutMs)
      if (opts.signal) {
        const signal = opts.signal
        const abort = (): void => this.interrupt(active, { kind: 'abort', message: String(signal.reason) })
        signal.addEventListener('abort', abort, { once: true })
        active.detach = () => signal.removeEventListener('abort', abort)
      }
      this.child?.stdin?.write(JSON.stringify({ id: active.id, code, ...this.options.cwd ? { cwd: this.options.cwd } : {} }) + '\n')
    })
  }

  private interrupt(active: Active, failure: Failure): void {
    if (this.active !== active || active.pendingForce) return
    active.pendingForce = failure
    for (const revoke of [...active.rejectCallbacks]) revoke()
    // Never signal an idle runner: defer until its started frame if necessary.
    if (active.started) this.signal('SIGINT')
    active.confirm = setTimeout(() => {
      if (this.active === active && active.started && active.pendingForce) this.signal('SIGINT')
    }, active.opts.interruptConfirmMs)
    active.force = setTimeout(() => {
      // A nonresponsive native operation cannot be left executing when the
      // queue advances. Reap the entire owned group before returning.
      void this.dispose()
    }, active.opts.interruptGraceMs)
  }

  private settle(outcome: CellOutcome): void {
    const active = this.active
    if (!active) return
    this.active = undefined
    clearTimeout(active.timeout)
    clearTimeout(active.force)
    clearTimeout(active.confirm)
    active.detach?.()
    for (const revoke of [...active.rejectCallbacks]) revoke()
    active.resolve(outcome)
  }

  private signal(signal: NodeJS.Signals): void {
    try { this.child?.kill(signal) } catch { /* already exited */ }
  }
  private killGroup(): void {
    const pid = this.child?.pid
    if (pid === undefined) return
    try {
      if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL')
      else this.child?.kill('SIGKILL')
    } catch { /* already reaped */ }
  }
  private died(message: string): void {
    this.state = 'shutdown'
    this.deathFailure ??= { kind: 'worker-exit', message }
    this.killGroup() // leader exit must also retire owned descendants
    // Exit is not close: callers settle only after close/drain in doDispose.
    void this.dispose()
  }

  private async internal(code: string, sentinel: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.executeCell(code, { timeoutMs: this.options.snapshotTimeoutMs, interruptGraceMs: 1_000, interruptConfirmMs: this.options.interruptConfirmMs })
    if (result.outcome !== 'completed' || result.status !== 'ok') return undefined
    try {
      const envelope: unknown = JSON.parse(extractStream(result.streamText, sentinel).envelope ?? '')
      return record(envelope) ? envelope : undefined
    } catch { return undefined }
  }
  async queryVar(name: string | null): Promise<QueryVarOutcome> {
    const sentinel = `__better_query_${randomBytes(12).toString('hex')}__`
    const reply = await this.internal(buildQueryVarCell(name, sentinel), sentinel)
    if (reply?.kind === 'names' && Array.isArray(reply.names)) return { kind: 'names', names: reply.names.filter((name): name is string => typeof name === 'string') }
    if (reply?.kind === 'missing') return { kind: 'missing' }
    if ((reply?.kind === 'json' || reply?.kind === 'repr') && typeof reply.text === 'string') return { kind: reply.kind, text: reply.text }
    return { kind: 'failed', reason: 'Python variable query failed' }
  }
  async setVar(name: string, valueJson: string): Promise<SetVarOutcome> {
    const sentinel = `__better_set_${randomBytes(12).toString('hex')}__`
    const reply = await this.internal(buildSetVarCell(name, valueJson, sentinel), sentinel)
    return reply?.ok === true ? { kind: 'ok' } : { kind: 'failed', reason: 'Python variable assignment failed' }
  }
  async snapshotState(payloadPath: string, manifestPath: string, spec: SnapshotSpec): Promise<SnapshotOutcome> {
    const sentinel = `__better_save_${randomBytes(12).toString('hex')}__`
    const reply = await this.internal(buildSnapshotCell(payloadPath, manifestPath, spec, sentinel), sentinel)
    if (reply?.kind === 'ok' && Array.isArray(reply.names) && typeof reply.sizeBytes === 'number' && typeof reply.turn === 'number' && record(reply.omitted)) {
      return { kind: 'ok', sizeBytes: reply.sizeBytes, names: reply.names as string[], omitted: reply.omitted as Record<string, string>, turn: reply.turn, ...typeof reply.warning === 'string' ? { warning: reply.warning } : {} }
    }
    if (reply?.kind === 'skipped') return { kind: 'skipped', reason: String(reply.reason), capBytes: spec.sizeCapBytes }
    return { kind: 'failed', reason: typeof reply?.reason === 'string' ? reply.reason : 'checkpoint helper timed out, failed, or exited; commit status could not be confirmed' }
  }
  async restoreState(payloadPath: string, manifestPath: string, bindings: string[] = []): Promise<RestoreStateOutcome> {
    const sentinel = `__better_restore_${randomBytes(12).toString('hex')}__`
    const reply = await this.internal(buildRestoreCell(payloadPath, manifestPath, sentinel, bindings), sentinel)
    if (reply?.kind === 'restored' && typeof reply.count === 'number' && typeof reply.turn === 'number' && record(reply.omitted)) {
      return { kind: 'restored', count: reply.count, turn: reply.turn, omitted: reply.omitted as Record<string, string> }
    }
    return { kind: 'degraded', reason: typeof reply?.reason === 'string' ? reply.reason : 'checkpoint restore helper failed or timed out' }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.doDispose()
    return this.disposePromise
  }
  private async doDispose(): Promise<void> {
    this.state = 'shutdown'
    const child = this.child
    if (!child) {
      this.callbackServer?.closeAllConnections()
      this.callbackServer?.close()
      return
    }
    const active = this.active
    // In-flight disposal or cancellation reaps immediately; idle shutdown
    // first asks the original runner to exit and bounds its drain.
    if (!active && child.exitCode === null && child.signalCode === null) {
      child.stdin?.end(JSON.stringify({ type: 'exit' }) + '\n')
      await this.waitClose(Math.min(200, this.options.disposeTimeoutMs))
    }
    this.killGroup()
    await this.waitClose(this.options.disposeTimeoutMs)
    if (this.active) this.settle({ outcome: 'forced', failure: this.active.pendingForce ?? this.deathFailure ?? { kind: 'worker-exit', message: 'Python disposed during cell execution' }, streamText: this.active.streamText })
    for (const reader of this.ownedReaders) reader.close()
    for (const stream of child.stdio) (stream as Readable | null)?.destroy()
    this.callbackServer?.closeAllConnections()
    this.callbackServer?.close()
    this.child = undefined
  }
  private async waitClose(ms: number): Promise<void> {
    if (!this.closePromise) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      void this.closePromise!.then(() => { clearTimeout(timer); resolve() })
    })
  }
}
