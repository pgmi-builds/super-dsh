import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { leaseHelperCommand, recoveryHelperCommand } from './ssh-lease.ts'
import { EventEmitter } from 'node:events'
import { startBinaryProcess } from './process.ts'
import { sshArgv, type SshConnection } from './ssh-targets.ts'
import { shQuote } from './transports.ts'
import { SOURCE_PROXY_HELPER, startSourceProxy } from './ssh-source-proxy.ts'

export type SshBuilder = typeof sshArgv
/** Native container exec owns the same clock/control/recovery protocol without SSH flags. */
export interface NativeCommandTransport { commandArgv(command: string): string[] }
type OwnerTransport = SshConnection | NativeCommandTransport
export interface CommandResult { exit: number | null; stdout: string; stderr: string; outputTruncated: boolean }
export const RELAY_SSH_OPTIONS = ['-a', '-o', 'ForwardAgent=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'] as const
const OUTPUT_LIMIT = 2 * 1024 * 1024

const LEASE_MS = 8000
const RENEW_STEP_MS = 2000
// Monotonic control/publish ticks, TERM/KILL/reap and ordinary scheduling margin.
const REMOTE_CLEANUP_MS = 3500
const marker = (token: string, kind: string) => `__SUPERD_RSYNC_${token}_${kind}__`

/** Existing origin group ownership plus the independently accounted remote barrier. */
class Command {
  readonly child: ReturnType<typeof startBinaryProcess>
  readonly events = new EventEmitter()
  stdout = ''; stderr = ''; truncated = false
  private renew: ReturnType<typeof setInterval> | undefined
  private stopping = false
  private prepared = false
  private exit: number | null | undefined
  private readonly argv: string[]
  private acknowledged = false
  private stopPromise: Promise<void> | undefined
  cleanupDeadline = 0
  constructor(argv: string[], private readonly signal: AbortSignal, readonly token?: string, private readonly recover?: () => Promise<void>) {
    signal.throwIfAborted()
    this.argv = argv
    this.child = startBinaryProcess(argv)
    for (const channel of ['stdout', 'stderr'] as const) {
      this.child[channel].setEncoding('utf8')
      this.child[channel].on('data', (text: string) => {
        const value = this[channel] + text
        if (value.length > OUTPUT_LIMIT) this.truncated = true
        this[channel] = value.slice(-OUTPUT_LIMIT)
        if (token && channel === 'stderr') {
          if (!this.prepared && this.stderr.includes(marker(token, 'PREPARED'))) {
            this.prepared = true
            // Receipt follows receiver preparation; no synchronized clocks required.
            this.cleanupDeadline = performance.now() + LEASE_MS + REMOTE_CLEANUP_MS
            if (!this.stopping && !signal.aborted) {
              this.child.stdin.write('START\n')
              this.renew = setInterval(() => {
                if (this.stopping || this.child.stdin.destroyed) return
                // Count BEFORE dispatch, including buffered, delayed or lost frames.
                this.cleanupDeadline += RENEW_STEP_MS
                this.child.stdin.write('KEEP\n')
              }, RENEW_STEP_MS)
            }
          }
          if (this.stderr.includes(marker(token, 'CLEANED'))) this.acknowledged = true
        }
        this.events.emit('change')
      })
    }
    if (!token) this.child.stdin.end()
    signal.addEventListener('abort', this.abort, { once: true })
    if (signal.aborted) this.abort()
    void this.child.done.then(result => { this.exit = result.exit; this.quiesce(); signal.removeEventListener('abort', this.abort); this.events.emit('change') })
  }
  quiesce(): void { this.stopping = true; if (this.renew) clearInterval(this.renew) }
  send(line: string): void {
    this.signal.throwIfAborted()
    if (this.stopping || this.child.stdin.destroyed) throw new Error('SSH relay admission closed')
    this.child.stdin.write(line + '\n')
  }
  stderrOutput(): string {
    return this.token ? this.stderr.replace(new RegExp(`^__SUPERD_RSYNC_${this.token}_(?:PREPARED|CLEANED)__[^\n]*\n?`, 'gm'), '') : this.stderr
  }
  private readonly abort = () => {
    this.quiesce()
    // Leased SSH transports stay up until their ORDERED stop; local exit is not an ACK.
    if (!this.token) { this.child.stdin.end(); this.child.cancel() }
    this.events.emit('change')
  }
  private async change(ms: number): Promise<void> {
    await new Promise<void>(resolve => {
      const timer = setTimeout(finish, ms), self = this
      function finish() { clearTimeout(timer); self.events.off('change', finish); resolve() }
      this.events.once('change', finish)
    })
  }
  async result(): Promise<CommandResult> {
    this.signal.throwIfAborted()
    let rejectAbort!: () => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(this.signal.reason) })
    this.signal.addEventListener('abort', rejectAbort, { once: true })
    let result: Awaited<typeof this.child.done>
    try { result = await Promise.race([this.child.done, aborted]) }
    finally { this.signal.removeEventListener('abort', rejectAbort) }
    this.signal.throwIfAborted()
    const stderr = this.stderrOutput() + (this.child.diagnostic() ? '\n' + this.child.diagnostic() : '')
    return { exit: result.exit, stdout: this.stdout, stderr: stderr.slice(-OUTPUT_LIMIT), outputTruncated: this.truncated || stderr.length > OUTPUT_LIMIT }
  }
  async ready(pattern: RegExp, timeoutMs = 10000): Promise<RegExpExecArray> {
    let ended = false
    void this.child.done.then(() => { ended = true })
    const until = Date.now() + timeoutMs
    for (;;) {
      this.signal.throwIfAborted()
      const match = pattern.exec(this.stdout)
      if (match) return match
      if (ended || Date.now() >= until) {
        const status = ended ? `exit ${(await this.child.done).exit}` : 'timeout'
        throw new Error(`SSH relay readiness failed (${status}): ${this.stderrOutput() || this.child.diagnostic() || 'no SSH ownership readiness greeting'}`)
      }
      await this.change(40)
    }
  }
  stop(): Promise<void> {
    return this.stopPromise ??= this.stopOwned()
  }
  private rejectedBeforeRemoteAdmission(): boolean {
    if (this.prepared || this.acknowledged) return false
    if (this.exit !== 255) return false
    // Positive native pre-command failures only; never classify generic SSH255/close.
    const lines = this.stderr.split('\n').map(line => line.replace(/\r$/, ''))
    if (lines.some(line => /^ssh: connect to host [^\r\n]+ port [0-9]+: (?:Connection refused|No route to host|Network is unreachable|Connection timed out)$/.test(line))) return true
    if (lines.some(line => /^[^\r\n ]+@[^\r\n ]+: Permission denied \((?:publickey|keyboard-interactive|password)(?:,[a-z-]+)*\)\.$/.test(line))) return true
    const forward = this.argv[this.argv.indexOf('-L') + 1]
    const local = forward && /^127\.0\.0\.1:([0-9]+):/.exec(forward)?.[1]
    return !!local && this.argv.includes('ExitOnForwardFailure=yes') && lines.includes(`bind [127.0.0.1]:${local}: Address already in use`) && lines.includes('Could not request local forwarding.')
  }
  private async stopOwned(): Promise<void> {
    this.quiesce()
    if (!this.child.stdin.destroyed) this.child.stdin.end('STOP\n')
    // No receipt means the inner lease is not yet established. A live channel
    // retains observation; a closed channel needs the receiving entry fence and
    // exclusive cohort lock proof, never local exit or elapsed time alone.
    while (this.token && !this.prepared && !this.acknowledged && !this.rejectedBeforeRemoteAdmission()) {
      if (this.exit !== undefined && this.recover) { await this.recover(); this.acknowledged = true }
      else await this.change(100)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.child.done, new Promise<void>(resolve => { timer = setTimeout(() => { this.child.cancel(); resolve() }, 2500) })])
      await this.child.done
      // START is sent only after preparation receipt. A missing receipt cannot admit work.
      while (this.prepared && !this.acknowledged && performance.now() < this.cleanupDeadline)
        await this.change(Math.min(100, this.cleanupDeadline - performance.now()))
    } finally { if (timer) clearTimeout(timer) }
  }
}

/** Native groups plus one owned monotonic clock/control coprocess. */
const supervisor = (leased = true, token?: string) => `set -eu
set -m
pid=
clockPid=
tmp=
ack=${token ? shQuote(marker(token, 'CLEANED')) : "''"}
extraCleanup() { :; }
cleanup() {
  trap - EXIT
  trap '' HUP INT TERM # A second gate/lease signal cannot interrupt cleanup or its final ACK.
  extraCleanup
  for child in $pid $clockPid $(jobs -pr); do
    kill -TERM -- "-$child" 2>/dev/null || :
    sleep .1
    kill -KILL -- "-$child" 2>/dev/null || :
    wait "$child" 2>/dev/null || :
    while kill -0 -- "-$child" 2>/dev/null; do sleep .02; done
  done
  if [ -n "$tmp" ]; then rm -rf -- "$tmp"; fi
  if [ -n "$ack" ]; then printf '%s\n' "$ack" >&2; fi
}
trap cleanup EXIT
trap 'exit 125' HUP INT TERM
${leased ? 'exec {leaseInput}<&0' : ''}
coproc CLOCK { ${leaseHelperCommand(leased ? 'lease-clock' : 'clock')}${leased ? ' 3<&$leaseInput' : ''}; }
clockPid=$CLOCK_PID
exec {clockRead}<&\${CLOCK[0]}
exec {clockWrite}>&\${CLOCK[1]}
${leased ? 'exec {leaseInput}<&-' : ''}
now=0
phase=prepared
leaseEnd=0
renewCount=0
clock() {
  previous=$now
  printf 'QUERY\n' >&$clockWrite || { echo 'rsync monotonic clock pipe failed; admission closed' >&2; exit 125; }
  IFS=' ' read -r now incomingEnd incomingCount incomingPhase <&$clockRead || { echo 'rsync monotonic clock EOF; admission closed' >&2; exit 125; }
  [[ "$now" =~ ^[0-9]+$ ]] && [ "$now" -ge "$previous" ] || { echo 'invalid monotonic rsync clock; admission closed' >&2; exit 125; }
  ${leased ? `[[ "$incomingEnd" =~ ^[0-9]+$ ]] && [[ "$incomingCount" =~ ^[0-9]+$ ]] || exit 125
  leaseEnd=$incomingEnd
  renewCount=$incomingCount
  phase=$incomingPhase
  [ "$phase" = prepared ] || [ "$phase" = active ] || exit 125` : ''}
}
publish() { :; }
control() {
  clock
  [ "$phase" = active ] || return 1
  publish
  sleep .1
}
`

const leasedCommand = (script: string, token: string) => 'bash -c ' + shQuote(supervisor(true, token) + `clock
[ "$phase" = prepared ] && [ "$now" -lt "$leaseEnd" ] && [ "$leaseEnd" -le $((now + 8000)) ] || { echo "native supervisor: prepared fence failed now=$now leaseEnd=$leaseEnd phase=$phase" >&2; exit 125; }
printf '%s\n' ${shQuote(marker(token, 'PREPARED'))} >&2
while :; do clock; [ "$phase" = prepared ] || break; sleep .02; done
[ "$phase" = active ] || { echo "native supervisor: admission not activated phase=$phase now=$now leaseEnd=$leaseEnd" >&2; exit 125; }
` + script)
async function startRecoverable(connection: OwnerTransport, command: string, token: string, signal: AbortSignal, ssh: SshBuilder, extra: readonly string[] = []): Promise<Command> {
  const clock = await runCommand(commandArgv(connection, 'bash -c '+shQuote('(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 1) ))')+' && '+recoveryHelperCommand('recovery-clock'), ssh), signal)
  if (clock.exit !== 0) throw new Error(`native receiving recovery prerequisite failed: Bash4.1+, Python3.7+ (macOS3.10+), Unix fcntl.flock and shared monotonic clock required: ${clock.stderr}`)
  const value = JSON.parse(clock.stdout) as { tick: number; base: string }
  if (!Number.isSafeInteger(value.tick) || value.tick < 0 || typeof value.base !== 'string' || !value.base.startsWith('/') || /[\0\r\n]/.test(value.base)) throw new Error('invalid rsync receiving recovery clock')
  const gate = { root: value.base.replace(/\/$/, '') + '/superd-rsync-recovery.' + token, since: value.tick, cutoff: value.tick + LEASE_MS, token }
  const recover = async () => {
    // Only this task's unresolved cleanup is retried. No command/START or availability probe.
    for (;;) {
      const result = await runCommand(commandArgv(connection, recoveryHelperCommand('recovery-observe', gate), ssh), new AbortController().signal)
      if (result.exit === 0 && result.stdout.trim() === marker(token, 'CLEANED')) return
      await new Promise<void>(resolve => setTimeout(resolve, 500))
    }
  }
  signal.throwIfAborted()
  const receiving = 'bash -c ' + shQuote(recoveryHelperCommand('recovery-run', { ...gate, command }))
  return new Command(commandArgv(connection, receiving, ssh, extra), signal, token, recover)
}
async function startLeased(connection: OwnerTransport, script: string, signal: AbortSignal, ssh: SshBuilder, extra: readonly string[] = []): Promise<Command> {
  const token = randomUUID()
  return startRecoverable(connection, leasedCommand(script, token), token, signal, ssh, extra)
}
const commandArgv = (connection: OwnerTransport | undefined, command: string, ssh: SshBuilder, extra: readonly string[] = []) => connection
  ? 'commandArgv' in connection ? connection.commandArgv(command) : ssh(connection, { extraArgs: [...RELAY_SSH_OPTIONS, ...extra], command }) : ['bash', '-c', command]

export async function runCommand(argv: string[], signal: AbortSignal): Promise<CommandResult> {
  const command = new Command(argv, signal)
  try { return await command.result() } finally { await command.stop() }
}
export async function preflightRsync(connection: SshConnection | undefined, signal: AbortSignal, ssh: SshBuilder = sshArgv): Promise<void> {
  const test = `set -eu
(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 1) )) || { echo 'rsync requires Bash4.1+ coproc and dynamic file descriptors' >&2; exit 69; }
coproc CLOCK { ${leaseHelperCommand('clock')}; }
pid=$CLOCK_PID
trap 'kill "$pid" 2>/dev/null || :; wait "$pid" 2>/dev/null || :' EXIT
exec {reader}<&\${CLOCK[0]}
exec {writer}>&\${CLOCK[1]}
printf 'QUERY\\n' >&$writer
IFS= read -r value <&$reader
[[ "$value" =~ ^[0-9]+$ ]]
`
  const result = await runCommand(commandArgv(connection, 'command -v bash >/dev/null && command -v rsync >/dev/null' + (connection ? ' && bash -c ' + shQuote(test) : ''), ssh), signal)
  if (result.exit !== 0) throw new Error(`rsync requires Bash/native rsync on the origin and Bash4.1+, native rsync, Python3.7+ monotonic clock/coprocess channel on SSH endpoints (no copy fallback): exit ${result.exit}; ${result.stderr}`)
}
/** Inspect link presence, not filenames: newline-bearing names cannot hide a link.
 * find owns a separate leased group, including while a large tree is inspected. */
export async function preflightRelaySource(connection: SshConnection, path: string, signal: AbortSignal, ssh: SshBuilder = sshArgv): Promise<void> {
  await preflightRsync(connection, signal, ssh)
  const source = path.replace(/\/+$/, '') || '/'
  const script = `command -v find >/dev/null || { echo 'SSH relay source inspection requires native find (no copy fallback)' >&2; exit 69; }
if [ -e ${shQuote(source)} ] || [ -L ${shQuote(source)} ]; then
  umask 077
  tmp=$(mktemp -d "\${TMPDIR:-/tmp}/superd-rsync-inspect.XXXXXXXX")
  clock; [ "$now" -lt "$leaseEnd" ] || exit 125
  find ${shQuote(source)} -type l -print > "$tmp/links" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do control || exit 125; done
  set +e
  wait "$pid"
  status=$?
  set -e
  [ "$status" = 0 ] || exit "$status"
  [ ! -s "$tmp/links" ] || { echo 'rsync SSH relay source symlinks are unsupported: confined non-chroot daemon cannot preserve their values. Use an ordinary local-SSH rsync leg or materialize files first.' >&2; exit 64; }
fi`
  const command = await startLeased(connection, script, signal, ssh)
  try {
    const result = await command.result()
    if (result.exit !== 0) throw new Error(`rsync relay source inspection: exit ${result.exit}; ${result.stderr}`)
  } finally { await command.stop() }
}
async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('cannot allocate SSH relay loopback port')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}
export interface RelayOptions { ssh?: SshBuilder; ports?: { destination: number; origin: number; source: number } }
export interface Relay {
  url: string
  /** Runs sender under a lease-owned remote supervisor, never downstream SSH. */
  run(argv: string[]): Promise<CommandResult>
}

export async function withSshRelay<T>(source: SshConnection, destination: SshConnection, targetPath: string, signal: AbortSignal, run: (relay: Relay) => Promise<T>, options: RelayOptions = {}): Promise<T> {
  if (!targetPath.startsWith('/') || /[\0\r\n]/.test(targetPath) || targetPath.trim() !== targetPath) throw new Error('rsync daemon destination must be an absolute existing directory without NUL/newline or leading/trailing whitespace')
  if (targetPath.includes('%')) throw new Error('rsync SSH relay destination percent signs are unsupported by daemon config path expansion; use an ordinary local-SSH rsync leg or rename the directory (no relay writes performed)')
  const target = targetPath.replace(/\/+$/, '') || '/'
  if (target.trim() !== target) throw new Error('rsync daemon normalized destination must not end in whitespace (no relay writes performed)')
  const ssh = options.ssh ?? sshArgv
  const chosen = new Set<number>()
  if (!options.ports) while (chosen.size < 3) chosen.add(await availablePort())
  const [d, o, s] = [...chosen]
  const ports = options.ports ?? { destination: d!, origin: o!, source: s! }
  for (const value of Object.values(ports)) if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('SSH relay requires unprivileged high ports')
  let dest: Command | undefined
  let proxy: ReturnType<typeof startSourceProxy> | undefined
  let closed = false
  const senders = new Set<Command>()
  let outcome: T | undefined
  try {
    await preflightRsync(source, signal, ssh); await preflightRsync(destination, signal, ssh)
    const daemon = `[ -d ${shQuote(target)} ] && [ ! -L ${shQuote(target)} ] || { echo 'rsync remote relay requires an existing non-symlink destination directory; files/new paths are unsupported (module not widened)' >&2; exit 64; }
umask 077
tmp=$(mktemp -d "\${TMPDIR:-/tmp}/superd-rsync.XXXXXXXX")
printf '%s\\n' 'use chroot = no' 'read only = no' 'munge symlinks = yes' 'hosts allow = 127.0.0.1' 'hosts deny = *' '[task]' ${shQuote('path = ' + target)} > "$tmp/rsyncd.conf"
clock; [ "$now" -lt "$leaseEnd" ] || exit 125
rsync --daemon --no-detach --address=127.0.0.1 --port=${ports.destination} --config="$tmp/rsyncd.conf" &
pid=$!
for i in $(seq 1 100); do
  clock; [ "$now" -lt "$leaseEnd" ] || exit 125
  kill -0 "$pid" || exit 70
  if (exec 3<>/dev/tcp/127.0.0.1/${ports.destination}) 2>/dev/null; then break; fi
  sleep .05
done
kill -0 "$pid"
printf 'READY %s %s\\n' "$pid" "$tmp"
while kill -0 "$pid" 2>/dev/null; do control || exit 125; done
wait "$pid"
`
    dest = await startLeased(destination, daemon, signal, ssh, ['-L', `127.0.0.1:${ports.origin}:127.0.0.1:${ports.destination}`])
    await dest.ready(/^READY \d+ \S+$/m)
    outcome = await withNativeCommandOwner(source, signal, async owner => {
      const command = leaseHelperCommand('native-command', { directory: owner, argv: ['python3', '-u', '-c', SOURCE_PROXY_HELPER, String(ports.source)] })
      proxy = startSourceProxy(commandArgv(source, command, ssh), ports.origin, signal)
      await Promise.race([proxy.ready, proxy.failed])
      return await Promise.race([proxy.failed, run({ url: `rsync://127.0.0.1:${ports.source}/task/`, async run(argv) {
        signal.throwIfAborted()
        if (closed) throw new Error('SSH relay admission closed')
        const sender = await startLeased(source, `LC_ALL=C ${argv.map(shQuote).join(' ')} <&0 &\npid=$!\nwhile kill -0 "$pid" 2>/dev/null; do control || exit 125; done\nset +e\nwait "$pid"\nexit $?\n`, signal, ssh)
        senders.add(sender)
        try {
          const result = await sender.result()
          const tunnel = [dest?.stderrOutput(), proxy?.stderr().replace('SOURCE_PROXY_READY\n', '')].filter(Boolean).join('\n')
          const stderr = result.stderr + (tunnel ? '\n[tunnel stderr]\n' + tunnel : '')
          return { ...result, stderr: stderr.slice(-OUTPUT_LIMIT), outputTruncated: result.outputTruncated || !!dest?.truncated || stderr.length > OUTPUT_LIMIT }
        } finally { await sender.stop();senders.delete(sender) }
      } })])
    }, ssh)
    signal.throwIfAborted()
    return outcome
  } catch (error) {
    const native = [dest?.stderrOutput(), proxy?.stderr()].filter(Boolean).join('\n')
    if (signal.aborted) throw signal.reason
    throw new Error(`${error instanceof Error ? error.message : String(error)}${native ? '\n[tunnel stderr]\n' + native : ''}`, { cause: error })
  } finally {
    closed = true
    dest?.quiesce(); for (const sender of senders) sender.quiesce()
    try { for (const sender of senders) await sender.stop() }
    finally {
      // The source owner above has finished its receiving barrier first.
      try { await proxy?.close() } finally { await dest?.stop() }
    }
  }
}

/** Portable sideband ownership: work stdin stays exclusively with the native command. */
export async function withNativeCommandOwner<T>(connection: OwnerTransport, signal: AbortSignal, run: (directory: string) => Promise<T>, ssh: SshBuilder = sshArgv): Promise<T> {
  signal.throwIfAborted()
  const controller = await startLeased(connection, `for executable in mktemp mv rm sleep; do
  command -v "$executable" >/dev/null || { printf 'native receiving control requires %s (no transfer admitted)\\n' "$executable" >&2; exit 69; }
done
umask 077
tmp=$(mktemp -d "\${TMPDIR:-/tmp}/superd-rsync-native.XXXXXXXX")
extraCleanup() {
  rm -f -- "$tmp/active"
  helpers=()
  groups=()
  clocks=()
  for record in "$tmp"/server.*; do
    [ -f "$record" ] || continue
    helper=\${record##*/server.}
    [[ "$helper" =~ ^[0-9]+$ ]] || continue
    group=0
    clockGroup=0
    IFS=' ' read -r ignored group clockGroup < "$record" || :
    [[ "$group" =~ ^[1-9][0-9]*$ ]] || group=0
    [[ "$clockGroup" =~ ^[1-9][0-9]*$ ]] || clockGroup=0
    helpers+=("$helper")
    groups+=("$group")
    clocks+=("$clockGroup")
    [ "$group" = 0 ] || kill -TERM -- "-$group" 2>/dev/null || :
    [ "$clockGroup" = 0 ] || kill -TERM -- "-$clockGroup" 2>/dev/null || :
    kill -TERM -- "$helper" 2>/dev/null || :
  done
  sleep .25
  for group in "\${groups[@]}"; do [ "$group" = 0 ] || kill -KILL -- "-$group" 2>/dev/null || :; done
  for group in "\${clocks[@]}"; do [ "$group" = 0 ] || kill -KILL -- "-$group" 2>/dev/null || :; done
  for helper in "\${helpers[@]}"; do kill -KILL -- "$helper" 2>/dev/null || :; done
  for group in "\${groups[@]}" "\${clocks[@]}"; do
    [ "$group" = 0 ] && continue
    while kill -0 -- "-$group" 2>/dev/null; do sleep .02; done
  done
  for helper in "\${helpers[@]}"; do while kill -0 "$helper" 2>/dev/null; do sleep .02; done; done
}
publish() {
  printf '%s %s\\n' "$((leaseEnd - now))" "$renewCount" > "$tmp/lease.new"
  mv -- "$tmp/lease.new" "$tmp/lease"
}
publish
clock; [ "$now" -lt "$leaseEnd" ] || { echo "native owner: lease expired before activation now=$now leaseEnd=$leaseEnd" >&2; exit 125; }
printf '%s\n' active > "$tmp/active"
printf 'OWNER %s\n' "$tmp"
while :; do control || { [ "$phase" = closed ] || echo "native owner: control lost while phase=$phase now=$now leaseEnd=$leaseEnd" >&2; exit 125; }; done
`, signal, ssh)
  try {
    const match = await controller.ready(/^OWNER (.+)$/m)
    const directory = match[1]!
    if (!directory.startsWith('/') || /[\0\r\n]/.test(directory)) throw new Error('native receiving ownership path is not representable')
    const result = await run(directory)
    signal.throwIfAborted()
    return result
  } finally { await controller.stop() }
}

/** Registration precedes the second activation fence and protocol child admission.
 * Controller and server use counted increments, never refresh leases from late arrival. */
export function nativeRsyncPath(directory: string): string {
  return 'bash -c ' + shQuote(supervisor(false) + `owner=${shQuote(directory)}
record="$owner/server.$$"
extraCleanup() { :; }
[ -f "$owner/active" ] || exit 125
printf '%s 0 %s\\n' "$$" "$clockPid" > "$record"
IFS=' ' read -r remaining seen < "$owner/lease"
[[ "$remaining" =~ ^[1-9][0-9]*$ ]] && [[ "$seen" =~ ^[0-9]+$ ]] || exit 125
clock
leaseEnd=$((now + remaining))
[ -f "$owner/active" ] || exit 125
rsync "$@" <&0 &
pid=$!
printf '%s %s %s\\n' "$$" "$pid" "$clockPid" > "$record"
while kill -0 "$pid" 2>/dev/null; do
  clock; [ "$now" -lt "$leaseEnd" ] && [ -f "$owner/active" ] || exit 125
  IFS=' ' read -r remaining count < "$owner/lease" || exit 125
  [[ "$remaining" =~ ^[1-9][0-9]*$ ]] && [[ "$count" =~ ^[0-9]+$ ]] || exit 125
  [ "$count" -ge "$seen" ] || exit 125
  leaseEnd=$((leaseEnd + (count - seen) * 2000))
  seen=$count
  [ "$leaseEnd" -le $((now + 8000)) ] || leaseEnd=$((now + 8000))
  sleep .1
done
set +e
wait "$pid"
status=$?
exit "$status"
`) + ' rsync-server'
}

/** Rsync uses the same portable owner, without changing its native protocol wrapper. */
export const withNativeSshOwner = withNativeCommandOwner
export const withNativeRsyncOwner = withNativeCommandOwner
