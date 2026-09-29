// The remote PTY executor — the DUMB side of spec §8.2 (~a hundred lines by
// design): one accepted WebSocket = one `script -qfec bash /dev/null` (host
// PTY, no node-pty) with a bidirectional byte pump. All session intelligence
// (nonce init/framing, two-stage interrupt, idle TTL) lives on the INITIATOR
// side (exec-pty-session.ts over exec-pty-channel.ts) — the executor never
// parses the stream. Protocol: text frames carry stdin/stdout bytes; the
// child's exit is announced as one JSON control frame `{"op":"exit","code":N}`
// before the socket closes; WS close (any reason) group-kills the child.
//
// Auth/trust: the same gate as the /hub family — connection.authorizeIndex
// (cookie) FIRST, then the browser-trust fence (requestRejection) — an
// upgrade is never weaker than its sibling HTTP routes (hub-route precedent).
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import type { A2aLogFn } from './a2a-log.js'

/** The exact upgrade path this executor claims. */
export const PTY_EXEC_PATH = '/api/superd/exec/pty'

/** Structural view of the `ws` module (runtime peer — world-mux precedent). */
interface WsServerLike {
  handleUpgrade(req: unknown, socket: unknown, head: Buffer, cb: (client: WsClientLike) => void): void
}
interface WsClientLike {
  send(data: string): void
  close(): void
  terminate(): void
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}
interface WsModuleLike { WebSocketServer: new (opts: { noServer: boolean }) => WsServerLike }

const WS_MODULE: string = 'ws'

async function loadWsServer(): Promise<WsModuleLike> {
  const require = createRequire(import.meta.url)
  const mod: unknown = require(WS_MODULE)
  const boxed = mod as WsModuleLike & { default?: WsModuleLike }
  return typeof (mod as WsModuleLike).WebSocketServer === 'function' ? (mod as WsModuleLike) : boxed.default!
}

const REASON_PHRASE: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' }

function rejectUpgrade(socket: unknown, status: number, body: string): void {
  const writable = socket as { write?: (chunk: string) => unknown; destroy?: () => void }
  writable.write?.(
    `HTTP/1.1 ${status} ${REASON_PHRASE[status] ?? 'Rejected'}\r\n`
    + 'Connection: close\r\n'
    + `Content-Type: application/json\r\n`
    + `Content-Length: ${String(Buffer.byteLength(body, 'utf8'))}\r\n\r\n`
    + body,
  )
  writable.destroy?.()
}

export interface PtyExecutorOptions {
  /** The ctx0 auth gate (connection.authorizeIndex) — cookie auth comes first. */
  authorize(req: unknown, res: unknown): boolean
  /** The ctx0 browser-trust fence (connection.requestRejection): Host/Origin policy. */
  requestRejection?(req: unknown): number | undefined
  log?: A2aLogFn
}

/** One connection = one dumb PTY pump. */
function runPump(client: WsClientLike, log?: A2aLogFn): void {
  let child: ChildProcess | null = null
  let closed = false
  const killTree = (): void => {
    const pid = child?.pid
    child = null
    if (pid === undefined) return
    try { process.kill(-pid, 'SIGTERM') } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }, 2_000).unref()
  }
  try {
    child = spawn('script', ['-qfec', 'bash', '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  } catch (err) {
    log?.('warn', 'exec.pty.spawn-failed', { error: err instanceof Error ? err.message : String(err) })
    try { client.send(JSON.stringify({ op: 'spawn-error', error: 'script spawn failed' })); client.close() } catch { /* closing */ }
    return
  }
  const started = Date.now()
  log?.('info', 'exec.pty.start', { pid: child.pid ?? 'none' })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (d: string) => { if (!closed) { try { client.send(d) } catch { /* closing */ } } })
  child.stderr?.setEncoding('utf8')
  child.once('close', (code) => {
    if (closed) return
    closed = true
    log?.('info', 'exec.pty.exit', { code: code ?? 'none', durationMs: Date.now() - started })
    try { client.send(JSON.stringify({ op: 'exit', code })); client.close() } catch { /* already closing */ }
    killTree()
  })
  client.on('message', (data) => {
    const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBufferLike).toString('utf8')
    if (child?.stdin?.writable === true) { try { child.stdin.write(text) } catch { /* dead */ } }
  })
  const shutdown = (): void => { closed = true; killTree() }
  client.on('close', shutdown)
  client.on('error', shutdown)
}

/**
 * Register the PTY executor's upgrade route on the REAL webserver face
 * (ctx0 only — gateway.ts's `webServer` inject scope, the /hub family's
 * sibling). @returns the dispose fn.
 */
export async function registerPtyExecutor(
  real: { registerUpgrade(route: { path: string; handler: (req: unknown, socket: unknown, head: Buffer) => void }): unknown },
  opts: PtyExecutorOptions,
): Promise<() => void> {
  const ws = await loadWsServer()
  const server = new ws.WebSocketServer({ noServer: true })
  const handler = (req: unknown, socket: unknown, head: Buffer): void => {
    // auth first, then trust fence — identical ordering to the /hub family
    let status = 401
    let body = ''
    const admitted = opts.authorize(req, {
      writeHead: (answered: number) => { status = answered },
      end: (chunk?: unknown) => { if (chunk !== undefined && chunk !== null) body = String(chunk) },
    })
    if (!admitted) { rejectUpgrade(socket, status, body !== '' ? body : JSON.stringify({ error: 'unauthorized' })); return }
    const rejection = opts.requestRejection?.(req)
    if (rejection !== undefined) {
      rejectUpgrade(socket, rejection, JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
      return
    }
    server.handleUpgrade(req, socket, head, (client) => runPump(client, opts.log))
  }
  return real.registerUpgrade({ path: PTY_EXEC_PATH, handler }) as () => void
}
