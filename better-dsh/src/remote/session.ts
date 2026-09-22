/**
 * PTY session state machine (channel-agnostic) — plan
 * docs/10_plans/2026-09-22-dashr-remote-tool-rm0.md, Task 5; design §4.2.
 *
 * Drives one {@link ShellChannel} (Task 6 adapts an ssh2 shell+PTY channel
 * onto this face) through the OSC 133 command loop of `dashr/remote/framing`:
 *
 * - **boot** — {@link PtySession.ready} resolves on the first orphan `D` frame
 *   (the initial prompt once the engine rc applied); no `D` within
 *   `timeoutMsDefault` → reject `[E_BOOT]` (nothing is written — there is no
 *   command to interrupt yet).
 * - **run** — {@link PtySession.run} writes `cmd + '\n'`, waits for the
 *   pairing `D` and resolves with the C→D output (ANSI-stripped, tail-capped
 *   over `maxOutputChars` with a truncation marker), the exit code carried by
 *   `D` and the cwd from the OSC 7 that follows it. A `D` **without** a cwd
 *   key (no OSC 7 seen) marks the cwd *unknown* — it never retains the
 *   previous value.
 * - **watchdog** — `timeoutMs` elapsed with no `D` → write `\x03` (Ctrl-C),
 *   then wait `graceMs` (default 5000) for the `D`: within grace →
 *   `interrupted: true` with the interrupt's exit code; still no `D` → reject
 *   `[E_WEDGED]` and `end()` the channel (the caller rebuilds the session).
 *   An aborted {@link AbortSignal} takes the same Ctrl-C path.
 * - **concurrency** — one command at a time; a concurrent {@link run} rejects
 *   `[E_BUSY]`. Queueing is the engine's job (Task 8).
 *
 * Error vocabulary — bracketed code prefix on the message, `.code` carries the
 * bare code: `[E_BOOT]` / `[E_BUSY]` / `[E_WEDGED]` from the plan, plus
 * `[E_ABORTED]` (signal already aborted before the command was written) and
 * `[E_CLOSED]` (channel lost / session disposed — rebuild required). A channel
 * that dies mid-run resolves the run with `exitCode: null` (outcome honestly
 * unknown) instead of throwing; every call after that rejects `[E_CLOSED]`.
 *
 * @module dashr/remote/session
 */
import { capTail, createFrameParser, stripAnsi, type FrameParser } from './framing.ts'

/** ssh2 channel 的结构最小面（backend 负责适配）。 */
export interface ShellChannel {
  write(data: string): void
  end(): void
  onData(cb: (chunk: Buffer) => void): void
  onClose(cb: (err?: Error) => void): void
}

export interface RunResult {
  exitCode: number | null
  output: string
  interrupted: boolean
  durationMs: number
}

/** Ctrl-C（`\x03`）后等 D 的宽限，默认 5000。 */
const DEFAULT_GRACE_MS = 5000

/** `[E_CODE] message` 形态的会话错误；`.code` 另挂机器可读裸码。 */
function sessionError(code: 'E_BOOT' | 'E_BUSY' | 'E_WEDGED' | 'E_ABORTED' | 'E_CLOSED', message: string): Error & { code: string } {
  const error = new Error(`[${code}] ${message}`) as Error & { code: string }
  error.code = code
  return error
}

/** 一次等待（boot 或 run）的挂起态；同会话同时至多一个（E_BUSY 保证）。 */
interface PendingWait {
  kind: 'boot' | 'run'
  cmd: string | undefined
  startedAt: number
  timeoutMs: number
  timer: ReturnType<typeof setTimeout> | undefined
  graceTimer: ReturnType<typeof setTimeout> | undefined
  interruptSent: boolean
  signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  resolve: (result: RunResult) => void
  reject: (error: Error) => void
}

/** 计划裁决 6 的截断标记：前置，N = 尾窗字符数，M = 原始长度。 */
function withTruncationMarker(text: string, capped: { text: string; truncatedFrom: number | undefined }): string {
  if (capped.truncatedFrom === undefined) return text
  return `[truncated: showing last ${capped.text.length} of ${capped.truncatedFrom} chars]\n${capped.text}`
}

export class PtySession {
  private readonly channel: ShellChannel
  private readonly parser: FrameParser = createFrameParser()
  private readonly timeoutMsDefault: number
  private readonly maxOutputChars: number
  private readonly graceMs: number
  private cwdValue: string | undefined
  private booted = false
  /** 通道已死（对端 close / wedge end / dispose）— 其后一切调用 E_CLOSED。 */
  private dead = false
  private disposed = false
  private pending: PendingWait | undefined

  constructor(channel: ShellChannel, opts: { timeoutMsDefault: number; maxOutputChars: number; graceMs?: number }) {
    this.channel = channel
    this.timeoutMsDefault = opts.timeoutMsDefault
    this.maxOutputChars = opts.maxOutputChars
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
    channel.onData(this.handleData)
    channel.onClose(this.handleClose)
  }

  /** 等 boot 首个 D（rc 应用后的首 prompt）→ ready；超时 throw E_BOOT。 */
  ready(): Promise<void> {
    if (this.booted) return Promise.resolve()
    if (this.dead) return Promise.reject(sessionError('E_CLOSED', 'channel already closed; rebuild the session before ready()'))
    if (this.pending !== undefined) return Promise.reject(sessionError('E_BUSY', 'another wait is already in flight'))
    const { promise } = this.startWait('boot', this.timeoutMsDefault)
    return promise.then(() => {})
  }

  /** 单命令：write cmd+'\n'，C→D 取输出；同会话串行由调用方（engine）排队。 */
  run(cmd: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    if (this.dead) return Promise.reject(sessionError('E_CLOSED', 'session is dead (channel closed or wedged); rebuild before run()'))
    if (this.pending !== undefined) return Promise.reject(sessionError('E_BUSY', `command ${JSON.stringify(cmd)} rejected: another command is already in flight on this session; queue at the engine`))
    if (!this.booted) return Promise.reject(sessionError('E_BOOT', 'ready() must resolve (first prompt seen) before run()'))
    const signal = opts.signal
    if (signal?.aborted) return Promise.reject(sessionError('E_ABORTED', 'signal already aborted; command not sent'))
    const { promise, wait } = this.startWait('run', opts.timeoutMs ?? this.timeoutMsDefault)
    wait.cmd = cmd
    this.channel.write(cmd + '\n')
    if (signal !== undefined) {
      wait.signal = signal
      wait.onAbort = () => this.interrupt()
      signal.addEventListener('abort', wait.onAbort, { once: true })
    }
    return promise
  }

  cwd(): string | undefined {
    return this.cwdValue
  }

  snapshot(): { cwd?: string } {
    return { cwd: this.cwdValue }
  }

  /** end() 通道（幂等）；在飞命令以 E_CLOSED 拒绝（调用方负责 reset 重建）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.dead = true
    const wait = this.pending
    if (wait !== undefined) {
      this.clearWait(wait)
      wait.reject(sessionError('E_CLOSED', `session disposed while ${wait.kind === 'boot' ? 'booting' : `running ${JSON.stringify(wait.cmd)}`}`))
    }
    this.channel.end()
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private startWait(kind: 'boot' | 'run', timeoutMs: number): { promise: Promise<RunResult>; wait: PendingWait } {
    const wait: PendingWait = {
      kind,
      cmd: undefined,
      startedAt: Date.now(),
      timeoutMs,
      timer: undefined,
      graceTimer: undefined,
      interruptSent: false,
      signal: undefined,
      onAbort: undefined,
      resolve: () => {},
      reject: () => {},
    }
    const promise = new Promise<RunResult>((resolve, reject) => {
      wait.resolve = resolve
      wait.reject = reject
    })
    wait.timer = setTimeout(this.onWaitTimeout, timeoutMs)
    this.pending = wait
    return { promise, wait }
  }

  /** 落定等待：清双定时器 + 摘 abort 监听 + 摘挂起态（幂等安全）。 */
  private clearWait(wait: PendingWait): void {
    if (wait.timer !== undefined) clearTimeout(wait.timer)
    if (wait.graceTimer !== undefined) clearTimeout(wait.graceTimer)
    if (wait.signal !== undefined && wait.onAbort !== undefined) wait.signal.removeEventListener('abort', wait.onAbort)
    if (this.pending === wait) this.pending = undefined
  }

  private handleData = (chunk: Buffer): void => {
    if (this.disposed) return
    for (const frame of this.parser.push(chunk.toString('utf8'))) {
      if (frame.kind === 'command-start') continue // 配对是 parser 的职责
      // command-end：OSC 7 缺席（无 cwd 键）= cwd 未知，绝不沿用旧值
      this.cwdValue = frame.cwd
      this.onCommandEnd(frame.exitCode)
    }
  }

  private onCommandEnd(exitCode: number): void {
    const wait = this.pending
    if (wait === undefined) {
      // 无等待者的 D：先于 ready() 到达的 boot D（首 prompt 可在 ready() 注册前
      // 竞速到达——锁存 boot 完成，ready() 随即幂等 resolve）或会话空闲期的杂散 D
      this.booted = true
      return
    }
    this.clearWait(wait)
    if (wait.kind === 'boot') {
      this.booted = true
      wait.resolve({ exitCode, output: '', interrupted: false, durationMs: 0 }) // boot 只认"D 到了"
    } else {
      wait.resolve({
        exitCode,
        output: this.takeOutput(),
        interrupted: wait.interruptSent,
        durationMs: Date.now() - wait.startedAt,
      })
    }
  }

  /** C→D 段原始输出 → stripAnsi → 超帽尾窗 + 截断标记。 */
  private takeOutput(): string {
    const text = stripAnsi(this.parser.takePendingOutput())
    return withTruncationMarker(text, capTail(text, this.maxOutputChars))
  }

  /** boot 超时 → E_BOOT；run 超时 → 看门狗 Ctrl-C。 */
  private onWaitTimeout = (): void => {
    const wait = this.pending
    if (wait === undefined) return
    if (wait.kind === 'boot') {
      this.clearWait(wait)
      wait.reject(sessionError('E_BOOT', `no prompt (D) within ${wait.timeoutMs}ms — remote shell never produced its first OSC 133 D frame`))
      return
    }
    this.interrupt()
  }

  /** 看门狗到点 / signal abort 共用：发 \x03 并开 grace 等 D。 */
  private interrupt(): void {
    const wait = this.pending
    if (wait === undefined || wait.interruptSent) return
    wait.interruptSent = true
    if (wait.timer !== undefined) {
      clearTimeout(wait.timer)
      wait.timer = undefined
    }
    this.channel.write('\x03')
    wait.graceTimer = setTimeout(this.onGraceExpired, this.graceMs)
  }

  /** grace 内无 D → E_WEDGED + end() channel（调用方负责 reset 重建）。 */
  private onGraceExpired = (): void => {
    const wait = this.pending
    if (wait === undefined || !wait.interruptSent) return
    this.clearWait(wait)
    this.dead = true
    this.channel.end()
    wait.reject(sessionError('E_WEDGED', `no D within ${this.graceMs}ms after Ctrl-C for ${JSON.stringify(wait.cmd)} — shell is wedged; channel ended, rebuild the session`))
  }

  /** 对端断线：boot → E_BOOT；run → exitCode null（结果未知，诚实上交）。 */
  private handleClose = (err?: Error): void => {
    this.dead = true
    const wait = this.pending
    if (wait === undefined) return
    this.clearWait(wait)
    if (wait.kind === 'boot') {
      wait.reject(sessionError('E_BOOT', `channel closed before the first prompt${err ? `: ${err.message}` : ''}`))
    } else {
      wait.resolve({
        exitCode: null,
        output: this.takeOutput(),
        interrupted: wait.interruptSent,
        durationMs: Date.now() - wait.startedAt,
      })
    }
  }
}
