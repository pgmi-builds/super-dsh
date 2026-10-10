import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { RemoteInput, PreparedRemoteInput } from './hub-contract.ts'

/** Local carrier validation precedes any target discovery, connection or spawn. */
export async function prepareRemoteInput(input: RemoteInput): Promise<PreparedRemoteInput> {
  if (input.mode !== undefined && input.mode !== 'oneshot' && input.mode !== 'pty')
    throw new Error('[E_BAD_MODE] remote: mode must be oneshot or pty')
  if (input.script !== undefined) {
    if (input.cmd !== undefined || input.stdin !== undefined || input.mode === 'pty' || input.spawn !== undefined || input.target?.startsWith('byop:'))
      throw new Error('[E_SCRIPT_PARAMS] remote: script is oneshot-only and cannot be combined with cmd, stdin, spawn or BYO-PTY')
    if (typeof input.script !== 'string' || !isAbsolute(input.script) || input.script.includes('\0'))
      throw new Error('[E_SCRIPT_PATH] remote: script must be a local absolute path without NUL')
  }
  if (!input.target) throw new Error('[E_PARAMS] remote: target is required; spawn requires a byop:<label> target')
  if (input.script !== undefined) {
    let stdin: string
    try { stdin = await readFile(input.script, 'utf8') }
    catch (error) { throw new Error(`[E_SCRIPT_READ] remote: cannot read local script ${JSON.stringify(input.script)} — ${error instanceof Error ? error.message : String(error)}`) }
    return { target: input.target, ssh: input.ssh, cmd: 'bash -s', stdin, mode: 'oneshot', timeout: input.timeout }
  }
  return { target: input.target, spawn: input.spawn, ssh: input.ssh, cmd: input.cmd ?? '', stdin: input.stdin, mode: input.mode, timeout: input.timeout }
}
