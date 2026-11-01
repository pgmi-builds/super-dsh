import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { RemoteInput, PreparedRemoteInput } from './hub-contract.ts'
import { shQuote } from './transports.ts'

/** Local carrier validation precedes any target discovery, connection or spawn. */
export async function prepareRemoteInput(input: RemoteInput): Promise<PreparedRemoteInput> {
  if (input.mode !== undefined && input.mode !== 'oneshot' && input.mode !== 'pty')
    throw new Error('[E_BAD_MODE] remote: mode must be oneshot or pty')
  if (input.scriptPath !== undefined) {
    if (input.cmd !== undefined || input.spawn !== undefined)
      throw new Error('[E_SCRIPT_PARAMS] remote: script and cmd are alternative carriers — pass one; spawn belongs to BYO PTY creation, not scripts')
    if (typeof input.scriptPath !== 'string' || !isAbsolute(input.scriptPath) || input.scriptPath.includes('\0'))
      throw new Error('[E_SCRIPT_PATH] remote: script must be a local absolute path without NUL')
  }
  if (!input.target && input.spawn === undefined && input.ssh === undefined)
    throw new Error('[E_PARAMS] remote: target is required (spawn / ssh are BYO entry points and may stand alone)')
  if (input.scriptPath !== undefined) {
    let script: string
    try { script = await readFile(input.scriptPath, 'utf8') }
    catch (error) { throw new Error(`[E_SCRIPT_READ] remote: cannot read local script ${JSON.stringify(input.scriptPath)} — ${error instanceof Error ? error.message : String(error)}`) }
    if (script.includes('\0'))
      throw new Error('[E_SCRIPT_NUL] remote: script contains NUL bytes — the command channel cannot carry it; transfer the file and run it with cmd instead')
    // spec remote-default-pty §1（F1/F2 修复，2026-11-01 独立复测）：载体 = bash -c + 单层机械引号（argv 通道，
    // 与 cmd 同一尺寸边界、同一远端解析纪律），业务 stdin 整体归脚本进程 fd0——脚本中途 read 读到的就是它。
    // 旧形状（bash -s + 脚本全文拼进 stdin）在 PTY 上使 bash 进入交互态永不结算、超时后残留 shell 接管会话；
    // oneshot 里脚本 read 会吃掉自己的下一行、业务 stdin 被当命令执行。PTY 中 -c 是普通子进程命令：
    // 跑完即结算（nonce 帧正常发出），cd/export 不泄漏父 shell。
    return { target: input.target, ssh: input.ssh, cmd: `bash -c ${shQuote(script)}`, stdin: input.stdin, mode: input.mode, timeout: input.timeout }
  }
  return { target: input.target, spawn: input.spawn, ssh: input.ssh, cmd: input.cmd ?? '', stdin: input.stdin, mode: input.mode, timeout: input.timeout }
}
