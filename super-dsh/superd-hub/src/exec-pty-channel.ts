// PTY channels — the ONE seam spec §8.2 carves out of better-dsh's
// PtySession: the session machinery (nonce injection, framing, two-stage
// interrupt, idle TTL) is transport-agnostic; only {open, write, kill} differ
// between "a local `script -qfec` subprocess" (this machine as target) and
// "a WebSocket to the peer's dumb PTY executor" (a paired machine as target).
//
// The WS client follows mesh-gateway's crash-proofing lesson: an 'error'
// listener is ALWAYS registered (ECONNREFUSED / a rejected 401 upgrade would
// otherwise be an uncaught exception), and sends before 'open' queue in
// order while post-close sends are swallowed (the session's death path owns
// the teardown).
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'

/** The transport seam the ported PtySession drives (spec §8.2: {write, onData, kill}). */
export interface PtyChannel {
  /** Open the transport; resolves when bytes can flow (session readiness itself = the init nonce frame). */
  open(onData: (chunk: string) => void): Promise<void>
  write(s: string): void
  /** Polite close (dispose path: 'exit\n' already sent by the session). */
  close(): void
  /** Hard kill: the transport AND any process group behind it (Ruling 8 fallback). */
  kill(): void
  /** Register for unexpected transport death (socket cut / process exit). */
  onDead(callback: () => void): void
  /** Diagnostics tail (transport stderr / socket errors) for init-failure messages. */
  readonly diag: string
}

/** Local target: `script -qfec bash /dev/null` — host-side PTY, no node-pty (spec §8.2 / D12). */
export class LocalScriptChannel implements PtyChannel {
  diag = ''
  private proc: ChildProcess | null = null
  private deadCb: (() => void) | undefined

  constructor(private readonly argv: string[] = ['script', '-qfec', 'bash', '/dev/null']) { }

  async open(onData: (chunk: string) => void): Promise<void> {
    const proc = spawn(this.argv[0]!, this.argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    this.proc = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (d: string) => onData(d))
    proc.stderr.setEncoding('utf8').on('data', (d: string) => { this.diag = (this.diag + d).slice(-2_000) })
    proc.once('close', () => this.deadCb?.())
    proc.once('error', (err) => { this.diag = (this.diag + `\n[pty: spawn failed: ${err.message}]`).slice(-2_000); this.deadCb?.() })
  }

  write(s: string): void {
    if (this.proc?.stdin?.writable !== true) return
    try { this.proc.stdin.write(s) } catch { /* dead: the death callback settles the session */ }
  }

  close(): void {
    this.write('exit\n')
    const pid = this.proc?.pid
    this.proc = null
    if (pid === undefined) return
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }, 1_000).unref()
  }

  kill(): void {
    const pid = this.proc?.pid
    this.proc = null
    if (pid === undefined) return
    try { process.kill(-pid, 'SIGTERM') } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }, 2_000).unref()
  }

  onDead(callback: () => void): void { this.deadCb = callback }
}

/** Structural view of the `ws` client socket (runtime peer — mesh-gateway precedent). */
interface WsSocketLike {
  send(data: unknown): void
  terminate(): void
  close(): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
}
type WsConstructorLike = new (url: string, options: { headers: Record<string, string> }) => WsSocketLike

const WS_MODULE: string = 'ws'
let wsConstructor: WsConstructorLike | undefined

function loadWs(): WsConstructorLike {
  if (wsConstructor !== undefined) return wsConstructor
  const require = createRequire(import.meta.url)
  const mod: unknown = require(WS_MODULE)
  const boxed = mod as { default?: unknown }
  wsConstructor = (typeof mod === 'function' ? mod : boxed.default) as WsConstructorLike
  return wsConstructor
}

/** Remote target: a WebSocket to the peer hub's dumb PTY executor, pairing Cookie riding the upgrade. */
export class WsPtyChannel implements PtyChannel {
  diag = ''
  private socket: WsSocketLike | null = null
  private deadCb: (() => void) | undefined
  private readonly pending: string[] = []
  private opened = false

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly wsCtor: WsConstructorLike | undefined = undefined,
  ) { }

  open(onData: (chunk: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let socket: WsSocketLike
      try {
        socket = new (this.wsCtor ?? loadWs())(this.url, { headers: this.headers })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      this.socket = socket
      // crash-proof by construction (mesh-gateway fix-round-1 lesson): 'error'
      // ALWAYS has a listener; 'close' is guaranteed to follow and the dead
      // path owns the teardown.
      socket.on('error', (err) => { this.diag = (this.diag + `\n[pty-ws: ${err instanceof Error ? err.message : String(err)}]`).slice(-2_000) })
      socket.on('open', () => {
        if (settled) return
        settled = true
        this.opened = true
        for (const chunk of this.pending.splice(0)) socket.send(chunk)
        resolve()
      })
      socket.on('message', (data) => {
        const text = typeof data === 'string'
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data as ArrayBufferLike).toString('utf8')
        onData(text)
      })
      socket.on('close', () => {
        if (!settled) { settled = true; reject(new Error(`pty-ws: socket closed before opening${this.diag !== '' ? `; ${this.diag}` : ''}`)); return }
        this.opened = false
        this.deadCb?.()
      })
    })
  }

  write(s: string): void {
    if (this.socket === null) return
    if (!this.opened) { this.pending.push(s); return }
    try { this.socket.send(s) } catch { /* dead: the close path settles the session */ }
  }

  close(): void {
    try { this.socket?.close() } catch { /* already closing */ }
  }

  kill(): void {
    try { this.socket?.terminate() } catch { /* already gone */ }
  }

  onDead(callback: () => void): void { this.deadCb = callback }
}
