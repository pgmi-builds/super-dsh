import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'

/** Origin-owned identity reference, never key contents or a persistent credential store. */
/** argv seam for transports/tests: builds the native SSH argv for one connection. */
export type SshBuilder = typeof sshArgv

export interface SshConnection {
  readonly host: string
  readonly user?: string
  readonly port?: number
  readonly key?: string
  readonly proxyJump?: string
}
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
// ProxyJump internally synthesizes an SSH command: prohibit shell/percent expansion
// there as well as option injection, while allowing aliases, IPv4 and IPv6 hops.
const HOST = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[A-Fa-f0-9:.]+\]|[A-Fa-f0-9:]+)$/
const JUMP = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[A-Fa-f0-9:.]+\])(?::([0-9]+))?$/

export function validateSshLabel(label: string): void {
  if (!LABEL.test(label)) throw new Error('[E_BAD_LABEL] remote: BYO-SSH label must use letters, digits, dot, underscore or hyphen and start with a letter/digit')
}
function bad(field: string): never {
  throw new Error(`[E_SSH_PARAMS] remote: invalid SSH ${field} — use host/user/port, an existing origin key file path, and optional ProxyJump aliases or [user@]host[:port] hops; no inline keys or shell options`)
}
export function normalizeSshConnection(input: SshConnection): SshConnection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('connection')
  if (Object.keys(input).some(key => !['host', 'user', 'port', 'key', 'proxyJump'].includes(key))) bad('field')
  if (typeof input.host !== 'string' || !HOST.test(input.host)) bad('host')
  if (input.user !== undefined && (typeof input.user !== 'string' || !USER.test(input.user))) bad('user')
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) bad('port')
  if (input.proxyJump !== undefined) {
    if (typeof input.proxyJump !== 'string' || !input.proxyJump || input.proxyJump.split(',').some(hop => {
      const match = JUMP.exec(hop)
      return !match || (match[1] !== undefined && (Number(match[1]) < 1 || Number(match[1]) > 65535))
    })) bad('proxyJump')
  }
  let key: string | undefined
  if (input.key !== undefined) {
    if (typeof input.key !== 'string' || !input.key || /[\0\r\n]/.test(input.key)) bad('key')
    key = input.key.startsWith('~/') ? join(homedir(), input.key.slice(2)) : resolve(input.key)
    try { if (!statSync(key).isFile()) bad('key') } catch { bad('key file (must exist on the origin)') }
  }
  return Object.freeze({ host: input.host,
    ...(input.user === undefined ? {} : { user: input.user }),
    ...(input.port === undefined ? {} : { port: input.port }),
    ...(key === undefined ? {} : { key }),
    ...(input.proxyJump === undefined ? {} : { proxyJump: input.proxyJump }),
  })
}

/** One instance per Agent-owned driver; destroyed with its Agent/plugin owners. */
export class SshTargets {
  private readonly targets = new Map<string, SshConnection>()
  register(label: string, connection: SshConnection): SshConnection {
    validateSshLabel(label)
    const normalized = normalizeSshConnection(connection), existing = this.targets.get(label)
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized))
      throw new Error(`[E_LABEL_CONFLICT] remote: byossh:${label} SSH identity conflict — nothing was run. Reuse the label without ssh, or choose another label; existing credentials were not replaced`)
    if (!existing) this.targets.set(label, normalized)
    return existing ?? normalized
  }
  get(label: string): SshConnection | undefined { validateSshLabel(label); return this.targets.get(label) }
  entries(): ReadonlyArray<readonly [string, SshConnection]> { return [...this.targets.entries()] }
  clear(): void { this.targets.clear() }
}

/** Shared by execution, probes and file/relay consumers. extraArgs is trusted
 * internal SSH argv (e.g. forwarding), never a model-provided shell string. */
export function sshArgv(connection: SshConnection, options: { tty?: boolean; extraArgs?: readonly string[]; command?: string } = {}): string[] {
  const args = options.tty ? ['ssh', '-tt', '-o', 'BatchMode=yes'] : ['ssh', '-o', 'BatchMode=yes', '-T']
  if (connection.user !== undefined) args.push('-l', connection.user)
  if (connection.port !== undefined) args.push('-p', String(connection.port))
  if (connection.key !== undefined) args.push('-i', connection.key)
  if (connection.proxyJump !== undefined) args.push('-J', connection.proxyJump)
  args.push(...options.extraArgs ?? [], '--', connection.host)
  if (options.command !== undefined) args.push(options.command)
  return args
}
