import type { RemoteProcess } from './hub-contract.ts'
import { startOneShot, startBinaryProcess } from './process.ts'
import { sshArgv, type SshConnection } from './ssh-targets.ts'
import { withNativeCommandOwner, RELAY_SSH_OPTIONS, type SshBuilder, type NativeCommandTransport } from './ssh-relay.ts'
import { leaseHelperCommand } from './ssh-lease.ts'
import { buildOneShotArgv } from './transports.ts'
import type { TargetPlan } from './target.ts'
type Options = { stdin?: string; timeoutSec?: number; signal: AbortSignal; ssh?: SshBuilder }

export function startOwnedSshProcess(connection: SshConnection, cmd: string, options: Options): Promise<RemoteProcess> {
  return startOwnedNativeProcess({ kind: 'ssh', host: connection.host, connection }, cmd, options)
}

/** The sideband owns receiving cleanup; the separate native work transport keeps literal stdio. */
export function startOwnedNativeProcess(plan: TargetPlan, cmd: string, options: Options): Promise<RemoteProcess> {
  const started = Date.now(), abort = new AbortController(), ssh = options.ssh ?? sshArgv
  const connection: SshConnection | NativeCommandTransport = plan.kind === 'ssh' ? plan.connection ?? { host: plan.host } : { commandArgv: command => buildOneShotArgv(plan, command) }
  const workArgv = (command: string) => 'commandArgv' in connection ? connection.commandArgv(command) : ssh(connection, { extraArgs: [...RELAY_SSH_OPTIONS], command })
  let timedOut = false, raw: RemoteProcess | undefined, diagnostic: string | undefined
  let complete!: (result: Awaited<RemoteProcess['done']>) => void
  const done = new Promise<Awaited<RemoteProcess['done']>>(resolve => { complete = resolve })
  let admit!: (value: RemoteProcess) => void, reject!: (error: unknown) => void
  const ready = new Promise<RemoteProcess>((resolve, fail) => { admit = resolve; reject = fail })
  const cancel = () => abort.abort(new Error('remote command cancelled'))
  options.signal.addEventListener('abort', cancel, { once: true })
  if (options.signal.aborted) cancel()
  const timer = options.timeoutSec === undefined ? undefined : setTimeout(() => { timedOut = true; cancel() }, options.timeoutSec * 1000)
  const operation = withNativeCommandOwner(connection, abort.signal, async directory => {
    abort.signal.throwIfAborted()
    const command = leaseHelperCommand('native-command', { directory, argv: ['bash', '-lc', cmd], subreaper: plan.kind !== 'ssh' })
    raw = startOneShot(workArgv(command), { stdin: options.stdin })
    admit({ done, cancel, read(channel, cursor) {
      const value = raw!.read(channel, cursor)
      return channel === 'stderr' && diagnostic ? { ...value, diagnostic } : value
    } })
    let aborted!: () => void
    const interrupted = new Promise<never>((_, fail) => { aborted = () => fail(abort.signal.reason) })
    abort.signal.addEventListener('abort', aborted, { once: true })
    if (abort.signal.aborted) aborted()
    try { return await Promise.race([raw.done, interrupted]) }
    finally { abort.signal.removeEventListener('abort', aborted) }
  }, ssh)
  void (async () => {
    let result: Awaited<RemoteProcess['done']> | undefined
    try { result = await operation }
    catch (error) { if (!abort.signal.aborted) diagnostic = String(error); if (!raw) reject(error) }
    finally {
      // withNativeCommandOwner has finished its remote barrier before local transport teardown.
      if (raw) {
        // The independent control ACK may precede the work channel's final bytes.
        // Drain that channel normally, but a partition cannot hold completed cleanup.
        let drainTimer: ReturnType<typeof setTimeout> | undefined
        const drained = await Promise.race([raw.done, new Promise<undefined>(resolve => { drainTimer = setTimeout(() => resolve(undefined), 2500) })])
        if (drainTimer) clearTimeout(drainTimer)
        if (!drained) {
          diagnostic = [diagnostic, 'remote: receiver cleanup confirmed; work output drain unavailable after 2500ms, output may be incomplete (stats count received data only)'].filter(Boolean).join('\n')
          raw.cancel()
        }
        result = drained ?? await raw.done
      }
      if (timer) clearTimeout(timer)
      options.signal.removeEventListener('abort', cancel)
      complete({ exit: diagnostic ? null : result?.exit ?? null, cancelled: abort.signal.aborted, timedOut, durationMs: Date.now() - started })
    }
  })()
  return ready
}


/** Raw file/protocol lane: no text rings or successful incomplete-output deadline.
 * Cancellation stops the receiver through its independent owner before the local
 * work transport is torn down. Normal completion requires the work stream close.
 */
export function startOwnedBinaryProcess(plan: TargetPlan, argv: string[], signal: AbortSignal): Promise<ReturnType<typeof startBinaryProcess>> {
  const started = Date.now(), abort = new AbortController()
  const connection: SshConnection | NativeCommandTransport = plan.kind === 'ssh' ? plan.connection ?? { host: plan.host } : { commandArgv: command => buildOneShotArgv(plan, command) }
  const workArgv = (command: string) => 'commandArgv' in connection ? connection.commandArgv(command) : sshArgv(connection, { extraArgs: [...RELAY_SSH_OPTIONS], command })
  let raw: ReturnType<typeof startBinaryProcess> | undefined, diagnostic: string | undefined
  let complete!: (result: Awaited<RemoteProcess['done']>) => void
  const done = new Promise<Awaited<RemoteProcess['done']>>(resolve => { complete = resolve })
  let admit!: (value: ReturnType<typeof startBinaryProcess>) => void, reject!: (error: unknown) => void
  const ready = new Promise<ReturnType<typeof startBinaryProcess>>((resolve, fail) => { admit = resolve; reject = fail })
  const cancel = () => abort.abort(signal.reason ?? new Error('remote binary operation cancelled'))
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const operation = withNativeCommandOwner(connection, abort.signal, async directory => {
    abort.signal.throwIfAborted()
    raw = startBinaryProcess(workArgv(leaseHelperCommand('native-command', { directory, argv, subreaper: plan.kind !== 'ssh' })))
    admit({ ...raw, cancel, done, diagnostic: () => diagnostic ?? raw!.diagnostic() })
    let interrupted!: () => void
    const interruption = new Promise<never>((_, fail) => { interrupted = () => fail(abort.signal.reason) })
    abort.signal.addEventListener('abort', interrupted, { once: true })
    if (abort.signal.aborted) interrupted()
    try { return await Promise.race([raw.done, interruption]) }
    finally { abort.signal.removeEventListener('abort', interrupted) }
  })
  void (async () => {
    let result: Awaited<RemoteProcess['done']> | undefined
    try { result = await operation }
    catch (error) { diagnostic = String(error); if (!raw) reject(error) }
    finally {
      // operation's finally includes the receiving helper/group/metadata barrier.
      if (raw) { if (!result) raw.cancel(); result = await raw.done }
      signal.removeEventListener('abort', cancel)
      complete({ exit: diagnostic ? null : result?.exit ?? null, cancelled: abort.signal.aborted, timedOut: false, durationMs: Date.now() - started })
    }
  })()
  return ready
}
