import { sshArgv, type SshConnection } from './ssh-targets.ts'
import { shQuote } from './transports.ts'
import { checkAbsolute } from './archive.ts'
import { withSshRelay, preflightRsync, preflightRelaySource, runCommand, nativeRsyncPath, withNativeRsyncOwner, RELAY_SSH_OPTIONS, type RelayOptions, type CommandResult } from './ssh-relay.ts'

// rsync -e has its OWN quoting grammar: doubled quotes, not shell backslashes
// or the shell's adjacent single/double-quote idiom (rsync(1) --rsh).
const rshQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'"

export interface RsyncRequest { src: string; dst: string; dryRun?: boolean; delete?: boolean; excludes?: readonly string[]; preserve?: boolean }
export interface RsyncEndpoint { path: string; connection?: SshConnection }
export interface RsyncReceipt extends CommandResult {
  action: 'rsync'; src: string; dst: string; dryRun: boolean; delete: boolean; preserve: boolean
  itemizedChanges: string[]; literalBytes?: number; matchedBytes?: number; sentBytes?: number; receivedBytes?: number; transferredBytes?: number
}
export async function runRsync(request: RsyncRequest, source: RsyncEndpoint, destination: RsyncEndpoint, signal: AbortSignal, options: RelayOptions = {}): Promise<RsyncReceipt> {
  signal.throwIfAborted()
  checkAbsolute(source.path); checkAbsolute(destination.path)
  if (!source.connection && !destination.connection) throw new Error('rsync requires at least one SSH endpoint; local-only is unsupported')
  if (request.excludes !== undefined && (!Array.isArray(request.excludes) || request.excludes.some(value => typeof value !== 'string' || value.includes('\0')))) throw new Error('rsync excludes must be strings without NUL')
  const dryRun = request.dryRun ?? true, remove = request.delete ?? false, preserve = request.preserve ?? true
  const args = ['rsync', preserve ? '-a' : '-r', '--no-compress', '--stats', '--itemize-changes', '--timeout=10', ...(dryRun ? ['--dry-run'] : []), ...(remove ? ['--delete'] : []), ...(request.excludes ?? []).map(value => '--exclude=' + value)]
  const ssh = options.ssh ?? sshArgv
  let result: CommandResult
  if (source.connection && destination.connection) {
    await preflightRelaySource(source.connection, source.path, signal, ssh)
    result = await withSshRelay(source.connection, destination.connection, destination.path, signal, relay => relay.run([...args, '--', source.path, relay.url]), options)
  } else {
    const remote = source.connection ?? destination.connection!
    await preflightRsync(undefined, signal, ssh); await preflightRsync(remote, signal, ssh)
    // rsync parses host/user/IPv6 itself. Consume its fixed placeholder on the
    // origin, then exec the COMPLETE canonical SSH argv + native server args.
    // Neither this placeholder nor the identity options enter the remote command.
    const adapter = 'shift; exec ' + ssh(remote, { extraArgs: RELAY_SSH_OPTIONS }).map(shQuote).join(' ') + ' "$@"'
    const transport = ['bash', '-c', adapter, 'rsync-ssh'].map(rshQuote).join(' ')
    const src = source.connection ? `rsync-peer:${source.path}` : source.path
    const dst = destination.connection ? `rsync-peer:${destination.path}` : destination.path
    result = await withNativeRsyncOwner(remote, signal, directory => {
      const argv = [...args, '--secluded-args', '-e', transport, '--rsync-path=' + nativeRsyncPath(directory), '--', src, dst]
      return runCommand(['bash', '-c', 'LC_ALL=C exec ' + argv.map(shQuote).join(' ')], signal)
    }, ssh)
  }
  const number = (label: string) => { const match = new RegExp(`^${label}: ([\\d,]+)(?: bytes)?$`, 'm').exec(result.stdout); return match ? Number(match[1]!.replaceAll(',', '')) : undefined }
  const sentBytes = number('Total bytes sent'), receivedBytes = number('Total bytes received')
  return { ...result, action: 'rsync', src: request.src, dst: request.dst, dryRun, delete: remove, preserve,
    itemizedChanges: result.stdout.split('\n').filter(line => /^[<>ch.*][fdLDS.]/.test(line) || line.startsWith('*deleting')),
    literalBytes: number('Literal data'), matchedBytes: number('Matched data'), sentBytes, receivedBytes,
    transferredBytes: sentBytes !== undefined && receivedBytes !== undefined ? sentBytes + receivedBytes : undefined }
}
