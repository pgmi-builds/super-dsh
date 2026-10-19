import { Utf16TailRing } from './output-ring.ts'
import type { OutputStats, StreamOutputStats } from './hub-contract.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { buildInitCommand, createNonceFrameParser, genNonce, wrapPtyCommand } from './nonce-framing.ts'

/** spec §五.2 逐字。 */
export const RECONNECT_NOTICE = '[remote: session reconnected to fresh shell; cwd reset to default]'

/** 池键 → 模型面名字：剥掉 agent 前缀与内部标记（`t:` → 裸 target；`p:` → `byop:<label>`）。
 *  这是**唯一**的 key→名字映射规则，roster 与错误面共用——错误面不得回吐内部键：
 *  2026-10-03 实测报告 F1，`E_SESSION_*` 曾把 `session-<uuid>|p:<label>` 整条吐给模型。 */
export function displayKey(key: string): string {
  const raw = key.includes('|') ? key.slice(key.indexOf('|') + 1) : key
  return raw.startsWith('t:') ? raw.slice(2) : raw.startsWith('p:') ? `byop:${raw.slice(2)}` : raw
}

export interface PtySessionOptions {
  key: string
  argv: string[]
  /** BYO-PTY 创建来源：`byop:<label>` 会话首次创建时给的 spawn 原文；transport target 会话为 undefined。
   * 唯一用途 = 同 label 再次给 spawn 时判「同一来源 → 复用」还是「不同来源 → 冲突」（driver 判，池不判）。 */
  origin?: string
  idleTtlSec: number
  initTimeoutSec?: number
  /** 池回调：会话彻底出池（dispose）时触发；进程意外死亡不出池（Ruling 7）。 */
  onDead?: () => void
}

export interface PtyDispatchOptions { stdin?: string; timeoutSec?: number; /** P5：立即回执 running job，不等帧（run_in_background 与超时 handoff 共用同一条 job 通道）。 */ background?: boolean }
/** detached job 的完成结果（frame 或会话死亡时结算；与 dispatch 回执同构）。 */
export interface PtyJobResult { output: string; outputStats?: StreamOutputStats; exit: number | null; cwd: string | null; timedOut: boolean }
/** P4/P5（2026-10-19）running job 句柄：byte-cursor 增量读 + P8 显式中断 + 完成时帧结算。 */
export interface PtyRunningJob {
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
  /** P4/P5：true = 命令仍在前台运行，本回执是 handoff（job 句柄随行）。 */
  running?: boolean
  job?: PtyRunningJob
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
  private lastSettleAt = 0
  /** 是否曾成功初始化（ready 过）。决定死亡语义：ready 过 → reconnect（留池）；从未 ready → 出池（见 start()）。 */
  private everReady = false
  private disposal: Promise<void> | undefined
  private procClose: Promise<void> = Promise.resolve()
  private groupCleanup: Promise<void> = Promise.resolve()

  constructor(private readonly opts: PtySessionOptions) {}

  get sessionState(): PtyState { return this.state }

  /** 创建来源（spawn 原文）；仅 `byop:<label>` 会话有。 */
  get origin(): string | undefined { return this.opts.origin }

  /** status 面快照：state + busy（有命令在跑）+ idleMs（上次 settle 至今）+ pid（进程组头，kill 兜底可观测）。 */
  get snapshot(): SessionSnapshot {
    return { state: this.state, busy: this.inFlight > 0, idleMs: this.lastSettleAt > 0 ? Date.now() - this.lastSettleAt : null, pid: this.proc?.pid ?? null }
  }

  /** 同一会话命令严格串行（FIFO）；死亡/冷态先重启。P4/P5（2026-10-19）：超时不再自动
   * 打断——handoff 成 running job（byte-cursor 轮询 + 显式 interrupt，P8 机制原样保留在
   * job.interrupt）；background 选项让 dispatch 立即回执。占用者是 detached job 时新命令
   * 拒绝（Q6：诚实回状态优先于排队），纯同步并发 FIFO 语义不变。 */
  dispatch(cmd: string, dOpts: PtyDispatchOptions = {}): Promise<PtyDispatchResult> {
    const attempt = async (): Promise<PtyDispatchResult> => {
      const started = Date.now()
      const reconnected = this.state === 'dead'
      if (this.state !== 'ready') await this.start()
      if (this.state === 'disposed') throw new Error(`[E_SESSION_DISPOSED] remote pty session '${displayKey(this.opts.key)}' was disposed before dispatch`)
      if (this.detachedJob !== null)
        throw new Error(
          `[E_SESSION_BUSY] remote pty session '${displayKey(this.opts.key)}' still has a command running in the foreground — poll it with job_output and, if needed, cancel with job_kill; the shell must be idle before a new command`,
        )
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
        const detach = (): PtyRunningJob => {
          // handoff：外层立即回执 running；parser/ring/死亡等待继续活着直到 frame/death/interrupt。
          const job: PtyRunningJob = {
            read: (fromByte) => ring.read(fromByte),
            stats: () => ring.stats(),
            interrupt: () => { if (!jobSettled) twoStage() },
            done: new Promise<PtyJobResult>((res) => { jobDone = res }),
          }
          this.detachedJob = job
          settled = true
          resolve({ output: ring.text, outputStats: { stdout: ring.stats() }, exit: null, cwd: null, timedOut: false, running: true, job, reconnected, durationMs: Date.now() - started })
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
        const settle = (r: Omit<PtyJobResult, 'outputStats'>): void => {
          if (jobSettled) return
          jobSettled = true
          cleanup()
          this.inFlight--
          this.lastSettleAt = Date.now()
          this.resetIdleTimer()
          const full: PtyJobResult = { ...r, outputStats: { stdout: ring.stats() } }
          jobDone?.(full)
          if (!settled) { settled = true; resolve({ ...full, reconnected, durationMs: Date.now() - started }) }
        }
        const deathWaiter = (): void => settle({ output: ring.text, exit: null, cwd: null, timedOut: interrupted })
        const parser = createNonceFrameParser(nonce, {
          onOutput: (t) => {
            ring.push(t)
          },
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
        onFrame: () => {
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
    const waiters = this.deathWaiters
    this.deathWaiters = []
    for (const w of waiters) w()
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    if (this.state === 'disposed') return
    // R1 双条件（2026-10-19）：有命令在跑（含 detached job）不算 idle——重挂整段 TTL；
    // 回收只发生在「无运行命令且 idle 超时」，静默长任务不被掐。
    this.idleTimer = setTimeout(() => {
      if (this.inFlight > 0) { this.resetIdleTimer(); return }
      void this.dispose()
    }, this.opts.idleTtlSec * 1_000)
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) { clearTimeout(this.idleTimer); this.idleTimer = null }
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

  getOrCreate(key: string, argv: string[], origin?: string): PtySession {
    if (this.disposed) throw new Error('[E_REMOTE_DISPOSED] remote: the owning Agent or plugin PTY pool was disposed')
    let s = this.sessions.get(key)
    if (s === undefined || s.sessionState === 'disposed') {
      s = new PtySession({ key, argv, origin, ...this.defaults, onDead: () => this.sessions.delete(key) })
      this.sessions.set(key, s)
    }
    return s
  }

  disposeAll(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    return this.disposal = Promise.all([...this.sessions.values()].map((s) => s.dispose()))
      .then(() => { this.sessions.clear() })
  }
}
