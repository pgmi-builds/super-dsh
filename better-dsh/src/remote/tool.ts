import { adoptRunningPtyJob, startRemoteJob } from './jobs.ts'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { RECONNECT_NOTICE } from './pty-session.ts'
import type { RemoteCallResult, RemoteDriver } from './driver.ts'
import type { StreamOutputStats } from './hub-contract.ts'
/** env delta 的结构类型（与 nonce-framing.EnvDelta 同构）：本文件不直接 import nonce-framing——
 * 那一行 import 会改变模块图解析顺序，触发 dsh-tools 类型双实例（TS2719，2026-10-19 实测定位）。 */
type EnvDelta = { added: string[]; changed: string[]; removed: string[] }

interface RemoteToolValue {
  kind: 'exec' | 'status' | 'roster' | 'job' | 'close' | 'input'
  receipt?: import('@deepseek-ai/dsh-util-values').JsonValue
  jobId?: string
  text: string
  exit: number | null
  durationMs: number
  cwd?: string
  stderr?: string
  timedOut?: boolean
  reconnected?: boolean
  truncated?: number
  outputStats?: StreamOutputStats
  outputStatsUnavailable?: boolean
  /** PTY workbench（§5.2）：session id（pty:pty-xxxx）→ label → connection → commandId。 */
  session?: string
  label?: string
  connection?: string
  byoTag?: string
  commandId?: string
  envDelta?: EnvDelta
  created?: boolean
  notice?: string
  /** oneshot 监督路径：`superd-run <ver> (<triple>)` 或 `posix-shim`。 */
  runner?: string
  /** P4/P5（2026-10-19）：pty 命令仍在前台运行（handoff 回执）；jobId 供 job_output/job_kill。 */
  running?: boolean
  /** 本 pty 会话 idle TTL 剩余（秒）；回执即状态快照（P2/P3）。 */
  ttlSec?: number
  /** close 回执（R2 复核 P1-3）：结构化结局，文本可保留。 */
  closed?: boolean
  reason?: string
  killed?: string[]
  /** input 回执（2026-10-25）：实际写入的 UTF-8 字节数；只确认写入，不承诺程序已读取。 */
  writtenBytes?: number
}

const NO_SESSION_KEY = 'remote:no-session'

/**
 * The model-visible surface of the `remote` tool (0.3.2-d user-ruled restructure:
 * Actions / Targets / PTY / Oneshot / Examples — the PTY block is the user's verbatim
 * final draft; Examples receipts match renderValue byte-for-byte).
 * ONE template literal — no backticks, no "${".
 *
 * 语义目标（surface 就是产品）：动作是唯一的派发维度；PTY 四词定位——stateful oneshot /
 * interact-able stdin / managed output / persistent env——回执形状与 oneshot 相同、只增状态，
 * 运行中的命令可分步观察后再补输（input 动作）；多步与交互任务默认进 PTY。
 */
const REMOTE_TOOL_DESCRIPTION = `Remote shell over ssh / docker / incus (Hub when configured): stateless oneshots + persistent interactive PTY sessions. Default to PTY for multi-step or interactive work; oneshot for isolated commands.

Actions (action is the only dispatch dimension; unknown fields are rejected):
- exec {target, cmd | scriptPath, stdin?, timeout?, run_in_background?}: run a command. Machine target → oneshot; pty:<id|label> → run inside that live session; <machine>:pty[:label] → create a NEW session and run there.
- add {ssh:{...} | spawn:"<cmd>", target?}: register a BYO endpoint (identity or interactive-shell command); no command runs. Returns the addressable label; a taken label answers [E_LABEL_IN_USE] — address existing names directly, never add again.
- status {}: roster — the one unified pool (machines, identities, live PTY sessions).
- status {target}: machine probe, or a session card (connection, cwd, ledger of the last 20 commands).
- input {target:"pty:<id|label>", stdin, commandId?}: write stdin into the command currently running in that session — passwords, OTP, tokens, menu choices, REPL lines. Never creates a session, never dials.
- close {target, force?}: close a PTY session; a running command refuses it (job_kill first) unless force:true kills it in the same step.

Targets:
- ssh:<name> / docker:<name> / incus:<name> / bare pool name → stateless oneshot.
- <machine>:pty[:label] → NEW PTY every call — creation is a target suffix, not a different tool.
- pty:<id|label> (or its bare label) → REUSE the live session.
After creation, reuse the returned session; repeating :pty opens another. Prefixes force the channel; bare names resolve through the roster.

PTY:
- stateful oneshot, interact-able stdin, managed output, persistent env
- timeout (default 120s) → command keeps running; returns job handle.
- run_in_background → same job lane. jobId = commandId.
- Read: job_output(jobId). Cancel: job_kill; try Ctrl-C first.
- Busy session: input / poll / cancel / use another session.
- exec.stdin = startup input; input = subsequent input.
- input is verbatim: "\\n" submits; "\\u0003" Ctrl-C; "\\u0004" Ctrl-D; "" writes nothing. Ctrl-D follows terminal EOF rules.
- commandId, if supplied, must match running command.
- Input receipt confirms write only; read result via SAME job.
- Output may truncate (~30k chars per read); redirect bulk output to files.
- Idle expiry: 15 min; running commands exempt.

Oneshot:
- stdout/stderr separate, exit code verbatim; no retained shell state. stdin is startup-only: there is no input after start — a prompt on a oneshot means cancel (job_kill) and switch to PTY. Heredocs and input redirection remain valid bulk-input alternatives.
- Supervision prefers a pinned superd-run helper cached on the endpoint (~/.cache/superd/run), falls back to a POSIX shim — the receipt field "runner" says which ran. Either way children are reaped on completion and the whole group is killed on timeout/cancel. The endpoint needs bash only — no Python.
- scriptPath (oneshot only): a LOCAL absolute script read before any dialing, sent literally over stdin to a fixed bash -s — the file carrier for multi-line scripts; pairs with neither cmd nor stdin.

Examples

Manage the persistent PTY session. One-shot style output, but stable: every command returns synchronously with exit, cwd, and an env delta.

No direct route to the endpoint? Compose the transport and land the session on the innermost machine — bring your own PTY. Here: borrow pc as a jump host to reach dev4.

remote { "action": "add", "spawn": "ssh -t pc ssh -t dev4", "target": "pty:dev4via" }

[session created — address it as pty:pty-irsq]
[pty:pty-irsq (dev4via) (byo-pty) · conn BYOP · idle-left ~15m · exit null · 0.0s]

remote { "action": "exec", "target": "pty:dev4via", "cmd": "hostname && sudo -n ss -tlnp | awk 'NR==1 || /LISTEN/' | head -5" }

dev4
State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      4096   127.0.0.1:45207     0.0.0.0:*            users:(("containerd",pid=1070,fd=14))
LISTEN 0      4096   127.0.0.1:2019      0.0.0.0:*            users:(("caddy",pid=5600,fd=4))
LISTEN 0      4096   127.0.0.1:19514     0.0.0.0:*            users:(("multica",pid=27030,fd=6))
LISTEN 0      4096   127.0.0.54:53       0.0.0.0:*             users:(("systemd-resolve",pid=26758,fd=17))
[pty:pty-irsq (dev4via) (byo-pty) · conn BYOP · cmd remote-0d89215d1cc64cdc · cwd /home/u1 · idle-left ~15m · exit 0 · 0.3s]

Reuse the same session for a long task — returns a jobId immediately; collect with job_output, cancel with job_kill:

remote { "action": "exec", "target": "pty:dev4via", "cmd": "for i in 1 2 3; do sleep 1; echo \\"tick $i\\"; done; echo done", "run_in_background": true }

Started remote-47676dff2c6443e8 on pty:pty-irsq (dev4via) (BYOP). Use job_output to read and job_kill to cancel; completion is reported by the host.

job_output { "job_id": "remote-47676dff2c6443e8", "wait": true }

tick 1
tick 2
tick 3
done
[status: completed, exit code: 0]

- Bring Your Own PTY fits when the endpoint has no direct route, or the connection/transport layer must be composed yourself (jump chains, docker exec, console servers).
- It also strips one or two shell-escaping layers — commands go straight to the innermost bash, quotes behave naturally.

Register once — the label enters the pool and works everywhere: exec, pty, copy, rsync. Worth it whenever more than one operation type is involved. Keys stay local-file references; nothing persisted.

remote { "action": "add", "ssh": { "host": "10.0.0.8", "user": "u1", "port": 22, "key": "/home/u1/.ssh/id_key4" }, "target": "ssh:lab" }
remote { "action": "exec", "target": "ssh:lab", "cmd": "uname -a" }
remote_transfer { "mode": "rsync", "src": "ssh:lab:/var/log/app/", "dst": "/home/u1/app-logs/", "argv": ["-a"] }`

/**
 * execute 实现放独立函数 + 结构类型（RemoteArgs/ExecLike）：defineTool 字面量与 typert
 * 生成类型的组合下，直接引用上游类型会触发 dsh-tools 双实例身份冲突（TS2719，
 * 2026-10-19 实测多轮二分；schema×execute×import 链组合触发，无单一根因）。
 * 运行时语义不变——字面量里的 execute 只是三行委托。
 */
interface RemoteArgs {
  action?: 'exec' | 'add' | 'close' | 'status' | 'input'
  target?: string
  cmd?: string
  stdin?: string
  scriptPath?: string
  timeout?: number
  run_in_background?: boolean
  ssh?: { host: string; user?: string; port?: number; key?: string; proxyJump?: string }
  spawn?: string
  force?: boolean
  /** input 专用：可选的运行命令匹配保护（来自 exec 回执 / job_output）。 */
  commandId?: string
}
type ExecLike = { signal: AbortSignal; agent?: { id: string; ctx: { get(key: 'jobs'): unknown } } }
/** 结构性 JobRegistry（与 dsh-jobs 同构）：与 ExecLike 一起隔离上游类型身份。 */
type JobRegistryLike = import('@deepseek-ai/dsh-jobs').JobRegistry

type Action = NonNullable<RemoteArgs['action']>

/** action 是唯一派发维度：每个动词声明自己的字段集，超出即报错（不做在场推断、不留别名）。 */
const ACTION_PARAMS: Record<Action, ReadonlySet<string>> = {
  exec: new Set(['action', 'target', 'cmd', 'stdin', 'scriptPath', 'timeout', 'run_in_background']),
  add: new Set(['action', 'target', 'ssh', 'spawn']),
  status: new Set(['action', 'target']),
  close: new Set(['action', 'target', 'force']),
  input: new Set(['action', 'target', 'stdin', 'commandId']),
}

const ACTION_HINT: Record<Action, string> = {
  exec: 'exec takes target plus cmd (or scriptPath) and the execution options; ssh/spawn belong to add',
  add: 'add takes exactly one of ssh or spawn, plus an optional target label',
  status: 'status takes only an optional target — omit it for the roster',
  close: 'close takes target pty:<id|label> and optional force',
  input: 'input takes target (a live PTY session), stdin, and an optional commandId guard — no cmd, no timeout, no creation',
}

async function remoteExecute(ENV: { driver: RemoteDriver; getSessionKey: (exec: ExecLike) => string }, args: RemoteArgs, exec: ExecLike): Promise<RemoteToolValue> {
  const action = args.action
  if (action === undefined) throw new Error('[E_PARAMS] remote: action is required — "exec" (run a command), "add" (register a BYO endpoint), "status" (roster / probe / session card), "close" (close a PTY session), "input" (append stdin to a running PTY command)')
  const allowed = ACTION_PARAMS[action]
  if (allowed === undefined) throw new Error(`[E_PARAMS] remote: unknown action ${JSON.stringify(String(action))} — one of exec / add / close / status / input`)
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error(`[E_PARAMS] remote: "${key}" does not belong to action "${action}" — ${ACTION_HINT[action]}`)
  }
  const sessionKey = ENV.getSessionKey(exec)
  const hasTarget = typeof args.target === 'string' && args.target.length > 0
  const hasCmd = typeof args.cmd === 'string' && args.cmd.length > 0

  if (action === 'status') {
    if (!hasTarget) return { kind: 'roster', text: await ENV.driver.roster({ sessionKey }), exit: null, durationMs: 0 }
    return { kind: 'status', text: await ENV.driver.status(args.target as string, { sessionKey }), exit: null, durationMs: 0 }
  }

  if (action === 'close') {
    if (!hasTarget) throw new Error('[E_PARAMS] close requires target pty:<id|label>')
    const r = ENV.driver.closePty((args.target as string).startsWith('pty:') ? (args.target as string).slice(4) : (args.target as string), sessionKey, args.force === true)
    const text = r.closed
      ? `closed ${r.session} (${r.connection})${r.killed.length > 0 ? ` — killed running job ${r.killed.join(', ')}` : ''}`
      : `${r.session}: not closed (${r.reason}) — ${r.message ?? 'no live session'}`
    return { kind: 'close', text, exit: null, durationMs: 0, session: r.session, closed: r.closed, ...(r.reason !== undefined ? { reason: r.reason } : {}), killed: r.killed }
  }

  // —— action === 'input'（2026-10-25）：只写已有 PTY 的运行中命令，不创建、不重连、不改期限 ——
  if (action === 'input') {
    if (!hasTarget) throw new Error('[E_PARAMS] remote: action "input" requires target — the live PTY session whose command is waiting (pty:<id|label> or its bare label)')
    if (args.stdin === undefined) throw new Error('[E_PARAMS] remote: action "input" requires stdin — the exact text to append; include a trailing \\n to submit a line, "\\u0003" for Ctrl-C, "\\u0004" for Ctrl-D ("" = zero bytes, not EOF)')
    if (typeof args.commandId === 'string' && args.commandId.length === 0) throw new Error('[E_PARAMS] remote: input: commandId, when given, must be the non-empty id from the exec receipt / job_output')
    const r = await ENV.driver.input(args.target as string, { stdin: args.stdin as string, ...(args.commandId !== undefined ? { commandId: args.commandId } : {}) }, { sessionKey })
    const handle = r.jobId ?? r.commandId
    return {
      kind: 'input', text: `wrote ${r.writtenBytes} byte${r.writtenBytes === 1 ? '' : 's'} into ${r.session} for command ${r.commandId} — this confirms the write, not the program's response; read the response with job_output ${handle}`,
      exit: null, durationMs: 0, session: r.session, connection: r.connection, ...(r.label !== undefined ? { label: r.label } : {}),
      commandId: r.commandId, ...(r.jobId !== undefined ? { jobId: r.jobId } : {}), writtenBytes: r.writtenBytes,
    }
  }

  if (action === 'add') {
    const hasSpawn = typeof args.spawn === 'string' && args.spawn.length > 0
    if (args.spawn !== undefined && !hasSpawn) throw new Error('[E_PARAMS] remote: add: spawn must be a non-empty command string')
    if (args.ssh === undefined && !hasSpawn) throw new Error('[E_PARAMS] remote: action "add" registers a BYO endpoint — pass ssh:{host,...} (identity) or spawn:"<command>" (PTY), exactly one')
    if (args.ssh !== undefined && hasSpawn) throw new Error('[E_PARAMS] remote: add: ssh and spawn are two different BYO entry points — pass one, not both')
    // 注册/预热只占池，不跑命令：cmd 恒为空串，回执给出后续可寻址的名字。
    const r = await ENV.driver.call({ ...(hasTarget ? { target: args.target } : {}), ...(args.ssh === undefined ? {} : { ssh: args.ssh }), ...(hasSpawn ? { spawn: args.spawn } : {}), cmd: '' }, { sessionKey })
    const v = workbenchValue(r)
    v.created = true
    // ssh 身份注册只有这条 notice 可教寻址；spawn 创建的回执已有 [session created] 行 +
    // 身份标记（0.3.2-d：不再叠加 registered notice——"ssh alias" 措辞对 pty 本就不通）。
    if (!hasSpawn) v.notice = `registered — address it as ${r.session ?? r.target} from now on (the label, id and ssh alias all work)`
    return v
  }

  // —— action === 'exec' ——
  if (!hasTarget) throw new Error('[E_PARAMS] remote: action "exec" requires target — a machine (ssh:dev4, docker:corti, hub:<m4>, a pool name) or a PTY session (pty:<id|label>, a bare label, or <machine>:pty[:label] to create one). Status probes and the roster live under action "status".')
  const target = args.target as string
  const ptyTarget = /^pty:/.test(target) || /:pty(:|$)/.test(target)
  if (args.scriptPath !== undefined) {
    if (args.scriptPath.length === 0) throw new Error('[E_PARAMS] remote: scriptPath must be a non-empty absolute path')
    if (ptyTarget) throw new Error('[E_SCRIPT_PARAMS] remote: scriptPath is oneshot-only — PTY lanes take cmd')
    if (hasCmd) throw new Error('[E_SCRIPT_PARAMS] remote: scriptPath and cmd are alternative carriers — pass one')
    if (args.stdin !== undefined) throw new Error('[E_SCRIPT_PARAMS] remote: scriptPath already occupies stdin — do not pass stdin with it')
  }
  if (args.stdin !== undefined && !hasCmd) throw new Error('[E_STDIN_WITHOUT_CMD] remote: exec stdin is startup input and requires cmd — to feed a command that is already running in a PTY, use {action:"input", target:"pty:<id|label>", stdin}')
  if (!hasCmd && args.scriptPath === undefined) throw new Error('[E_PARAMS] remote: action "exec" must execute something — pass cmd, or scriptPath for a local script file')

  if (args.run_in_background) {
    const jobs = exec.agent?.ctx.get('jobs') as unknown as JobRegistryLike | undefined
    if (!jobs) throw new Error('remote: background requires the official DSH jobs service and job_output/job_kill controller; foreground execution remains available')
    // PTY lane：先把会话占位（不拨号），回执才能给出可寻址的 session/connection（R2 复核 P1-4）。
    const lane = await ENV.driver.preparePtyLane({ target: args.target, cmd: args.cmd, scriptPath: args.scriptPath, stdin: args.stdin, timeout: args.timeout }, { sessionKey })
    let jobId: string
    try {
      jobId = startRemoteJob(jobs as JobRegistry, lane !== undefined
        ? lane.input
        : { target: args.target, cmd: args.cmd, scriptPath: args.scriptPath, stdin: args.stdin, timeout: args.timeout }, exec as never, ENV.driver)
    } catch (error) {
      lane?.cleanup()
      throw error
    }
    const where = lane === undefined ? '' : ` on ${lane.session}${lane.label !== undefined ? ` (${lane.label})` : ''} (${lane.connection})`
    return {
      kind: 'job', jobId, exit: null, durationMs: 0,
      text: `Started ${jobId}${where}. Use job_output to read and job_kill to cancel; completion is reported by the host.`,
      ...(lane !== undefined ? { commandId: jobId, session: lane.session, connection: lane.connection, ...(lane.label !== undefined ? { label: lane.label } : {}) } : {}),
    }
  }

  const r: RemoteCallResult = await ENV.driver.call(
    { target: args.target, cmd: args.cmd, scriptPath: args.scriptPath, stdin: args.stdin, timeout: args.timeout },
    { sessionKey },
  )
  const v = workbenchValue(r)
  if (r.running === true && r.ptyJob !== undefined) {
    const jobs = exec.agent?.ctx.get('jobs') as unknown as JobRegistryLike | undefined
    if (jobs) {
      const jobId = adoptRunningPtyJob(jobs as JobRegistry, exec as never, `${r.target}: ${args.cmd}`, r.ptyJob)
      v.jobId = jobId
      v.running = true
      if (r.commandId !== undefined && jobId !== r.commandId) ENV.driver.attachPtyJob(r.commandId, jobId, sessionKey)
    } else {
      r.ptyJob.interrupt()
      v.notice = 'The command outlived its synchronous wait and no jobs service is available to poll it, so it was interrupted. Use run_in_background:true for long commands.'
    }
  }
  return v
}

export function createRemoteTool(
  driver: RemoteDriver,
  opts: { getSessionKey?: (exec: ToolRunContext) => string } = {},
): ToolDefinition {
  const getSessionKey = opts.getSessionKey ?? ((exec: ToolRunContext) => exec.agent?.id ?? NO_SESSION_KEY)
  const tool = defineTool({
    name: 'remote',
    description: REMOTE_TOOL_DESCRIPTION,

    parameters: {
      action: { type: 'string', enum: ['exec', 'add', 'status', 'close', 'input'], required: true, description: 'Required. exec = run a command (oneshot on a machine, or inside a PTY session); add = register a BYO ssh identity or BYO PTY into the pool; status = roster (no target) or probe/session card (target); close = close a PTY session; input = append stdin to the command currently running in a live PTY session.' },
      target: { type: 'string', description: 'exec: required. A machine (bare pool name, ssh:<name>, docker:<name>, incus:<name>, hub:<m4>), a live PTY session (pty:<id|label> or its bare label), or a machine with :pty[:label] to create a new session (ssh:dev4:pty, hub:<m4>:pty, ssh:dev4:pty:build). add: optional label for the BYO entry. status: optional — omit for the roster. close / input: pty:<id|label> (input never creates or dials — the session must already run the command).' },

      cmd: { type: 'string', description: "exec: one raw shell string parsed by the remote bash (multi-line = one compound; exit = last command's). Required unless scriptPath is given." },
      stdin: { type: 'string', description: 'exec: startup input fed to cmd — oneshot: piped to stdin; pty: written right after the command line (REPL-style); requires cmd. input: the exact text to append to the RUNNING command — "" writes zero bytes (not EOF); include "\\n" to submit a line; "\\u0003" = Ctrl-C, "\\u0004" = Ctrl-D as raw characters.' },
      commandId: { type: 'string', description: 'input only: optional guard — when given it must equal the running command\'s id (from the exec receipt or job_output); a stale id refuses the write instead of feeding the next command. Ignored by other actions.' },
      timeout: { type: 'number', description: 'exec: per-command timeout in seconds (default 120). oneshot: interrupts then kills the whole group. pty: the command is NOT killed on timeout — it hands off to a running job you can poll (job_output) and cancel (job_kill = Ctrl-C first; the session survives an interrupt).' },
      run_in_background: { type: 'boolean', description: 'exec: oneshot AND pty — return a native jobId immediately, read with job_output, cancel with job_kill; output is available while running. On pty lanes the jobId IS the commandId — it tracks the running command inside a persistent session; job_kill sends Ctrl-C and the session survives. Requires the official jobs service/controller.' },
      ssh: { type: 'object', description: 'add: BYO ssh identity to register into the pool (no dialing). Later exec calls address the returned label. No inline keys or arbitrary SSH options; nothing is persisted — a new Agent registers again.', additionalProperties: false, properties: {
        host: { type: 'string', required: true, description: 'SSH hostname, IP or native config alias.' },
        user: { type: 'string', description: 'Login user; omitted preserves native SSH config.' },
        port: { type: 'integer', description: 'SSH port 1–65535; omitted preserves native SSH config.' },
        key: { type: 'string', description: 'Existing origin private-key file path, not key contents; never copied or persisted.' },
        proxyJump: { type: 'string', description: 'Official ProxyJump: comma-separated [user@]host[:port] or native aliases; jump identity remains in origin SSH config.' },
      } },
      spawn: { type: 'string', description: 'add: BYO PTY entry point — the full command that starts an interactive shell (e.g. "docker exec -it img bash"). Pairs with target pty[:<label>] / a bare <label> / nothing (auto id). Nested hops are dumb pipes (only the innermost bash frames).' },
      force: { type: 'boolean', description: 'close only: default false — a session with a running job is refused (job_kill it first). true = kill the group and close in one step; the receipt lists what was killed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['exec', 'status', 'roster', 'job', 'close', 'input'] },
          text: { type: 'string', required: true },
          jobId: { type: 'string' },
          receipt: { type: 'json' },
          exit: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          durationMs: { type: 'integer' },
          cwd: { type: 'string' },
          stderr: { type: 'string' },
          timedOut: { type: 'boolean' },
          reconnected: { type: 'boolean' },
          truncated: { type: 'integer' },
          outputStats: { type: 'json' },
          outputStatsUnavailable: { type: 'boolean' },
          session: { type: 'string', description: 'pty session id, e.g. pty:pty-7k2m' },
          label: { type: 'string' },
          connection: { type: 'string', description: 'underlying connection: ssh:dev4 / docker:c / incus:x / hub:m4 / BYOP' },
          byoTag: { type: 'string' },
          commandId: { type: 'string', description: 'ledger key; equals the jobId whenever a job exists' },
          writtenBytes: { type: 'integer', description: 'input: UTF-8 bytes actually written; confirms the write, not the program response' },
          envDelta: { type: 'json', description: 'names only: {added,changed,removed}' },
          created: { type: 'boolean' },
          notice: { type: 'string' },
          runner: { type: 'string', description: 'oneshot supervision path: superd-run <ver> (<triple>), posix-shim, or hub-lease (peer hub server supervises natively)' },
          running: { type: 'boolean' },
          ttlSec: { type: 'integer' },
          closed: { type: 'boolean', description: 'close: true = the session is gone now' },
          reason: { type: 'string', description: 'close: not-found / already-closed-or-reaped' },
          killed: { type: 'array', items: { type: 'string' }, description: 'close force: the running commandIds that were killed' },
        },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: renderValue(value as RemoteToolValue) }],
    },
    async execute(args, exec) {
      return remoteExecute({ driver, getSessionKey: getSessionKey as unknown as (e: ExecLike) => string }, args as unknown as RemoteArgs, exec as unknown as ExecLike)
    },
  })
  const description = tool.description
  Object.defineProperty(tool, 'description', { enumerable: true, get: () => description + (driver.hasHub() ? '\nHub transport available: hub:<m4> selects a paired remote machine (never self; the roster lists them). Hub failures never fall back to SSH.\n- hub:<m4> oneshot: the peer hub server is the runner itself — bash -lc in a detached group, TERM→2s→KILL cleanup; the receipt runner field says "hub-lease" (the superd-run helper is a dumb-pipe artifact, never uploaded over the Hub). Inline cmd is limited to 4096 chars; scriptPath is the file carrier and is not argv.\n- hub:<m4>:pty[:label] opens the SAME persistent interactive session as every other transport — id, label, input, busy, timeout handoff, background, close, session card, ledger, idle TTL, quota — carried by a local pump child over one authenticated WebSocket to the peer terminal.' : '') })
  return tool
}

/** RemoteCallResult → RemoteToolValue（pty 工作台字段 + 既有字段）。 */
function workbenchValue(r: RemoteCallResult): RemoteToolValue {
  const v: RemoteToolValue = { kind: 'exec', text: r.stdout, exit: r.exit, durationMs: r.durationMs }
  if (r.cwd !== null && r.cwd !== undefined) v.cwd = r.cwd
  if (r.stderr !== undefined) v.stderr = r.stderr
  if (r.timedOut) v.timedOut = true
  if (r.reconnected) v.reconnected = true
  if (r.truncated !== undefined) v.truncated = r.truncated
  if (r.outputStats !== undefined) v.outputStats = r.outputStats
  if (r.outputStatsUnavailable) v.outputStatsUnavailable = true
  if (r.session !== undefined) v.session = r.session
  if (r.label !== undefined) v.label = r.label
  if (r.connection !== undefined) v.connection = r.connection
  if (r.byoTag !== undefined) v.byoTag = r.byoTag
  if (r.commandId !== undefined) v.commandId = r.commandId
  if (r.envDelta !== undefined) v.envDelta = r.envDelta
  if (r.created === true) v.created = true
  if (r.notice !== undefined) v.notice = r.notice
  if (r.runner !== undefined) v.runner = r.runner
  if (r.ttlSec !== undefined) v.ttlSec = r.ttlSec
  return v
}

function renderEnvDelta(d: EnvDelta): string | undefined {
  const bits: string[] = []
  if (d.added.length > 0) bits.push(`+${d.added.join(',+')}`)
  if (d.changed.length > 0) bits.push(`~${d.changed.join(',~')}`)
  if (d.removed.length > 0) bits.push(`-${d.removed.join(',-')}`)
  return bits.length > 0 ? bits.join(' ') : undefined
}

function renderValue(v: RemoteToolValue): string {
  if (v.kind === 'status' || v.kind === 'roster' || v.kind === 'job' || v.kind === 'close' || v.kind === 'input') return v.text
  const parts: string[] = []
  if (v.reconnected === true) parts.push(RECONNECT_NOTICE)
  if (typeof v.notice === 'string' && v.notice.length > 0) parts.push(v.notice)
  if (v.created === true && v.session !== undefined) parts.push(`[session created — address it as ${v.session}]`)
  parts.push(v.text)
  const secs = ((v.durationMs ?? 0) / 1_000).toFixed(1)
  // §5.2 回执字段序（R2 对齐）：session → connection → commandId → cwd/env/ttl → exit/duration → 异常尾注。
  const markers: string[] = []
  if (typeof v.session === 'string' && v.session.length > 0) markers.push(`${v.session}${typeof v.label === 'string' && v.label.length > 0 ? ` (${v.label})` : ''}${v.byoTag !== undefined ? ` (${v.byoTag})` : ''}`)
  if (typeof v.connection === 'string' && v.connection.length > 0 && v.session !== undefined) markers.push(`conn ${v.connection}`)
  if (typeof v.commandId === 'string' && v.commandId.length > 0) markers.push(`cmd ${v.commandId}`)
  if (typeof v.cwd === 'string' && v.cwd.length > 0) markers.push(`cwd ${v.cwd}`)
  const envTag = v.envDelta !== undefined ? renderEnvDelta(v.envDelta) : undefined
  if (envTag !== undefined) markers.push(`env ${envTag}`)
  if (typeof v.ttlSec === 'number') markers.push(`idle-left ~${Math.max(1, Math.round(v.ttlSec / 60))}m`)
  if (typeof v.runner === 'string' && v.runner.length > 0) markers.push(`runner ${v.runner}`)
  if (v.timedOut === true) markers.push('interrupted')
  markers.push(`exit ${v.exit}`)
  markers.push(`${secs}s`)
  if (v.running === true) markers.push(`still running — poll job_output${v.jobId !== undefined ? ` ${v.jobId}` : ''}`)
  if (v.truncated !== undefined) markers.push(`truncated, ${v.outputStatsUnavailable ? 'returned peer tail' : 'original'} ${v.truncated} ${v.outputStats?.stdout.unit === 'bytes' ? 'bytes' : 'chars'}`)
  if (v.outputStatsUnavailable) markers.push('peer output totals/retention unavailable; returned tail only')
  parts.push(`[${markers.join(' · ')}]`)
  if (v.runner === 'posix-shim' && ((v.exit !== null && v.exit !== 0) || v.timedOut === true))
    parts.push('note: this oneshot ran through the POSIX fallback on this target; PTY lanes use an independent lane and may still work here')
  if (v.stderr !== undefined && v.stderr.length > 0) parts.push('[stderr]', v.stderr)
  return parts.join('\n')
}
