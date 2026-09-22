/**
 * SSH transport backend — 真实 ssh2 协议（{@link Client}）。
 *
 * 池化：每个 backend 至多一条 TCP 连接、一个 {@link Client}，首个命令惰性建连
 * （连接池归 Task 8 引擎所有，backend 只保证"单目标不重复握手"）。降级 exec
 * 走 `buildDegradedCommand`（cd 守卫 + bash -lc + 尾部哨兵），stdout/stderr 分流、
 * 尾帽截断；PTY 会话经 sftp 写 rcfile（0600）→ `exec bash --rcfile`（真 PTY）→
 * OSC 133/7 引擎接管，bash 版本不足（< 4，PS0 前提）则拒会话降级。主机钥
 * TOFU：首连落 store，失配一律拒绝且不回写。
 *
 * @module dashr/remote/backend
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import { buildDegradedCommand, buildEngineRc, capTail, parseDegradedOutput, shellQuote } from './framing.ts'
import { fingerprintOfKey } from './hostkeys.ts'
import type { HostKeyStore } from './hostkeys.ts'
import { PtySession } from './session.ts'
import type { ShellChannel } from './session.ts'
import type { RemoteTargetSpec } from './registry.ts'

export type ConnState = 'idle' | 'connecting' | 'ready' | 'closed'

export interface RemoteError extends Error {
  code:
    | 'E_AUTH'
    | 'E_HOSTKEY_CHANGED'
    | 'E_CONNECT'
    | 'E_PROXY_UNSUPPORTED'
    | 'E_KEY_UNREADABLE'
    | 'E_KEY_ENCRYPTED'
    | 'E_TIMEOUT'
    | 'E_CWD_GONE'
}

export interface ExecOutcome {
  exitCode: number | null
  output: string
  stderr?: string
  cwdAfter?: string
  durationMs: number
  interrupted?: boolean
  truncated?: number
}

export interface SshBackend {
  readonly targetName: string
  connState(): ConnState
  exec(cmd: string, opts: { cwd: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<ExecOutcome>
  openShellSession(env?: Record<string, string>): Promise<PtySession>
  probe(): Promise<{ rttMs: number }>
  snapshotRestore(cwd: string): Promise<void>
  close(): Promise<void>
}

/** 降级 exec 单向输出尾帽（字符数；超出保留尾窗，truncated 报原长）。 */
const MAX_EXEC_OUTPUT_CHARS = 100_000
/** 连接就绪默认上限（ms）。 */
const DEFAULT_READY_TIMEOUT_MS = 10_000
/** 连接保活默认间隔（ms）。 */
const DEFAULT_KEEPALIVE_MS = 15_000
/** 会话通道默认单命令超时（ms；PtySession 的 timeoutMsDefault）。 */
const SESSION_TIMEOUT_MS = 30_000
/** 会话通道默认输出帽（字符数）。 */
const SESSION_MAX_OUTPUT_CHARS = 100_000
/** rcfile 前缀（/tmp，dispose 后经 sftp unlink 清理）。 */
const RC_PREFIX = '/tmp/.better-dsh-rc-'

/** 造一个带 code 的 RemoteError（message 供 UI 直读，含修复线索）。 */
function remoteError(code: RemoteError['code'], message: string): RemoteError {
  const err = new Error(message) as RemoteError
  err.code = code
  return err
}

/** 把 ssh2 连接/握手错误映射为 RemoteError 码（顺序敏感：加密钥优先于解析失败）。 */
function mapConnectError(raw: Error): RemoteError {
  const msg = String(raw.message ?? raw)
  if (/encrypted/i.test(msg)) {
    return remoteError('E_KEY_ENCRYPTED', 'identity key is passphrase-encrypted; add the key to ssh-agent (ssh-add) or use an unencrypted key file')
  }
  if (/Host denied|host key verification/i.test(msg)) {
    return remoteError('E_HOSTKEY_CHANGED', 'host key does not match the pinned fingerprint (possible MITM or server rebuild); update the pin only after verifying the new key out-of-band')
  }
  if (/Cannot parse privateKey|Could not parse|invalid .*key/i.test(msg)) {
    return remoteError('E_KEY_UNREADABLE', `identity file unreadable or not a valid private key: ${msg}`)
  }
  if (/All configured authentication methods failed/i.test(msg)) {
    return remoteError('E_AUTH', 'authentication failed: key rejected by the server; check authorized_keys / user / identityFile')
  }
  return remoteError('E_CONNECT', `ssh connect failed: ${msg}`)
}

/**
 * ssh2 backend 实现。单目标、懒连接；`close()` 后不再复连（一切调用 E_CONNECT）。
 * 注意：`close()` 不取消在飞命令（语义：优雅排空，由引擎保证先无在飞再关）。
 */
export function createSshBackend(
  target: RemoteTargetSpec,
  opts: {
    hostKeyStore: HostKeyStore
    readyTimeoutMs?: number
    keepaliveIntervalMs?: number
  },
): SshBackend {
  const store = opts.hostKeyStore
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const keepaliveIntervalMs = opts.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS

  let state: ConnState = 'idle'
  let client: Client | undefined
  let connectPromise: Promise<Client> | undefined

  /** 经闭包读 state（返回声明类型）：close() 可在 await 间隙并发改写，
   *  直读会撞上 TS 对 `state = 'connecting'` 的赋值收窄（TS2367 误报）。 */
  function stateIs(s: ConnState): boolean {
    return state === s
  }

  function err(code: RemoteError['code'], message: string): RemoteError {
    return remoteError(code, message)
  }

  /** 解析 identityFile / ssh-agent 认证素材为 ConnectConfig 片段。 */
  function resolveAuth(): Pick<ConnectConfig, 'privateKey' | 'agent'> {
    if (target.identityFile !== undefined && target.identityFile !== '') {
      let pem: Buffer
      try {
        pem = readFileSync(target.identityFile)
      } catch (cause) {
        throw err('E_KEY_UNREADABLE', `identity file cannot be read: ${target.identityFile} (${String((cause as Error).message ?? cause)})`)
      }
      return { privateKey: pem }
    }
    const agent = process.env.SSH_AUTH_SOCK
    if (agent === undefined || agent === '') {
      throw err('E_AUTH', 'no credentials: set identityFile in the target, or start ssh-agent and add a key (ssh-add)')
    }
    return { agent }
  }

  /** TOFU 主机钥校验：未知 → 落 store 并放行；失配 → 拒绝且不回写。 */
  function hostVerifier(key: Buffer): boolean {
    const fp = fingerprintOfKey(key)
    const known = store.get(target.name)
    if (known === undefined) {
      store.set(target.name, fp)
      return true
    }
    return known === fp
  }

  /** 建连（幂等共享）：proxyJump 先行拒绝；失败回 idle 允许重试。 */
  function ensureConnected(): Promise<Client> {
    if (state === 'closed') {
      return Promise.reject(err('E_CONNECT', `backend for ${target.name} is closed; create a new backend`))
    }
    if (target.proxyJump !== undefined && target.proxyJump !== '') {
      return Promise.reject(err('E_PROXY_UNSUPPORTED', `proxyJump (${target.proxyJump}) is not supported by this build; connect directly or pre-establish the jump manually`))
    }
    if (state === 'ready' && client !== undefined) return Promise.resolve(client)
    if (connectPromise !== undefined) return connectPromise

    state = 'connecting'
    connectPromise = (async () => {
      const auth = resolveAuth()
      const c = new Client()
      c.on('error', () => {
        // 失败经 ready-reject / ready-timeout 传递；此处仅吞掉未订阅的 error 事件
      })
      c.on('close', () => {
        // 网络断开 → 丢引用、回 idle，下次调用惰性重连（TOFU 会再次校验指纹）
        if (client === c) client = undefined
        if (connectPromise !== undefined && state !== 'closed') connectPromise = undefined
        if (state !== 'closed') state = 'idle'
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(err('E_CONNECT', `ssh handshake timed out after ${readyTimeoutMs}ms (host ${target.host}:${target.port ?? 22})`))
            c.end()
          }, readyTimeoutMs)
          c.once('ready', () => {
            clearTimeout(timer)
            resolve()
          })
          c.once('error', (e: Error) => {
            clearTimeout(timer)
            reject(mapConnectError(e))
          })
          c.connect({
            host: target.host,
            port: target.port ?? 22,
            username: target.user ?? process.env.USER ?? 'root',
            hostVerifier,
            keepaliveInterval: keepaliveIntervalMs,
            readyTimeout: readyTimeoutMs,
            ...auth,
          })
        })
        // close() 在握手期间到达：不得复活 — 立即拆链并按失败处理（state 保持 closed）
        if (stateIs('closed')) {
          c.end()
          throw err('E_CONNECT', `backend for ${target.name} closed during connect`)
        }
        client = c
        state = 'ready'
        return c
      } catch (cause) {
        // 同上：close() 期间连接失败也必须保持 closed（否则下次调用复活重连）
        if (!stateIs('closed')) state = 'idle'
        if (client === c) client = undefined
        connectPromise = undefined
        c.end()
        throw cause
      }
    })()
    return connectPromise
  }

  /** 在既有连接上开 sftp 通道（rcfile 写入/清理用；不触发建连）。 */
  function openSftpOn(c: Client, what: string): Promise<SFTPWrapper> {
    return new Promise<SFTPWrapper>((resolve, reject) => {
      c.sftp((sftpErr, sftp) => {
        if (sftpErr !== undefined) reject(err('E_CONNECT', `${what} failed: ${String(sftpErr.message)}`))
        else resolve(sftp)
      })
    })
  }

  /** 降级 exec 核心：stdout/stderr 分流收集 + 超时/中止 + 通道销毁。 */
  async function runDegraded(
    cmd: string,
    execOpts: { cwd: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ raw: string; stderr: string; interrupted: boolean; durationMs: number }> {
    const c = await ensureConnected()
    const startedAt = Date.now()
    const env: Record<string, string> = {}
    if (target.env !== undefined) Object.assign(env, target.env)
    if (execOpts.env !== undefined) Object.assign(env, execOpts.env)

    return await new Promise((resolve, reject) => {
      let settled = false
      let timedOut = false
      let interrupted = false
      const outChunks: Buffer[] = []
      const errChunks: Buffer[] = []

      function settle<T>(fin: (v: T) => void, value: T): void {
        if (settled) return
        settled = true
        fin(value)
      }

      c.exec(buildDegradedCommand(cmd, execOpts.cwd), { env }, (execErr, stream) => {
        if (execErr !== undefined) {
          settle(reject, mapConnectError(execErr))
          return
        }
        const timer = setTimeout(() => {
          timedOut = true
          stream.close()
        }, execOpts.timeoutMs)
        const onAbort = () => {
          interrupted = true
          stream.close()
        }
        if (execOpts.signal !== undefined) {
          if (execOpts.signal.aborted) onAbort()
          else execOpts.signal.addEventListener('abort', onAbort, { once: true })
        }
        stream.on('data', (chunk: Buffer) => outChunks.push(chunk))
        stream.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))
        stream.on('close', () => {
          clearTimeout(timer)
          if (execOpts.signal !== undefined) execOpts.signal.removeEventListener('abort', onAbort)
          const raw = Buffer.concat(outChunks).toString('utf8')
          const stderr = Buffer.concat(errChunks).toString('utf8')
          if (timedOut) {
            settle(reject, err('E_TIMEOUT', `command exceeded ${execOpts.timeoutMs}ms; channel destroyed: ${JSON.stringify(cmd).slice(0, 120)}`))
            return
          }
          settle(resolve, { raw, stderr, interrupted, durationMs: Date.now() - startedAt })
        })
      })
    })
  }

  async function exec(cmd: string, execOpts: { cwd: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<ExecOutcome> {
    const { raw, stderr, interrupted, durationMs } = await runDegraded(cmd, execOpts)
    const parsed = parseDegradedOutput(raw)
    if (parsed.cwdGone) {
      throw err('E_CWD_GONE', `working directory no longer exists: ${execOpts.cwd} (command not run)`)
    }
    // bash 退出码域 0–255；-1 只能来自哨兵缺失（通道被杀）→ 未知，诚实上交 null
    const exitCode = interrupted || parsed.exitCode === -1 ? null : parsed.exitCode
    const tail = capTail(parsed.output, MAX_EXEC_OUTPUT_CHARS)
    return {
      exitCode,
      output: tail.text,
      stderr: stderr === '' ? undefined : stderr,
      cwdAfter: parsed.cwd === '' ? undefined : parsed.cwd,
      durationMs,
      interrupted: interrupted || undefined,
      truncated: tail.truncatedFrom,
    }
  }

  async function openShellSession(env?: Record<string, string>): Promise<PtySession> {
    const c = await ensureConnected()
    const merged: Record<string, string> = {}
    if (target.env !== undefined) Object.assign(merged, target.env)
    if (env !== undefined) Object.assign(merged, env)

    // 1. sftp 写 rcfile（0600）— 引擎帧 + 哨兵从此注入。
    //    写完/写败都必须 end：sftp 是池化连接上的会话通道，不释放会一直钉住
    //    （真实 sshd MaxSessions 默认 10，钉满后通道开不出来 → E_CONNECT）。
    const sftp = await openSftpOn(c, 'rcfile upload')
    const rcPath = `${RC_PREFIX}${randomBytes(8).toString('hex')}`
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.writeFile(rcPath, buildEngineRc(), { mode: 0o600 }, (wErr) => {
          if (wErr != null) reject(err('E_CONNECT', `rcfile upload failed: ${String(wErr.message)}`))
          else resolve()
        })
      })
    } finally {
      sftp.end()
    }

    // 2. exec bash --rcfile（真 PTY）；通道适配 ShellChannel
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      c.exec(`exec bash --rcfile ${shellQuote(rcPath)}`, { env: merged, pty: { term: 'dumb', rows: 40, cols: 120 } }, (execErr, stream) => {
        if (execErr !== undefined) {
          reject(err('E_CONNECT', `shell session failed to start: ${String(execErr.message)}`))
          return
        }
        resolve(stream)
      })
    })
    const shell = adaptShellChannel(channel)

    // 3. boot + bash 版本门（PS0 需 bash ≥ 4.4；不足 → 拒会话，引擎走降级 exec）
    const session = new ManagedPtySession(shell, { timeoutMsDefault: SESSION_TIMEOUT_MS, maxOutputChars: SESSION_MAX_OUTPUT_CHARS }, rcPath, () => removeRcFile(c, rcPath))
    try {
      await session.ready()
      const probe = await exec('printf %s "$BASH_VERSION"', { cwd: '/', timeoutMs: SESSION_TIMEOUT_MS })
      const major = /^(\d+)/.exec(probe.output.trim())
      if (major === null || Number(major[1]) < 4) {
        // brief L25/L50（Ruling 3）：bash 太旧 → 专用码（非 RemoteError 八码之一），
        // engine 据此把目标整体降级到纯 degraded exec
        const fallback = new Error(`remote bash too old for engine frames (BASH_VERSION=${JSON.stringify(probe.output.trim())}); PTY session refused`) as Error & { code: 'E_EXEC_FALLBACK' }
        fallback.code = 'E_EXEC_FALLBACK'
        throw fallback
      }
      return session
    } catch (cause) {
      // boot 失败 / 版本不足：会话与 rcfile 全清，调用方只拿到错误
      await session.dispose().catch(() => {})
      throw cause
    }
  }

  /** 在既有连接上尽力删除 rcfile；连接已死则静默放弃（/tmp 老化兜底）。 */
  async function removeRcFile(c: Client, rcPath: string): Promise<void> {
    try {
      const sftp = await openSftpOn(c, 'rcfile cleanup')
      await new Promise<void>((resolve) => {
        sftp.unlink(rcPath, () => {
          sftp.end()
          resolve()
        })
      })
    } catch {
      // 尽力而为：dispose 永不因清理失败而抛
    }
  }

  async function probe(): Promise<{ rttMs: number }> {
    const out = await exec('true', { cwd: '/', timeoutMs: readyTimeoutMs })
    return { rttMs: out.durationMs }
  }

  async function snapshotRestore(cwd: string): Promise<void> {
    // E_CWD_GONE 直接向上抛（message 含 cwd 原文）— 引擎决定下一步
    await exec('true', { cwd, timeoutMs: readyTimeoutMs })
  }

  async function close(): Promise<void> {
    state = 'closed'
    const c = client
    client = undefined
    connectPromise = undefined
    c?.end()
  }

  const backend: SshBackend = {
    targetName: target.name,
    connState: () => state,
    exec,
    openShellSession,
    probe,
    snapshotRestore,
    close,
  }
  return backend
}

/**
 * {@link PtySession} 子类：dispose 时先收通道，再尽力经原连接删除 rcfile。
 * rcPath 暴露给诊断（boot 失败报告里带上）。
 */
class ManagedPtySession extends PtySession {
  readonly rcPath: string
  private readonly cleanup: () => Promise<void>

  constructor(
    channel: ShellChannel,
    opts: { timeoutMsDefault: number; maxOutputChars: number; graceMs?: number },
    rcPath: string,
    cleanup: () => Promise<void>,
  ) {
    super(channel, opts)
    this.rcPath = rcPath
    this.cleanup = cleanup
  }

  override async dispose(): Promise<void> {
    try {
      await super.dispose()
    } finally {
      await this.cleanup()
    }
  }
}

/** ClientChannel → ShellChannel 适配（数据/关闭两事件 + write/end 两动作）。 */
function adaptShellChannel(channel: ClientChannel): ShellChannel {
  return {
    write(data: string): void {
      channel.write(data)
    },
    end(): void {
      channel.end()
    },
    onData(cb: (chunk: Buffer) => void): void {
      channel.on('data', cb)
    },
    onClose(cb: (err?: Error) => void): void {
      // ssh2 的 close 携带退出码/信号（非 Error）；按契约只通知"已关"
      channel.on('close', () => cb())
    },
  }
}
