import { copyTree, type CopyRequest, type TransferReceipt } from './copy.ts'
import { runRsync, type RsyncRequest, type RsyncReceipt } from './rsync.ts'
import { nativeCopy, type NativeCopyReceipt, type CopyPlan } from './native-copy.ts'
import { localFileEndpoint } from './archive.ts'
import { parseFileEndpoint } from './endpoints.ts'
import { randomUUID } from 'node:crypto'
import type { SshConnection } from './ssh-targets.ts'
import { normalizeSshConnection } from './ssh-targets.ts'
import type { HubRemoteTransport, RemoteInput, PreparedRemoteInput, StreamOutputStats, RemoteProcess } from './hub-contract.ts'
import { prepareRemoteInput } from './input.ts'
import { startOneShot, runOneShot } from './oneshot.ts'
import { startBinaryProcess } from './process.ts'
import { helperAssets, HelperRegistry, type HelperAssets, type HelperRunnerInfo } from './helper.ts'
import { startOwnedNativeProcess } from './ssh-process.ts'
import { SshMux } from './ssh-mux.ts'
import { PtyPool, type PtyRunningJob, type PtySession, type PtyInputOptions, type PtyInputReceipt } from './pty-session.ts'
import { disclose, type EnvDelta } from './nonce-framing.ts'
import { resolveTarget, parseTargetForm, type TargetForm, type TargetPlan } from './target.ts'
import { LabelPool, validateLabel, PTY_ID_RE, describeEntry, type PoolEntry } from './labels.ts'
import { probeTarget, renderProbe, type ProbeOptions } from './status.ts'
import { scanLocal, renderRoster, type RosterOptions } from './roster.ts'
import { literalHosts } from './roster.ts'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildOneShotArgv, buildPtyArgv, buildSpawnArgv, buildHubPtyArgv, buildHelperOneShotArgv, buildHelperKillgroupArgv, buildHelperProbeArgv, buildHelperUploadArgv, helperShellArgv, type HubPtyEndpoint } from './transports.ts'

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
  /** §5.2 回执字段序：session（+label）→ connection → commandId → state 字段（cwd/envDelta/ttlSec/exit）。 */
  session?: string
  label?: string
  connection?: string
  /** (byo-pty)/(byo-ssh) 来源标注（创建回执与 roster/card；native 回执省略）。 */
  byoTag?: 'byo-pty' | 'byo-ssh'
  commandId?: string
  envDelta?: EnvDelta
  /** 引导/教学行；无则省略。 */
  notice?: string
  /** oneshot 监督路径的如实标注：`superd-run <ver> (<triple>)` 或 `posix-shim`（spec remote-rescope §5）。 */
  runner?: string
  /** P4/P5（2026-10-19）：true = pty 命令仍在前台运行（回执 = handoff），ptyJob 随行供 job 通道接管。 */
  running?: boolean
  ptyJob?: PtyRunningJob
  /** 本会话 idle TTL 剩余（秒）；回执即状态快照（P2/P3：状态留在上下文里）。 */
  ttlSec?: number
  /** 预热（创建形无 cmd）回执 = true。 */
  created?: boolean
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
  onAudit?: (r: RemoteAuditRecord) => void
  oneshotArgvFor?: (plan: TargetPlan, cmd: string, options: { cleanupTag?: string; muxArgv?: readonly string[] }) => string[]
  ptyArgvFor?: (plan: TargetPlan) => string[]
  spawnArgvFor?: (spawnCommand: string) => string[]
  /** 测试/验收缝：hub PTY 泵 argv（默认 buildHubPtyArgv + 宿主树 ws 解析）。 */
  hubPtyArgvFor?: (endpoint: HubPtyEndpoint) => string[]
  probeRunner?: ProbeOptions['runner']
  /** 测试/验收缝：helper 资产来源（默认 lib 旁挂 helper-bin）；显式 null 强制 shim 路径。 */
  helperAssetsFor?: () => HelperAssets | null
  /** 测试/验收缝：SSH oneshot MUX 状态（默认每 driver 一个 SshMux = 每 Agent 隔离）。 */
  sshMux?: SshMux
  /** 测试缝：roster 扫描执行器（裸名解析复用）。 */
  rosterRunner?: RosterOptions['runner']
  /** 测试缝：ssh config 读取（裸名解析复用）。 */
  sshConfigReader?: () => Promise<string>
}

/** R1：idle TTL 15 min——idle 随活动重置，在用会话永不超时（PtySession 双条件）。 */
export const REMOTE_PTY_IDLE_TTL_SEC = 900
/** P3（user 2026-10-19）：每 agent 10 个 PTY 会话，跨所有 connection 统一计；仅 error message 披露。 */
/** 二/三轮裁决（2026-11-01）：每 Agent session 全局 30 个 active PTY（默认/handoff/BYO 全计入）；
 * 仅触达上限时的错误回执与 roster 可见性披露，任何模型可见 surface 不预先公布。 */
export const REMOTE_PTY_SESSION_LIMIT = 30

/** hub 线 one-shot 监督披露（0.3.2-c）：对端 = 我们自己的 hub server（bash -lc 于独立进程组，
 *  Node 原生 TERM→2s→KILL + 输出环 + 租约生命周期）；superd-run helper 是 dumb-pipe 专用物，
 *  从不经 hub 上传（non-goal，docs/10_plans/2026-10-25-hub-remote-parity.md §3 O1/O8）。 */
const HUB_RUNNER = 'hub-lease (peer bash -lc, peer Node supervision)'

/** hub PTY 泵资产：pump 与本模块同目录（npm 包与 Super 闭包同构，helper.ts 同款纪律）。
 *  ws 模块路径由 transport 侧（superd-hub 上下文，分叉的 proven 解析链）解析后经
 *  ptyEndpoint 传入——闭包自身子树无可解析的 ws，按名解析不在闭包里做（0.3.2-c 定稿）。 */
export function hubPtyAssets(): { pumpPath: string } {
  return { pumpPath: join(dirname(fileURLToPath(import.meta.url)), 'hub-pty-pump.mjs') }
}

/** 账本键与 jobId 同构（同格式 `<kind>-<16hex>`）；background 通道预传入 registry id 时两者字面相等。 */
const genCommandId = (): string => `remote-${randomUUID().replace(/-/g, '').slice(0, 16)}`

/** 双轨调度器：参数校验 → 目标语法（parseTargetForm）→ 统一 label 池 → oneshot 子进程 / pty 会话池。 */
export class RemoteDriver {
  private readonly pool: PtyPool
  /** 默认 PTY 槽（spec remote-default-pty §1）：sessionKey → 归一 machineKey → pool key。
   * 会话本体是普通 PtySession（id 创建即认领，roster 全可见）；槽登记在 dispose/TTL 后悬空，
   * 取槽时经 pool.get（disposed 视同出池）惰性清理。 */
  private readonly defaultSlots = new Map<string, Map<string, string>>()
  private readonly labels = new LabelPool()
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
  private readonly mux: SshMux
  constructor(private readonly opts: RemoteDriverOptions = {}) {
    this.mux = opts.sshMux ?? new SshMux()
    this.ptyIdleTtlSec = opts.idleTtlSec ?? REMOTE_PTY_IDLE_TTL_SEC
    this.pool = new PtyPool({ idleTtlSec: this.ptyIdleTtlSec })
  }

  async call(params: RemoteCallParams, callCtx: { sessionKey?: string; ptyBackground?: boolean; commandId?: string } = {}): Promise<RemoteCallResult> {
    const started = Date.now()
    try {
      this.assertOpen()
      const prepared = await prepareRemoteInput(params)
      this.assertOpen()
      const form = parseTargetForm(prepared.target)
      this.validate(form, prepared)
      const result = await this.execute(prepared, form, callCtx)
      this.audit({
        target: result.target, cmd: prepared.cmd, cwd: result.cwd ?? undefined,
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

  /** 参数互斥矩阵（§2）：spawn/ssh 是 BYO 入口（参数在场即 BYO），只与对应形态的 target 配对。 */
  private validate(form: TargetForm, params: PreparedRemoteInput): void {
    if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0))
      throw new Error(`[E_BAD_TIMEOUT] remote: timeout must be a positive number of seconds (got ${JSON.stringify(params.timeout)})`)
    if (params.stdin !== undefined && (params.cmd === undefined || params.cmd.length === 0))
      throw new Error('[E_STDIN_WITHOUT_CMD] remote: stdin requires cmd')
    const hasSpawn = params.spawn !== undefined && params.spawn.length > 0
    const hasSsh = params.ssh !== undefined
    if (hasSpawn && hasSsh)
      throw new Error('[E_PARAMS] remote: spawn and ssh are two different BYO entry points — pass one, not both')
    const ptyForm = form.form === 'pty-selector' || form.form === 'empty' || form.form === 'bare'
    const sshForm = form.form === 'ssh-prefix' || form.form === 'empty' || form.form === 'bare'
      || (form.form === 'direct' && form.transport === 'ssh')
    if (hasSpawn && !ptyForm)
      throw new Error('[E_PARAMS] remote: spawn pairs only with a pty target (pty, pty:<label>, or a bare label) — machines are dialed, not spawned')
    if (hasSsh && !sshForm)
      throw new Error('[E_PARAMS] remote: ssh registration pairs with ssh-form targets only (ssh, ssh:<label>, a bare label, or no target)')
  }

  private async execute(
    params: PreparedRemoteInput,
    form: TargetForm,
    callCtx: { sessionKey?: string; ptyBackground?: boolean; commandId?: string },
  ): Promise<RemoteCallResult> {
    const timeoutSec = params.timeout ?? this.opts.execTimeoutSec ?? 120
    const sessionKey = callCtx.sessionKey ?? 'no-session'
    const hasCmd = params.cmd !== undefined && params.cmd.length > 0
    const hasSpawn = params.spawn !== undefined && params.spawn.length > 0

    // —— 默认 PTY 槽（spec remote-default-pty §1，2026-11-01）：machine target 且未显式 oneshot → 复用每 machine 默认 shell（保留 cwd/env）。BYO 注册（ssh 在场）与 spawn 创建不进槽。——
    const bareHitsPty = form.form === 'bare' && this.labels.resolve(form.name, sessionKey)?.kind === 'pty' // bare 名先让 pty 认领（claim shadows machines，既有语义）
    if ((form.form === 'direct' || form.form === 'hub' || (form.form === 'bare' && !bareHitsPty)) && params.mode !== 'oneshot' && params.ssh === undefined && !hasSpawn) {
      const { session } = await this.defaultSlot(form, sessionKey)
      if (!hasCmd) return this.cardReceipt(session)
      return await this.dispatchPty(session, params, callCtx, timeoutSec)
    }

    // —— hub oneshot lane（监督披露 runner=HUB_RUNNER；hub:<m4>:pty 自 0.3.2-c 走下方 createPtyLane 会话形）——
    if (form.form === 'hub') {
      const hub = this.requireHub()
      this.hubProviders.add(hub)
      const process = this.own(await hub.start(form.machine, { ...params, target: `hub:${form.machine}`, mode: 'oneshot', timeout: timeoutSec }, this.hubOwner))
      if (this.disposed) process.cancel('owner disposed')
      const result = await process.done
      const stdout = process.read('stdout', 0), stderr = process.read('stderr', 0)
      const out = disclose(stdout.text, stdout.stats)
      const err = disclose(stderr.text, stderr.stats)
      return {
        ...result, mode: 'oneshot', target: `hub:${form.machine}`, connection: `hub:${form.machine}`, cwd: null, reconnected: false, runner: HUB_RUNNER,
        stdout: (!stdout.stats && stdout.lossy ? '[truncated: peer returned only a tail; exact total/retained/dropped unavailable]\n' : '') + out.text,
        stderr: [err.text, stderr.diagnostic].filter(Boolean).join('\n'),
        ...(out.stats ? { outputStats: { stdout: out.stats, stderr: err.stats } } : { outputStatsUnavailable: true }),
        ...(out.truncated === undefined ? {} : { truncated: out.truncated }),
      }
    }

    // —— PTY 创建（spawn BYO / ssh BYO / native `:pty`）：每次新建（tab 语义）——
    const lane = this.createPtyLane(params, form, sessionKey)
    if (lane !== undefined) {
      const session = lane.session
      if (!hasCmd) { await session.warm(); return this.warmReceipt(session) }
      return await this.dispatchPty(session, params, callCtx, timeoutSec)
    }

    // —— BYO SSH 注册（ssh 在场、但不是开 PTY 的形态）——
    if (params.ssh !== undefined) {
      const label = form.form === 'direct' || form.form === 'bare' ? form.name : undefined
      const name = this.registerByoSsh(label, params.ssh, sessionKey)
      if (!hasCmd) return { mode: 'oneshot', target: `ssh:${name}`, connection: `ssh:${name}`, byoTag: 'byo-ssh', exit: null, cwd: null, timedOut: false, reconnected: false, stdout: `ssh:${name} registered (byo-ssh, no dialing). Reuse the label anywhere ssh: aliases work; a new Agent registers again.`, durationMs: 0 }
      return await this.oneshot({ kind: 'ssh', host: normalizeSshConnection(params.ssh).host, connection: normalizeSshConnection(params.ssh) }, `ssh:${name}`, params, timeoutSec)
    }

    // —— PTY 复用（pty:<id|label> 或裸 label 命中池内会话）——
    if (form.form === 'pty-selector' && form.idOrLabel === undefined)
      throw new Error('[E_PARAMS] remote: "pty" alone selects nothing — append an id/label (pty:pty-1a2b, pty:build) or pass spawn to create one')
    if (form.form === 'pty-selector') {
      const session = this.resolvePty(form.idOrLabel!, sessionKey)
      if (!hasCmd) return this.cardReceipt(session)
      return await this.dispatchPty(session, params, callCtx, timeoutSec)
    }
    // —— oneshot：direct 前缀或裸名（池解析，miss 触发一次扫描）——
    if (form.form === 'direct') {
      const plan = form.transport === 'ssh' ? this.sshPlanFor(form.name, sessionKey) : resolveTarget(`${form.transport}:${form.name}`)
      return await this.oneshot(plan, `${form.transport}:${form.name}`, params, timeoutSec)
    }
    if (form.form !== 'bare') throw new Error('[E_INTERNAL] remote: unreachable target form after routing')
    // bare：先池内寻址（pty 会话优先于机器——会话是操作环境），miss 扫描一次再寻址
    const entry = await this.resolvePoolEntry(form.name, sessionKey)
    if (entry.kind === 'pty') {
      const session = this.resolvePty(form.name, sessionKey)
      if (!hasCmd) return this.cardReceipt(session)
      return await this.dispatchPty(session, params, callCtx, timeoutSec)
    }
    if (entry.kind === 'hub') return await this.hubOneshot(entry.machine, `hub:${entry.machine}`, params, timeoutSec)
    const plan = this.planOf(entry)
    return await this.oneshot(plan, form.name, params, timeoutSec)
  }

  /** Native-first copy routing (spec: remote-native-shortcut) — unchanged by the workbench round. */
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
        const form = parseTargetForm(parsed.target)
        if (form.form === 'hub' || form.form === 'pty-selector')
          throw new Error('rsync supports SSH endpoints only (plus one local endpoint); no mixed-transport or copy fallback')
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
  start(input: RemoteInput, signal: AbortSignal, callCtx: { sessionKey?: string } = {}): Promise<RemoteProcess> {
    const work = this.startPrepared(input, AbortSignal.any([signal, this.fileAbort.signal]), callCtx)
    this.starting.add(work)
    void work.then(() => this.starting.delete(work), () => this.starting.delete(work))
    return work
  }

  private async startPrepared(input: RemoteInput, signal: AbortSignal, callCtx: { sessionKey?: string } = {}): Promise<RemoteProcess> {
    this.assertOpen(); signal.throwIfAborted()
    const params = await prepareRemoteInput(input)
    this.assertOpen(); signal.throwIfAborted()
    const form = parseTargetForm(params.target)
    this.validate(form, params)
    if (form.form !== 'direct' && form.form !== 'bare' && form.form !== 'hub')
      throw new Error('remote: background oneshot takes a machine target; PTY lanes go through the pty job channel')
    // background 通道同样接受首次注册（与 execute 同一认领规则；复用时不带 ssh 即可）。
    if (params.ssh !== undefined && (form.form === 'direct' || form.form === 'bare') && (form as { transport?: string }).transport !== 'docker' && (form as { transport?: string }).transport !== 'incus')
      this.registerByoSsh(form.name, params.ssh, callCtx.sessionKey ?? 'no-session')
    let process: RemoteProcess
    if (form.form === 'hub') {
      process = await this.hubOneshotProcess(form.machine, params)
    } else if (form.form === 'direct') {
      // direct 前缀 = 强制通道：不进池、不触发发现（旧 byossh 直接解析同形）。
      const plan = form.transport === 'ssh' ? this.sshPlanFor(form.name, callCtx.sessionKey ?? 'no-session') : resolveTarget(`${form.transport}:${form.name}`)
      this.assertOpen(); signal.throwIfAborted()
      process = await this.nativeProcess(plan, `${form.transport}:${form.name}`, params, params.timeout, signal)
    } else if (form.form === 'bare') {
      const entry = await this.resolvePoolEntry(form.name, callCtx.sessionKey ?? 'no-session')
      this.assertOpen(); signal.throwIfAborted()
      if (entry.kind === 'pty' || entry.kind === 'hub') throw new Error('remote: background requires an ssh/docker/incus target')
      process = await this.nativeProcess(this.planOf(entry), form.name, params, params.timeout, signal)
    } else {
      throw new Error('remote: background oneshot takes a machine target')
    }
    this.own(process)
    if (signal.aborted || this.disposed) process.cancel('owner closed during start')
    return process
  }

  private async nativeProcess(plan: TargetPlan, display: string, params: PreparedRemoteInput, timeoutSec?: number, signal = this.fileAbort.signal): Promise<RemoteProcess> {
    // Helper fast path first (spec §5): a pinned superd-run on the endpoint gives portable
    // supervision + kernel-anchored disconnect cleanup; every miss falls back to the POSIX
    // wrapper below with byte-identical behavior. The receipt's runner field says which ran.
    // Task E：SSH oneshot 全链（helper probe/upload/run/killgroup + shim + cleanup）共用同一
    // MUX 身份（原始 target + 有效连接字段）；docker/incus 不注入。master 与客户端进程组完全
    // 脱钩（探针 2026-11-01），本地 killpg 取消语义不受影响。
    const muxArgv = this.muxArgvFor(plan, display)
    const cleanupTag = randomUUID().slice(0, 8)
    const helper = await this.ensureHelper(plan, muxArgv)
    if (helper !== null && !this.disposed) {
      // Task E：mux master 经 fd-passing 持有被杀客户端的会话 fd 到远端会话结束——cleanup
      // killer 必须在取消时刻就发射（onCancel），不能等 close 后的 done.then（死锁：close 等
      // 远端结束、远端结束等 killer）。done.then 仅作兜底（至多一次）。无 mux 时两者等价。
      let killed = false
      const kill = () => {
        if (killed) return
        killed = true
        const killer = startOneShot(buildHelperKillgroupArgv(plan, helper.binPath, cleanupTag, muxArgv), { timeoutSec: 15 })
        killer.done.catch(() => {})
      }
      const process = startOneShot(buildHelperOneShotArgv(plan, helper.binPath, { tag: cleanupTag, cmd: params.cmd, ...(muxArgv !== undefined ? { muxArgv } : {}) }), { stdin: params.stdin, timeoutSec, onCancel: kill })
      this.runnerOf.set(process, `superd-run ${helper.ver} (${helper.triple})`)
      void process.done.then(result => {
        if (!result.cancelled && !result.timedOut) return
        kill()
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
    // Task E：同上——posix shim 的 pidfile killer 在取消时刻即发（wrapper 首行就写 pidfile，
    // 取消时已可用）；done.then 兜底保持既有形状。
    let killed = false
    const kill = () => {
      if (killed) return
      killed = true
      const pidfile = `"\${TMPDIR:-/tmp}/superd-oneshot-${cleanupTag}.pgid"`
      const cleanup = `p=$(cat ${pidfile} 2>/dev/null) && { kill -TERM -- "-$p" 2>/dev/null; sleep 0.3; kill -KILL -- "-$p" 2>/dev/null; }; rm -f ${pidfile}`
      const killer = startOneShot((this.opts.oneshotArgvFor ?? buildOneShotArgv)(plan, cleanup, { ...(muxArgv !== undefined ? { muxArgv } : {}) }), { timeoutSec: 15 })
      killer.done.catch(() => {})
    }
    const process = startOneShot((this.opts.oneshotArgvFor ?? buildOneShotArgv)(plan, params.cmd, { cleanupTag, ...(muxArgv !== undefined ? { muxArgv } : {}) }), { stdin: params.stdin, timeoutSec, onCancel: kill })
    this.runnerOf.set(process, 'posix-shim')
    void process.done.then(result => {
      if (!result.cancelled && !result.timedOut) return
      kill()
    }).catch(() => {})
    const work = Promise.resolve(process)
    this.starting.add(work)
    void work.then(() => this.starting.delete(work), () => this.starting.delete(work))
    return work
  }

  /** Helper bootstrap is best-effort and sticky: any failure parks null for this driver
   * lifetime and the shim stays the path. First call to a target pays probe (+ upload). */
  private async ensureHelper(plan: TargetPlan, muxArgv?: readonly string[]): Promise<HelperRunnerInfo | null> {
    if (this.helpers === undefined) {
      const assets = this.opts.helperAssetsFor?.() ?? helperAssets()
      this.helpers = assets === null ? null : new HelperRegistry(assets, (argv, options) => this.helperExec(argv, options), buildHelperProbeArgv, buildHelperUploadArgv)
    }
    if (this.helpers === null || this.disposed) return null
    try { return await this.helpers.ensure(plan, muxArgv ?? []) } catch { return null }
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

  // —— 统一 label 池（§2.5）——

  /** 现场采集机器面并 merge 进本 session 注册表（ssh → docker → incus → hub，迟到者加前缀）。错误逐段吞掉（roster 另行如实呈现）。 */
  private async refreshMachines(sessionKey: string): Promise<void> {
    const runner = this.opts.rosterRunner ?? runOneShot
    const readCfg = this.opts.sshConfigReader ?? (async () => await readFile(join(homedir(), '.ssh', 'config'), 'utf8'))
    let sshHosts: string[] = []
    try { sshHosts = literalHosts(await readCfg()).hosts } catch { /* 无可读 config：跳过该源 */ }
    const names = (argv: string[]): Promise<string[]> => (async () => {
      const r = await runner(argv, { timeoutSec: 10 })
      this.assertOpen()
      return r.exit === 0 ? r.stdout.trim().split(/\r?\n/).map((l) => l.split(/[\t,]/)[0]!.trim()).filter((n) => n.length > 0) : []
    })().catch(() => [] as string[])
    const [docker, incus] = await Promise.all([
      names(['docker', 'ps', '-a', '--format', '{{.Names}}']),
      names(['incus', 'list', '--format', 'csv', '--columns', 'n']),
    ])
    const hub = this.opts.getHub?.()?.listTargets().map((t) => t.id) ?? []
    this.labels.mergeScan(sessionKey, { sshHosts, docker, incus, hub })
  }

  /** 池寻址：命中即回；miss 现场采集一次再寻址（docker 容器名不经 roster 也可达）。 */
  private async resolvePoolEntry(name: string, sessionKey: string): Promise<PoolEntry> {
    const hit = this.labels.resolve(name, sessionKey)
    if (hit !== undefined) return hit
    await this.refreshMachines(sessionKey)
    this.assertOpen()
    const after = this.labels.resolve(name, sessionKey)
    if (after !== undefined) return after
    return { kind: 'ssh', name, host: name } // 旧行为保留：miss 落穿 ssh，原生错误如实透传（roster/前缀是更好的入口，但不挡路）
  }

  private planOf(entry: PoolEntry): TargetPlan {
    switch (entry.kind) {
      case 'ssh': return { kind: 'ssh', host: entry.host }
      case 'ssh-byo': return { kind: 'ssh', host: entry.connection.host, connection: entry.connection }
      case 'docker': return { kind: 'docker', container: entry.container }
      case 'incus': return { kind: 'incus', container: entry.container }
      case 'pty': throw new Error('remote: a PTY session is not a connection target')
      case 'hub': throw new Error('remote: hub machines are not connection targets')
    }
  }

  /** ssh:<name> 的池感知解析：BYO 身份 → 其 connection；否则按 config 别名/主机名。 */
  private sshPlanFor(name: string, sessionKey: string): TargetPlan {
    const entry = this.labels.resolve(name, sessionKey)
    if (entry?.kind === 'ssh-byo') return { kind: 'ssh', host: entry.connection.host, connection: entry.connection }
    return { kind: 'ssh', host: name }
  }

  /** Task E MUX 身份：仅 SSH plan 注入（docker/incus/hub 返回 undefined）。身份键 = 原始
   * target 串 + 有效连接字段（host/user/port/key/ProxyJump）——同身份共享 master，跨身份
   * 不串 socket；目录/寿命/拆除全部由 SshMux 自持。 */
  private muxArgvFor(plan: TargetPlan, target: string): readonly string[] | undefined {
    if (plan.kind !== 'ssh') return undefined
    return this.mux.argvFor({ target, connection: plan.connection ?? { host: plan.host } })
  }

  /** BYO ssh 注册（v2：无 spec 对比——label 占用即拒；注册成功才认领）。返回实际名（label 或 s-id）。 */
  private registerByoSsh(label: string | undefined, connection: SshConnection, sessionKey: string): string {
    this.assertOpen()
    const normalized = normalizeSshConnection(connection)
    if (label !== undefined) validateLabel(label)
    const name = label ?? this.labels.freshId('ssh-', sessionKey)
    if (label !== undefined) {
      const existing = this.labels.resolve(label, sessionKey)
      if (existing !== undefined)
        throw new Error(
          `[E_LABEL_IN_USE] remote: label ${JSON.stringify(label)} is already taken by ${describeEntry(existing)} — nothing was run.\n` +
          `  To reuse it:    address ssh:${label} without the ssh field\n` +
          `  To register new: pick another label`,
        )
      this.labels.claim(label, sessionKey, { kind: 'ssh-byo', name: label, connection: normalized })
      return label
    }
    this.labels.claim(name, sessionKey, { kind: 'ssh-byo', name, connection: normalized })
    return name
  }

  /** PTY 会话创建（native/spawn 同一形状）：上限 → label 认领 → 惰性会话（失败由 onDead 释放 label）。 */
  private createSession(opts: { argv: string[]; connection: string; byo: boolean; label?: string; origin?: string }, sessionKey: string): PtySession {
    this.assertOpen()
    // 只有活会话算配额：死会话没有进程，留池只为一次 reconnect（且有 death reaper），
    // 把它算成「live」会让 Agent 在 10 条死标签后再也开不出新会话（R2 复核 P0-2）。
    const live = this.pool.list()
      .filter(({ key }) => key.startsWith(`${sessionKey}|`))
      .map(({ key }) => this.pool.get(key))
      .filter((s): s is PtySession => s !== undefined && s.sessionState !== 'dead')
    if (live.length >= REMOTE_PTY_SESSION_LIMIT) {
      const listing = live.map(sessionLine).join(' · ')
      throw new Error(`[E_SESSION_LIMIT] remote: this Agent already holds ${live.length} live PTY sessions — the per-Agent session global limit (${REMOTE_PTY_SESSION_LIMIT}) is reached. Check the live sessions below (or {action:"status"} for the roster), then close one ({action:"close", target:"pty:<id>" or the machine name}), kill its running job (job_kill), reuse a session, or run {mode:"oneshot"} instead.
  live: ${listing}`)
    }
    const { label } = opts
    if (label !== undefined) validateLabel(label)
    const id = this.labels.freshId('pty-', sessionKey)
    const entry: PoolEntry = { kind: 'pty', name: id, id, ...(label !== undefined ? { label } : {}), connection: opts.connection, byo: opts.byo }
    if (label !== undefined) this.labels.claim(label, sessionKey, { ...entry, name: label })
    const key = `${sessionKey}|p:${id}`
    let session: PtySession
    try {
      session = this.pool.create({ key, argv: opts.argv, id, ...(label !== undefined ? { label } : {}), connection: opts.connection, byo: opts.byo, builtOn: this.isBuiltOn(opts.connection, sessionKey), ...(opts.origin !== undefined ? { origin: opts.origin } : {}), onDead: () => { this.labels.release(id, sessionKey); if (label !== undefined) this.labels.release(label, sessionKey) } })
    } catch (error) {
      this.labels.release(id, sessionKey)
      if (label !== undefined) this.labels.release(label, sessionKey)
      throw error
    }
    this.labels.claim(id, sessionKey, entry)
    return session
  }

  private ttlMinutes(): number { return Math.max(1, Math.round(this.ptyIdleTtlSec / 60)) }

  /** connection 由 BYO ssh 身份建立 → card 面标 `(built on)`（与 roster 同词，R2 复核 P2-10）。 */
  private isBuiltOn(connection: string, sessionKey: string): boolean {
    return connection.startsWith('ssh:') && this.labels.resolve(connection.slice(4), sessionKey)?.kind === 'ssh-byo'
  }

  /** PTY 创建形唯一实现（execute 与 background 预建共用）：spawn BYO（spec 2026-11-01：native `:pty`/hub-pty 创建语法已删，machine 会话经默认槽 + handoff）。 */
  private createPtyLane(params: PreparedRemoteInput, form: TargetForm, sessionKey: string): { session: PtySession } | undefined {
    const hasSpawn = params.spawn !== undefined && params.spawn.length > 0
    if (hasSpawn) {
      const label = form.form === 'pty-selector' && form.idOrLabel !== undefined ? form.idOrLabel : form.form === 'bare' ? form.name : undefined
      if (label !== undefined && PTY_ID_RE.test(label))
        throw new Error(`[E_BAD_LABEL] remote: ${JSON.stringify(label)} looks like an auto id — ids are generated, labels are yours to choose`)
      const session = this.createSession({ argv: (this.opts.spawnArgvFor ?? buildSpawnArgv)(params.spawn!), connection: 'BYOP', byo: true, ...(label !== undefined ? { label } : {}), origin: params.spawn! }, sessionKey)
      return { session }
    }
    return undefined
  }

  // —— 默认 PTY 槽（spec remote-default-pty，2026-11-01）：machine key 归一 + 懒建/复用 + handoff + machine close ——


  /** 池条目的槽键归一：同一实体（host/container/machine 身份）跨裸名/前缀/撞名前缀共享同一默认槽。 */
  private machineKeyOfEntry(entry: PoolEntry): string {
    switch (entry.kind) {
      case 'ssh': return `ssh:${entry.host}`
      case 'ssh-byo': return `byo:${entry.name}`
      case 'docker': return `docker:${entry.container}`
      case 'incus': return `incus:${entry.container}`
      case 'hub': return `hub:${entry.machine}`
      case 'pty': throw new Error('remote: a PTY session is not a machine slot')
    }
  }

  /** 默认槽的 machine 规格：归一 key + 创建 argv + 展示 connection（hub 每次经 ptyEndpoint 重验 pairing，P10）。 */
  private async machineSlotSpec(form: TargetForm, sessionKey: string): Promise<{ key: string; argv: string[]; connection: string; builtOn?: boolean }> {
    if (form.form === 'hub') {
      const hub = this.requireHub()
      this.hubProviders.add(hub)
      const endpoint = hub.ptyEndpoint(form.machine)
      return { key: `hub:${form.machine}`, argv: this.opts.hubPtyArgvFor !== undefined ? this.opts.hubPtyArgvFor(endpoint) : buildHubPtyArgv(endpoint, hubPtyAssets()), connection: `hub:${form.machine}` }
    }
    if (form.form === 'direct') {
      if (form.transport === 'ssh') {
        const entry = this.labels.resolve(form.name, sessionKey)
        if (entry?.kind === 'ssh-byo') {
          const connection = entry.connection
          return { key: `byo:${entry.name}`, argv: (this.opts.ptyArgvFor ?? buildPtyArgv)({ kind: 'ssh', host: connection.host, connection }), connection: `ssh:${entry.name}`, builtOn: true }
        }
        return { key: `ssh:${form.name}`, argv: (this.opts.ptyArgvFor ?? buildPtyArgv)({ kind: 'ssh', host: form.name }), connection: `ssh:${form.name}` }
      }
      const plan = resolveTarget(`${form.transport}:${form.name}`)
      return { key: `${form.transport}:${form.name}`, argv: (this.opts.ptyArgvFor ?? buildPtyArgv)(plan), connection: `${form.transport}:${form.name}` }
    }
    if (form.form === 'bare') {
      const entry = await this.resolvePoolEntry(form.name, sessionKey) // miss 触发一次本地扫描（零拨号，既有语义）
      this.assertOpen()
      if (entry.kind === 'hub') return this.machineSlotSpec({ form: 'hub', machine: entry.machine }, sessionKey)
      if (entry.kind === 'pty') throw new Error('[E_INTERNAL] remote: bare pty entries route before machine slots')
      const key = this.machineKeyOfEntry(entry)
      if (entry.kind === 'ssh') return { key, argv: (this.opts.ptyArgvFor ?? buildPtyArgv)({ kind: 'ssh', host: entry.host }), connection: `ssh:${entry.name}` }
      if (entry.kind === 'ssh-byo') return { key, argv: (this.opts.ptyArgvFor ?? buildPtyArgv)({ kind: 'ssh', host: entry.connection.host, connection: entry.connection }), connection: `ssh:${entry.name}`, builtOn: true }
      const plan = entry.kind === 'docker' ? resolveTarget(`docker:${entry.container}`) : resolveTarget(`incus:${entry.container}`)
      return { key, argv: (this.opts.ptyArgvFor ?? buildPtyArgv)(plan), connection: `${entry.kind === 'docker' ? 'docker' : 'incus'}:${entry.name}` }
    }
    throw new Error(`[E_TARGET_FORMAT] remote: a machine target is required (ssh:<name>, docker:<name>, incus:<name>, hub:<m4>, or a bare pool name) — got form ${JSON.stringify(form.form)}`)
  }

  /** 取/懒建 machine 的默认 PTY 槽：dead/disposed 槽惰性重建；id 创建即认领（roster 全可见 + 防撞）。 */
  private async defaultSlot(form: TargetForm, sessionKey: string): Promise<{ session: PtySession; machineKey: string; isNew: boolean }> {
    const spec = await this.machineSlotSpec(form, sessionKey)
    this.assertOpen()
    const byKey = this.defaultSlots.get(sessionKey) ?? new Map<string, string>()
    this.defaultSlots.set(sessionKey, byKey)
    const existingKey = byKey.get(spec.key)
    if (existingKey !== undefined) {
      const existing = this.pool.get(existingKey)
      if (existing !== undefined) return { session: existing, machineKey: spec.key, isNew: false }
      byKey.delete(spec.key) // TTL/关闭后的悬空登记：惰性清理
    }
    const session = this.createSession({ argv: spec.argv, connection: spec.connection, byo: false, ...(spec.builtOn === true ? { builtOn: true } : {}) }, sessionKey)
    byKey.set(spec.key, session.key)
    return { session, machineKey: spec.key, isNew: true }
  }

  private releaseDefaultSlot(machineKey: string, sessionKey: string): void {
    this.defaultSlots.get(sessionKey)?.delete(machineKey)
  }

  /** 按池键反查并解绑默认槽（background 提交即 handoff 用）；非槽会话无操作。 */
  private releaseSlotByPoolKey(poolKey: string, sessionKey: string): void {
    const byKey = this.defaultSlots.get(sessionKey)
    if (byKey === undefined) return
    for (const [machineKey, key] of byKey) if (key === poolKey) { byKey.delete(machineKey); return }
  }

  /** roster/status 面：本 session 的默认槽标注（session id → machineKey；悬空条目过滤）。 */
  private defaultMarks(sessionKey: string): Map<string, string> {
    const marks = new Map<string, string>()
    const byKey = this.defaultSlots.get(sessionKey)
    if (byKey === undefined) return marks
    for (const [machineKey, poolKey] of byKey) {
      const s = this.pool.get(poolKey)
      if (s !== undefined) marks.set(s.identity.id, machineKey)
    }
    return marks
  }

  /** spec §1 handoff（2026-11-01 二/三轮裁决）：把 machine 默认 PTY 解绑成可寻址 pty:<id>——同引用移动
   * （不重启、不复制输出流）；fresh（尚无默认槽）= 后台创建空闲 shell 再隔离（默认 PTY 思维模型恒
   * ready，创建时机是实现细节）；busy = 附当前命令与 job 句柄。machine 下次 exec 按需新建默认 PTY。 */
  async handoff(target: string, callCtx: { sessionKey?: string } = {}): Promise<RemoteCallResult> {
    this.assertOpen()
    const sessionKey = callCtx.sessionKey ?? 'no-session'
    const form = parseTargetForm(target)
    if (form.form !== 'direct' && form.form !== 'bare' && form.form !== 'hub')
      throw new Error(`[E_TARGET_FORMAT] remote: handoff detaches a machine's default PTY — pass a machine target (ssh:dev4, docker:c, hub:<m4>, or a bare pool name); addressable sessions are already detached, and ${JSON.stringify(target)} is not a machine`)
    const spec = await this.machineSlotSpec(form, sessionKey)
    this.assertOpen()
    let session: PtySession | undefined
    const poolKey = this.defaultSlots.get(sessionKey)?.get(spec.key)
    if (poolKey !== undefined) session = this.pool.get(poolKey)
    let created = false
    if (session === undefined) {
      this.releaseDefaultSlot(spec.key, sessionKey)
      session = this.createSession({ argv: spec.argv, connection: spec.connection, byo: false, ...(spec.builtOn === true ? { builtOn: true } : {}) }, sessionKey)
      created = true
      await session.warm() // fresh handoff：真的建一个 ready 的空闲 shell；失败如实抛（createSession 路径已自清，槽不残留）
    }
    this.releaseDefaultSlot(spec.key, sessionKey)
    const id = session.identity
    const snap = session.snapshot
    const activeCmd = session.active
    const lines = [
      `handed off pty:${id.id}${id.label !== undefined ? ` (label ${id.label})` : ''} — ${id.connection}${id.builtOn ? ' (built on)' : ''}`,
      created ? 'fresh idle shell created and detached' : snap.state === 'dead' ? 'session died — its next dispatch reconnects a fresh shell' : 'detached',
      `this machine's next exec opens a fresh default PTY`,
    ]
    if (activeCmd !== null)
      lines.push(`still running: command ${activeCmd.commandId}${activeCmd.jobId !== undefined ? ` — follow with job_output ${activeCmd.jobId}, cancel with job_kill` : ' — a synchronous exec settles into its receipt; a timeout handoff is adoptable via job_output'}`)
    return {
      mode: 'pty', target: `pty:${id.id}`, session: `pty:${id.id}`, ...(id.label !== undefined ? { label: id.label } : {}),
      connection: id.connection, exit: null, cwd: session.lastCwd, timedOut: false, reconnected: false,
      stdout: lines.join('\n'), durationMs: 0,
      ...(created ? { created: true } : {}),
      ...(activeCmd !== null ? { running: true, commandId: activeCmd.commandId } : {}),
      ...this.ptyTtl(session.key),
    }
  }

  /** close 统一入口（spec §1 + 三轮补充裁决）：machine target 只关默认槽；pty selector 关该会话；
   * 不存在 job 定位——取消运行中命令的唯一入口是官方 job_kill。 */
  async close(target: string, sessionKey: string, force = false): Promise<{ session: string; connection: string; closed: boolean; reason?: string; killed: string[]; message?: string }> {
    this.assertOpen()
    const form = parseTargetForm(target)
    const bareIsPty = form.form === 'bare' && this.labels.resolve(form.name, sessionKey)?.kind === 'pty'
    if (form.form === 'direct' || form.form === 'hub' || (form.form === 'bare' && !bareIsPty)) return this.closeDefault(form, sessionKey, force)
    if (form.form === 'pty-selector') {
      if (form.idOrLabel === undefined) throw new Error('[E_PARAMS] remote: "pty" alone selects nothing — append an id/label (pty:pty-1a2b, pty:build)')
      return this.closePty(form.idOrLabel, sessionKey, force)
    }
    if (form.form === 'bare') return this.closePty(form.name, sessionKey, force)
    throw new Error(`[E_TARGET_FORMAT] remote: close takes a machine target (closes its default PTY) or pty:<id|label> — got ${JSON.stringify(target)}`)
  }

  private async closeDefault(form: TargetForm, sessionKey: string, force: boolean): Promise<{ session: string; connection: string; closed: boolean; reason?: string; killed: string[]; message?: string }> {
    const spec = await this.machineSlotSpec(form, sessionKey) // bare 归一可能触发一次本地扫描（零拨号）
    this.assertOpen()
    const poolKey = this.defaultSlots.get(sessionKey)?.get(spec.key)
    if (poolKey === undefined)
      return { session: spec.key, connection: spec.connection, closed: false, reason: 'not-found', killed: [], message: `no default PTY on ${spec.key} — a machine's first exec opens one` }
    const session = this.pool.get(poolKey)
    if (session === undefined) {
      this.releaseDefaultSlot(spec.key, sessionKey)
      return { session: spec.key, connection: spec.connection, closed: false, reason: 'already-closed-or-reaped', killed: [], message: `the default PTY on ${spec.key} was already closed or reaped after ${this.ttlMinutes()} min idle` }
    }
    const r = this.closePty(session.identity.id, sessionKey, force)
    if (r.closed) this.releaseDefaultSlot(spec.key, sessionKey)
    return r
  }

  /** background PTY lane：会话先占位（不拨号）再进官方 jobs registry——首回执必须能寻址；
   * registry 拒绝时把新建的会话拆掉（复用形的会话绝不拆）。返回 undefined = 走普通 oneshot job。 */
  async preparePtyLane(params: RemoteCallParams, callCtx: { sessionKey?: string } = {}): Promise<{ input: RemoteInput; session: string; connection: string; label?: string; cleanup: () => void } | undefined> {
    this.assertOpen()
    const prepared = await prepareRemoteInput(params)
    this.assertOpen()
    const sessionKey = callCtx.sessionKey ?? 'no-session'
    const form = parseTargetForm(prepared.target)
    // F3 修复（2026-11-01 独立复测）：lane 输入携带 prepared 的载体——scriptPath 经 prepareRemoteInput
    // 变换后的 cmd/stdin；旧形状取 params.cmd/params.stdin 会丢掉脚本载体（Started 后 E_STDIN_WITHOUT_CMD
    // 或 dispatch 失败，脚本从未执行）。
    const target = (id: string): RemoteInput => ({ target: `pty:${id}`, cmd: prepared.cmd, stdin: prepared.stdin, timeout: prepared.timeout, mode: 'pty' })
    // spawn / :pty 在场 = 创建（无论 target 写成 pty:<label> 还是裸 label）；先于 selector 解析。
    const lane = this.createPtyLane(prepared, form, sessionKey)
    if (lane === undefined && form.form === 'pty-selector') {
      if (form.idOrLabel === undefined)
        throw new Error('[E_PARAMS] remote: "pty" alone selects nothing — append an id/label (pty:pty-1a2b, pty:build) or pass spawn to create one')
      const id = this.resolvePty(form.idOrLabel, sessionKey).identity
      return { input: target(id.id), session: `pty:${id.id}`, connection: id.connection, ...(id.label !== undefined ? { label: id.label } : {}), cleanup: () => undefined }
    }
    // —— machine 默认槽（spec §1）：run_in_background 在默认 PTY 提交 framed cmd 的同一操作内 handoff ——
    if (lane === undefined && (form.form === 'direct' || form.form === 'hub' || (form.form === 'bare' && this.labels.resolve(form.name, sessionKey)?.kind !== 'pty')) && prepared.mode !== 'oneshot') {
      const slot = await this.defaultSlot(form, sessionKey) // 懒建占位（不拨号）；bare-pty 认领不进此路径（落穿 oneshot lane 沿用旧拒绝）
      this.assertOpen()
      const id = slot.session.identity
      return {
        input: target(id.id), session: `pty:${id.id}`, connection: id.connection, ...(id.label !== undefined ? { label: id.label } : {}),
        cleanup: () => { if (slot.isNew) void slot.session.dispose() }, // registry 拒绝只拆新建槽；复用槽保持
      }
    }
    if (lane === undefined) return undefined
    const id = lane.session.identity
    return { input: target(id.id), session: `pty:${id.id}`, connection: id.connection, ...(id.label !== undefined ? { label: id.label } : {}), cleanup: () => { void lane.session.dispose() } }
  }

  /** `pty:<id|label>` 寻址：先 id 后 label；miss 给重建形式。 */
  private resolvePty(selector: string, sessionKey: string): PtySession {
    const entry = this.labels.resolve(selector, sessionKey)
    if (entry?.kind === 'pty') {
      const s = this.pool.get(`${sessionKey}|p:${entry.id}`)
      if (s !== undefined) return s
    }
    throw new Error(
      `[E_NO_SESSION] remote: no live PTY under ${PTY_ID_RE.test(selector) ? `id ${selector}` : `label ${JSON.stringify(selector)}`} — sessions are created by appending :pty to a transport target ({target:"ssh:dev4:pty", cmd:"…"}) or by spawn; idle sessions are reaped after ${this.ttlMinutes()} min`,
    )
  }

  /** §6 close：默认撞 detached job 报错（列杀法）；force = 杀组+关闭（披露 killed）。幂等 not-found。 */
  closePty(selector: string, sessionKey: string, force = false): { session: string; connection: string; closed: boolean; reason?: string; killed: string[]; message?: string } {
    this.assertOpen()
    const entry = this.labels.resolve(selector, sessionKey)
    if (entry?.kind !== 'pty')
      return { session: selector, connection: '', closed: false, reason: 'not-found', killed: [], message: `no pty session is registered under ${JSON.stringify(selector)}` }
    const session = this.pool.get(`${sessionKey}|p:${entry.id}`)
    if (session === undefined)
      return { session: `pty:${entry.id}`, connection: entry.connection, closed: false, reason: 'already-closed-or-reaped', killed: [], message: `pty:${entry.id} was already closed or reaped after ${this.ttlMinutes()} min idle` }
    const pending = session.detachedCommandId
    if (pending !== null && !force)
      throw new Error(
        `[E_SESSION_BUSY] remote: pty session ${entry.id} still runs a detached command (${pending}) — job_kill ${pending} first (or wait for it), then close again; force:true closes the tab and kills the group in one step`,
      )
    void session.dispose()
    return { session: `pty:${entry.id}`, connection: entry.connection, closed: true, ...(pending !== null ? { killed: [pending] } : { killed: [] }) }
  }

  /** job 通道收养回填（timeout handoff 时 registry id ≠ commandId，账本记录两者）。 */
  attachPtyJob(commandId: string, jobId: string, sessionKey: string): void {
    for (const { key } of this.pool.list()) {
      if (!key.startsWith(`${sessionKey ?? 'no-session'}|`)) continue
      this.pool.get(key)?.attachJob(commandId, jobId)
    }
  }

  /** spec remote-default-pty §1（2026-11-01）：exec stdin-only 写入核心——向已有 live PTY 的当前运行命令
   * 追加 exact-byte stdin。寻址：pty:<id|label> / 裸 label 命中 pty 项 / machine target（其默认槽的
   * 当前命令，无槽不懒建、如实报错）。不触发拨号、创建或重连；回执附 connection/label 供工具层渲染。 */
  async input(target: string, options: PtyInputOptions, callCtx: { sessionKey?: string } = {}): Promise<PtyInputReceipt & { connection: string; label?: string }> {
    this.assertOpen()
    const sessionKey = callCtx.sessionKey ?? 'no-session'
    const form = parseTargetForm(target)
    let session: PtySession
    if (form.form === 'pty-selector') {
      if (form.idOrLabel === undefined)
        throw new Error('[E_PARAMS] remote: "pty" alone selects nothing — append an id/label (pty:pty-1a2b, pty:build)')
      session = this.resolvePty(form.idOrLabel, sessionKey)
    } else if (form.form === 'bare' && this.labels.resolve(form.name, sessionKey)?.kind === 'pty') {
      session = this.resolvePty(form.name, sessionKey)
    } else if (form.form === 'direct' || form.form === 'hub' || form.form === 'bare') {
      // machine target：写入其默认槽的当前命令（spec §1 stdin-only）。不懒建——无槽即无运行命令，诚实报错。
      const spec = await this.machineSlotSpec(form, sessionKey)
      this.assertOpen()
      const poolKey = this.defaultSlots.get(sessionKey)?.get(spec.key)
      const slot = poolKey !== undefined ? this.pool.get(poolKey) : undefined
      if (slot === undefined)
        throw new Error(`[E_SESSION_NOT_RUNNING] remote: no default PTY on ${spec.key} yet — start a command first ({action:"exec", target:"${spec.key}", cmd:…}); a raw stdin write goes to the command running there`)
      session = slot
    } else {
      throw new Error(`[E_TARGET_FORMAT] remote: a raw stdin write goes into a live PTY session — pass pty:<id|label>, a bare session label, or a machine target (its default PTY); got ${JSON.stringify(target)}`)
    }
    const receipt = await session.input(options)
    const id = session.identity
    return { ...receipt, connection: id.connection, ...(id.label !== undefined ? { label: id.label } : {}) }
  }
  private async dispatchPty(
    session: PtySession,
    params: PreparedRemoteInput,
    callCtx: { sessionKey?: string; ptyBackground?: boolean; commandId?: string },
    timeoutSec: number,
  ): Promise<RemoteCallResult> {
    // P10（hub 会话）：每次 dispatch 前重验 pairing——ptyEndpoint 校验 registry 行，复用不豁免。
    const hubConn = session.identity.connection
    if (hubConn.startsWith('hub:')) {
      const hub = this.requireHub()
      this.hubProviders.add(hub)
      hub.ptyEndpoint(hubConn.slice(4))
    }
    const commandId = callCtx.commandId ?? genCommandId()
    const r = await session.dispatch(params.cmd, { stdin: params.stdin, timeoutSec, commandId, ...(callCtx.ptyBackground === true ? { background: true, jobId: commandId } : {}) }) // background: commandId 即 registry jobId，账本/input 回执如实携带
    // spec §1（2026-11-01）：默认槽的 background 提交 = 同一操作内 handoff——命令已启动（running 回执）即解绑槽；
    // dispatch 失败（busy/死亡）不解绑。同步超时（detach 成 job）不解绑：busy 槽由显式 handoff 或命令结束释放。
    if (callCtx.ptyBackground === true && r.running === true) this.releaseSlotByPoolKey(session.key, callCtx.sessionKey ?? 'no-session')
    const out = disclose(r.output, r.outputStats?.stdout)
    const id = session.identity
    return {
      mode: 'pty', target: `pty:${id.id}`, session: `pty:${id.id}`, ...(id.label !== undefined ? { label: id.label } : {}),
      connection: id.connection, ...(id.byo ? { byoTag: 'byo-pty' as const } : {}),
      commandId: r.commandId, exit: r.exit, cwd: r.cwd,
      timedOut: r.timedOut, reconnected: r.reconnected, stdout: out.text,
      outputStats: out.stats ? { stdout: out.stats } : undefined,
      durationMs: r.durationMs, ...(out.truncated !== undefined ? { truncated: out.truncated } : {}),
      ...(r.envDelta !== undefined ? { envDelta: r.envDelta } : {}),
      ...(r.running === true && r.job !== undefined ? { running: true, ptyJob: r.job } : {}),
      ...this.ptyTtl(session.key),
    }
  }

  /** 预热（创建形无 cmd）回执：§3——无 commandId/envDelta；timeout 忽略。 */
  private warmReceipt(session: PtySession): RemoteCallResult {
    const id = session.identity
    return {
      mode: 'pty', target: `pty:${id.id}`, session: `pty:${id.id}`, ...(id.label !== undefined ? { label: id.label } : {}),
      connection: id.connection, ...(id.byo ? { byoTag: 'byo-pty' as const } : {}),
      created: true, exit: null, cwd: null, timedOut: false, reconnected: false, stdout: '', durationMs: 0,
      ...this.ptyTtl(session.key),
    }
  }

  /** session card 回执（`pty:<id|label>` 无 cmd）：connection/state/cwd + 最近 20 条账本（不带输出尾，§9 Q7）。 */
  private cardReceipt(session: PtySession): RemoteCallResult {
    const id = session.identity
    const snap = session.snapshot
    const state = snap.busy ? 'busy (a command is running)' : snap.state === 'dead' ? 'died — next dispatch reconnects a fresh shell' : `idle ${Math.round((snap.idleMs ?? 0) / 1000)}s (connected)`
    const head = `pty:${id.id}${id.label !== undefined ? ` (label ${id.label})` : ''} — ${id.connection}${id.byo ? ' (byo-pty)' : id.builtOn ? ' (built on)' : ''} · ${state} · cwd ${session.lastCwd ?? '(none yet)'}`
    return {
      mode: 'pty', target: `pty:${id.id}`, session: `pty:${id.id}`, ...(id.label !== undefined ? { label: id.label } : {}),
      connection: id.connection, ...(id.byo ? { byoTag: 'byo-pty' as const } : {}),
      exit: null, cwd: session.lastCwd, timedOut: false, reconnected: false,
      stdout: [head, activeLine(session)].join('\n'), durationMs: 0,
      ...this.ptyTtl(session.key),
    }
  }

  private async oneshot(plan: TargetPlan, display: string, params: PreparedRemoteInput, timeoutSec: number): Promise<RemoteCallResult> {
    this.assertOpen()
    const process = this.own(await this.nativeProcess(plan, display, params, timeoutSec))
    if (this.disposed) process.cancel('owner disposed')
    const result = await process.done
    const stdout = process.read('stdout', 0), stderr = process.read('stderr', 0)
    const r = { ...result, stdout: stdout.text, stderr: [stderr.text, stderr.diagnostic].filter(Boolean).join('\n'), outputStats: { stdout: stdout.stats!, stderr: stderr.stats } }
    const out = disclose(r.stdout, r.outputStats?.stdout)
    const err = r.stderr.length > 0 ? disclose(r.stderr, r.outputStats?.stderr) : undefined
    return {
      mode: 'oneshot', target: display, exit: r.exit, cwd: null,
      timedOut: r.timedOut, reconnected: false, stdout: out.text,
      ...(err !== undefined ? { stderr: err.text } : {}),
      ...(out.stats ? { outputStats: { stdout: out.stats, stderr: err?.stats ?? r.outputStats?.stderr } } : {}), durationMs: r.durationMs,
      ...(out.truncated !== undefined ? { truncated: out.truncated } : {}),
      ...(this.runnerOf.get(process) === undefined ? {} : { runner: this.runnerOf.get(process)! }),
    }
  }

  private async hubOneshot(machine: string, display: string, params: PreparedRemoteInput, timeoutSec: number): Promise<RemoteCallResult> {
    const process = this.own(await this.hubOneshotProcess(machine, params))
    if (this.disposed) process.cancel('owner disposed')
    const result = await process.done
    const stdout = process.read('stdout', 0), stderr = process.read('stderr', 0)
    const out = disclose(stdout.text, stdout.stats)
    const err = disclose(stderr.text, stderr.stats)
    return {
      ...result, mode: 'oneshot', target: display, connection: display, cwd: null, reconnected: false, runner: HUB_RUNNER,
      stdout: (!stdout.stats && stdout.lossy ? '[truncated: peer returned only a tail; exact total/retained/dropped unavailable]\n' : '') + out.text,
      stderr: [err.text, stderr.diagnostic].filter(Boolean).join('\n'),
      ...(out.stats ? { outputStats: { stdout: out.stats, stderr: err.stats } } : { outputStatsUnavailable: true }),
      ...(out.truncated === undefined ? {} : { truncated: out.truncated }),
    }
  }

  private async hubOneshotProcess(machine: string, params: PreparedRemoteInput): Promise<RemoteProcess> {
    const hub = this.requireHub()
    this.hubProviders.add(hub)
    return await hub.start(machine, { ...params, target: `hub:${machine}`, mode: 'oneshot' }, this.hubOwner)
  }

  /** Ruling P19 + §2.5：roster = 注意力入口——本地扫描刷新统一池，零拨号；机器面公共，会话面 caller-scoped。 */
  async roster(callCtx: { sessionKey?: string } = {}): Promise<string> {
    this.assertOpen()
    const scan = await scanLocal({ runner: this.opts.rosterRunner, readSshConfig: this.opts.sshConfigReader })
    this.assertOpen()
    this.labels.mergeScan(callCtx.sessionKey ?? 'no-session', { sshHosts: scan.ssh.hosts, docker: scan.docker.rows.map((r) => r.name), incus: scan.incus.rows.map((r) => r.name), hub: this.opts.getHub?.()?.listTargets().map((t) => t.id) ?? [] })
    const prefix = `${callCtx.sessionKey ?? 'no-session'}|`
    const sessions = this.pool.list()
      .filter(({ key }) => key.startsWith(prefix))
      .map(({ key }) => { const s = this.pool.get(key); return s === undefined ? null : s })
      .filter((s): s is PtySession => s !== null)
    const hub = this.opts.getHub?.()
    return renderRoster(scan, this.labels.list(callCtx.sessionKey ?? 'no-session'), sessions, hub === undefined ? null : hub.listTargets(), this.defaultMarks(callCtx.sessionKey ?? 'no-session'))
  }

  /** status probe（target 无 cmd）：机器面 = probe + 该 connection 上的会话；pty selector = session card。 */
  async status(target: string, callCtx: { sessionKey?: string } = {}): Promise<string> {
    this.assertOpen()
    const sessionKey = callCtx.sessionKey ?? 'no-session'
    const form = parseTargetForm(target)
    if (form.form === 'hub') {
      const row = this.requireHub().listTargets().find((t) => t.id === form.machine)
      if (!row) throw new Error(`unknown remote machine ${form.machine} — select a remote machine from the Hub roster; local execution is not available`)
      const hubSlotKey = `hub:${form.machine}`
      const hubSlotPoolKey = this.defaultSlots.get(sessionKey)?.get(hubSlotKey)
      const hubSlot = hubSlotPoolKey !== undefined ? this.pool.get(hubSlotPoolKey) : undefined
      return [
        `hub:${form.machine} — Hub remote machine (${row.label}); exec ${row.execEnabled ? 'enabled' : 'disabled'}; not probed`,
        hubSlot === undefined ? `default PTY: none — this machine's first exec opens one` : `default PTY: ${sessionLine(hubSlot)}`,
      ].join('\n')
    }
    if (form.form === 'pty-selector') {
      if (form.idOrLabel === undefined) throw new Error('[E_PARAMS] remote: "pty" alone selects nothing — append an id/label (pty:pty-1a2b, pty:build)')
      return this.cardReceipt(this.resolvePty(form.idOrLabel, sessionKey)).stdout
    }
    if (form.form !== 'direct' && form.form !== 'bare')
      throw new Error('[E_PARAMS] remote: status takes a machine target (bare name or ssh:/docker:/incus:/hub:) or a pty:<id|label> selector')
    const name = directName(form) || (form.form === 'bare' ? form.name : '')
    const entry = await this.resolvePoolEntry(name, sessionKey)
    this.assertOpen()
    if (entry.kind === 'pty') {
      if (form.form !== 'bare') throw new Error('[E_TARGET_FORMAT] remote: ssh:/docker:/incus: force a machine channel — the pty selector is pty:<id|label>')
      return this.cardReceipt(this.resolvePty(form.name, sessionKey)).stdout
    }
    if (entry.kind === 'hub') return this.status(`hub:${entry.machine}`, callCtx)
    const plan = this.planOf(entry)
    const head = `${target} — ${plan.kind === 'ssh' ? 'ssh host' : `${plan.kind} container`}${entry.kind === 'ssh-byo' ? ' (built on)' : ''}`
    const runner = this.opts.probeRunner ?? runOneShot
    const probe = await probeTarget(plan, { runner: (argv, options) => { this.assertOpen(); return runner(argv, options) }, muxArgvFor: p => this.muxArgvFor(p, target) ?? [] })
    const prefix = `${sessionKey}|`
    const onConnection = this.pool.list()
      .filter(({ key }) => key.startsWith(prefix))
      .map(({ key }) => this.pool.get(key))
      .filter((s): s is PtySession => s !== undefined && s.identity.connection === `${plan.kind === 'ssh' ? 'ssh' : plan.kind}:${name}`)
    const slotKey = this.machineKeyOfEntry(entry)
    const slotPoolKey = this.defaultSlots.get(sessionKey)?.get(slotKey)
    const slotSession = slotPoolKey !== undefined ? this.pool.get(slotPoolKey) : undefined
    const slotLine = slotSession === undefined ? `default PTY: none — this machine's first exec opens one` : `default PTY: ${sessionLine(slotSession)}`
    return [head, renderProbe(probe), slotLine, onConnection.length > 0 ? `pty sessions on this connection: ${onConnection.map(sessionLine).join(' · ')}` : 'pty sessions on this connection: none'].join('\n')
  }

  /** Ruling 13：审计 best-effort——钩子抛错不得影响命令路径。 */
  private audit(r: RemoteAuditRecord): void {
    try { this.opts.onAudit?.(r) } catch { /* audit hook failure is never the command's failure */ }
  }

  /** Single target resolver for later copy/rsync; PTY sessions are not filesystem connections. */
  async resolveConnectionTarget(target: string, callCtx: { sessionKey?: string } = {}): Promise<TargetPlan> {
    this.assertOpen()
    const form = parseTargetForm(target)
    if (form.form === 'pty-selector') throw new Error('remote: a PTY session is not a filesystem connection')
    if (form.form === 'hub') throw new Error('remote: hub endpoints resolve through the Hub file lane, not a CLI connection')
    if (form.form === 'direct') {
      const plan = form.transport === 'ssh' ? this.sshPlanFor(form.name, callCtx.sessionKey ?? 'no-session') : resolveTarget(`${form.transport}:${form.name}`)
      return plan
    }
    if (form.form === 'ssh-prefix' || form.form === 'empty') throw new Error('[E_TARGET_FORMAT] remote: connection targets need a name')
    const entry = await this.resolvePoolEntry(form.name, callCtx.sessionKey ?? 'no-session')
    this.assertOpen()
    return this.planOf(entry)
  }

  /** P2/P3：回执即状态快照——idle TTL 剩余随每次 pty 回执带回。 */
  private ptyTtl(key: string): { ttlSec?: number } {
    const snap = this.pool.inspect(key)
    // 死会话没有 idle timer（card 不显示 idle-left）；未用过的 warm 会话则剩余整段 TTL。
    if (snap === undefined || snap.state === 'dead' || snap.state === 'disposed') return {}
    if (snap.idleMs === null) return { ttlSec: this.ptyIdleTtlSec }
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
    this.disposed = true // Close admission synchronously, before draining existing resources.
    this.labels.clear()
    this.defaultSlots.clear()
    this.fileAbort.abort(new Error('remote owner disposed'))
    for (const process of this.processes) process.cancel('remote owner disposed')
    return this.disposal = (async () => {
      await Promise.allSettled([...this.starting])
      await Promise.all([this.pool.disposeAll(), ...[...this.processes].map(p => p.done), ...[...this.hubProviders].map(hub => hub.releaseOwner(this.hubOwner))])
      this.hubProviders.clear()
      await this.mux.dispose() // Task E：master 逐 socket `-O exit` 后删 socket 目录（进程已排干，cleanup killer 不再需要 master）
    })()
  }
}

/** direct 形态回退到 resolveTarget 可解析的名字（ssh:dev4 → dev4）。 */
function directName(form: TargetForm): string {
  return form.form === 'direct' ? form.name : ''
}

/** session card 的当前命令行（spec 2026-11-01：历史 ledger 已删，只报活动命令）。 */
function activeLine(s: PtySession): string {
  const a = s.active
  return a === null ? 'no command running' : `running: ${a.commandId}${a.jobId !== undefined ? ` (job ${a.jobId})` : ''} — feed it stdin with exec stdin-only, follow job_output, cancel job_kill`
}

/** roster/status 一行的会话描述：`p-ab12 (label build) ssh:dev4 idle 12s`。 */
function sessionLine(s: PtySession): string {
  const id = s.identity
  const snap = s.snapshot
  const state = snap.busy ? 'busy' : snap.state === 'dead' ? 'died' : `idle ${Math.round((snap.idleMs ?? 0) / 1000)}s`
  return `${id.id}${id.label !== undefined ? ` (label ${id.label})` : ''} ${id.connection}${id.byo ? ' (byo-pty)' : ''} ${state}`
}

function displayOf(key: string): string {
  const raw = key.includes('|') ? key.slice(key.indexOf('|') + 1) : key
  return raw.startsWith('p:') ? `pty:${raw.slice(2)}` : raw
}
