/**
 * RemoteEngine — remote ssh face 的编排核心（plan
 * docs/10_plans/2026-09-22-dashr-remote-tool-rm0.md Task 8；设计 §4.2 / §CWD）。
 *
 * 每个 target 持有至多一个池化 {@link SshBackend} 与至多一个 PTY
 * {@link PtySession}，经 promise 链队列严格串行化（design Ruling 6）。连接懒建：
 * 首次 exec 才 factory backend 并 lazy 开 PTY 会话；连接层错误（E_CONNECT 等）
 * 不毒化 target——整个 backend 丢弃，下次调用重新 factory。空闲超过 `idleTtlSec`
 * 的 target 被 timer 回收（close + 状态清零），下次 exec 重建并经
 * `snapshotRestore` 回放断线前 cwd（④：回放失败大声报错，绝不静默回落 HOME）。
 *
 * 会话失败两条路：openShellSession 抛 `E_EXEC_FALLBACK` → 该 target 永久降级
 * `backend.exec`（framing 哨兵协议，cwd 由 `cwdAfter` 跟踪）；PTY 通道半路死
 * （exitCode null / E_WEDGED / E_CLOSED）→ 本次如实交部分结果或报错，会话作废，
 * 下次调用重建并用内部 `cd -- <lastCwd>` 重新定位（内部 cd 不进审计）。
 *
 * Ruling 2（RM0 验收修订）：`status()` 是"一次调用拿全块"——冷 target 也走
 * exec 同一条 lazy factory 懒拨号（ensureBackend），随后做一次 degraded-exec
 * probe（buildProbeCommand → parseProbeOutput），渲染 user/key/工具链/sudo/
 * rtt/cwd 全块。status 唯一不做的是**开 PTY 会话**（openShellSession 只属于
 * exec）。拨号/探测失败 → formatStatus 的 error 行替代事实行（status 正常
 * resolve，不 throw）。`bind()`/`boundTarget()` 是 sessionKey → target 的 LRU
 * 绑定（容量 64）。`onAudit` 每条用户命令一条记录；内部 cd 与 probe 不记。
 *
 * @module dashr/remote/engine
 */
import { capTail, shellQuote } from './framing.ts'
import type { ConnState, ExecOutcome, SshBackend } from './backend.ts'
import { createSshBackend } from './backend.ts'
import type { HostKeyStore } from './hostkeys.ts'
import type { PtySession } from './session.ts'
import type { RemoteTargetSpec } from './registry.ts'
import type { StatusLine } from './preparation.ts'
import { buildProbeCommand, formatStatus, parseProbeOutput } from './preparation.ts'

const DEFAULT_EXEC_TIMEOUT_SEC = 120
const DEFAULT_IDLE_TTL_SEC = 300
const DEFAULT_MAX_OUTPUT_CHARS = 30_000
/** bind LRU 容量（plan Task 8 Step 3：>64 逐最旧）。 */
const BINDING_CAP = 64
/** status 一次性 probe 的超时（独立于用户命令的 execTimeoutSec）。 */
const PROBE_TIMEOUT_MS = 10_000

/** 审计事件（Ruling 10 的 engine 半：每用户命令一条，内部 cd 不记）。 */
export interface AuditEvent {
  target: string
  cmd: string
  cwd?: string
  exit: number | null
  durationMs: number
}

export interface EngineOptions {
  registry: Map<string, RemoteTargetSpec>
  hostKeyStore: HostKeyStore
  execTimeoutSec?: number
  idleTtlSec?: number
  maxOutputChars?: number
  backendFactory?: (target: RemoteTargetSpec) => SshBackend
  onAudit?: (e: AuditEvent) => void
  now?: () => number
}

/** 连接层错误：任一出现 → 丢弃整个 backend，下次调用重新 factory（重建路径）。 */
const CONN_CODES: ReadonlySet<string> = new Set([
  'E_CONNECT',
  'E_AUTH',
  'E_HOSTKEY_CHANGED',
  'E_PROXY_UNSUPPORTED',
  'E_KEY_UNREADABLE',
  'E_KEY_ENCRYPTED',
  'E_TIMEOUT',
])
/** 会话层错误：会话没了/坏了 → 只丢会话（backend 与 TCP 可能还活着）。 */
const SESSION_CODES: ReadonlySet<string> = new Set(['E_CLOSED', 'E_WEDGED', 'E_BOOT'])

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(`[${code}] ${message}`) as Error & { code: string }
  error.code = code
  return error
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/** 单 target 池化状态（plan Task 8 Step 3 状态清单）。 */
interface TargetState {
  spec: RemoteTargetSpec
  backend: SshBackend | undefined
  session: PtySession | undefined
  /** 'exec' = 该 target 已永久降级 degraded exec（E_EXEC_FALLBACK 记忆）。 */
  sessionMode: 'pty' | 'exec' | undefined
  /** promise 链队列尾（同 target 串行化的全部含义所在）。 */
  queue: Promise<unknown>
  busy: boolean
  /** 池化连接的建立时刻（status conn 行存活时长的分母）。 */
  connSince: number | undefined
  lastUsed: number
  idleTimer: ReturnType<typeof setTimeout> | undefined
  /** 断线/回收前最后已知 cwd（快照回放与内部 cd 的来源）。 */
  lastCwd: string | undefined
}

export class RemoteEngine {
  private readonly states = new Map<string, TargetState>()
  private readonly bindings = new Map<string, string>()
  private readonly hostKeyStore: HostKeyStore
  private readonly execTimeoutMs: number
  private readonly idleTtlMs: number
  private readonly maxOutputChars: number
  private readonly backendFactory: (target: RemoteTargetSpec) => SshBackend
  private readonly onAudit: ((event: AuditEvent) => void) | undefined
  private readonly clock: () => number

  constructor(opts: EngineOptions) {
    this.hostKeyStore = opts.hostKeyStore
    this.execTimeoutMs = (opts.execTimeoutSec ?? DEFAULT_EXEC_TIMEOUT_SEC) * 1000
    this.idleTtlMs = (opts.idleTtlSec ?? DEFAULT_IDLE_TTL_SEC) * 1000
    this.maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
    this.backendFactory =
      opts.backendFactory ?? ((target: RemoteTargetSpec) => createSshBackend(target, { hostKeyStore: opts.hostKeyStore }))
    this.onAudit = opts.onAudit
    this.clock = opts.now ?? Date.now
    for (const [name, spec] of opts.registry) {
      this.states.set(name, {
        spec,
        backend: undefined,
        session: undefined,
        sessionMode: undefined,
        queue: Promise.resolve(),
        busy: false,
        connSince: undefined,
        lastUsed: this.clock(),
        idleTimer: undefined,
        lastCwd: undefined,
      })
    }
  }

  targetNames(): string[] {
    return [...this.states.keys()]
  }

  /** 注册表序的行数据；渲染归 Task 9 的 formatTargets（本方法绝不拨号）。 */
  summary(): Array<{ name: string; host: string; port: number; user?: string; alive: boolean; defaultCwd?: string }> {
    return [...this.states.values()].map((st) => {
      const row: { name: string; host: string; port: number; user?: string; alive: boolean; defaultCwd?: string } = {
        name: st.spec.name,
        host: st.spec.host,
        port: st.spec.port,
        alive: st.backend !== undefined && st.backend.connState() === 'ready',
      }
      if (st.spec.user !== undefined) row.user = st.spec.user
      if (st.spec.defaultCwd !== undefined) row.defaultCwd = st.spec.defaultCwd
      return row
    })
  }

  /**
   * Ruling 2（RM0 验收修订）：status 永不建会话；冷 target 先懒拨号再 probe，
   * 一次调用拿全块（工具链/sudo/rtt）。经同一条队列（与 exec 串行，状态读取无
   * 竞态）；拨号也算活动，池化连接照常走 idle TTL。
   */
  async status(name: string): Promise<string> {
    const st = this.mustTarget(name) // 未知名 → rejection（async API 一致性）
    return this.enqueue(st, async () => {
      st.lastUsed = this.clock()
      st.busy = true
      try {
        return await this.renderStatus(st)
      } finally {
        st.busy = false
        this.armIdle(st)
      }
    })
  }

  /**
   * 在 target 上执行一条命令：入队 → ensureConn（lazy factory）→ ensureSession
   * （E_EXEC_FALLBACK 永久降级）→ run / degraded exec → 审计。错误恢复路径全部
   * 落到 closed 状态由下次调用重建（Step 3）。
   */
  async exec(name: string, cmd: string, opts?: { timeoutMs?: number; signal?: AbortSignal; stdin?: string }): Promise<ExecOutcome> {
    const st = this.mustTarget(name) // 未知名 → rejection（async API 一致性）
    return this.enqueue(st, async () => {
      st.lastUsed = this.clock()
      st.busy = true
      try {
        const outcome = await this.runCommand(st, cmd, opts)
        this.emitAudit({ target: name, cmd, cwd: st.lastCwd, exit: outcome.exitCode, durationMs: outcome.durationMs })
        return outcome
      } finally {
        st.busy = false
        this.armIdle(st)
      }
    })
  }

  /** 未知 target → E_UNKNOWN_TARGET（消息列全部名字）。 */
  bind(sessionKey: string, name: string): void {
    if (!this.states.has(name)) {
      throw codedError(
        'E_UNKNOWN_TARGET',
        `unknown remote target ${JSON.stringify(name)}; known targets: ${[...this.states.keys()].join(', ')}`,
      )
    }
    this.bindings.delete(sessionKey) // delete+set = 触碰到 LRU 尾
    this.bindings.set(sessionKey, name)
    while (this.bindings.size > BINDING_CAP) {
      const oldest = this.bindings.keys().next()
      if (oldest.done === true) break
      this.bindings.delete(oldest.value)
    }
  }

  boundTarget(sessionKey: string): string | undefined {
    const name = this.bindings.get(sessionKey)
    if (name === undefined) return undefined
    this.bindings.delete(sessionKey) // 读取即触碰（LRU）
    this.bindings.set(sessionKey, name)
    return name
  }

  /** 关闭全部池化 backend、清 idle timer；进行中的命令随 backend 关闭自然失败。 */
  async dispose(): Promise<void> {
    const teardown: Array<Promise<unknown>> = []
    for (const st of this.states.values()) {
      if (st.idleTimer !== undefined) {
        clearTimeout(st.idleTimer)
        st.idleTimer = undefined
      }
      const { backend, session } = st
      st.backend = undefined
      st.session = undefined
      st.connSince = undefined
      if (session !== undefined) teardown.push(session.dispose().catch(() => {}))
      if (backend !== undefined) teardown.push(backend.close().catch(() => {}))
    }
    await Promise.all(teardown)
  }

  // ── 内部：队列 ────────────────────────────────────────────────────────────

  private mustTarget(name: string): TargetState {
    const st = this.states.get(name)
    if (st === undefined) {
      throw codedError(
        'E_UNKNOWN_TARGET',
        `unknown remote target ${JSON.stringify(name)}; known targets: ${[...this.states.keys()].join(', ')}`,
      )
    }
    return st
  }

  /** promise 链串行化：上一命令的失败不得阻塞下一命令（then(op, op)）。 */
  private enqueue<T>(st: TargetState, op: () => Promise<T>): Promise<T> {
    const result = st.queue.then(op, op)
    st.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  // ── 内部：命令执行 ───────────────────────────────────────────────────────

  private async runCommand(
    st: TargetState,
    cmd: string,
    opts: { timeoutMs?: number; signal?: AbortSignal; stdin?: string } | undefined,
  ): Promise<ExecOutcome> {
    const timeoutMs = opts?.timeoutMs ?? this.execTimeoutMs
    const signal = opts?.signal
    const stdin = opts?.stdin
    const { backend, fresh } = this.ensureBackend(st)

    // 断线重连（backend 重建）→ 快照回放断线前 cwd（④：失败大声报错）
    if (fresh && st.lastCwd !== undefined) {
      try {
        await backend.snapshotRestore(st.lastCwd)
      } catch (error) {
        throw this.recover(st, error)
      }
    }

    if (st.sessionMode !== 'exec') {
      try {
        return await this.runInSession(st, backend, cmd, timeoutMs, signal, stdin)
      } catch (error) {
        if (codeOf(error) === 'E_EXEC_FALLBACK') {
          st.sessionMode = 'exec' // 永久降级（该 target 生命周期内不再尝试 PTY）
          st.session = undefined
        } else {
          throw this.recover(st, error)
        }
      }
    }
    return this.runDegraded(st, backend, cmd, timeoutMs, signal, stdin)
  }

  /** PTY 路径：ensureSession（lazy open + 新会话定位）→ run（stdin 紧随复合命令裸写）→ cwd 跟踪。 */
  private async runInSession(
    st: TargetState,
    backend: SshBackend,
    cmd: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    stdin: string | undefined,
  ): Promise<ExecOutcome> {
    let session = st.session
    if (session === undefined) {
      session = await backend.openShellSession(st.spec.env)
      st.session = session
      st.sessionMode = 'pty'
      await this.positionSession(st, session, timeoutMs)
    }
    const result = await session.run(cmd, { timeoutMs, signal, stdin })
    const cwd = session.snapshot().cwd
    if (cwd !== undefined) st.lastCwd = cwd
    if (result.exitCode === null) this.clearSession(st) // 通道半路死：部分结果照交，会话作废
    return this.capOutcome({
      exitCode: result.exitCode,
      output: result.output,
      cwdAfter: cwd,
      durationMs: result.durationMs,
      interrupted: result.interrupted || undefined,
      truncated: result.truncated, // 重要评审项 3：会话已截断的真原长，二次裁剪必须沿用
    })
  }

  /**
   * 新会话定位：重建会话 → cd 回放 lastCwd；首调 → cd 到注册表 defaultCwd
   * （①首调用即落对地方）。失败 = E_CWD_GONE 大声报错（④），绝不静默落 HOME。
   * 内部 cd 不进审计（audit 只在 exec 的用户命令路径发出）。
   */
  private async positionSession(st: TargetState, session: PtySession, timeoutMs: number): Promise<void> {
    const dir = st.lastCwd ?? st.spec.defaultCwd
    if (dir === undefined) return
    const placed = await session.run(`cd -- ${shellQuote(dir)}`, { timeoutMs })
    if (placed.exitCode !== 0) {
      this.clearSession(st)
      st.lastCwd = undefined
      throw codedError('E_CWD_GONE', `working directory no longer exists: ${dir} (session cwd replay failed)`)
    }
    st.lastCwd = session.snapshot().cwd ?? dir
  }

  /** 降级路径：framing 哨兵协议的 backend.exec，cwd 由 outcome.cwdAfter 跟踪。stdin 无独立输入流可走：
   *  保留既有的 wire 拼接（`cmd\nstdin`，bash -lc 引号串整体执行）——披露过的 RM0 best-effort 语义。 */
  private async runDegraded(
    st: TargetState,
    backend: SshBackend,
    cmd: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    stdin: string | undefined,
  ): Promise<ExecOutcome> {
    const cwd = st.lastCwd ?? st.spec.defaultCwd ?? '.'
    let outcome: ExecOutcome
    try {
      outcome = await backend.exec(stdin !== undefined ? `${cmd}\n${stdin}` : cmd, { cwd, timeoutMs, signal })
    } catch (error) {
      throw this.recover(st, error)
    }
    if (outcome.cwdAfter !== undefined && outcome.cwdAfter !== '') st.lastCwd = outcome.cwdAfter
    return this.capOutcome(outcome)
  }

  /**
   * maxOutputChars 尾窗截断（重要评审项 3）：引擎级二次裁剪，output 与 stderr
   * 同规。产出端已截断时（truncated = 真原长），标记必须沿用那个数——拿 100k
   * 尾窗串重新计量会把「原始 5 MB」谎报成「原始 100k」。stderr 无 upstream
   * truncated 通道（backend 侧已给 output 报真原长；stderr 帽与 output 一致），
   * 裁剪时按自身长度计。
   */
  private capOutcome(outcome: ExecOutcome): ExecOutcome {
    const next: ExecOutcome = { ...outcome }
    const total = outcome.truncated ?? capTail(outcome.output, this.maxOutputChars).truncatedFrom
    const capped = capTail(outcome.output, this.maxOutputChars)
    if (total !== undefined) {
      next.output = `[truncated: showing last ${capped.text.length} of ${total} chars]\n${capped.text}`
      next.truncated = total
    }
    if (next.stderr !== undefined) {
      const sCapped = capTail(next.stderr, this.maxOutputChars)
      if (sCapped.truncatedFrom !== undefined) {
        next.stderr = `[truncated: showing last ${sCapped.text.length} of ${sCapped.truncatedFrom} chars]\n${sCapped.text}`
      }
    }
    return next
  }

  // ── 内部：连接与会话生命周期 ─────────────────────────────────────────────

  private ensureBackend(st: TargetState): { backend: SshBackend; fresh: boolean } {
    if (st.backend !== undefined) return { backend: st.backend, fresh: false }
    const backend = this.backendFactory(st.spec)
    st.backend = backend
    st.connSince = this.clock()
    this.armIdle(st)
    return { backend, fresh: true }
  }

  /**
   * 错误恢复路由（Step 3：错误恢复路径全部落到 closed 状态由下次调用重建）：
   * E_CWD_GONE → 快照失效，清 lastCwd 留新鲜 backend（本调已大声报错，下次从
   * defaultCwd/HOME 重来）；连接层码 → 整个 backend 作废；会话层码 → 只丢会话。
   */
  private recover(st: TargetState, error: unknown): unknown {
    const code = codeOf(error)
    if (code === 'E_CWD_GONE') {
      st.lastCwd = undefined
      return error
    }
    if (code !== undefined && CONN_CODES.has(code)) {
      this.dropConnection(st)
      return error
    }
    if (code !== undefined && SESSION_CODES.has(code)) {
      this.clearSession(st)
      return error
    }
    return error
  }

  /** 连接级回收（idle timer 与连接层错误共用）：backend + 会话全清，lastCwd 保留供回放。 */
  private dropConnection(st: TargetState): void {
    const { backend, session } = st
    st.backend = undefined
    st.session = undefined
    st.connSince = undefined
    if (session !== undefined) void session.dispose().catch(() => {})
    if (backend !== undefined) void backend.close().catch(() => {})
  }

  /** 会话级清理（通道死 / wedge / 定位失败）：dispose 幂等（session.ts end 文档）。 */
  private clearSession(st: TargetState): void {
    const session = st.session
    st.session = undefined
    if (session !== undefined) void session.dispose().catch(() => {})
  }

  // ── 内部：空闲回收 ────────────────────────────────────────────────────────

  /** 每次操作收尾重排 timer；到点时若仍有操作在跑则放弃（由该操作收尾重排）。 */
  private armIdle(st: TargetState): void {
    if (st.idleTimer !== undefined) clearTimeout(st.idleTimer)
    if (st.backend === undefined) {
      st.idleTimer = undefined
      return
    }
    st.idleTimer = setTimeout(() => {
      st.idleTimer = undefined
      if (!st.busy) this.dropConnection(st)
    }, this.idleTtlMs)
  }

  // ── 内部：status 渲染 ─────────────────────────────────────────────────────

  private async renderStatus(st: TargetState): Promise<string> {
    let facts: StatusLine['facts']
    let error: string | undefined
    // 冷 target 也拨号（exec 同一条 lazy factory；ensureBackend 内 armIdle，拨号即活动）
    const { backend } = this.ensureBackend(st)
    // 一次性 degraded-exec probe；拨号/探测失败 → error 行替代事实行（不 throw）
    try {
      const probe = await backend.exec(buildProbeCommand(), {
        cwd: st.lastCwd ?? st.spec.defaultCwd ?? '.',
        timeoutMs: PROBE_TIMEOUT_MS,
      })
      facts = { ...parseProbeOutput(probe.output), rttMs: probe.durationMs }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      // 状态机与 exec 同规：连接层码 → 丢弃 backend 由下次调用重 factory（错误仍渲染不抛）
      this.recover(st, err)
    }
    return formatStatus({
      target: st.spec,
      facts,
      conn: this.connLine(st),
      session: this.sessionLine(st),
      error,
    })
  }

  private connLine(st: TargetState): StatusLine['conn'] {
    const backend = st.backend
    if (backend === undefined) return { state: 'idle' }
    return {
      state: backend.connState(),
      sinceMs: st.connSince !== undefined ? Math.max(0, this.clock() - st.connSince) : undefined,
    }
  }

  private sessionLine(st: TargetState): StatusLine['session'] {
    if (st.sessionMode === 'exec') return { mode: 'exec', cwd: st.lastCwd ?? st.spec.defaultCwd }
    const session = st.session
    if (session !== undefined) return { mode: 'pty', cwd: session.snapshot().cwd ?? st.lastCwd }
    return undefined
  }

  // ── 内部：审计 ────────────────────────────────────────────────────────────

  private emitAudit(event: AuditEvent): void {
    if (this.onAudit === undefined) return
    try {
      this.onAudit(event)
    } catch {
      // 审计观察面的故障不反噬命令路径
    }
  }
}
