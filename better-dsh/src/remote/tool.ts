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
  kind: 'exec' | 'handoff' | 'status' | 'roster' | 'job' | 'close' | 'input'
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
const REMOTE_TOOL_DESCRIPTION = `Remote shell over ssh / docker / incus (Hub when configured): one reusable default interactive PTY per machine, plus oneshot for isolated commands.

Actions (action is the only dispatch dimension; unknown fields are rejected):
- exec {target, cmd | scriptPath, stdin?, mode?:"pty"|"oneshot"="pty", timeout?, run_in_background?}: run a command, or a raw stdin write. Machine target = its default PTY (retains cwd/env across calls; lazily opened, fresh after handoff/close/expiry). mode:"oneshot" = isolated, stateless. PTY stdin alone (no cmd/scriptPath) = raw write into the command currently running in that PTY (exact bytes; optional commandId guard rejects stale writes).
- handoff {target:<machine>}: detach the machine's default PTY as an addressable pty:<id> — at any time (fresh creates an idle shell first; busy carries the running command with it). The machine's next exec opens a fresh default.
- add {ssh:{...} | spawn:"<cmd>", target?}: register a BYO endpoint (identity or interactive-shell command); no command runs. Returns the addressable label; a taken label answers [E_LABEL_IN_USE] — address existing names directly, never add again.
- status {}: roster — the one unified pool (machines, identities, live PTY sessions incl. defaults).
- status {target}: machine probe (with its default PTY state), or a session card (connection, cwd, running command).
- close {target, force?}: close a PTY shell — a machine target closes only its default PTY; pty:<id|label> closes that session. A running command refuses close unless force:true (interrupts and closes in one step); cancelling a running command is job_kill's job — close takes no job id.

Targets:
- ssh:<n> / docker:<n> / incus:<n> / bare pool name -> the machine's default PTY (mode:"oneshot" for a stateless run).
- pty:<id|label> (or its bare label) -> REUSE the live session (from handoff, background, or add {spawn}).
Prefixes force the channel; bare names resolve through the roster.

PTY:
- stateful oneshot, interact-able stdin, managed output, persistent env
- timeout (default 120s) = the sync wait limit: the command is NOT killed — it hands off to a running job you can poll (job_output) and cancel (job_kill = Ctrl-C first; the session survives).
- run_in_background = the command went async (not bash &): a job handle returns immediately and a completion notification will follow — no polling required. On a default PTY the framed command starts and that PTY is handed off in the same operation; on an addressable PTY it stays in its session. job_output reads the command's full stream from byte 0 (overlap with a pre-handoff receipt is expected); job_kill cancels. Known defect: startup stdin is NOT reliably delivered to a background command — run stdin-consuming commands in the FOREGROUND (or background WITHOUT stdin, then feed stdin-only writes to the session; those are reliable).
- Busy PTY rejects new cmds (feed it stdin / poll / cancel / handoff it / use another session / oneshot).
- exec.stdin with a command = startup input (REPL-style; with scriptPath it is the script process's own stdin); stdin alone = raw write; verbatim always: "\\n" submits; "\\u0003" Ctrl-C; "\\u0004" Ctrl-D; "" writes zero bytes. After a raw "\\u0003" the adopted job stays running — settle it with job_kill.
- Output returns in full up to retention (4M chars per stream; Hub oneshot 4MiB bytes) — beyond it the retained tail plus outputStats. Redirect bulk output to files.
- Idle expiry: 15 min; running commands exempt.

Oneshot:
- stdout/stderr separate, exit code verbatim, no retained shell state. stdin is startup-only — a prompt on a oneshot means cancel (job_kill) and switch to PTY.
- Supervision prefers a pinned superd-run helper cached on the endpoint (~/.cache/superd/run), falls back to a POSIX shim — the receipt field "runner" says which ran. Either way children are reaped and the whole group is killed on timeout/cancel. The endpoint needs bash only — no Python.
- scriptPath: a LOCAL absolute script read before any dialing and carried as ONE bash -c command (same quoting/size discipline as cmd) — the file carrier for multi-line scripts. Your stdin is the script process's own input (a read inside the script gets exactly your bytes). Works in oneshot and PTY alike; in a PTY it runs as a child command that settles on its own (cd/export never affect the parent shell).

Examples

A machine's default PTY — consecutive calls share one shell (cwd/env persist):

remote { "action": "exec", "target": "ssh:dev4", "cmd": "cd /srv/app && pwd" }

/srv/app
[pty:pty-irsq · conn ssh:dev4 · cmd remote-0d89215d1cc64cdc · cwd /srv/app · idle-left ~15m · exit 0 · 0.3s]

A long task went async on the default PTY — the same operation hands the PTY off; collect or cancel, the completion notice arrives by itself:

remote { "action": "exec", "target": "ssh:dev4", "cmd": "make test", "run_in_background": true }

Started remote-47676dff2c6443e8 on pty:pty-irsq (ssh:dev4). Use job_output to read and job_kill to cancel; completion is reported by the host.

remote { "action": "handoff", "target": "ssh:dev4" }

handed off pty:pty-irsq — ssh:dev4
detached
this machine's next exec opens a fresh default PTY

Answer a prompt inside a running command (raw write; the guard rejects writes aimed at an earlier command):

remote { "action": "exec", "target": "pty:pty-irsq", "stdin": "yes\n", "commandId": "remote-47676dff2c6443e8" }

An isolated, stateless one-off:

remote { "action": "exec", "target": "ssh:dev4", "mode": "oneshot", "cmd": "uname -a" }

No direct route to the endpoint? Compose the transport and land the session on the innermost machine — bring your own PTY. Here: borrow pc as a jump host to reach dev4.

remote { "action": "add", "spawn": "ssh -t pc ssh -t dev4", "target": "pty:dev4via" }

[session created — address it as pty:pty-irsq]

remote { "action": "exec", "target": "pty:dev4via", "cmd": "hostname" }

- BYO PTY fits when the endpoint has no direct route, or the connection/transport layer must be composed yourself (jump chains, docker exec, console servers). It also strips one or two shell-escaping layers — commands go straight to the innermost bash.
- Register an ssh identity once — the label enters the pool and works everywhere: exec, copy, rsync. Keys stay local-file references; nothing persisted.

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
  action?: 'exec' | 'handoff' | 'add' | 'close' | 'status'
  target?: string
  cmd?: string
  stdin?: string
  scriptPath?: string
  timeout?: number
  run_in_background?: boolean
  /** spec remote-default-pty：exec 执行形态；默认 pty（machine = 默认槽），oneshot 显式无状态。 */
  mode?: 'oneshot' | 'pty'
  ssh?: { host: string; user?: string; port?: number; key?: string; proxyJump?: string }
  spawn?: string
  force?: boolean
  /** exec stdin-only（raw write）专用：可选的运行命令匹配保护（来自 exec 回执 / job_output）。 */
  commandId?: string
}
type ExecLike = { signal: AbortSignal; agent?: { id: string; ctx: { get(key: 'jobs'): unknown } } }
/** 结构性 JobRegistry（与 dsh-jobs 同构）：与 ExecLike 一起隔离上游类型身份。 */
type JobRegistryLike = import('@deepseek-ai/dsh-jobs').JobRegistry

type Action = NonNullable<RemoteArgs['action']>

/** action 是唯一派发维度：每个动词声明自己的字段集，超出即报错（不做在场推断、不留别名）。 */
const ACTION_PARAMS: Record<Action, ReadonlySet<string>> = {
  exec: new Set(['action', 'target', 'cmd', 'stdin', 'scriptPath', 'timeout', 'run_in_background', 'mode', 'commandId']),
  handoff: new Set(['action', 'target']),
  add: new Set(['action', 'target', 'ssh', 'spawn']),
  status: new Set(['action', 'target']),
  close: new Set(['action', 'target', 'force']),
}

const ACTION_HINT: Record<Action, string> = {
  exec: 'exec takes target plus cmd (or scriptPath, or stdin alone as a raw write into the running command) and the execution options; ssh/spawn belong to add',
  handoff: 'handoff takes exactly one field besides action: target — the machine whose default PTY becomes pty:<id>',
  add: 'add takes exactly one of ssh or spawn, plus an optional target label',
  status: 'status takes only an optional target — omit it for the roster',
  close: 'close takes a target (machine = its default PTY, or pty:<id|label>) and optional force — never a job id; cancel jobs with job_kill',
}

async function remoteExecute(ENV: { driver: RemoteDriver; getSessionKey: (exec: ExecLike) => string }, args: RemoteArgs, exec: ExecLike): Promise<RemoteToolValue> {
  const action = args.action
  if (action === undefined) throw new Error('[E_PARAMS] remote: action is required — "exec" (run a command or raw stdin write), "handoff" (detach a machine default PTY), "add" (register a BYO endpoint), "status" (roster / probe / session card), "close" (close a PTY shell)')
  const allowed = ACTION_PARAMS[action]
  if (allowed === undefined) throw new Error(`[E_PARAMS] remote: unknown action ${JSON.stringify(String(action))} — one of exec / handoff / add / close / status`)
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

  // —— action === 'handoff'（spec remote-default-pty §1）：默认槽解绑成 pty:<id> ——
  if (action === 'handoff') {
    if (!hasTarget) throw new Error('[E_PARAMS] remote: action "handoff" requires target — the machine whose default PTY becomes an addressable pty:<id> (ssh:dev4, docker:c, hub:<m4>, or a bare pool name)')
    const r = await ENV.driver.handoff(args.target as string, { sessionKey })
    return {
      kind: 'handoff', text: r.stdout, exit: null, durationMs: 0,
      session: r.session, connection: r.connection, ...(r.label !== undefined ? { label: r.label } : {}),
      ...(r.cwd !== null && r.cwd !== undefined ? { cwd: r.cwd } : {}),
      ...(r.created === true ? { created: true } : {}),
      ...(r.running === true && r.commandId !== undefined ? { running: true, commandId: r.commandId } : {}),
      ...(r.ttlSec !== undefined ? { ttlSec: r.ttlSec } : {}),
    }
  }

  if (action === 'close') {
    if (!hasTarget) throw new Error('[E_PARAMS] close requires target — a machine (closes its default PTY) or pty:<id|label>')
    const r = await ENV.driver.close(args.target as string, sessionKey, args.force === true)
    const text = r.closed
      ? `closed ${r.session} (${r.connection})${r.killed.length > 0 ? ` — killed running job ${r.killed.join(', ')}` : ''}`
      : `${r.session}: not closed (${r.reason}) — ${r.message ?? 'no live session'}`
    return { kind: 'close', text, exit: null, durationMs: 0, session: r.session, closed: r.closed, ...(r.reason !== undefined ? { reason: r.reason } : {}), killed: r.killed }
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
  if (args.commandId !== undefined && args.commandId.length === 0)
    throw new Error('[E_PARAMS] remote: commandId, when given, must be the non-empty id from the exec receipt / job_output')
  if (args.scriptPath !== undefined) {
    if (args.scriptPath.length === 0) throw new Error('[E_PARAMS] remote: scriptPath must be a non-empty absolute path')
    if (hasCmd) throw new Error('[E_SCRIPT_PARAMS] remote: scriptPath and cmd are alternative carriers — pass one')
  }
  if (args.commandId !== undefined && (hasCmd || args.scriptPath !== undefined))
    throw new Error('[E_PARAMS] remote: commandId guards a raw stdin write (stdin alone, no cmd/scriptPath) — drop it for a normal command')

  // —— exec stdin-only（spec §1）：向该 PTY 当前运行命令的 raw write ——
  if (args.stdin !== undefined && !hasCmd && args.scriptPath === undefined) {
    if (args.mode === 'oneshot')
      throw new Error('[E_STDIN_WITHOUT_CMD] remote: oneshot has no interactive lane — stdin without cmd/scriptPath is a raw write into a PTY running command; drop mode:"oneshot" (or pass cmd)')
    if (args.run_in_background === true)
      throw new Error('[E_PARAMS] remote: a raw stdin write cannot go background — it writes the command currently running in that PTY; follow it with job_output instead')
    const r = await ENV.driver.input(target, { stdin: args.stdin as string, ...(args.commandId !== undefined ? { commandId: args.commandId } : {}) }, { sessionKey })
    const handle = r.jobId ?? r.commandId
    return {
      kind: 'input', text: `wrote ${r.writtenBytes} byte${r.writtenBytes === 1 ? '' : 's'} into ${r.session} for command ${r.commandId} — this confirms the write, not the program's response; read the response with job_output ${handle}`,
      exit: null, durationMs: 0, session: r.session, connection: r.connection, ...(r.label !== undefined ? { label: r.label } : {}),
      commandId: r.commandId, ...(r.jobId !== undefined ? { jobId: r.jobId } : {}), writtenBytes: r.writtenBytes,
    }
  }
  if (!hasCmd && args.scriptPath === undefined)
    throw new Error('[E_PARAMS] remote: action "exec" must execute something — pass cmd, or scriptPath for a local script file, or stdin alone for a raw write into a PTY running command')

  if (args.run_in_background) {
    const jobs = exec.agent?.ctx.get('jobs') as unknown as JobRegistryLike | undefined
    if (!jobs) throw new Error('remote: background requires the official DSH jobs service and job_output/job_kill controller; foreground execution remains available')
    // PTY lane：先把会话占位（不拨号），回执才能给出可寻址的 session/connection（R2 复核 P1-4）。
    const lane = await ENV.driver.preparePtyLane({ target: args.target, cmd: args.cmd, scriptPath: args.scriptPath, stdin: args.stdin, timeout: args.timeout, ...(args.mode !== undefined ? { mode: args.mode } : {}) }, { sessionKey })
    let jobId: string
    try {
      jobId = startRemoteJob(jobs as JobRegistry, lane !== undefined
        ? lane.input
        : { target: args.target, cmd: args.cmd, scriptPath: args.scriptPath, stdin: args.stdin, timeout: args.timeout, ...(args.mode !== undefined ? { mode: args.mode } : {}) }, exec as never, ENV.driver)
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
    { target: args.target, cmd: args.cmd, scriptPath: args.scriptPath, stdin: args.stdin, timeout: args.timeout, ...(args.mode !== undefined ? { mode: args.mode } : {}) },
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
      action: { type: 'string', enum: ['exec', 'handoff', 'add', 'status', 'close'], required: true, description: 'Required. exec = run a command / script / raw stdin write (machine target defaults to its reusable PTY); handoff = detach a machine\'s default PTY as pty:<id>; add = register a BYO ssh identity or BYO PTY into the pool; status = roster (no target) or probe/session card (target); close = close a PTY shell (no job id — cancel with job_kill).' },
      target: { type: 'string', description: 'exec: required — a machine (bare pool name, ssh:<name>, docker:<name>, incus:<name>, hub:<m4>; its default PTY unless mode is oneshot) or a live PTY session (pty:<id|label> or its bare label). handoff: the machine whose default PTY detaches. add: optional label for the BYO entry. status: optional — omit for the roster. close: a machine (its default PTY) or pty:<id|label>.' },

      cmd: { type: 'string', description: "exec: one raw shell string parsed by the remote bash (multi-line = one compound; exit = last command's). Required unless scriptPath is given." },
      stdin: { type: 'string', description: 'exec: with cmd/scriptPath = startup input (oneshot: piped; pty: REPL-style right after the command line; with scriptPath it is the script process\'s own stdin). Alone (no cmd/scriptPath) = a raw write into the PTY\'s RUNNING command — exact bytes; "" writes zero bytes (not EOF); "\\n" submits a line; "\\u0003" = Ctrl-C, "\\u0004" = Ctrl-D as raw characters; after a raw "\\u0003" settle the job with job_kill.' },
      commandId: { type: 'string', description: 'exec stdin-only: optional guard — when given it must equal the running command\'s id (from the exec receipt or job_output); a stale id refuses the write instead of feeding the next command. Not valid with cmd/scriptPath.' },
      timeout: { type: 'number', description: 'exec: per-command timeout in seconds (default 120). oneshot: interrupts then kills the whole group. pty: the command is NOT killed on timeout — it hands off to a running job you can poll (job_output) and cancel (job_kill = Ctrl-C first; the session survives an interrupt).' },
      mode: { type: 'string', enum: ['pty', 'oneshot'], description: 'exec: pty (default) — a machine target reuses its default interactive PTY (cwd/env persist); oneshot — isolated, stateless, stdout/stderr split, verbatim exit. Redundant on pty:<id|label> targets; "oneshot" on an addressable PTY is an error.' },
      run_in_background: { type: 'boolean', description: 'exec with cmd/scriptPath only: the command went async (not bash &) — a running job returns immediately and a completion notification will follow, so no polling is required. Oneshot runs async; on a machine\'s default PTY the framed command starts and that PTY is handed off in the same operation; on an addressable PTY it keeps its identity. job_output reads the command\'s full stream from byte 0 (overlap with the pre-handoff receipt is expected); job_kill cancels. Requires the official jobs service/controller.' },
      ssh: { type: 'object', description: 'add: BYO ssh identity to register into the pool (no dialing). Later exec calls address the returned label. No inline keys or arbitrary SSH options; nothing is persisted — a new Agent registers again.', additionalProperties: false, properties: {
        host: { type: 'string', required: true, description: 'SSH hostname, IP or native config alias.' },
        user: { type: 'string', description: 'Login user; omitted preserves native SSH config.' },
        port: { type: 'integer', description: 'SSH port 1–65535; omitted preserves native SSH config.' },
        key: { type: 'string', description: 'Existing origin private-key file path, not key contents; never copied or persisted.' },
        proxyJump: { type: 'string', description: 'Official ProxyJump: comma-separated [user@]host[:port] or native aliases; jump identity remains in origin SSH config.' },
      } },
      spawn: { type: 'string', description: 'add: BYO PTY entry point — the full command that starts an interactive shell (e.g. "docker exec -it img bash"). Pairs with target pty:<label> / a bare <label> / nothing (auto id). Nested hops are dumb pipes (only the innermost bash frames).' },
      force: { type: 'boolean', description: 'close only: default false — a session with a running job is refused (job_kill it first). true = kill the group and close in one step; the receipt lists what was killed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['exec', 'handoff', 'status', 'roster', 'job', 'close', 'input'] },
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
  Object.defineProperty(tool, 'description', { enumerable: true, get: () => description + (driver.hasHub() ? '\nHub transport available: hub:<m4> selects a paired remote machine (never self; the roster lists them). Hub failures never fall back to SSH.\n- hub:<m4> oneshot: the peer hub server is the runner itself — bash -lc in a detached group, TERM→2s→KILL cleanup; the receipt runner field says "hub-lease" (the superd-run helper is a dumb-pipe artifact, never uploaded over the Hub). The peer caps inline commands at 4096 chars — and a scriptPath IS carried as one bash -c command, so hub-oneshot scripts share that cap (split large work or transfer the file and run it with cmd).\n- hub:<m4> as a machine target has the SAME default-PTY semantics as every other transport — exec opens the default session (a local pump child over one authenticated WebSocket to the peer terminal), handoff / background / stdin-only / close / idle TTL all work identically.' : '') })
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
  if (v.kind === 'status' || v.kind === 'roster' || v.kind === 'job' || v.kind === 'close' || v.kind === 'input' || v.kind === 'handoff') return v.text
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
  if (v.outputStatsUnavailable) markers.push('peer output totals/retention unavailable')
  parts.push(`[${markers.join(' · ')}]`)
  if (v.runner === 'posix-shim' && ((v.exit !== null && v.exit !== 0) || v.timedOut === true))
    parts.push('note: this oneshot ran through the POSIX fallback on this target; PTY lanes use an independent lane and may still work here')
  if (v.stderr !== undefined && v.stderr.length > 0) parts.push('[stderr]', v.stderr)
  return parts.join('\n')
}
