import { Utf16TailRing } from './output-ring.ts'
import type { OutputStats, StreamOutputStats } from './hub-contract.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { buildInitCommand, createNonceFrameParser, decodeEnvSnapshot, diffEnv, genNonce, wrapPtyCommand, type EnvDelta } from './nonce-framing.ts'

/** spec §五.2 逐字。 */
export const RECONNECT_NOTICE = '[remote: session reconnected to fresh shell; cwd reset to default]'

/** 池键 → 模型面名字：剥掉 agent 前缀与内部标记（`p:` → `pty:<id>`）。
 * 这是**唯一**的 key→名字映射规则，roster 与错误面共用——错误面不得回吐内部键：
 * 2026-10-03 实测报告 F1，`E_SESSION_*` 曾把 `session-<uuid>|p:<label>` 整条吐给模型。 */
export function displayKey(key: string): string {
  const raw = key.includes('|') ? key.slice(key.indexOf('|') + 1) : key
  return raw.startsWith('p:') ? `pty:${raw.slice(2)}` : raw
}

export interface PtySessionOptions {
  key: string
  argv: string[]
  /** Workbench 身份（§3）：自动 id（p-xxxx）+ 可选 label + connection 展示名（ssh:dev4 / docker:c / BYOP）。 */
  id: string
  label?: string
  connection: string
  byo?: boolean
  /** connection 来自 BYO ssh 身份（card 面标 `(built on)`，与 roster 同词）。 */
  builtOn?: boolean
  /** spawn 原文（BYO 会话存档；v2 无 spec 对比——不再参与复用判定，仅供回执/账本溯源）。 */
  origin?: string
  idleTtlSec: number
  initTimeoutSec?: number
  /** 池回调：会话彻底出池（dispose）时触发；进程意外死亡不出池（Ruling 7）。 */
  onDead?: () => void
}

export interface PtyDispatchOptions { stdin?: string; timeoutSec?: number; /** 账本键：driver 分配（background 通道预传入 registry jobId；同步命令同格式本地生成）——一个命令永远只有一个 id。 */ commandId: string; /** P5：立即回执 running job，不等帧（run_in_background 与超时 handoff 共用同一条 job 通道）。 */ background?: boolean }
/** detached job 的完成结果（frame 或会话死亡时结算；与 dispatch 回执同构）。 */
export interface PtyJobResult { output: string; outputStats?: StreamOutputStats; exit: number | null; cwd: string | null; timedOut: boolean; commandId: string; envDelta?: EnvDelta }
/** P4/P5（2026-10-19）running job 句柄：byte-cursor 增量读 + P8 显式中断 + 完成时帧结算。 */
export interface PtyRunningJob {
  /** 账本键：与 jobId 同构（background 通道预传入 registry id；同步完成命令用同格式生成 id）。 */
  commandId: string
  /** Byte-cursor incremental read over the command's merged output (tail-ring retention; lossy reports eviction). */
  read: (fromByte: number) => { text: string; nextOffset: number; lossy: boolean }
  stats: () => OutputStats
  /** P8 两段式 ^C 中断（会话存活；trap-INT 走宽限 group-kill 兜底）。 */
  interrupt: () => void
  /** Settles on the exit frame, or with exit null when the session dies. */
  done: Promise<PtyJobResult>
}
export interface PtyDispatchResult {
  output: string
  outputStats?: StreamOutputStats
  exit: number | null
  cwd: string | null
  timedOut: boolean
  reconnected: boolean
  durationMs: number
  commandId: string
  /** env delta（E 帧侧信道）：只回名字 + 变动标记，值不回传；init 侧信道失败时省略。 */
  envDelta?: EnvDelta
  /** P4/P5：true = 命令仍在前台运行，本回执是 handoff（job 句柄随行）。 */
  running?: boolean
  job?: PtyRunningJob
}

/** 账本条目（§5）：commandId / 摘要 / exit / 耗时；保留最近 20 条（user 定案）。 */
export interface LedgerEntry { commandId: string; jobId?: string; summary: string; exit: number | null; durationMs: number; running: boolean }
const LEDGER_MAX = 20
const summaryOf = (cmd: string): string => {
  const first = cmd.trim().split(/\r?\n/, 1)[0] ?? ''
  return first.length > 72 ? `${first.slice(0, 71)}…` : first
}

export type PtyState = 'cold' | 'starting' | 'ready' | 'dead' | 'disposed'

/** 会话运行时快照（status 面消费，Ruling 16 词汇源）。 */
export interface SessionSnapshot { state: PtyState; busy: boolean; idleMs: number | null; pid: number | null }

const DEFAULT_INIT_TIMEOUT_SEC = 30
const INTERRUPT_GRACE_MS = 3_000
/** pty 收集内存安全帽（Ruling P15，与 oneshot HARD_CAP 对齐）：模型面只见尾窗，保留尾部。 */
const OUTPUT_HARD_CAP = 4_000_000

export class PtySession {
  private proc: ChildProcess | null = null
  private state: PtyState = 'cold'
  private startPromise: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private idleTimer: NodeJS.Timeout | null = null
  private onChunk: ((c: string) => void) | null = null
  private deathWaiters: Array<() => void> = []
  private diag = ''
  private inFlight = 0
  /** P4/P5：当前占用前台的 detached job（background/超时 handoff）。非 null 时新命令拒绝（Q6）。 */
  private detachedJob: PtyRunningJob | null = null
  /** 账本（§5）：本会话最近 20 条命令（FIFO，超出丢最旧）。 */
  private ledger: LedgerEntry[] = []
  /** env 侧信道基线（init E 帧）；undefined = 侧信道不可用（不报假 delta）。 */
  private envBaseline: Map<string, number> | undefined
  /** idle 起点（ready / settle 时重置）；null = 尚无 idle 时钟（cold 或已 dispose）。 */
  private idleSince: number | null = null
  /** 意外死亡后的回收定时器（R2）：ready 过的会话先留池供 reconnect，超时仍无人寻址则出池。 */
  private deathTimer: NodeJS.Timeout | null = null
  private lastCwdSeen: string | null = null
  /** 是否曾成功初始化（ready 过）。决定死亡语义：ready 过 → reconnect（留池）；从未 ready → 出池（见 start()）。 */
  private everReady = false
  private disposal: Promise<void> | undefined
  private procClose: Promise<void> = Promise.resolve()
  private groupCleanup: Promise<void> = Promise.resolve()

  constructor(private readonly opts: PtySessionOptions) {}

  get sessionState(): PtyState { return this.state }

  /** 池键（driver 的 ttl/inspect 用）。 */
  get key(): string { return this.opts.key }

  /** 最近帧 cwd（card 面）；从未执行过 = null。 */
  get lastCwd(): string | null { return this.lastCwdSeen }

  /** 占用前台的 detached job 的 commandId（无 = null；close 拒绝与 busy 文案共用）。 */
  get detachedCommandId(): string | null { return this.detachedJob?.commandId ?? null }

  /** job 通道收养后回填 jobId（timeout handoff 时 registry id ≠ commandId，账本如实记录两者）。 */
  attachJob(commandId: string, jobId: string): void {
    const entry = [...this.ledger].reverse().find((e) => e.commandId === commandId)
    if (entry !== undefined) entry.jobId = jobId
  }

  /** Workbench 身份（§3）：id + 可选 label + connection + byo 标记。 */
  get identity(): { id: string; label?: string; connection: string; byo: boolean; builtOn: boolean } {
    return { id: this.opts.id, ...(this.opts.label !== undefined ? { label: this.opts.label } : {}), connection: this.opts.connection, byo: this.opts.byo === true, builtOn: this.opts.builtOn === true }
  }

  /** 账本快照（session card 面，只读）。 */
  ledgerSnapshot(): readonly LedgerEntry[] { return this.ledger }

  /** spawn 创建原文（仅 BYO 会话；v2 起仅存档，不参与复用判定）。 */
  get origin(): string | undefined { return this.opts.origin }

  /** status 面快照：state + busy（有命令在跑）+ idleMs（上次 settle 至今）+ pid（进程组头，kill 兜底可观测）。 */
  get snapshot(): SessionSnapshot {
    return { state: this.state, busy: this.inFlight > 0, idleMs: this.idleSince === null ? null : Date.now() - this.idleSince, pid: this.proc?.pid ?? null }
  }
  /** 预热创建（创建形无 cmd）：真正拨号到 init 帧——「会话已就绪」必须是真的，
   * 而且只有 ready 过才挂 idle 回收（cold 会话没有 timer，会永远占配额）。 */
  async warm(): Promise<void> { await this.start() }

  /** 同一会话命令严格串行（FIFO）；死亡/冷态先重启。P4/P5（2026-10-19）：超时不再自动
   * 打断——handoff 成 running job（byte-cursor 轮询 + 显式 interrupt，P8 机制原样保留在
   * job.interrupt）；background 选项让 dispatch 立即回执。占用者是 detached job 时新命令
   * 拒绝（Q6：诚实回状态优先于排队），纯同步并发 FIFO 语义不变。 */
  dispatch(cmd: string, dOpts: PtyDispatchOptions): Promise<PtyDispatchResult> {
    const attempt = async (): Promise<PtyDispatchResult> => {
      const started = Date.now()
      const reconnected = this.state === 'dead'
      if (this.state !== 'ready') await this.start()
      if (this.state === 'disposed') throw new Error(`[E_SESSION_DISPOSED] remote pty session '${this.opts.id}' was disposed before dispatch`)
      if (this.detachedJob !== null)
        throw new Error(
          `[E_SESSION_BUSY] remote: pty session '${this.opts.id}' still runs a detached command (${this.detachedJob.commandId}) — poll job_output ${this.detachedJob.commandId}, cancel with job_kill ${this.detachedJob.commandId}, or address other work to another session / oneshot`,
        )
      const commandId = dOpts.commandId
      const entry: LedgerEntry = { commandId, summary: summaryOf(cmd), exit: null, durationMs: 0, running: true }
      this.ledger.push(entry)
      if (this.ledger.length > LEDGER_MAX) this.ledger.shift()
      this.inFlight++
      return await new Promise<PtyDispatchResult>((resolve) => {
        const nonce = genNonce()
        const ring = new Utf16TailRing(OUTPUT_HARD_CAP)
        let interrupted = false
        let settled = false // 外层 dispatch 回执已提前结算（background / 超时 handoff）
        let jobSettled = false
        let interruptTimer: NodeJS.Timeout | undefined
        let killTimer: NodeJS.Timeout | undefined
        let jobDone: ((r: PtyJobResult) => void) | null = null
        let envNext: Map<string, number> | undefined
        const detach = (): PtyRunningJob => {
          // handoff：外层立即回执 running；parser/ring/死亡等待继续活着直到 frame/death/interrupt。
          const job: PtyRunningJob = {
            commandId,
            read: (fromByte) => ring.read(fromByte),
            stats: () => ring.stats(),
            interrupt: () => { if (!jobSettled) twoStage() },
            done: new Promise<PtyJobResult>((res) => { jobDone = res }),
          }
          this.detachedJob = job
          settled = true
          resolve({ output: ring.text, outputStats: { stdout: ring.stats() }, exit: null, cwd: null, timedOut: false, running: true, job, commandId, reconnected, durationMs: Date.now() - started })
          return job
        }
        const cleanup = (): void => {
          this.onChunk = null
          this.detachedJob = null
          // I1（终审）：已结算 dispatch 的死亡等待必须摘除——否则闭包钉住整段 output，
          // 长命会话每调用累积一个 waiter（init 路径的 filter 同款形态）
          this.deathWaiters = this.deathWaiters.filter((w) => w !== deathWaiter)
          if (interruptTimer !== undefined) clearTimeout(interruptTimer)
          if (killTimer !== undefined) clearTimeout(killTimer)
        }
        const settle = (r: Omit<PtyJobResult, 'outputStats' | 'commandId' | 'envDelta'>): void => {
          if (jobSettled) return
          jobSettled = true
          cleanup()
          this.inFlight--
          this.idleSince = Date.now()
          this.resetIdleTimer()
          if (r.cwd !== null) this.lastCwdSeen = r.cwd
          const envDelta = envNext !== undefined ? diffEnv(this.envBaseline, envNext) : undefined
          if (envNext !== undefined) this.envBaseline = envNext
          entry.exit = r.exit
          entry.durationMs = Date.now() - started
          entry.running = false
          const full: PtyJobResult = { ...r, outputStats: { stdout: ring.stats() }, commandId, ...(envDelta !== undefined ? { envDelta } : {}) }
          jobDone?.(full)
          if (!settled) { settled = true; resolve({ ...full, reconnected, durationMs: Date.now() - started }) }
        }
        const deathWaiter = (): void => settle({ output: ring.text, exit: null, cwd: null, timedOut: interrupted })
        const parser = createNonceFrameParser(nonce, {
          onOutput: (t) => {
            ring.push(t)
          },
          onEnv: (b64) => { const m = decodeEnvSnapshot(b64); if (m !== undefined) envNext = m },
          onFrame: ({ exit, cwd }) => settle({ output: ring.text, exit, cwd, timedOut: interrupted }),
        })
        const twoStage = (): void => {
          interrupted = true
          // P8 两段打断：\x03 中断前台作业后，交互 bash 会放弃当前命令行的剩余部分
          // （尾部 marker 不再执行）；紧随注入的同 nonce 130-marker 行在 bash 回到
          // 读取态后被执行。无论 bash 弃行还是续行，帧都在宽限内到达且 exit=130，
          // 会话存活；若命令 trap 掉 SIGINT，原 marker 先帧、注入行帧后字节被丢弃。
          this.write('\x03')
          this.write(`printf '\\033]133;D;${nonce};130;%s\\007' "$PWD"\n`)
          killTimer = setTimeout(() => {
            // Ruling 8 的 kill 兜底：宽限无帧 = 会话不可恢复，杀整组后收尸
            // （否则 trap-INT 的卡死进程永生，重连后旧组再不可达）
            this.killTree()
            this.markDead()
            settle({ output: ring.text, exit: null, cwd: null, timedOut: true })
          }, INTERRUPT_GRACE_MS)
        }
        this.onChunk = (c) => parser.feed(c)
        this.write(wrapPtyCommand(cmd, nonce))
        if (dOpts.stdin !== undefined) this.write(dOpts.stdin) // Ruling 11: REPL 式紧随
        this.deathWaiters.push(deathWaiter)
        if (dOpts.background === true) { detach(); return }
        // P4：同步等待到期 = handoff（不再自动 ^C）；命令由 job 通道继续（job_output 增量 / job_kill 显式中断）。
        interruptTimer = setTimeout(() => detach(), dOpts.timeoutSec === undefined ? 120_000 : dOpts.timeoutSec * 1_000)
      })
    }
    const run = this.queue.then(attempt, attempt)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** TTL / row teardown：尽力 exit，1s 后杀组，出池。 */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.clearIdleTimer()
    this.clearDeathTimer()
    this.state = 'disposed'
    this.startPromise = null
    const proc = this.proc
    const close = this.procClose
    // Captured pgid, not this.proc: the shell may close before redirected
    // background descendants. Their TERM/KILL policy must still run.
    const group = this.reapGroup(proc?.pid, 1_000, close)
    this.disposal = Promise.all([close, this.groupCleanup, group]).then(() => {
      if (this.proc === proc) this.proc = null
    })
    this.write('exit\n')
    this.opts.onDead?.()
    return this.disposal
  }

  private write(s: string): void {
    if (this.proc?.stdin?.writable !== true) return
    try { this.proc.stdin.write(s) } catch { /* dead: death waiter settles the dispatch */ }
  }

  private async start(): Promise<void> {
    if (this.state === 'disposed')
      throw new Error(`[E_SESSION_DISPOSED] remote pty session '${displayKey(this.opts.key)}' was disposed — the pool replaces disposed sessions; this reference is stale`)
    this.clearDeathTimer()
    if (this.startPromise === null) {
      this.state = 'starting'
      this.startPromise = this.doStart().catch((err: unknown) => {
        this.startPromise = null
        this.markDead()
        // 从未成功初始化 = 这里从来没有过一个会话：不得在池里留下一个「永远起不来、又永远换不掉」
        // 的项——它会按 origin 锁死 label，并让复用重跑冻结的 argv（实测报告 F2）。
        // 已 ready 过的会话不走这里：那种死亡是 reconnect 语义，留在池里是对的。
        if (!this.everReady) void this.dispose()
        throw err
      })
    }
    return this.startPromise
  }

  private async doStart(): Promise<void> {
    const proc = spawn(this.opts.argv[0]!, this.opts.argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // Ruling 9: 进程组杀法
    })
    this.proc = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (d: string) => { this.onChunk?.(d) })
    proc.stderr.setEncoding('utf8').on('data', (d: string) => { this.diag = (this.diag + d).slice(-2_000) })
    this.procClose = new Promise<void>((resolve) => {
      proc.once('close', () => { this.markDead(); resolve() })
    })
    proc.once('error', (err) => { this.diag = (this.diag + `\n[remote: spawn failed: ${err.message}]`).slice(-2_000) })

    const initTimeoutSec = this.opts.initTimeoutSec ?? DEFAULT_INIT_TIMEOUT_SEC
    const initNonce = genNonce()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.killTree()
        reject(new Error(
          `[E_SESSION_START] remote pty session '${displayKey(this.opts.key)}' did not initialize in ${initTimeoutSec}s` +
          (this.diag.length > 0 ? `; transport stderr tail: ${this.diag}` : '')))
      }, initTimeoutSec * 1_000)
      const waiter = (): void => {
        clearTimeout(timer)
        reject(new Error(
          `[E_SESSION_DIED] remote pty session '${displayKey(this.opts.key)}' died before initializing` +
          (this.diag.length > 0 ? `; transport stderr tail: ${this.diag}` : '')))
      }
      this.deathWaiters.push(waiter)
      const parser = createNonceFrameParser(initNonce, {
        onEnv: (b64) => { const m = decodeEnvSnapshot(b64); if (m !== undefined) this.envBaseline = m },
        onFrame: () => {
          // R2（2026-10-19 复核 P0）：成功路径必须撤掉 init 超时——否则 30s 后 timer 回调
          // killTree() 把刚起好的会话整组 SIGTERM（0.3.2-a 回归，模型面只看到 reconnect）。
          clearTimeout(timer)
          this.deathWaiters = this.deathWaiters.filter((w) => w !== waiter)
          if (this.state === 'disposed') {
            // dispose 竞态 init：不得复活已终态会话（否则重挂 idle timer + 幽灵 ready）
            reject(new Error(`[E_SESSION_DISPOSED] remote pty session '${displayKey(this.opts.key)}' disposed during init`))
            return
          }
          this.everReady = true
          this.state = 'ready'
          this.resetIdleTimer()
          resolve()
        },
      })
      this.onChunk = (c) => parser.feed(c)
      this.write(buildInitCommand(initNonce))
    })
  }

  private markDead(): void {
    if (this.state === 'disposed') {
      // dispose 是终态：不再翻转 state，但在飞 dispatch 的死亡等待仍需立即结算
      // （row teardown 不是超时——不得等 123s 看门狗，也不得错标 timedOut）
      const waiters = this.deathWaiters
      this.deathWaiters = []
      for (const w of waiters) w()
      return
    }
    this.state = 'dead'
    this.startPromise = null
    this.clearIdleTimer()
    this.armDeathReaper()
    const waiters = this.deathWaiters
    this.deathWaiters = []
    for (const w of waiters) w()
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    if (this.state === 'disposed') return
    // R1 双条件（2026-10-19）：有命令在跑（含 detached job）不算 idle——重挂整段 TTL；
    // 回收只发生在「无运行命令且 idle 超时」，静默长任务不被掐。
    this.idleSince = Date.now()
    this.idleTimer = setTimeout(() => {
      if (this.inFlight > 0) { this.resetIdleTimer(); return }
      void this.dispose()
    }, this.opts.idleTtlSec * 1_000)
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) { clearTimeout(this.idleTimer); this.idleTimer = null }
  }

  /** 意外死亡后的回收：留池只换取一次 reconnect 机会，不得超过一段 idle TTL（R2 复核 P0）。
   * 否则死会话永久占 label + 永久计入 10 配额，Agent 再也开不出新会话。 */
  private armDeathReaper(): void {
    this.clearDeathTimer()
    if (!this.everReady || this.state !== 'dead') return
    this.deathTimer = setTimeout(() => { void this.dispose() }, this.opts.idleTtlSec * 1_000)
    this.deathTimer.unref()
  }

  private clearDeathTimer(): void {
    if (this.deathTimer !== null) { clearTimeout(this.deathTimer); this.deathTimer = null }
  }

  private killTree(): void {
    const pid = this.proc?.pid
    this.proc = null
    const cleanup = this.reapGroup(pid, 0, this.procClose)
    this.groupCleanup = Promise.all([this.groupCleanup, cleanup]).then(() => undefined)
  }

  /** A direct child's close is not proof that its detached process group is gone. */
  private reapGroup(pid: number | undefined, graceMs: number, close: Promise<void>): Promise<void> {
    if (pid === undefined) return Promise.resolve()
    const signal = (value: NodeJS.Signals | 0): boolean => {
      try { process.kill(-pid, value); return true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw error
      }
    }
    return new Promise<void>((resolve, reject) => {
      let termTimer: NodeJS.Timeout | undefined
      let killTimer: NodeJS.Timeout | undefined
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        if (termTimer !== undefined) clearTimeout(termTimer)
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (error !== undefined) reject(error)
        else resolve()
      }
      // Early completion is allowed only when the *whole group* is absent.
      const checkGone = () => { try { if (!signal(0)) finish() } catch (error) { finish(error) } }
      checkGone()
      if (settled) return
      void close.then(checkGone)
      termTimer = setTimeout(() => {
        try {
          if (!signal('SIGTERM')) { finish(); return }
          killTimer = setTimeout(() => {
            // A next check-phase callback can still precede kernel signal
            // settlement. Bound this final settle window; never wait for
            // orphan zombie PID removal by the system reaper.
            try { signal('SIGKILL'); killTimer = setTimeout(() => finish(), 100) }
            catch (error) { finish(error) }
          }, 2_000)
        } catch (error) { finish(error) }
      }, graceMs)
    })
  }

}

export interface PtyPoolDefaults { idleTtlSec: number; initTimeoutSec?: number }

/** 会话池：键 → 会话。意外死亡的会话留在池内（下次 dispatch 带 reconnect 提示）。 */
export class PtyPool {
  private readonly sessions = new Map<string, PtySession>()
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly defaults: PtyPoolDefaults) {}

  get size(): number { return this.sessions.size }

  /** status 面：键上的会话快照（无会话 = undefined → "none — dials on first exec"）。 */
  inspect(key: string): SessionSnapshot | undefined {
    return this.sessions.get(key)?.snapshot
  }

  /** roster 面：池内全部会话（key = `${sessionKey}|t:<target>` 或 `${sessionKey}|p:<label>`）。 */
  list(): Array<{ key: string; snapshot: SessionSnapshot }> {
    return [...this.sessions.entries()].map(([key, s]) => ({ key, snapshot: s.snapshot }))
  }

  /** 池内会话本体（driver 判「有/无 + origin」用；status/roster 面走 inspect/list）。
   * disposed 视同出池 —— 与 getOrCreate 的替换条件同源，两处不得漂移。 */
  get(key: string): PtySession | undefined {
    const s = this.sessions.get(key)
    return s === undefined || s.sessionState === 'disposed' ? undefined : s
  }

  /** v2：创建一律新建（「同 label 同来源复用」废除——复用只走 get/get by id）；disposed 残留由这里替换。 */
  create(opts: { key: string; argv: string[]; id: string; label?: string; connection: string; byo?: boolean; builtOn?: boolean; origin?: string; onDead?: () => void }): PtySession {
    if (this.disposed) throw new Error('[E_REMOTE_DISPOSED] remote: the owning Agent or plugin PTY pool was disposed')
    const existing = this.sessions.get(opts.key)
    if (existing !== undefined && existing.sessionState !== 'disposed')
      throw new Error(`[E_INTERNAL] remote: pty pool key collision for ${opts.id}`)
    const s = new PtySession({ ...opts, ...this.defaults, onDead: () => { this.sessions.delete(opts.key); opts.onDead?.() } })
    this.sessions.set(opts.key, s)
    return s
  }

  disposeAll(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    return this.disposal = Promise.all([...this.sessions.values()].map((s) => s.dispose()))
      .then(() => { this.sessions.clear() })
  }
}
