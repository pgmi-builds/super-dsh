import type { SshConnection } from './ssh-targets.ts'

/**
 * ONE identity-assembly policy for every SSH-speaking lane (user close-out
 * ruling 2026-10-17: "four builders necessarily mean four identity
 * semantics" — the structural root of F1).
 *
 * Assembly: explicit connection fields (byossh registrations; caller options
 * may override later by the CLI's own last-option-wins) in ONE order —
 * user, port, key, proxyJump — spoken in the target CLI's dialect.
 *
 * Resolution: config-side identity (aliases, config-only IdentityFile paths)
 * is read from the ORIGIN's own ssh config natively by every lane. The single
 * exception is the scp -3 temp config (ssh -F sees no user config), where
 * tempSshConfig inlines the `ssh -G`-resolved fields — paths only, never key
 * material (F1, 2026-10-14). That policy lives beside this builder in
 * native-copy.ts and must stay the only such inline site.
 *
 * Former duplicate builders now reduced here: sshArgv (execution/probes),
 * identityArgv (scp routes), rsyncRsh (RSYNC_RSH wiring), relaySsh
 * (dual-SSH relay). Behavior is byte-identical to each former site.
 */

/** Identity options ONLY for one connection, in the target CLI's dialect:
 * user, port, key, proxyJump — conditional, one order, NO base flags (each
 * lane's dialect base — BatchMode, -T, hardening — stays at its call site).
 * scp carries the user inside its user@host operand, so the scp dialect
 * never emits -l; its port flag is -P. */
export function sshIdentityArgv(connection: SshConnection, dialect: 'ssh' | 'scp'): string[] {
  const args: string[] = []
  if (dialect === 'ssh' && connection.user !== undefined) args.push('-l', connection.user)
  if (connection.port !== undefined) args.push(dialect === 'scp' ? '-P' : '-p', String(connection.port))
  if (connection.key !== undefined) args.push('-i', connection.key)
  if (connection.proxyJump !== undefined) args.push('-J', connection.proxyJump)
  return args
}

/** Full ssh invocation around the shared identity core. base and extra are
 * trusted internal argv (dialect flags incl. BatchMode, forwarding options)
 * — never a model-provided shell string. */
export function sshCommandArgv(connection: SshConnection, base: readonly string[], extra: readonly string[], command?: string): string[] {
  const args = ['ssh', ...base, ...sshIdentityArgv(connection, 'ssh'), ...extra, '--', connection.host]
  if (command !== undefined) args.push(command)
  return args
}
