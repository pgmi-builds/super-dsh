import type { SshConnection } from './ssh-targets.ts'
import { checkAbsolute } from './archive.ts'
import { checkArgv, runNative, type RunResult } from './native-copy.ts'
import { relayRsync, type RelayRsyncOptions } from './ssh-rsync-native-relay.ts'

export interface RsyncRequest { src: string; dst: string; argv?: string[] }
export interface RsyncEndpoint { path: string; connection?: SshConnection }
export interface RsyncReceipt extends RunResult {
  action: 'rsync'; src: string; dst: string; argv: string[]
  command: string
  /** Populated only when the CLI actually printed --stats output. */
  itemizedChanges?: string[]; literalBytes?: number; matchedBytes?: number; sentBytes?: number; receivedBytes?: number; transferredBytes?: number
  /** Two-SSH route actually used, when applicable. */
  route?: 'local-ssh' | 'ssh-ssh-forward' | 'ssh-ssh-stdio'
}

/**
 * Native rsync with ordered caller options. Local↔SSH runs rsync directly with
 * the endpoint's SSH identity wired as RSYNC_RSH; explicit -e/--rsh in argv
 * overrides that wiring per rsync's own rules (the receipt shows the argv).
 * SSH↔SSH delegates to the native relay routes (forwarding first, stdio second).
 * No option is injected: no archive, no timeout, no dry-run, no remote owner.
 */
export async function runRsync(request: RsyncRequest, source: RsyncEndpoint, destination: RsyncEndpoint, signal: AbortSignal, options: RelayRsyncOptions = {}): Promise<RsyncReceipt> {
  signal.throwIfAborted()
  checkAbsolute(source.path); checkAbsolute(destination.path)
  const argv = checkArgv('argv', request.argv)
  if ('pullArgv' in request || 'pushArgv' in request) throw new Error('remote: rsync takes argv only; pullArgv/pushArgv are copy-only fields')
  for (const legacy of ['dryRun', 'delete', 'excludes', 'preserve', 'verify', 'mkdir'] as const) {
    if (legacy in (request as unknown as Record<string, unknown>)) throw new Error(`remote: rsync field "${legacy}" was removed — pass native options through argv instead (e.g. "--dry-run", "--delete", "--exclude=<pattern>", "-a"/"-r"; verify/mkdir belong to the copy Hub/local lane)`)
  }
  if (!source.connection && !destination.connection) throw new Error('rsync requires at least one SSH endpoint; local-only is unsupported')

  let result: RunResult
  let route: RsyncReceipt['route']
  if (source.connection && destination.connection) {
    const relayed = await relayRsync(argv, { connection: source.connection, path: source.path }, { connection: destination.connection, path: destination.path }, signal, options)
    result = relayed
    route = relayed.route
  }
  else {
    route = 'local-ssh'
    const remote = source.connection ?? destination.connection!
    const wrap: (argv: string[]) => string[] = options.wrapArgv ?? (value => value)
    // Caller-supplied -e/--rsh overrides the tool's SSH wiring per rsync's
    // own precedence: the real host goes into the operand for rsync to parse,
    // and no RSYNC_RSH is set. Otherwise the placeholder host is consumed on
    // the origin by RSYNC_RSH, which execs the canonical SSH argv.
    const callerRsh = argv.some(token => token === '-e' || token === '--rsh'
      || token.startsWith('--rsh=')
      // short-option clusters: rsync bundles like -avze put the rsh flag last
      || (/^-[a-zA-Z]+e$/.test(token) && !token.startsWith('--')))
    const hostSpec = (connection: SshConnection) => {
      const host = connection.host.includes(':') && !connection.host.startsWith('[') ? `[${connection.host}]` : connection.host
      return connection.user !== undefined ? `${connection.user}@${host}` : host
    }
    const env: NodeJS.ProcessEnv = callerRsh ? {} : { RSYNC_RSH: rsyncRsh(remote, wrap) }
    const src = source.connection ? (callerRsh ? `${hostSpec(source.connection)}:${source.path}` : `rsync-native:${source.path}`) : source.path
    const dst = destination.connection ? (callerRsh ? `${hostSpec(destination.connection)}:${destination.path}` : `rsync-native:${destination.path}`) : destination.path
    result = await runNative(wrap(['rsync', ...argv, '--', src, dst]), signal, env)
  }

  const number = (label: string) => { const match = new RegExp(`^${label}: ([\\d,]+)(?: bytes)?$`, 'm').exec(result.stdout); return match ? Number(match[1]!.replaceAll(',', '')) : undefined }
  const sentBytes = number('Total bytes sent'), receivedBytes = number('Total bytes received')
  const literalBytes = number('Literal data'), matchedBytes = number('Matched data')
  const itemized = result.stdout.split('\n').filter(line => /^[<>ch.*][fdLDS.]/.test(line) || line.startsWith('*deleting'))
  return {
    ...result, action: 'rsync', src: request.src, dst: request.dst, argv, route,
    command: `rsync ${argv.join(' ')}`,
    ...(itemized.length > 0 || argv.includes('--itemize-changes') || argv.includes('-i') ? { itemizedChanges: itemized } : {}),
    ...(literalBytes === undefined ? {} : { literalBytes }),
    ...(matchedBytes === undefined ? {} : { matchedBytes }),
    ...(sentBytes === undefined ? {} : { sentBytes }),
    ...(receivedBytes === undefined ? {} : { receivedBytes }),
    ...(sentBytes !== undefined && receivedBytes !== undefined ? { transferredBytes: sentBytes + receivedBytes } : {}),
  }
}

/** RSYNC_RSH value: rsync word-splits this string with its own quote
 * convention (single quotes, internal quotes doubled); the adapter drops the
 * placeholder host rsync appends and execs the canonical SSH argv. All tokens
 * are tool-built argv (identity options/aliases), never model text. */
function rsyncRsh(connection: SshConnection, wrap: (argv: string[]) => string[]): string {
  const args = ['ssh', '-o', 'BatchMode=yes', '-T']
  if (connection.user !== undefined) args.push('-l', connection.user)
  if (connection.port !== undefined) args.push('-p', String(connection.port))
  if (connection.key !== undefined) args.push('-i', connection.key)
  if (connection.proxyJump !== undefined) args.push('-J', connection.proxyJump)
  args.push('--', connection.host)
  const sshArgv = wrap(args)
  const adapter = ['bash', '-c', `shift; exec ${sshArgv.map(rshQuote).join(' ')} "$@"`, 'rsync-rsh']
  return adapter.map(rshQuote).join(' ')
}

/** rsync -e/RSYNC_RSH grammar: doubled quotes, not shell backslashes (rsync(1) --rsh). */
const rshQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
