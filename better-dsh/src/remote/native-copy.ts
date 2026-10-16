/** Native CLI copy routes (spec: remote-native-shortcut).
 * scp / docker cp / incus file run verbatim with caller-ordered argv options;
 * the tool appends parsed src/dst. No option whitelist, no forced flags, no
 * remote worker. Exit codes and stderr pass through; success never claims
 * independent verification.
 */
import { mkdtemp, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startBinaryProcess } from './process.ts'
import type { SshConnection } from './ssh-targets.ts'
import type { TargetPlan } from './target.ts'

export interface NativeCopyReceipt {
  action: 'copy'
  src: string
  dst: string
  /** Native route actually used, stated as a fact (two-command routes never masquerade as one CLI). */
  route: string
  /** Native argv actually executed per command, one token per element, no shell joining. */
  argv: string[][]
  exits: (number | null)[]
  stdout: string[]
  stderr: string[]
  outputTruncated: boolean
  /** Native CLI success only — no independent digest was computed for this path. */
  verified: false
  /** Tool-owned staging/config release: released on normal/observed exit, unknown when a channel was lost. */
  cleanup: 'released' | 'unknown' | 'none-required'
}

const OUTPUT_LIMIT = 512 * 1024

export class ArgvError extends Error {
  constructor(field: string, reason: string) {
    super(`remote: ${field} must be an array of non-empty string tokens without NUL (${reason})`)
  }
}

/** Ordered native option tokens; one element = one argv token, never shell-parsed. */
export function checkArgv(field: string, value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ArgvError(field, 'got a non-array')
  for (const token of value) {
    if (typeof token !== 'string' || token.length === 0) throw new ArgvError(field, 'empty or non-string element')
    if (token.includes('\0')) throw new ArgvError(field, 'NUL byte in element')
    if (token === '--') throw new ArgvError(field, 'a bare -- would terminate option parsing and let later tokens act as extra source operands; src/dst cannot be overridden via argv')
  }
  return [...value]
}

/** scp -R re-authenticates to the destination FROM the source host, breaking the identities-stay-on-origin boundary. */
export function rejectRemoteToRemoteScp(argv: readonly string[]): void {
  const boundary = 'remote: scp -R would authenticate to the destination from the source host; identities must stay on the origin (scp -3 through-origin is the supported route)'
  for (const token of argv) {
    if (token === '-R' || token === '--remote-to-remote' || token === '--r') throw new Error(boundary)
    if (token.startsWith('-') && !token.startsWith('--') && token.slice(1).includes('R')) throw new Error(boundary)
  }
}

export interface RunResult { exit: number | null; stdout: string; stderr: string; outputTruncated: boolean }

/** Run one native CLI with group-owned lifecycle; output bounded, exit verbatim.
 * `env` overlays process env (RSYNC_RSH wiring); values are tool-built argv, never model text. */
export async function runNative(argv: string[], signal: AbortSignal, env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  signal.throwIfAborted()
  const child = startBinaryProcess(argv, { env: { ...process.env, ...env } })
  const cancel = () => child.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  let stdout = '', stderr = '', truncated = false
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (text: string) => { const value = stdout + text; if (value.length > OUTPUT_LIMIT) truncated = true; stdout = value.slice(-OUTPUT_LIMIT) })
  child.stderr.on('data', (text: string) => { const value = stderr + text; if (value.length > OUTPUT_LIMIT) truncated = true; stderr = value.slice(-OUTPUT_LIMIT) })
  try {
    const result = await child.done
    const diagnostic = child.diagnostic()
    return {
      exit: result.exit,
      stdout,
      stderr: diagnostic !== undefined ? (stderr + '\n' + diagnostic).slice(-OUTPUT_LIMIT) : stderr,
      outputTruncated: truncated || diagnostic !== undefined,
    }
  }
  finally { signal.removeEventListener('abort', cancel) }
}

/** Endpoint kinds the native router understands: a CLI peer or the origin itself. */
export type CopyPlan = TargetPlan | { kind: 'local' }

/** Typed endpoint for nativeCopy: plan discriminates the route, path is the absolute operand. */
export interface NativeEndpoint { plan: CopyPlan; path: string }

export interface NativeCopyOptions {
  /** Test seam: wraps every spawned native transport argv (fixture isolation). */
  wrapArgv?: (argv: string[]) => string[]
  /** Test seam: overrides the scratch root for two-segment staging. */
  scratchRoot?: string
}

/** scp spec keeps identity in argv/config; caller -F/-i/-P override by scp's own precedence. */
function scpSpec(connection: SshConnection, path: string): string {
  const host = connection.host.includes(':') ? `[${connection.host}]` : connection.host
  const at = connection.user !== undefined ? `${connection.user}@${host}` : host
  return `${at}:${path}`
}

/** Connection identity as scp options (port, key), placed BEFORE caller argv so
 * an explicit caller -F/-i/-P/-J overrides the registered identity by scp's own
 * precedence (last option wins). */
function identityArgv(connection: SshConnection): string[] {
  const options = ['-o', 'BatchMode=yes']
  if (connection.port !== undefined) options.push('-P', String(connection.port))
  if (connection.key !== undefined) options.push('-i', connection.key)
  if (connection.proxyJump !== undefined) options.push('-J', connection.proxyJump)
  return options
}

/** SSH endpoint as a connection (BYO identity when registered, bare host otherwise). */
export function sshEndpoint(plan: TargetPlan): { connection: SshConnection; path: string }
export function sshEndpoint(plan: CopyPlan): { connection: SshConnection }
export function sshEndpoint(plan: CopyPlan): { connection: SshConnection } {
  if (plan.kind !== 'ssh') throw new Error('remote: native copy endpoint is not an SSH target')
  return { connection: plan.connection ?? { host: plan.host } }
}

/** Container name for docker/incus endpoints (narrows without casts). */
function containerOf(plan: CopyPlan): string {
  if (plan.kind !== 'docker' && plan.kind !== 'incus') throw new Error('remote: native copy endpoint is not a container target')
  return plan.container
}

/**
 * One native copy.
 * - local↔SSH: scp; SSH↔SSH: scp -3 through origin (both identities here; when
 *   they differ a temp origin-only config maps two synthetic aliases)
 * - local↔docker: docker cp; local↔incus: incus file push/pull
 * - every other cross-endpoint pair: two native commands with origin staging,
 *   each segment with its own options (pullArgv/pushArgv)
 */
export async function nativeCopy(request: {
  src: string
  dst: string
  argv?: string[]
  pullArgv?: string[]
  pushArgv?: string[]
}, endpoints: { src: NativeEndpoint; dst: NativeEndpoint }, signal: AbortSignal, options: NativeCopyOptions = {}): Promise<NativeCopyReceipt> {
  signal.throwIfAborted()
  const oneShot = checkArgv('argv', request.argv)
  const pull = checkArgv('pullArgv', request.pullArgv)
  const push = checkArgv('pushArgv', request.pushArgv)
  if (oneShot.length > 0 && (pull.length > 0 || push.length > 0)) throw new Error('remote: argv cannot be combined with pullArgv/pushArgv (argv is for single-command routes; pullArgv/pushArgv for two-segment routes)')
  if (request.pullArgv !== undefined && request.pushArgv === undefined) throw new Error('remote: pullArgv requires pushArgv (a two-segment copy has both halves)')
  if (request.pushArgv !== undefined && request.pullArgv === undefined) throw new Error('remote: pushArgv requires pullArgv (a two-segment copy has both halves)')
  const wrap = options.wrapArgv ?? (argv => argv)
  const s = endpoints.src.plan.kind, t = endpoints.dst.plan.kind
  const receipt: NativeCopyReceipt = { action: 'copy', src: request.src, dst: request.dst, route: '', argv: [], exits: [], stdout: [], stderr: [], outputTruncated: false, verified: false, cleanup: 'none-required' }
  const finish = (route: string, argvs: string[][], results: RunResult[]): NativeCopyReceipt => {
    receipt.route = route
    receipt.argv = argvs
    receipt.exits = results.map(result => result.exit)
    receipt.stdout = results.map(result => result.stdout)
    receipt.stderr = results.map(result => result.stderr)
    receipt.outputTruncated = results.some(result => result.outputTruncated)
    return receipt
  }

  // Single native command routes.
  if (s === 'local' && t === 'ssh') {
    rejectRemoteToRemoteScp(oneShot)
    const connection = sshEndpoint(endpoints.dst.plan).connection
    const argv = ['scp', ...identityArgv(connection), ...(await recursiveFlag(endpoints.src.path, oneShot, '-r')), ...oneShot, endpoints.src.path, scpSpec(connection, endpoints.dst.path)]
    return finish('scp', [argv], [await runNative(wrap(argv), signal)])
  }
  if (s === 'ssh' && t === 'local') {
    rejectRemoteToRemoteScp(oneShot)
    const connection = sshEndpoint(endpoints.src.plan).connection
    const argv = ['scp', ...identityArgv(connection), ...oneShot, scpSpec(connection, endpoints.src.path), endpoints.dst.path]
    return finish('scp', [argv], [await runNative(wrap(argv), signal)])
  }
  if (s === 'ssh' && t === 'ssh') {
    rejectRemoteToRemoteScp(oneShot)
    const source = sshEndpoint(endpoints.src.plan).connection, destination = sshEndpoint(endpoints.dst.plan).connection
    const sameIdentity = JSON.stringify(source) === JSON.stringify(destination)
    let config: { path: string; dir: string } | undefined
    let unknown = false
    try {
      let srcSpec: string, dstSpec: string
      let extra: string[] = []
      if (sameIdentity) {
        srcSpec = scpSpec(source, endpoints.src.path)
        dstSpec = scpSpec(destination, endpoints.dst.path)
        extra = identityArgv(source)
      }
      else {
        config = await tempSshConfig(source, destination, runNative)
        extra = ['-F', config.path]
        srcSpec = `superd-scp3-source:${endpoints.src.path}`
        dstSpec = `superd-scp3-destination:${endpoints.dst.path}`
      }
      const argv = ['scp', '-3', ...extra, ...oneShot, srcSpec, dstSpec]
      return finish('scp -3 (data through origin)', [argv], [await runNative(wrap(argv), signal)])
    }
    catch (error) {
      if (signal.aborted) unknown = true
      throw error
    }
    finally {
      if (config !== undefined) {
        const removed = await rm(config.dir, { recursive: true, force: true }).then(() => true, () => false)
        receipt.cleanup = !removed || unknown ? 'unknown' : 'released'
      }
    }
  }
  if (s === 'local' && t === 'docker') {
    const argv = ['docker', 'cp', ...oneShot, endpoints.src.path, `${containerOf(endpoints.dst.plan)}:${endpoints.dst.path}`]
    const result = await runNative(wrap(argv), signal)
    withSymlinkHint(result)
    return finish('docker cp', [argv], [result])
  }
  if (s === 'docker' && t === 'local') {
    const argv = ['docker', 'cp', ...oneShot, `${containerOf(endpoints.src.plan)}:${endpoints.src.path}`, endpoints.dst.path]
    const result = await runNative(wrap(argv), signal)
    withSymlinkHint(result)
    return finish('docker cp', [argv], [result])
  }
  if (s === 'local' && t === 'incus') {
    const argv = ['incus', 'file', 'push', ...(await recursiveFlag(endpoints.src.path, oneShot, '-r')), ...oneShot, endpoints.src.path, `${containerOf(endpoints.dst.plan)}${endpoints.dst.path}`]
    return finish('incus file push', [argv], [await runNative(wrap(argv), signal)])
  }
  if (s === 'incus' && t === 'local') {
    const argv = ['incus', 'file', 'pull', ...oneShot, `${containerOf(endpoints.src.plan)}${endpoints.src.path}`, endpoints.dst.path]
    return finish('incus file pull', [argv], [await runNative(wrap(argv), signal)])
  }
  if (s === 'local' || t === 'local') throw new Error('remote: this endpoint pair is a single native command route; pullArgv/pushArgv apply to cross-endpoint pairs only')

  // Two-segment route: origin staging, each segment a native command.
  const pullOptions = request.pullArgv !== undefined ? pull : oneShot
  const pushOptions = request.pushArgv !== undefined ? push : oneShot
  const scratch = await mkdtemp(join(options.scratchRoot ?? join(process.cwd(), '.scratch'), 'remote-native-copy-'))
  const staged = join(scratch, 'staged')
  try {
    rejectRemoteToRemoteScp(pullOptions); rejectRemoteToRemoteScp(pushOptions)
    const pullArgv = segmentArgv(endpoints.src.plan, endpoints.src.path, staged, pullOptions, 'pull')
    const pushArgv = segmentArgv(endpoints.dst.plan, endpoints.dst.path, staged, pushOptions, 'push')
    const first = await runNative(wrap(pullArgv), signal)
    if (first.exit !== 0) return finish('two native commands with origin staging (push not started: pull failed)', [pullArgv], [first])
    const second = await runNative(wrap(pushArgv), signal)
    return finish('two native commands with origin staging', [pullArgv, pushArgv], [first, second])
  }
  finally {
    const removed = await rm(scratch, { recursive: true, force: true }).then(() => true, () => false)
    receipt.cleanup = removed && !signal.aborted ? 'released' : 'unknown'
  }
}

/** One segment of a two-segment route: pull remote→staging, or push staging→remote. */
function segmentArgv(plan: CopyPlan, remote: string, staged: string, opts: string[], leg: 'pull' | 'push'): string[] {
  if (plan.kind === 'local') throw new Error('remote: two-segment staging connects two CLI peers, not a local path')
  if (plan.kind === 'ssh') {
    const connection = sshEndpoint(plan).connection
    const spec = scpSpec(connection, remote)
    return leg === 'pull' ? ['scp', ...opts, ...identityArgv(connection), spec, staged] : ['scp', ...opts, ...identityArgv(connection), staged, spec]
  }
  if (plan.kind === 'docker') {
    const spec = `${plan.container}:${remote}`
    return leg === 'pull' ? ['docker', 'cp', ...opts, spec, staged] : ['docker', 'cp', ...opts, staged, spec]
  }
  const spec = `${plan.container}${remote}`
  return leg === 'pull' ? ['incus', 'file', 'pull', ...opts, spec, staged] : ['incus', 'file', 'push', ...opts, staged, spec]
}

/** Distinguishing identities for scp -3: an origin-only temp config maps two
 * synthetic aliases; keys are referenced in place, never copied to any remote. */
/** D8 (2026-10-14 user adoption, third acceptance round): a LOCAL directory source gets
 *  the route's recursive flag appended automatically — scp / incus file push refuse
 *  directories without it. The appended flag lands in the executed argv, which the
 *  receipt shows verbatim: disclosure by receipt, never silent. Remote sources stay
 *  caller-explicit (we do not dial just to stat); an explicit caller flag wins. */
async function recursiveFlag(localPath: string, callerArgv: readonly string[], flag: '-r'): Promise<string[]> {
  if (callerArgv.includes(flag) || callerArgv.includes('--recursive')) return []
  try {
    if ((await stat(localPath)).isDirectory()) return [flag]
  } catch { /* not statable: let the native CLI report the real problem */ }
  return []
}

/** docker cp follows symlinks only with -L; its native error ("invalid symlink")
 *  names no remedy. Append the one-line hint on that failure path (F5, 2026-10-14). */
function withSymlinkHint(result: { exit: number | null; stderr: string }): void {
  if (result.exit !== 0 && /invalid symlink/i.test(result.stderr)) {
    result.stderr = `${result.stderr}\nhint: docker cp follows symlinks only with -L — pass argv:["-L"] (e.g. /etc/os-release is a symlink)`
  }
}

async function tempSshConfig(source: SshConnection, destination: SshConnection, runNative: (argv: string[], signal: AbortSignal) => Promise<{ exit: number | null; stdout: string }>): Promise<{ path: string; dir: string }> {
  // `ssh:<alias>` targets carry the alias verbatim; with `-F <tempconfig>` ssh
  // cannot see ~/.ssh/config, so an alias HostName is unresolvable (2026-10-14
  // user acceptance: scp -3 dev3→dev4 died with "Could not resolve hostname").
  // Resolve each side through the ORIGIN's real config via `ssh -G` (native,
  // no dialing) and inline the effective fields; explicit connection fields
  // (byossh registrations) always win.
  const resolvedSource = await resolveThroughOriginConfig(source, runNative)
  const resolvedDestination = await resolveThroughOriginConfig(destination, runNative)
  // Config-line injection guard: every interpolated value must stay one line.
  // Registered byossh identities are already shape-checked at registration;
  // ssh -G output is machine-generated single-line values, checked here anyway.
  for (const { connection: c, identityFiles } of [resolvedSource, resolvedDestination]) {
    for (const [field, value] of [['host', c.host], ['user', c.user], ['key', c.key], ['proxyJump', c.proxyJump]] as const) {
      if (value !== undefined && /[\r\n]/.test(value)) throw new Error(`remote: scp -3 temp config rejects newline in SSH ${field} (no config injection)`)
    }
    for (const idFile of identityFiles) {
      if (/[\r\n]/.test(idFile)) throw new Error('remote: scp -3 temp config rejects newline in resolved IdentityFile (no config injection)')
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'superd-scp3-'))
  const path = join(dir, 'config')
  const block = (name: string, c: SshConnection, identityFiles: readonly string[]) => {
    const lines = [`Host ${name}`, `  HostName ${c.host.replace(/^.*@/, '')}`]
    if (c.user !== undefined) lines.push(`  User ${c.user}`)
    if (c.port !== undefined) lines.push(`  Port ${String(c.port)}`)
    for (const idFile of [c.key !== undefined ? [c.key] : [], identityFiles].flat()) lines.push(`  IdentityFile ${idFile}`)
    if (c.proxyJump !== undefined) lines.push(`  ProxyJump ${c.proxyJump}`)
    return lines.join('\n')
  }
  await writeFile(path, `${block('superd-scp3-source', resolvedSource.connection, resolvedSource.identityFiles)}\n${block('superd-scp3-destination', resolvedDestination.connection, resolvedDestination.identityFiles)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
  return { path, dir }
}
/** Effective fields for one connection per the origin's own ssh config (ssh -G,
 *  prints resolved settings without dialing). Explicit fields win; empty/none
 *  proxyjump is dropped. IdentityFile PATHS from the config are returned separately
 *  for inlining into the temp config — a path is not key material and stays on the
 *  origin (F1, 2026-10-14: dev4's only authorized key lived in config, not the agent;
 *  dropping it made scp -3 fail with a bare Permission denied). */
async function resolveThroughOriginConfig(c: SshConnection, runNative: (argv: string[], signal: AbortSignal) => Promise<{ exit: number | null; stdout: string }>): Promise<{ connection: SshConnection; identityFiles: string[] }> {
  let probe: { exit: number | null; stdout: string } | undefined
  try { probe = await runNative(['ssh', '-G', c.host], new AbortController().signal) } catch { probe = undefined }
  if (probe === undefined || probe.exit !== 0) return { connection: c, identityFiles: [] }
  const lines = probe.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const pick = (key: string): string | undefined => lines.find(line => line.startsWith(`${key} `))?.slice(key.length + 1).trim() || undefined
  // ssh -G lists compiled-in default identities for hosts without config keys;
  // those apply to the temp config anyway (no IdentityFile → defaults tried), so
  // inline only config-specified paths, preserving -G order and de-duplicating.
  // ssh -G lists compiled-in default identities for hosts without config keys;
  // those apply to the temp config anyway (no IdentityFile → defaults tried), so inline
  // only config-specified paths, preserving -G order and de-duplicating. Match the
  // DEFAULT PATHS exactly (never a bare basename: a custom /opt/keys/id_ed25519 is a
  // real config key and must survive); "none" is an explicit disable, not a path.
  const home = process.env.HOME ?? ''
  const compiledDefault = (path: string) => path === 'none' || ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk']
    .some(name => path === `~/.ssh/${name}` || (home !== '' && path === `${home}/.ssh/${name}`))
  const identityFiles = [...new Set(lines
    .filter(line => line.startsWith('identityfile '))
    .map(line => line.slice('identityfile '.length).trim())
    .filter(path => path !== '' && !compiledDefault(path)))]
  const host = (pick('hostname') ?? c.host).replace(/^.*@/, '')
  const user = c.user ?? pick('user')
  const portText = pick('port')
  const port = c.port ?? (portText !== undefined && /^\d+$/.test(portText) ? Number(portText) : undefined)
  const proxyJumpRaw = c.proxyJump ?? pick('proxyjump')
  return {
    connection: {
      host,
      ...(user !== undefined && user !== '' ? { user } : {}),
      ...(port !== undefined && Number.isInteger(port) && port > 0 ? { port } : {}),
      ...(c.key !== undefined ? { key: c.key } : {}),
      ...(proxyJumpRaw !== undefined && proxyJumpRaw !== '' && proxyJumpRaw.toLowerCase() !== 'none' ? { proxyJump: proxyJumpRaw } : {}),
    },
    identityFiles,
  }
}
