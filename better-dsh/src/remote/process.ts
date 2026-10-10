import { type Readable, type Writable } from 'node:stream'
import { spawn } from 'node:child_process'
import { ByteTailRing, Utf16TailRing } from './output-ring.ts'
import type { RemoteProcess } from './hub-contract.ts'

const TERM_GRACE_MS = 2000
const KILL_SETTLE_MS = 100
export const PROCESS_CLEANUP_BOUND_MS = TERM_GRACE_MS + KILL_SETTLE_MS

export interface ProcessOptions {
  stdin?: string; timeoutSec?: number; cwd?: string
  /** Hub retains raw bytes; native transports retain decoded UTF16 units. */
  unit?: 'bytes' | 'utf16'
  onOutput?: () => void
}

/** Real detached process. Completion includes group cleanup, even after its leader closes. */
export function startBinaryProcess(argv: string[], options: Pick<ProcessOptions, 'cwd' | 'timeoutSec'> = {}): { stdout: Readable; stderr: Readable; stdin: Writable; cancel(): void; done: RemoteProcess['done']; diagnostic(): string | undefined } {
  const started = Date.now()
  const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  let diagnostic: string | undefined
  let timedOut = false, finished = false, cancelled = false
  let cleanup: Promise<void> | undefined
  let timer: NodeJS.Timeout | undefined
  const signal = (sig: NodeJS.Signals | 0): boolean => {
    if (child.pid === undefined) return false
    try { process.kill(-child.pid, sig); return true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') diagnostic = `remote: process cleanup failed: ${String(error)}`
      return false
    }
  }
  let closed!: () => void
  const close = new Promise<void>(resolve => { closed = resolve })
  const reap = (): Promise<void> => cleanup ??= new Promise(resolve => {
    if (!signal('SIGTERM')) { resolve(); return }
    let settled = false
    const finish = () => { if (!settled) { settled = true; clearTimeout(grace); resolve() } }
    const grace = setTimeout(() => { signal('SIGKILL'); setTimeout(finish, KILL_SETTLE_MS) }, TERM_GRACE_MS)
    void close.then(() => { if (!signal(0)) finish() })
  })
  const cancel = () => { if (!finished) { cancelled = true; void reap() } }
  child.stdin.on('error', () => {})
  child.once('error', error => { diagnostic = `exec: spawn failed — ${error.message}${options.cwd === undefined ? '' : ` (cwd: ${options.cwd})`}` })
  const done: RemoteProcess['done'] = new Promise(resolve => {
    child.once('close', async exit => {
      closed()
      if (timer) clearTimeout(timer)
      await reap()
      finished = true
      resolve({ exit: diagnostic ? null : exit, timedOut, cancelled, durationMs: Date.now() - started })
    })
  })
  if (options.timeoutSec !== undefined) timer = setTimeout(() => { timedOut = true; cancel() }, options.timeoutSec * 1000)
  return { cancel, done, stdout: child.stdout, stderr: child.stderr, stdin: child.stdin, diagnostic: () => diagnostic }
}

/** Text adapter over the same owned process-group lifecycle as binary pipelines. */
export function startOneShot(argv: string[], options: ProcessOptions = {}): RemoteProcess {
  const child = startBinaryProcess(argv, options)
  const byteMode = options.unit === 'bytes'
  const stdout = byteMode ? new ByteTailRing() : new Utf16TailRing()
  const stderr = byteMode ? new ByteTailRing() : new Utf16TailRing()
  for (const [stream, ring] of [[child.stdout, stdout], [child.stderr, stderr]] as const) {
    if (!byteMode) stream.setEncoding('utf8')
    stream.on('data', (chunk: Buffer | string) => {
      if (ring instanceof ByteTailRing) ring.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      else ring.push(String(chunk))
      options.onOutput?.()
    })
  }
  child.stdin.end(options.stdin)
  return {
    cancel: child.cancel, done: child.done,
    read(channel, fromByte) {
      const ring = channel === 'stdout' ? stdout : stderr
      const read = ring.read(fromByte), diagnostic = child.diagnostic()
      return { ...read, stats: ring.stats(byteMode ? Buffer.byteLength(read.text) : read.text.length), ...(channel === 'stderr' && diagnostic ? { diagnostic } : {}) }
    },
  }
}
