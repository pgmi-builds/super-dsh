/** Dual-SSH rsync native relay (spec: remote-native-shortcut).
 *
 * Route A (preferred): the destination runs a loopback-only temporary rsync
 * daemon; destination `ssh -L` exposes it on an origin port; source `ssh -R`
 * maps that port onto the source's loopback; the source's own native rsync
 * (inside its own SSH exec) then talks rsync-daemon protocol through
 * source-loopback → origin → destination. The origin only forwards rsync
 * protocol bytes — no staging; both identities stay on the origin; the
 * destination's existing file data feeds real delta matching.
 *
 * Route B (fallback when either forward is denied): two SSH exec standard
 * streams bridged bidirectionally in Node carrying one rsync protocol
 * conversation between native rsync peers (empirical; validated by the
 * no-forwarding fixture).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, createServer, type AddressInfo } from 'node:net'
import type { Readable } from 'node:stream'
import type { SshConnection } from './ssh-targets.ts'
import { runNative, type RunResult } from './native-copy.ts'

export interface RelayRsyncOptions {
  /** Test seam: wraps every spawned SSH/daemon argv (fixture isolation). */
  wrapArgv?: (argv: string[]) => string[]
  /** Test seam: fixed daemon port instead of ephemeral allocation. */
  ports?: { daemon: number }
  /** Test seam: skip route A (simulate denied forwarding). */
  forceStdioRoute?: boolean
}

export interface RelayRsyncResult extends RunResult {
  route: 'ssh-ssh-forward' | 'ssh-ssh-stdio'
  /** Lifecycle of tool-owned daemons/forwards: released, or unknown when a channel was lost. */
  cleanup: 'released' | 'unknown'
  /** SSH argv actually spawned (both ends; identity tokens as passed). */
  sshArgv: string[][]
}

interface RelayEndpoint { connection: SshConnection; path: string }

/** ssh argv for the relay: batch, no agent, no multiplexing. `command` is the
 * remote command; forwarding options go before `--`, the host after it. */
function relaySsh(connection: SshConnection, extra: readonly string[], command?: string): string[] {
  const args = ['ssh', '-o', 'BatchMode=yes', '-T', '-a', '-o', 'ForwardAgent=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2']
  if (connection.user !== undefined) args.push('-l', connection.user)
  if (connection.port !== undefined) args.push('-p', String(connection.port))
  if (connection.key !== undefined) args.push('-i', connection.key)
  if (connection.proxyJump !== undefined) args.push('-J', connection.proxyJump)
  args.push(...extra, '--', connection.host)
  if (command !== undefined) args.push(command)
  return args
}

async function freePorts(count: number): Promise<number[]> {
  const servers: import('node:net').Server[] = []
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer()
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
      await promise
      servers.push(server)
    }
    const ports = servers.map(server => (server.address() as AddressInfo).port)
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    return ports
  }
  finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  }
}

async function originPortOpen(port: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    if (await promise) return true
    if (Date.now() >= until) return false
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * Dual-SSH rsync. Forwarding route first; on forwarding denial the stdio
 * route; if both are unavailable the combined facts are reported — never a
 * full-copy fallback.
 */
export async function relayRsync(argv: string[], source: RelayEndpoint, destination: RelayEndpoint, signal: AbortSignal, options: RelayRsyncOptions = {}): Promise<RelayRsyncResult> {
  if (options.forceStdioRoute !== true) {
    try {
      return await forwardRoute(argv, source, destination, signal, options)
    }
    catch (error) {
      if (signal.aborted) throw signal.reason
      if (!forwardingDenied(error)) throw error
      try {
        return await stdioRoute(argv, source, destination, signal, options)
      }
      catch (stdioError) {
        if (signal.aborted) throw signal.reason
        throw new Error(`dual-SSH rsync unavailable: forwarding route denied (${error instanceof Error ? error.message : String(error)}); stdio route failed (${stdioError instanceof Error ? stdioError.message : String(stdioError)}); no full-copy fallback is performed`, { cause: stdioError })
      }
    }
  }
  return stdioRoute(argv, source, destination, signal, options)
}

/** Forwarding was actually refused by an endpoint (admin policy), not any other failure. */
function forwardingDenied(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}\n${String(error.cause ?? '')}` : String(error)
  return /administratively prohibited|forwarding failed|could not request (local|remote) forwarding|AllowTcpForwarding/i.test(text)
}

const OUTPUT_LIMIT = 512 * 1024

/** Bounded stdout/stderr capture for a child stream. */
function capture(stream: Readable | null, sink: { text: string; truncated: boolean }): (text: string) => void {
  const onText = (text: string) => { const value = sink.text + text; if (value.length > OUTPUT_LIMIT) sink.truncated = true; sink.text = value.slice(-OUTPUT_LIMIT) }
  stream?.setEncoding('utf8')
  stream?.on('data', onText)
  return onText
}

/** A held SSH child (forward/daemon carrier) with group shutdown and stderr. */
class Held {
  readonly child: ChildProcess
  private readonly done: Promise<void>
  readonly stderrSink = { text: '', truncated: false }
  private stopped = false
  constructor(argv: string[], private readonly signal: AbortSignal) {
    signal.throwIfAborted()
    this.child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    capture(this.child.stderr, this.stderrSink)
    this.done = new Promise<void>(resolve => { this.child.once('close', () => resolve()) })
  }
  async stop(): Promise<void> {
    if (this.stopped) { await this.done; return }
    this.stopped = true
    if (this.child.pid !== undefined) { try { process.kill(-this.child.pid, 'SIGTERM') } catch { /* already gone */ } }
    await Promise.race([this.done, new Promise(resolve => setTimeout(resolve, 3000))])
    if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid !== undefined) {
      try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    await this.done
  }
}

/**
 * Route A. Three SSH sessions, all origin-held:
 *  1. destination: -L + daemon script (daemon binds destination loopback only)
 *  2. source hold: -N -R maps origin daemon port onto source loopback
 *  3. source run: executes the native rsync client against its own loopback
 * rsync protocol bytes traverse source → origin → destination; nothing is
 * staged on the origin.
 */
async function forwardRoute(argv: string[], source: RelayEndpoint, destination: RelayEndpoint, signal: AbortSignal, options: RelayRsyncOptions): Promise<RelayRsyncResult> {
  signal.throwIfAborted()
  const wrap = options.wrapArgv ?? (value => value)
  // Three distinct ports: the daemon binds destination loopback, -L binds an
  // origin port, -R binds a source port. Even when endpoints share one host
  // (tests), no two bindings collide.
  const ports = options.ports?.daemon !== undefined
    ? [options.ports.daemon, ...await freePorts(2)]
    : await freePorts(3)
  const daemonPort = ports[0]!, originPort = ports[1]!, sourcePort = ports[2]!
  const destinationArgv = relaySsh(destination.connection, ['-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${originPort}:127.0.0.1:${daemonPort}`], daemonCommand(destination.path, daemonPort))
  const sourceHoldArgv = relaySsh(source.connection, ['-o', 'ExitOnForwardFailure=yes', '-N', '-R', `127.0.0.1:${sourcePort}:127.0.0.1:${originPort}`])
  const destinationChild = new Held(wrap(destinationArgv), signal)
  const sourceHold = new Held(wrap(sourceHoldArgv), signal)
  const remoteTempOf = (held: Held): string | undefined => /^SUPERD-RSYNC-TMP (\S+)$/m.exec(held.stderrSink.text)?.[1]
  const settle = async (): Promise<'released' | 'unknown'> => {
    await Promise.all([destinationChild.stop(), sourceHold.stop()])
    const temp = remoteTempOf(destinationChild)
    if (temp === undefined) return 'unknown'
    return (await removeRemoteTemp(destination.connection, temp, wrap)) ? 'released' : 'unknown'
  }
  try {
    signal.throwIfAborted()
    // The local -L listener comes up the moment the SSH session establishes, but the
    // daemon script may still die right after (destination directory missing → exit 64
    // at ~t+200ms). A single instantaneous liveness check loses that race (0.3.1-e's
    // attempt, 2026-10-14 user acceptance F4 re-test): instead wait for the script's own
    // SUPERD-RSYNC-TMP marker — printed AFTER the directory check and immediately before
    // the daemon exec — or its exit, whichever comes first.
    const daemonState = await waitForDaemonReady(destinationChild, 5000)
    if (daemonState === 'exited') {
      throw new Error(`dual-SSH rsync destination daemon exited before serving${relayDetail(destinationChild, sourceHold)}`)
    }
    if (daemonState === 'timeout') {
      throw new Error(`dual-SSH rsync destination daemon never announced readiness${relayDetail(destinationChild, sourceHold)}`)
    }
    signal.throwIfAborted()
    if (!await originPortOpen(originPort, 15000)) {
      throw new Error(`dual-SSH rsync destination daemon never became reachable${relayDetail(destinationChild, sourceHold)}`)
    }
    signal.throwIfAborted()
    // The source rsync client runs inside its own SSH exec session and dials
    // its own loopback forward; SSH session exit = rsync exit.
    const runArgv = relaySsh(source.connection, [], rsyncClientCommand(argv, source.path, sourcePort))
    const result = await runNative(wrap(runArgv), signal)
    if (result.exit !== 0) {
      // rsync ran on the source; its own diagnostics are in stdout/stderr. Any
      // non-zero exit gets the held-session stderr appended: the daemon script's
      // own messages (missing dir, daemon errors) live there and otherwise never
      // reach the caller. 255 additionally means the SSH session layer failed.
      result.stderr = (result.stderr + relayDetail(destinationChild, sourceHold)).slice(-OUTPUT_LIMIT)
    }
    // A refused forward surfaces as a failing rsync client with the ssh
    // session stderr naming the refusal: escalate so the caller can pick the
    // stdio route instead of misreading a connection error as "rsync broken".
    if (result.exit !== 0 && /remote port forwarding failed|administratively prohibited|could not request (local|remote) forwarding/.test(relayDetail(destinationChild, sourceHold))) {
      throw new Error(`dual-SSH rsync forwarding route refused by an endpoint: ${relayDetail(destinationChild, sourceHold)}`)
    }
    return { ...result, route: 'ssh-ssh-forward', cleanup: await settle(), sshArgv: [destinationArgv, sourceHoldArgv, runArgv] }
  }
  catch (error) {
    // Failure and abort paths remove the remote temp dir too (bounded by the
    // cleanup session's own 10s timeout) before propagating.
    await settle().catch(() => 'unknown' as const)
    if (signal.aborted) throw signal.reason
    const detail = relayDetail(destinationChild, sourceHold)
    if (detail) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message}${message.includes('[relay stderr]') ? '' : detail}`, { cause: error })
    }
    throw error
  }
  finally {
    await Promise.allSettled([destinationChild.stop(), sourceHold.stop()])
  }
}

/** Wait until the destination daemon script announces itself (stderr marker,
 *  printed after its directory check and right before the daemon exec) or exits.
 *  'ready' only when the daemon is actually about to serve — closes the 0.3.1-e
 *  race where -L opens at session start but the script dies ~150ms later. */
export async function waitForDaemonReady(held: { stderrSink: { text: string }; child: { exitCode: number | null } }, budgetMs: number): Promise<'ready' | 'exited' | 'timeout'> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (/^SUPERD-RSYNC-TMP \S+$/m.test(held.stderrSink.text)) return 'ready'
    if (held.child.exitCode !== null) return 'exited'
    if (Date.now() >= deadline) return 'timeout'
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function relayDetail(...held: readonly Held[]): string {
  const detail = held.map(child => child.stderrSink.text).filter(Boolean).join('\n')
  return detail ? `\n[relay stderr]\n${detail}` : ''
}

function daemonCommand(targetPath: string, port: number): string {
  if (/[\r\n]/.test(targetPath)) throw new Error('dual-SSH rsync refuses newline-bearing destination paths (no daemon config injection)')
  return `set -eu
[ -d ${shellQuote(targetPath)} ] || { echo 'dual-SSH rsync destination directory does not exist' >&2; exit 64; }
umask 077
tmp=$(mktemp -d "\${TMPDIR:-/tmp}/superd-rsync.XXXXXXXX")
# The origin reads this marker from held stderr and stops the daemon + removes
# the directory over a dedicated cleanup session: killing the local ssh cannot
# rely on remote traps (a dropped connection terminates the remote session
# without HUP), and an unreaped daemon keeps its loopback port open.
printf 'SUPERD-RSYNC-TMP %s\\n' "$tmp" >&2
printf '%s\\n' 'use chroot = no' 'read only = no' 'munge symlinks = yes' 'hosts allow = 127.0.0.1' 'hosts deny = *' 'pid file = '"$tmp"'/rsyncd.pid' '[task]' ${shellQuote('path = ' + targetPath)} > "$tmp/rsyncd.conf"
exec rsync --daemon --no-detach --address=127.0.0.1 --port=${port} --config="$tmp/rsyncd.conf"
`
}

/** Best-effort teardown of the remote daemon (pidfile kill) and its temp dir
 * over its own SSH session; identities stay origin-held. Returns whether the
 * whole teardown is confirmed. */
async function removeRemoteTemp(connection: SshConnection, path: string, wrap: (argv: string[]) => string[]): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  const script = `if [ -f ${shellQuote(path + '/rsyncd.pid')} ]; then
  p=$(cat ${shellQuote(path + '/rsyncd.pid')})
  kill "$p" 2>/dev/null || :
  i=0; while kill -0 "$p" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i+1)); done
  kill -9 "$p" 2>/dev/null || :
fi
rm -rf ${shellQuote(path)}`
  try {
    const result = await runNative(wrap(relaySsh(connection, [], script)), controller.signal)
    return result.exit === 0
  }
  catch { return false }
  finally { clearTimeout(timer) }
}

function rsyncClientCommand(argv: string[], sourcePath: string, port: number): string {
  return `exec rsync ${argv.map(shellQuote).join(' ')} -- ${shellQuote(sourcePath)} rsync://127.0.0.1:${port}/task/`
}

function shellQuote(value: string): string {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(value) ? `'${value.replaceAll("'", `'\\''`)}'` : value
}

/**
 * Route B (empirical verdict): a Node bidirectional bridge of two SSH exec
 * standard streams carrying one rsync protocol conversation. The design was
 * validated with local processes (source rsync client + fd-dup adapter +
 * `rsync --server --daemon .` receiver, full transfer with real delta), but
 * under real OpenSSH sessions the source-side combination (rsync client in an
 * exec session + fd-dup adapter) makes ssh tear down the session's stdin
 * channel ("channel 0: read failed ... Broken pipe" then EOF), starving the
 * protocol's return path before any byte of rsync protocol flows. Shell-level
 * adjustments (closing fd 0 for the client, dropping -T/keepalives) did not
 * change this on OpenSSH 10.2 + rsync 3.4.1. Per the spec this route reports
 * itself unavailable on such combinations instead of degrading into two
 * ordinary rsyncs or a full copy: the origin would stage the whole source and
 * the destination's existing data could not feed delta matching.
 */
async function stdioRoute(argv: string[], source: RelayEndpoint, destination: RelayEndpoint, signal: AbortSignal, options: RelayRsyncOptions): Promise<RelayRsyncResult> {
  signal.throwIfAborted()
  void argv; void source; void destination; void options
  throw new Error('dual-SSH rsync stdio route unavailable on this SSH/rsync combination: the source-side rsync client with a stdio adapter causes the SSH session stdin channel to be torn down before the rsync protocol starts (validated locally without SSH; fails under OpenSSH 10.2 + rsync 3.4.1). No full-copy fallback is performed')
}

