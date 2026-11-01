import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOneShot } from './oneshot.ts'
import type { SshConnection } from './ssh-targets.ts'

/** SSH oneshot 连接复用（plan 2026-11-01 Task E；探针基线 = 发起端 OpenSSH 10.2p1，2026-11-01 实测）：
 *  - master 与客户端完全脱钩（fork 后 PPID=init、自有 pgid/session）→ 本地 killpg 取消/超时永不波及
 *    master，后续 oneshot 继续复用；这正好落在 startBinaryProcess 的组杀清理语义之内。
 *  - ControlPersist 到期 master 自行退出并 unlink socket；`ssh -O exit` 主动拆除亦同。
 *  - master 被 SIGKILL 会留下残 socket 文件：ControlMaster=auto 的下一个客户端会自愈重建
 *    （实测 exit 0），失败语义按 ssh 真实回退，不冒充复用。
 *  - 只注入 SSH oneshot 执行链（POSIX wrapper / helper probe·upload·run·killgroup / cleanup /
 *    status 探测）；PTY、scp、rsync、relay 与 copy 的 mkdir pre-hop 一律不注入。
 *  - CLI `-o` 覆盖用户 config 同名项是 OpenSSH 语义（last-option-wins），其余身份选项照常读 config。 */
export const SSH_MUX_CONTROL_PERSIST_SEC = 600

/** Linux sun_path 上限 108；留余量并在超限时诚实退化为不复用（MUX 是优化，不是前提）。 */
const MAX_SOCKET_PATH = 104

export interface SshMuxIdentity {
  /** 原始 target 串（如 `ssh:dev4` / `dev4`）——同一 effective 身份不同拼法也不串 socket。 */
  target: string
  connection: SshConnection
}

export interface SshMuxOptions {
  persistSec?: number
  /** socket 目录根（默认 os.tmpdir()）；测试注入口。 */
  rootDir?: string
  runner?: (argv: string[], opts?: { timeoutSec?: number }) => Promise<{ exit: number | null }>
}

function identityKey(identity: SshMuxIdentity): string {
  const c = identity.connection
  const raw = JSON.stringify([identity.target, c.host, c.user ?? null, c.port ?? null, c.key ?? null, c.proxyJump ?? null])
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/** 每 Agent 一个（driver 私有）：tool-owned 0700 socket 目录 + 按连接身份的 socket 名。
 *  目录名含随机 owner 后缀，跨 Agent 天然不共享；dispose 逐 socket `-O exit` 后整目录删除。 */
export class SshMux {
  private readonly persistSec: number
  private readonly rootDir: string
  private readonly runner: NonNullable<SshMuxOptions['runner']>
  private readonly owner = randomUUID().slice(0, 8)
  private readonly sockets = new Map<string, string>() // socket path → host operand（-O exit 用）
  private dir: string | undefined
  private disposal: Promise<void> | undefined

  constructor(options: SshMuxOptions = {}) {
    this.persistSec = options.persistSec ?? SSH_MUX_CONTROL_PERSIST_SEC
    this.rootDir = options.rootDir ?? tmpdir()
    this.runner = options.runner ?? runOneShot
  }

  /** 注入 SSH argv 的 MUX 选项（trusted internal argv，非模型输入）。目录懒建（纯 docker/hub
   *  Agent 永不触盘）；超限/已 dispose 返回 [] = 诚实退化为普通连接。 */
  argvFor(identity: SshMuxIdentity): string[] {
    if (this.disposal !== undefined) return []
    const socket = join(this.dir ?? (this.dir = join(this.rootDir, `superd-mux-${this.owner}`)), identityKey(identity))
    if (socket.length + 1 > MAX_SOCKET_PATH) return [] // sun_path 含 NUL 终结符
    try {
      mkdirSync(this.dir!, { recursive: true, mode: 0o700 })
    } catch {
      return [] // 目录不可建（如只读 tmp）：退化直连，执行语义不变
    }
    this.sockets.set(socket, identity.connection.host)
    return ['-o', `ControlPath=${socket}`, '-o', 'ControlMaster=auto', '-o', `ControlPersist=${this.persistSec}`]
  }

  /** Teardown：先 `-O exit` 逐 socket 礼貌拆除 master（不拨号、5s 上限、错误全吞——
   *  master 已死/残 socket 属正常），再删目录。单飞（重复调用同一 Promise）。 */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    const sockets = [...this.sockets.entries()]
    this.sockets.clear()
    return this.disposal = (async () => {
      await Promise.allSettled(sockets.map(([socket, host]) =>
        this.runner(['ssh', '-o', `ControlPath=${socket}`, '-O', 'exit', '--', host], { timeoutSec: 5 })))
      if (this.dir !== undefined) { try { rmSync(this.dir, { recursive: true, force: true }) } catch { /* best-effort */ } }
    })()
  }
}
