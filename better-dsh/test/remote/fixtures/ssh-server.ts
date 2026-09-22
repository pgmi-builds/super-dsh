/**
 * 进程内 {@link Server ssh2.Server} 夹具 — 真 ssh2 协议、真 TCP（127.0.0.1:0 随机
 * 端口），backend.spec 的被测对象。按任务书约定：<br>
 * - 认证：ed25519 客户端密钥对，夹具生成一次、私钥写 tmpdir 文件（目标
 *   `identityFile` 指向它）；`rejectKeyAuth` 打开后一律拒绝（E_AUTH 测试）。
 * - exec：对每个 exec/shell 请求 `spawn('bash', ['-lc', command])` 管道子进程
 *   （不分配真 PTY — rcfile 里的 stty 容忍失败），stdout/stderr 分流回写，
 *   退出码经 `exit-status` 回送；`env` 通道请求记入会话级环境，套在子进程上。
 * - sftp：最小服务端实现（OPEN/WRITE/FSETSTAT/CLOSE/REMOVE），恰好覆盖
 *   backend 写 rcfile 与 dispose 后清理两条路径；其余请求无人监听 → ssh2 判
 *   fatal SFTP 错误（fail-loud）。
 *
 * @module dashr/remote/fixtures/ssh-server
 */
import { spawn } from 'node:child_process'
import {
  closeSync,
  fchmodSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs'
import type { Socket, AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, utils } from 'ssh2'
import type { ServerChannel, Session } from 'ssh2'
import { fingerprintOfKey } from '../../../src/remote/hostkeys.ts'

export interface SshServerFixtureOptions {
  /** 打开后认证一律拒绝 — backend 报 E_AUTH 的负路径测试用。 */
  rejectKeyAuth?: boolean
}

export interface SshServerFixture {
  /** 起 sshd（127.0.0.1 随机端口），返回端口与主机指纹（与 hostkeys.ts 同构）。 */
  start(): Promise<{ port: number; hostKeyFingerprint: string }>
  /** 停 sshd：结束 SSH 连接、关监听、清 tmpdir。 */
  stop(): Promise<void>
  /** 本夹具实例累计收到的 SSH 连接数 — 单 TCP 池化断言用。 */
  readonly connectionCount: number
  /** 本夹具实例累计打开的 sftp 会话通道数（含 upload/cleanup 每次 open）。 */
  readonly sftpChannelsOpened: number
  /** 其中已经关闭（服务端收到通道 close）的数量。 */
  readonly sftpChannelsClosed: number
  /** 当前仍存活的 sftp 通道数 = opened − closed（sftp 通道泄漏断言用）。 */
  readonly liveSftpChannels: number
  /** 累计收到的 ssh `env` 通道请求数（wire-baked env 契约：backend 恒不发，应保持 0）。 */
  readonly envRequests: number
  /** 客户端私钥文件路径（0600，tmpdir 内）— 目标 identityFile 指向它。 */
  readonly clientPrivateKeyPath: string
}

/** 生成一把 ed25519 钥匙（utils.generateKeyPair 回调式，包成 Promise）。 */
function generateEd25519(): Promise<{ private: string; public: string }> {
  return new Promise((resolve, reject) => {
    utils.generateKeyPair('ed25519', (err, keys) => {
      if (err !== null) reject(err)
      else resolve(keys)
    })
  })
}

/**
 * 生成并立即用 parseKey 验收的 ed25519 钥匙。上游 ssh2 keygen.js 对 ed25519
 * SPKI bitstring 的"去前导零"处理有缺陷：偶发（实测 ~6/3000 ≈ 1/500）产出
 * 连它自家 parseKey 都拒收的 OpenSSH 私钥（"Malformed OpenSSH private key"）。
 * 夹具重试去 flake；5 连坏则放行最后一枚（在调用点 fail-loud）。
 */
async function generateEd25519Verified(): Promise<{ private: string; public: string }> {
  let keys = await generateEd25519()
  for (let attempt = 0; utils.parseKey(keys.private) instanceof Error && attempt < 4; attempt++) {
    keys = await generateEd25519()
  }
  return keys
}

/** ssh2 OPEN_MODE 位标志 → node fs 打开串（夹具只需覆盖常规读/写/追加组合）。 */
function sftpFlagsToNodeFlags(flags: number): string {
  const canRead = (flags & utils.sftp.OPEN_MODE.READ) !== 0
  const canWrite = (flags & utils.sftp.OPEN_MODE.WRITE) !== 0
  const append = (flags & utils.sftp.OPEN_MODE.APPEND) !== 0
  const creat = (flags & utils.sftp.OPEN_MODE.CREAT) !== 0
  const trunc = (flags & utils.sftp.OPEN_MODE.TRUNC) !== 0
  const excl = (flags & utils.sftp.OPEN_MODE.EXCL) !== 0
  if (canWrite && !canRead) {
    if (append) return 'a'
    if (excl) return 'wx'
    if (trunc || creat) return 'w'
    return 'r+'
  }
  if (canWrite && canRead) {
    if (append) return 'a+'
    if (excl) return 'wx+'
    if (trunc) return 'w+'
    return 'r+'
  }
  return 'r'
}

export function createSshServerFixture(options: SshServerFixtureOptions = {}): SshServerFixture {
  const { rejectKeyAuth = false } = options

  let server: Server | undefined
  let port = 0
  let hostKeyFingerprint = ''
  let connectionCount = 0
  let sftpChannelsOpened = 0
  let sftpChannelsClosed = 0
  let envRequests = 0
  let clientPrivateKeyPath: string | undefined
  let tmpDir: string | undefined
  const sockets = new Set<Socket>()

  const fixture: SshServerFixture = {
    get connectionCount() {
      return connectionCount
    },
    get sftpChannelsOpened() {
      if (server === undefined) throw new Error('fixture not started')
      return sftpChannelsOpened
    },
    get sftpChannelsClosed() {
      if (server === undefined) throw new Error('fixture not started')
      return sftpChannelsClosed
    },
    get liveSftpChannels() {
      if (server === undefined) throw new Error('fixture not started')
      return sftpChannelsOpened - sftpChannelsClosed
    },
    get envRequests() {
      if (server === undefined) throw new Error('fixture not started')
      return envRequests
    },
    get clientPrivateKeyPath() {
      if (clientPrivateKeyPath === undefined) throw new Error('fixture not started')
      return clientPrivateKeyPath
    },
    async start() {
      if (server !== undefined) throw new Error('fixture already started')
      connectionCount = 0
      sftpChannelsOpened = 0
      sftpChannelsClosed = 0
      envRequests = 0
      // 主机钥（算指纹用 getPublicSSH 的线内 blob — 与客户端 hostVerifier 收到的同形）
      const hostKeys = await generateEd25519Verified()
      const parsedHostKey = utils.parseKey(hostKeys.private)
      if (parsedHostKey instanceof Error) throw parsedHostKey
      hostKeyFingerprint = fingerprintOfKey(parsedHostKey.getPublicSSH())

      // 客户端钥：私钥落 tmpdir 文件（目标 identityFile 指它），公钥给认证对照
      const clientKeys = await generateEd25519Verified()
      tmpDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-fixture-'))
      clientPrivateKeyPath = join(tmpDir, 'client_key')
      writeFileSync(clientPrivateKeyPath, clientKeys.private, { mode: 0o600 })
      const parsedClientKey = utils.parseKey(clientKeys.private)
      if (parsedClientKey instanceof Error) throw parsedClientKey
      const clientPub = parsedClientKey.getPublicSSH()

      const srv = new Server({ hostKeys: [hostKeys.private] }, (client) => {
        connectionCount++
        // 客户端拆链（认证失败后 end() 等）会以 DISCONNECT 形式到达服务端 →
        // Connection 发 'error'；无听众即 uncaught。吞之（拆链本就是预期路径）。
        client.on('error', () => {})
        client.on('authentication', (ctx) => {
          if (rejectKeyAuth) {
            ctx.reject()
            return
          }
          if (ctx.method === 'publickey' && ctx.key.data.equals(clientPub)) {
            ctx.accept()
            return
          }
          ctx.reject()
        })
        client.on('ready', () => {
          client.on('session', (accept) => {
            const session: Session = accept()
            // env 请求 → 会话级环境（exec 子进程继承）；pty 请求一律接受。
            // 注意：wantReply=false 时 accept 为 undefined（server.js 只在
            // wantReply 时装配 accept 闭包）——必须用 ?.() 调用。
            const envVars: Record<string, string> = {}
            // 会话是否申请过 PTY — 决定 exec 子进程挂真 PTY（模拟 sshd 行为）
            let ptyRequested = false
            session.on('env', (envAccept, _reject, info) => {
              envRequests++
              envVars[info.key] = info.val
              envAccept?.()
            })
            session.on('pty', (ptyAccept) => {
              ptyRequested = true
              ptyAccept?.()
            })
            // exec：无 pty → bash -lc 管道子进程（stdout/stderr 分流，退出码回送）；
            // 有 pty → script(1) 真终端（isatty ⇒ bash --rcfile 自然进交互态，
            // PS0/PS1 引擎帧才会发射 — 管道下 bash 判定非交互，帧永不出现）。
            session.on('exec', (execAccept, _reject, info) => {
              const stream: ServerChannel = execAccept()
              const child = ptyRequested
                ? spawn('script', ['-qefc', info.command, '/dev/null'], {
                    env: { ...process.env, ...envVars },
                    stdio: ['pipe', 'pipe', 'pipe'],
                  })
                : spawn('bash', ['-lc', info.command], {
                    env: { ...process.env, ...envVars },
                    stdio: ['pipe', 'pipe', 'pipe'],
                  })
              child.stdout?.on('data', (chunk: Buffer) => stream.write(chunk))
              child.stderr?.on('data', (chunk: Buffer) => stream.stderr.write(chunk))
              child.on('error', (err) => {
                stream.stderr.write(`fixture: spawn failed: ${String(err)}\n`)
                stream.exit(127)
                stream.end()
              })
              child.on('close', (code) => {
                stream.exit(code ?? 127)
                stream.end()
              })
              stream.on('data', (chunk: Buffer) => {
                child.stdin?.write(chunk)
              })
              stream.on('end', () => {
                child.stdin?.end()
              })
              // 通道先于子进程退出 → 防孤儿
              stream.on('close', () => {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
              })
            })
            // sftp：最小服务端（写文件 + 删除）；未监听的请求 → ssh2 fatal（fail-loud）
            session.on('sftp', (sftpAccept) => {
              const sftp = sftpAccept()
              // sftp 通道泄漏观测：opened 计 open、closed 计服务端通道 close
              sftpChannelsOpened++
              sftp.on('close', () => {
                sftpChannelsClosed++
              })
              const OK = utils.sftp.STATUS_CODE.OK
              const FAILURE = utils.sftp.STATUS_CODE.FAILURE
              const NO_SUCH_FILE = utils.sftp.STATUS_CODE.NO_SUCH_FILE
              // 句柄表以 hex 为键 — 线上回传的 handle 是新 Buffer 实例，
              // Map 按 Buffer 对象身份查表永远 miss。
              const openFiles = new Map<string, number>()
              let handleCounter = 0
              sftp.on('OPEN', (reqId, filename, flags, attrs) => {
                try {
                  const fd = openSync(filename, sftpFlagsToNodeFlags(flags), attrs?.mode)
                  const handle = Buffer.alloc(4)
                  handle.writeUInt32BE(handleCounter++, 0)
                  openFiles.set(handle.toString('hex'), fd)
                  sftp.handle(reqId, handle)
                } catch (err) {
                  sftp.status(reqId, FAILURE, String(err))
                }
              })
              sftp.on('WRITE', (reqId, handle, offset, data) => {
                const fd = openFiles.get(handle.toString('hex'))
                if (fd === undefined) {
                  sftp.status(reqId, FAILURE, 'unknown handle')
                  return
                }
                try {
                  writeSync(fd, data, 0, data.length, offset)
                  sftp.status(reqId, OK)
                } catch (err) {
                  sftp.status(reqId, FAILURE, String(err))
                }
              })
              sftp.on('FSETSTAT', (reqId, handle, attrs) => {
                const fd = openFiles.get(handle.toString('hex'))
                if (fd === undefined || attrs?.mode === undefined) {
                  sftp.status(reqId, FAILURE)
                  return
                }
                try {
                  fchmodSync(fd, attrs.mode)
                  sftp.status(reqId, OK)
                } catch (err) {
                  sftp.status(reqId, FAILURE, String(err))
                }
              })
              sftp.on('CLOSE', (reqId, handle) => {
                const fd = openFiles.get(handle.toString('hex'))
                if (fd === undefined) {
                  sftp.status(reqId, FAILURE, 'unknown handle')
                  return
                }
                openFiles.delete(handle.toString('hex'))
                try {
                  closeSync(fd)
                  sftp.status(reqId, OK)
                } catch (err) {
                  sftp.status(reqId, FAILURE, String(err))
                }
              })
              sftp.on('REMOVE', (reqId, path) => {
                try {
                  unlinkSync(path)
                  sftp.status(reqId, OK)
                } catch (err) {
                  const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? NO_SUCH_FILE : FAILURE
                  sftp.status(reqId, code, String(err))
                }
              })
            })
          })
        })
      })

      server = srv
      // net.Server 的 'connection' 仍携裸 socket（ssh2 的握手监听只是另一听众）—
      // 追踪之，stop() 兜底强拆，保证 vitest 退出零悬挂。
      srv.on('connection', (socket: Socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })

      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject)
        srv.listen(0, '127.0.0.1', () => {
          port = (srv.address() as AddressInfo).port
          resolve()
        })
      })
      return { port, hostKeyFingerprint }
    },
    async stop() {
      const srv = server
      if (srv === undefined) return
      server = undefined
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy()
        }, 1500)
        srv.close(() => {
          clearTimeout(timer)
          resolve()
        })
        for (const socket of sockets) socket.end()
      })
      if (tmpDir !== undefined) {
        rmSync(tmpDir, { recursive: true, force: true })
        tmpDir = undefined
      }
      clientPrivateKeyPath = undefined
      connectionCount = 0
      sftpChannelsOpened = 0
      sftpChannelsClosed = 0
      envRequests = 0
    },
  }
  return fixture
}
