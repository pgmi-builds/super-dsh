import { copyTree, type CopyRequest, type TransferReceipt } from './copy.ts'
import { runRsync, type RsyncRequest, type RsyncReceipt } from './rsync.ts'
import { nativeCopy, type NativeCopyReceipt, type CopyPlan } from './native-copy.ts'
import { localFileEndpoint } from './archive.ts'
import { parseFileEndpoint } from './endpoints.ts'
import { SshTargets, type SshConnection } from './ssh-targets.ts'
import { randomUUID } from 'node:crypto'
import type { HubRemoteTransport, RemoteInput, PreparedRemoteInput, StreamOutputStats, RemoteProcess } from './hub-contract.ts'
import { prepareRemoteInput } from './input.ts'
import { startOneShot, runOneShot } from './oneshot.ts'
import { startBinaryProcess } from './process.ts'
import { helperAssets, HelperRegistry, type HelperAssets, type HelperRunnerInfo } from './helper.ts'
import { startOwnedNativeProcess } from './ssh-process.ts'
import { PtyPool, displayKey, type PtyRunningJob } from './pty-session.ts'
import { tailWindow } from './nonce-framing.ts'
import { resolveTarget, type TargetPlan } from './target.ts'
import { probeTarget, renderProbe, renderSession, renderPtySession, type ProbeOptions } from './status.ts'
import { renderRoster, type RosterOptions } from './roster.ts'
import { literalHosts } from './roster.ts'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildOneShotArgv, buildPtyArgv, buildSpawnArgv, buildHelperOneShotArgv, buildHelperKillgroupArgv, buildHelperProbeArgv, buildHelperUploadArgv, helperShellArgv } from './transports.ts'

export type RemoteCallParams = RemoteInput

export interface RemoteCallResult {
  mode: 'oneshot' | 'pty'
  target: string
  exit: number | null
  cwd: string | null
  timedOut: boolean
  reconnected: boolean
  stdout: string
  stderr?: string
  durationMs: number
  truncated?: number
  outputStats?: StreamOutputStats
  outputStatsUnavailable?: boolean
  /** `byop:<label>` 调用面：本会话的 label（模型自选、即复用入口）。transport target 会话不带。 */
  session?: string
  /** 引导/教学行（同 label 重复给 spawn 时的「可省略 spawn」提示等）；无则省略。 */
  notice?: string
  /** oneshot 监督路径的如实标注：`superd-run <ver> (<triple>)` 或 `posix-shim`（spec remote-rescope §5）。 */
  runner?: string
  /** P4/P5（2026-10-19）：true = pty 命令仍在前台运行（回执 = handoff），ptyJob 随行供 job 通道接管。 */
  running?: boolean
  ptyJob?: PtyRunningJob
  /** 本会话 idle TTL 剩余（秒）；回执即状态快照（P2/P3：状态留在上下文里）。 */
  ttlSec?: number
}

export interface RemoteAuditRecord {
  target: string
  cmd: string
  cwd?: string
  exit?: number | null
  durationMs?: number
  error?: string
}

export interface RemoteDriverOptions {
  /** Fixture transport seam; normal consumers use the canonical native SSH builder. */
  /** Fixture transport seam for native copy CLIs (scp/docker/incus argv isolation). */
  nativeArgvFor?: (argv: string[]) => string[]
  getHub?: () => HubRemoteTransport | undefined
  execTimeoutSec?: number
  idleTtlSec?: number
  maxOutputChars?: number
  onAudit?: (r: RemoteAuditRecord) => void
  oneshotArgvFor?: (plan: TargetPlan, cmd: string, options: { cleanupTag?: string }) => string[]
  ptyArgvFor?: (plan: TargetPlan) => string[]
  spawnArgvFor?: (spawnCommand: string) => string[]
  probeRunner?: ProbeOptions['runner']
  /** 测试/验收缝：helper 资产来源（默认 lib 旁挂 helper-bin）；显式 null 强制 shim 路径。 */
  helperAssetsFor?: () => HelperAssets | null
  /** 测试缝：roster 扫描执行器（bare-name 解析复用）。 */
  rosterRunner?: RosterOptions['runner']
  /** 测试缝：ssh config 读取（bare-name 解析复用）。 */
  sshConfigReader?: () => Promise<string>
}

/** PTY 选择器路由面：label 必有；spawn 只在「首次创建该 label」的那一次调用里出现。 */
interface PtyRouting { label: string; spawn?: string }

/** 裸名候选表解析结果：命中三段之一 = transport plan；末位命中池内活 PTY = pty label；全不中 = ssh 兜底。 */
type BareResolution = TargetPlan | { kind: 'pty'; label: string }

/** PTY label 字符集：只禁空白 / `:` / 控制字符（roster 一行一 label，带换行的 label 渲染即烂）。 */
const PTY_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** R1（2026-10-19 二轮修订）：idle TTL 15 min——idle 随活动重置，在用会话永不超时；
 * 「有运行命令」不算 idle（PtySession 双条件），静默长任务不被掐。 */
export const REMOTE_PTY_IDLE_TTL_SEC = 900

/** 双轨调度器（spec §七 Phase 2）：参数校验 → 路由 → oneshot 子进程 / pty 会话池。 */
export class RemoteDriver {
  private readonly sshTargets = new SshTargets()
  private readonly pool: PtyPool
  private readonly hubOwner = randomUUID()
  private readonly hubProviders = new Set<HubRemoteTransport>()
  private readonly processes = new Set<RemoteProcess>()
  private readonly starting = new Set<Promise<unknown>>()
  private readonly fileAbort = new AbortController()
  private disposed = false
  /** undefined = 未尝试；null = 资产缺失（shim-only）；registry = 每 target sticky 状态机。 */
  private helpers: HelperRegistry | null | undefined
  private readonly runnerOf = new WeakMap<RemoteProcess, string>()
  private disposal: Promise<void> | undefined
  private readonly ptyIdleTtlSec: number
  constructor(private readonly opts: RemoteDriverOptions = {}) {
    this.ptyIdleTtlSec = opts.idleTtlSec ?? REMOTE_PTY_IDLE_TTL_SEC
    this.pool = new PtyPool({ idleTtlSec: this.ptyIdleTtlSec })
  }

  async call(params: RemoteCallParams, callCtx: { sessionKey?: string; ptyBackground?: boolean } = {}): Promise<RemoteCallResult> {
    const started = Date.now()
    try {
      this.assertOpen()
      const prepared = await prepareRemoteInput(params)
      this.assertOpen()
      const routing = this.route(prepared)
      const result = await this.execute(prepared, routing, callCtx)
      this.audit({
        target: routing.display, cmd: prepared.cmd, cwd: result.cwd ?? undefined,
        exit: result.exit, durationMs: Date.now() - started,
      })
      return result
    } catch (error) {
      this.audit({
        target: params.target ?? params.spawn ?? '?', cmd: params.cmd ?? '[local script]',
        error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started,
      })
      throw error
    }
  }

  /** Native-first copy routing (spec: remote-native-shortcut): CLI peers run
   * their native CLI verbatim; only Hub↔local↔local stays on the staged tree
   * lane with verify/mkdir. Mixed pairs (Hub↔CLI peer) are refused: Hub has no
   * native CLI and the tree lane has no CLI options. */
  copy(request: CopyRequest & { argv?: unknown; pullArgv?: unknown; pushArgv?: unknown }, signal: AbortSignal, callCtx: { sessionKey?: string } = {}): Promise<TransferReceipt | NativeCopyReceipt> {
    const combined = AbortSignal.any([signal, this.fileAbort.signal])
    const work = (async () => {
      this.assertOpen(); combined.throwIfAborted()
      const resolve = async (value: string) => {
        const parsed = parseFileEndpoint(value)
        if (!parsed.target) return { kind: 'local' as const, path: parsed.path }
        if (parsed.target.startsWith('hub:')) return { kind: 'hub' as const, path: parsed.path, machine: parsed.target.slice(4) }
        const plan = await this.resolveConnectionTarget(parsed.target, callCtx)
        this.assertOpen(); combined.throwIfAborted()
        return { kind: 'cli' as const, path: parsed.path, plan }
      }
      const src = await resolve(request.src), dst = await resolve(request.dst)
      this.assertOpen(); combined.throwIfAborted()
      if (src.kind === 'hub' || dst.kind === 'hub') {
        if (src.kind === 'hub' && dst.kind === 'local') {
          const hub = this.requireHub(); this.hubProviders.add(hub)
          return copyTree(request, { path: src.path, endpoint: hub.fileEndpoint(src.machine) }, { path: dst.path, endpoint: localFileEndpoint() }, combined)
        }
        if (src.kind === 'local' && dst.kind === 'hub') {
          const hub = this.requireHub(); this.hubProviders.add(hub)
          return copyTree(request, { path: src.path, endpoint: localFileEndpoint() }, { path: dst.path, endpoint: hub.fileEndpoint(dst.machine) }, combined)
        }
        if (src.kind === 'hub' && dst.kind === 'hub') {
          const hub = this.requireHub(); this.hubProviders.add(hub)
          return copyTree(request, { path: src.path, endpoint: hub.fileEndpoint(src.machine) }, { path: dst.path, endpoint: hub.fileEndpoint(dst.machine) }, combined)
        }
        throw new Error('copy: Hub endpoints pair only with local paths or another Hub machine (native CLI peers have no Hub lane and the Hub has no CLI options)')
      }
      if (src.kind === 'local' && dst.kind === 'local')
        return copyTree(request, { path: src.path, endpoint: localFileEndpoint() }, { path: dst.path, endpoint: localFileEndpoint() }, combined)
      // At least one CLI peer: native route (local↔peer is still one command).
      // verify stays a Hub-staged-lane option (tier C is not implemented on
      // native routes — D1=A, 2026-10-17); mkdir is now a native default (D3)
      // and passes through to nativeCopy's best-effort pre-hop.
      if (request.verify !== undefined) throw new Error('copy: verify is a Hub/local staged lane option (independent SHA-256); native routes report exit-code-only verification — self-verify via oneshot digest commands when needed' )
      const planOf = (end: typeof src | typeof dst) => end.kind === 'cli' ? end.plan : end.kind === 'local' ? ({ kind: 'local' } as const) : undefined
      const srcPlan = planOf(src), dstPlan = planOf(dst)
      if (srcPlan === undefined || dstPlan === undefined) throw new Error('copy: unreachable route resolution')
      const execArgvFor = (plan: import('./target.ts').TargetPlan, script: string): string[] => {
        const argv = helperShellArgv(plan, script)
        return this.opts.nativeArgvFor ? this.opts.nativeArgvFor(argv) : argv
      }
      return nativeCopy({ src: request.src, dst: request.dst, ...(request.mkdir === undefined ? {} : { mkdir: request.mkdir }), ...(request.argv === undefined ? {} : { argv: request.argv as string[] }), ...(request.pullArgv === undefined ? {} : { pullArgv: request.pullArgv as string[] }), ...(request.pushArgv === undefined ? {} : { pushArgv: request.pushArgv as string[] }) }, { src: { plan: srcPlan, path: src.path }, dst: { plan: dstPlan, path: dst.path } }, combined, { wrapArgv: this.opts.nativeArgvFor, execArgvFor })
    })()
    this.starting.add(work)
    void work.then(() => this.starting.delete(work), () => this.starting.delete(work))
    return work
  }

  rsync(request: RsyncRequest, signal: AbortSignal, callCtx: { sessionKey?: string } = {}): Promise<RsyncReceipt> {
    const combined = AbortSignal.any([signal, this.fileAbort.signal])
    const work = (async () => {
      this.assertOpen(); combined.throwIfAborted()
      const endpoint = async (value: string) => {
        const parsed = parseFileEndpoint(value)
        if (!parsed.target) return { path: parsed.path }
        if (/^(hub|docker|incus|byop):/.test(parsed.target)) throw new Error('rsync supports SSH/byossh only (plus one local endpoint); no mixed-transport or copy fallback')
        const plan = await this.resolveConnectionTarget(parsed.target, callCtx)
        this.assertOpen(); combined.throwIfAborted()
        if (plan.kind !== 'ssh') throw new Error('rsync requires an SSH target; no copy fallback')
        return { path: parsed.path, connection: plan.connection ?? { host: plan.host } }
      }
      const source = await endpoint(request.src), destination = await endpoint(request.dst)
      this.assertOpen(); combined.throwIfAborted()
      return runRsync(request, source, destination, combined, { wrapArgv: this.opts.nativeArgvFor })
    })()
    this.starting.add(work)
    void work.then(() => this.starting.delete(work), () => this.starting.delete(work))
    return work
  }

  /** Only called from JobSpec.run: admission precedes local file reads and discovery. */
  start(input: RemoteInput, signal: AbortSignal): Promise<RemoteProcess> {
    const work = this.startPrepared(input, AbortSignal.any([signal, this.fileAbort.signal]))
    this.starting.add(work)
    void work.then(() => this.starting.delete(work), () => this.starting.delete(work))
    return work
  }

  private async startPrepared(input: RemoteInput, signal: AbortSignal): Promise<RemoteProcess> {
    this.assertOpen(); signal.throwIfAborted()
    const params = await prepareRemoteInput(input)
    this.assertOpen(); signal.throwIfAborted()
    const route = this.route(params)
    if (route.mode !== 'oneshot' || route.pty) throw new Error('remote: background requires oneshot')
    let process: RemoteProcess
    if (route.display.startsWith('hub:')) {
      const hub = this.requireHub(); this.hubProviders.add(hub)
      process = await hub.start(route.display.slice(4), { ...params, mode: 'oneshot' }, this.hubOwner)
    } else {
      const plan = route.plan ?? await this.resolveBareName(route.bare!, 'no-session', false)
      this.assertOpen(); signal.throwIfAborted()
      if (plan.kind === 'pty') throw new Error('remote: background requires oneshot')
      process = await this.nativeProcess(plan, params, params.timeout, signal)
    }
    this.own(process)
    if (signal.aborted || this.disposed) process.cancel('owner closed during start')
    return process
  }

  private async nativeProcess(plan: TargetPlan, params: PreparedRemoteInput, timeoutSec?: number, signal = this.fileAbort.signal): Promise<RemoteProcess> {
    // Helper fast path first (spec §5): a pinned superd-run on the endpoint gives portable
    // supervision + kernel-anchored disconnect cleanup; every miss falls back to the POSIX
    // wrapper below with byte-identical behavior. The receipt's runner field says which ran.
    const cleanupTag = randomUUID().slice(0, 8)
    const helper = await this.ensureHelper(plan)
    if (helper !== null && !this.disposed) {
      const process = startOneShot(buildHelperOneShotArgv(plan, helper.binPath, { tag: cleanupTag, cmd: params.cmd }), { stdin: params.stdin, timeoutSec })
      this.runnerOf.set(process, `superd-run ${helper.ver} (${helper.triple})`)
      void process.done.then(result => {
        if (!result.cancelled && !result.timedOut) return
        const killer = startOneShot(buildHelperKillgroupArgv(plan, helper.binPath, cleanupTag), { timeoutSec: 15 })
        killer.done.catch(() => {})
      }).catch(() => {})
      const tracked = Promise.resolve(process)
      this.starting.add(tracked)
      void tracked.then(() => this.starting.delete(tracked), () => this.starting.delete(tracked))
      return tracked
    }
    // Plain native oneshot: the endpoint wrapper reaps backgrounded children
    // on normal completion (EXIT trap). Cancellation/timeout kills the LOCAL
    // transport at once; sshd delivers no signal to a no-PTY session, so the
    // remote tree is cleaned through its own session reading the pidfile the
    // wrapper left (same explicit-cleanup shape as the rsync daemon route).
    const process = startOneShot((this.opts.oneshotArgvFor ?? buildOneShotArgv)(plan, params.cmd, { cleanupTag }), { stdin: params.stdin, timeoutSec })
    this.runnerOf.set(process, 'posix-shim')
    void process.done.then(result => {
      if (!result.cancelled && !result.timedOut) return
      const pidfile = `"\${TMPDIR:-/tmp}/superd-oneshot-${cleanupTag}.pgid"`
      const cleanup = `p=$(cat ${pidfile} 2>/dev/null) && { kill -TERM -- "-$p" 2>/dev/null; sleep 0.3; kill -KILL -- "-$p" 2>/dev/null; }; rm -f ${pidfile}`
      const killer = startOneShot((this.opts.oneshotArgvFor ?? buildOneShotArgv)(plan, cleanup, {}), { timeoutSec: 15 })
      killer.done.catch(() => {})
    }).catch(() => {})
    const work = Promise.resolve(process)
    this.starting.add(work)
    void work.then(() => this.starting.delete(work), () => this.starting.delete(work))
    return work
  }

  /** Helper bootstrap is best-effort and sticky: any failure parks null for this driver
   *  lifetime and the shim stays the path. First call to a target pays probe (+ upload). */
  private async ensureHelper(plan: TargetPlan): Promise<HelperRunnerInfo | null> {
    if (this.helpers === undefined) {
      const assets = this.opts.helperAssetsFor?.() ?? helperAssets()
      this.helpers = assets === null ? null : new HelperRegistry(assets, (argv, options) => this.helperExec(argv, options), buildHelperProbeArgv, buildHelperUploadArgv)
    }
    if (this.helpers === null || this.disposed) return null
    try { return await this.helpers.ensure(plan) } catch { return null }
  }

  private async helperExec(argv: string[], options?: { stdin?: Buffer; timeoutSec?: number }): Promise<{ exit: number | null; stdout: string }> {
    this.assertOpen()
    const stdin = options?.stdin
    if (stdin !== undefined) {
      const proc = startBinaryProcess(argv, { timeoutSec: options?.timeoutSec })
      proc.stdin.on('error', () => {})
      proc.stdin.end(stdin)
      const done = await proc.done
      return { exit: done.exit, stdout: '' }
    }
    const proc = startOneShot(argv, { timeoutSec: options?.timeoutSec })
    const done = await proc.done
    return { exit: done.exit, stdout: proc.read('stdout', 0).text }
  }

  private own(process: RemoteProcess): RemoteProcess {
    this.processes.add(process)
    void process.done.then(() => this.processes.delete(process))
    return process
  }

  /** Ruling 16/17：on-demand 探测 + 会话层，两行如实陈述。 */
  /**
   * Ruling P20 + PTY 候选表末位：裸名按名匹配——ssh config 字面 host → docker → incus（本地廉价扫描，
   * 撞名 ssh 优先），三段全不中再看池内活 PTY label，最后才是默认 ssh（交原生错误）。
   * 位置即优先级：现有三段一位不挪。选择器前缀的 target 不经此路径。
   */
  private async resolveBareName(name: string, sessionKey: string, usePtyLabels = true): Promise<BareResolution> {
    const runner = this.opts.rosterRunner ?? runOneShot
    const readCfg = this.opts.sshConfigReader ?? (async () => await readFile(join(homedir(), '.ssh', 'config'), 'utf8'))
    let hosts: string[] = []
    try { hosts = literalHosts(await readCfg()).hosts } catch { /* 无可读 config：跳过该源 */ }
    this.assertOpen()
    if (hosts.some((h) => h.toLowerCase() === name.toLowerCase())) return { kind: 'ssh', host: name }
    const docker = await runner(['docker', 'ps', '-a', '--format', '{{.Names}}'], { timeoutSec: 10 })
    this.assertOpen()
    if (docker.exit === 0 && docker.stdout.trim().split(/\r?\n/).some((n) => n.trim().toLowerCase() === name.toLowerCase()))
      return { kind: 'docker', container: name }
    const incus = await runner(['incus', 'list', '--format', 'csv', '--columns', 'n'], { timeoutSec: 10 })
    this.assertOpen()
    if (incus.exit === 0 && incus.stdout.trim().split(/\r?\n/).some((n) => n.split(',')[0]?.trim().toLowerCase() === name.toLowerCase()))
      return { kind: 'incus', container: name }
    // 候选表末位 = 池内活 PTY label（三段之后、ssh 兜底之前）。usePtyLabels=false：调用面显式要
    // oneshot 时不吃这个候选，裸名在 mode:'oneshot' 下的旧行为逐位保留。
    if (usePtyLabels && this.pool.get(`${sessionKey}|p:${name}`) !== undefined) return { kind: 'pty', label: name }
    return { kind: 'ssh', host: name }
  }

  /** Ruling P19：roster = 注意力入口——本地廉价扫描（ssh config/docker ps/incus list + 池内活会话），零拨号。
   *  活的 pty 会话按调用方 agent session 过滤（2026-10-03 裁决）：ssh/docker/incus 是**公共静态配置**，
   *  而活会话是**操作环境**——复用别的 agent 留下的 shell 等于继承未知状态，且两个 agent 各开一条线
   *  的代价可忽略。BYO-PTY 天然是活的，于是自然落进这个 scope，无需另立规则。 */
  async roster(callCtx: { sessionKey?: string } = {}): Promise<string> {
    this.assertOpen()
    const prefix = `${callCtx.sessionKey ?? 'no-session'}|`
    const sessions = this.pool.list()
      .filter(({ key }) => key.startsWith(prefix))
      .map(({ key, snapshot }) => ({
        target: displayKey(key),
        state: snapshot.state,
        idleSec: snapshot.idleMs !== null ? Math.round(snapshot.idleMs / 1000) : null,
      }))
    const runner = this.opts.rosterRunner ?? runOneShot
    const hub = this.opts.getHub?.()
    const hubRoster = hub ? ['hub machines: ' + (hub.listTargets().map(t => `hub:${t.id} (${t.label}${t.execEnabled ? '' : '; exec disabled'})`).join(', ') || 'none')] : []
    return [...hubRoster, await renderRoster(sessions, { byosshLabels: this.sshTargets.entries().map(([label]) => label), readSshConfig: this.opts.sshConfigReader, runner: (argv, options) => { this.assertOpen(); return runner(argv, options) } })].join('\n')
  }

  async status(target: string, callCtx: { sessionKey?: string } = {}): Promise<string> {
    this.assertOpen()
    if (target.startsWith('hub:')) {
      const machine = target.slice(4)
      const row = this.requireHub().listTargets().find(t => t.id === machine)
      if (!row) throw new Error(`unknown remote machine ${machine} — select a remote machine from the Hub roster; local execution is not available`)
      return `${target} — Hub remote machine (${row.label}); exec ${row.execEnabled ? 'enabled' : 'disabled'}; not probed`
    }
    const sessionKey = callCtx.sessionKey ?? 'no-session'
    const label = target.startsWith('byop:') ? target.slice(5) : undefined
    if (label !== undefined) return this.ptyStatus(target, label, sessionKey)
    const direct = /^(docker|incus|ssh):/.test(target)
    const resolved: BareResolution = target.startsWith('byossh:') ? this.byosshPlan(target) : direct ? resolveTarget(target) : await this.resolveBareName(target, sessionKey)
    this.assertOpen()
    if (resolved.kind === 'pty') return this.ptyStatus(`byop:${resolved.label}`, resolved.label, sessionKey)
    const head = `${target} — ${resolved.kind === 'ssh' ? 'ssh host' : `${resolved.kind} container`}`
    const runner = this.opts.probeRunner ?? runOneShot
    const probe = await probeTarget(resolved, { runner: (argv, options) => { this.assertOpen(); return runner(argv, options) } })
    return [head, renderProbe(probe), renderSession(this.pool.inspect(`${sessionKey}|t:${target}`))].join('\n')
  }

  /** PTY 状态行：纯池内读取，零拨号（label 从来不是可拨目标）。 */
  private ptyStatus(display: string, label: string, sessionKey: string): string {
    return [`${display} — BYO pty session`, renderPtySession(this.pool.inspect(`${sessionKey}|p:${label}`))].join('\n')
  }

  /** Ruling 13：审计 best-effort——钩子抛错不得影响命令路径（成功被毒化成失败+双重审计）。 */
  private audit(r: RemoteAuditRecord): void {
    try { this.opts.onAudit?.(r) } catch { /* audit hook failure is never the command's failure */ }
  }

  /** Registration never dials; response reveals labels only, not credentials. */
  registerSsh(target: string, connection: SshConnection): string {
    this.assertOpen()
    if (!target.startsWith('byossh:')) throw new Error('[E_SSH_PARAMS] remote: ssh requires a byossh:<label> target')
    this.sshTargets.register(target.slice(7), connection)
    return `${target} registered (no dialing). Reuse this Agent's label without ssh; a new Agent/cold resume must register again.`
  }

  private byosshPlan(target: string, connection?: SshConnection): TargetPlan {
    if (connection !== undefined) this.registerSsh(target, connection)
    const spec = this.sshTargets.get(target.slice(7))
    if (!spec) throw new Error(`[E_NO_SSH_TARGET] remote: ${target} is not registered in this Agent — supply ssh:{host,user?,port?,key?,proxyJump?} first; key must be an existing origin file path`)
    return { kind: 'ssh', host: spec.host, connection: spec }
  }

  /** Single target resolver for later copy/rsync; BYO identities cannot be
   * independently re-resolved through the origin's alias table. */
  async resolveConnectionTarget(target: string, callCtx: { sessionKey?: string } = {}): Promise<TargetPlan> {
    this.assertOpen()
    if (target.startsWith('byossh:')) return this.byosshPlan(target)
    if (/^(docker|incus|ssh):/.test(target)) return resolveTarget(target)
    if (/^(byop|hub):/.test(target)) throw new Error('remote: select an SSH/Docker/Incus target for this connection resolver')
    const plan = await this.resolveBareName(target, callCtx.sessionKey ?? 'no-session', false)
    this.assertOpen()
    if (plan.kind === 'pty') throw new Error('remote: BYO-PTY is not a filesystem connection')
    return plan
  }

  private route(params: PreparedRemoteInput): { mode: 'oneshot' | 'pty'; display: string; plan?: TargetPlan; bare?: string; pty?: PtyRouting } {
    const hasTarget = params.target !== undefined && params.target.length > 0
    const hasSpawn = params.spawn !== undefined && params.spawn.length > 0
    if (!hasTarget && !hasSpawn)
      throw new Error('[E_PARAMS] remote: target is required (e.g. { target: "dev4", cmd: "git status" }); spawn is a modifier of a "byop:<label>" target and cannot stand alone')
    if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0))
      throw new Error(`[E_BAD_TIMEOUT] remote: timeout must be a positive number of seconds (got ${JSON.stringify(params.timeout)})`)
    if (params.stdin !== undefined && (params.cmd === undefined || params.cmd.length === 0))
      throw new Error('[E_STDIN_WITHOUT_CMD] remote: stdin requires cmd')
    if (params.ssh !== undefined && !params.target.startsWith('byossh:'))
      throw new Error('[E_SSH_PARAMS] remote: ssh requires a byossh:<label> target')
    if (params.target.startsWith('byossh:')) {
      if (hasSpawn) throw new Error('[E_PARAMS] remote: spawn is only for byop:<label>, not BYO-SSH')
      return { mode: params.mode ?? 'oneshot', display: params.target, plan: this.byosshPlan(params.target, params.ssh) }
    }
    // PTY 选择器 = BYO-PTY 的唯一入口：label 由模型自选（可读 → 可复用），spawn 只是它的伴生创建参数。
    if (hasTarget && params.target!.startsWith('byop:')) {
      const label = params.target!.slice(5)
      if (!PTY_LABEL_RE.test(label))
        throw new Error(`[E_BAD_LABEL] remote: PTY label must match ${PTY_LABEL_RE.source} (got ${JSON.stringify(label)}) — e.g. target: "byop:dev3"`)
      if (params.mode !== undefined && params.mode !== 'pty')
        throw new Error(`[E_BAD_MODE] remote: "${params.target}" is a PTY selector — mode is locked to 'pty'`)
      return { mode: 'pty', display: params.target!, pty: { label, ...(hasSpawn ? { spawn: params.spawn! } : {}) } }
    }
    if (hasSpawn)
      throw new Error('[E_PARAMS] remote: spawn requires a "byop:<label>" target — e.g. { target: "byop:dev3", spawn: "ssh dev3", cmd: "…" }; it is not a standalone entry point')
    const mode: 'oneshot' | 'pty' = params.mode ?? 'oneshot'
    // P20：带选择器前缀的 target 走同步解析；裸名延迟到 execute 的按名匹配（异步本地扫描）。
    if (params.target!.startsWith('hub:')) return { mode, display: params.target! }
    const direct = /^(docker|incus|ssh):/.test(params.target!)
    return { mode, display: params.target!, ...(direct ? { plan: resolveTarget(params.target!) } : { bare: params.target! }) }
  }

  private async execute(
    params: PreparedRemoteInput,
    routing: { mode: 'oneshot' | 'pty'; display: string; plan?: TargetPlan; bare?: string; pty?: PtyRouting },
    callCtx: { sessionKey?: string; ptyBackground?: boolean },
  ): Promise<RemoteCallResult> {
    const timeoutSec = params.timeout ?? this.opts.execTimeoutSec ?? 120
    const cap = this.opts.maxOutputChars ?? 30_000
    if (routing.display.startsWith('hub:')) {
      const hub = this.requireHub()
      this.hubProviders.add(hub)
      const machine = routing.display.slice(4)
      if (routing.mode === 'pty') {
        const result = await hub.pty(machine, params.cmd, this.hubOwner, { stdin: params.stdin, timeout: timeoutSec })
        const out = tailWindow(result.stdout, cap, result.outputStats?.stdout)
        return { ...result, stdout: out.text, ...(out.stats ? { outputStats: { ...result.outputStats, stdout: out.stats } } : {}), ...(out.truncated === undefined ? {} : { truncated: out.truncated }) }
      }
      const process = this.own(await hub.start(machine, { ...params, target: routing.display, mode: 'oneshot', timeout: timeoutSec }, this.hubOwner))
      if (this.disposed) process.cancel('owner disposed')
      const result = await process.done
      const stdout = process.read('stdout', 0), stderr = process.read('stderr', 0)
      const out = tailWindow(stdout.text, cap, stdout.stats)
      const err = tailWindow(stderr.text, cap, stderr.stats)
      return {
        ...result, mode: 'oneshot', target: routing.display, cwd: null, reconnected: false,
        stdout: (!stdout.stats && stdout.lossy ? '[truncated: peer returned only a tail; exact total/retained/dropped unavailable]\n' : '') + out.text,
        stderr: [err.text, stderr.diagnostic].filter(Boolean).join('\n'),
        ...(out.stats ? { outputStats: { stdout: out.stats, stderr: err.stats } } : { outputStatsUnavailable: true }),
        ...(out.truncated === undefined ? {} : { truncated: out.truncated }),
      }
    }
    const sessionKey = callCtx.sessionKey ?? 'no-session'
    if (routing.bare !== undefined) {
      // 裸名候选表（含末位 PTY 候选）解析；命中 PTY 则就地切通道 + 切 mode。
      // usePtyLabels：仅「显式 mode:'oneshot'」不吃末位候选——未指定 mode 的裸名照样命中，
      // 否则懒复用（只写 label 不写 PTY 选择器）不可能成立。
      const resolved = await this.resolveBareName(routing.bare, sessionKey, params.mode !== 'oneshot')
      this.assertOpen()
      if (resolved.kind === 'pty') {
        routing.pty = { label: resolved.label }
        routing.mode = 'pty'
        routing.display = `byop:${resolved.label}`
      } else routing.plan = resolved
    }
    if (routing.pty !== undefined) return await this.ptyCall(routing.pty, params, sessionKey, timeoutSec, cap, callCtx.ptyBackground === true)
    if (routing.mode === 'oneshot') {
      this.assertOpen()
      const process = this.own(await this.nativeProcess(routing.plan!, params, timeoutSec))
      if (this.disposed) process.cancel('owner disposed')
      const result = await process.done
      const stdout = process.read('stdout', 0), stderr = process.read('stderr', 0)
      const r = { ...result, stdout: stdout.text, stderr: [stderr.text, stderr.diagnostic].filter(Boolean).join('\n'), outputStats: { stdout: stdout.stats!, stderr: stderr.stats } }
      const out = tailWindow(r.stdout, cap, r.outputStats?.stdout)
      const err = r.stderr.length > 0 ? tailWindow(r.stderr, cap, r.outputStats?.stderr) : undefined
      return {
        mode: 'oneshot', target: routing.display, exit: r.exit, cwd: null,
        timedOut: r.timedOut, reconnected: false, stdout: out.text,
        ...(err !== undefined ? { stderr: err.text } : {}),
        ...(out.stats ? { outputStats: { stdout: out.stats, stderr: err?.stats ?? r.outputStats?.stderr } } : {}), durationMs: r.durationMs,
        ...(out.truncated !== undefined ? { truncated: out.truncated } : {}),
        ...(this.runnerOf.get(process) === undefined ? {} : { runner: this.runnerOf.get(process)! }),
      }
    }
    const argv = (this.opts.ptyArgvFor ?? buildPtyArgv)(routing.plan!)
    const key = `${sessionKey}|t:${routing.display}`
    const session = this.pool.getOrCreate(key, argv)
    const r = await session.dispatch(params.cmd, { stdin: params.stdin, timeoutSec, ...(callCtx.ptyBackground === true ? { background: true } : {}) })
    const out = tailWindow(r.output, cap, r.outputStats?.stdout)
    return {
      mode: 'pty', target: routing.display, exit: r.exit, cwd: r.cwd,
      timedOut: r.timedOut, reconnected: r.reconnected, stdout: out.text,
      outputStats: out.stats ? { stdout: out.stats } : undefined,
      durationMs: r.durationMs, ...(out.truncated !== undefined ? { truncated: out.truncated } : {}),
      ...(r.running === true && r.job !== undefined ? { running: true, ptyJob: r.job } : {}),
      ...this.ptyTtl(key),
    }
  }

  /** BYO-PTY 通道：label 即池键（agent 前缀之外），spawn 只在 label 尚不存在时被接受。
   * 三分支 —— 建（无会话）/ 复用（无 spawn，或有 spawn 且与创建来源相同）/ **冲突（有 spawn 且来源不同：不执行任何命令）**。 */
  private async ptyCall(
    pty: PtyRouting,
    params: PreparedRemoteInput,
    sessionKey: string,
    timeoutSec: number,
    cap: number,
    background: boolean,
  ): Promise<RemoteCallResult> {
    const display = `byop:${pty.label}`
    const key = `${sessionKey}|p:${pty.label}`
    const existing = this.pool.get(key)
    let session = existing
    let notice: string | undefined
    if (existing !== undefined && pty.spawn !== undefined && existing.origin !== pty.spawn)
      throw new Error(
        `[E_LABEL_CONFLICT] remote: ${display} already exists and was created by a different command — nothing was run.\n` +
          `  existing spawn: ${JSON.stringify(existing.origin)}\n` +
          `  given spawn:    ${JSON.stringify(pty.spawn)}\n` +
          `  To reuse it:    { target: "${display}", cmd: "…" }   (drop spawn — spawn only ever creates)\n` +
          `  To start new:   pick another label, e.g. { target: "byop:${pty.label}2", spawn: ${JSON.stringify(pty.spawn)}, cmd: "…" }`,
      )
    if (session === undefined) {
      if (pty.spawn === undefined)
        throw new Error(
          `[E_NO_SESSION] remote: no live PTY under ${display} — one exists only after a call that supplies spawn, and it is reaped after the idle TTL (15 min).\n` +
            `  Create it:      { target: "${display}", spawn: "…", cmd: "…" }   (the spawn command is not retained; the label is yours to choose)`,
        )
      session = this.pool.getOrCreate(key, (this.opts.spawnArgvFor ?? buildSpawnArgv)(pty.spawn), pty.spawn)
    } else if (pty.spawn !== undefined) {
      notice = `[remote: ${display} already runs that exact command and is persistent — reuse it with { target: "${display}", cmd: "…" }; spawn is only needed to create.]`
    }
    const r = await session.dispatch(params.cmd, { stdin: params.stdin, timeoutSec, ...(background ? { background: true } : {}) })
    const out = tailWindow(r.output, cap, r.outputStats?.stdout)
    return {
      mode: 'pty', target: display, session: display, exit: r.exit, cwd: r.cwd,
      timedOut: r.timedOut, reconnected: r.reconnected, stdout: out.text,
      ...(notice !== undefined ? { notice } : {}),
      outputStats: out.stats ? { stdout: out.stats } : undefined,
      durationMs: r.durationMs, ...(out.truncated !== undefined ? { truncated: out.truncated } : {}),
      ...(r.running === true && r.job !== undefined ? { running: true, ptyJob: r.job } : {}),
      ...this.ptyTtl(key),
    }
  }

  /** P2/P3：回执即状态快照——把「idle TTL 剩余」随每次 pty 回执带回（不可得则省略）。 */
  private ptyTtl(key: string): { ttlSec?: number } {
    const snap = this.pool.inspect(key)
    if (snap === undefined || snap.idleMs === null) return {}
    return { ttlSec: Math.max(0, Math.round(this.ptyIdleTtlSec - snap.idleMs / 1_000)) }
  }
  hasHub(): boolean { return this.opts.getHub?.() !== undefined }

  private requireHub(): HubRemoteTransport {
    this.assertOpen()
    const hub = this.opts.getHub?.()
    if (!hub || hub.protocol !== 1) throw new Error('[E_HUB_UNAVAILABLE] remote: Hub transport unavailable — enable the Super D Hub body, or select an explicit SSH/Docker/Incus/BYO target')
    return hub
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('[E_REMOTE_DISPOSED] remote: this Agent or plugin owner has exited — create a new session or cold resume')
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.sshTargets.clear()
    this.disposed = true // Close admission synchronously, before draining existing resources.
    this.fileAbort.abort(new Error('remote owner disposed'))
    for (const process of this.processes) process.cancel('remote owner disposed')
    return this.disposal = (async () => {
      await Promise.allSettled([...this.starting])
      await Promise.all([this.pool.disposeAll(), ...[...this.processes].map(p => p.done), ...[...this.hubProviders].map(hub => hub.releaseOwner(this.hubOwner))])
      this.hubProviders.clear()
    })()
  }
}
