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
  kind: 'exec' | 'status' | 'roster' | 'job' | 'copy' | 'rsync' | 'close'
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
}

const NO_SESSION_KEY = 'remote:no-session'

/**
 * The model-visible surface of the `remote` tool (workbench round, plan
 * 2026-10-19-pty-workbench). ONE template literal — no backticks, no "${".
 */
const REMOTE_TOOL_DESCRIPTION = `Remote execution and file transfer over ssh / docker / incus, plus stateful PTY workbenches. Pick the call shape:
  {}                                   → roster (local scan; refreshes the name pool: ssh aliases, BYO identities, docker/incus containers, hub machines, live pty sessions)
  {target}                             → status probe: machine reachability + its pty sessions, or a session card (connection, cwd, ledger of the last 20 commands) for pty:<id|label>
  {target, cmd}                        → run cmd — oneshot (stateless bash -lc) on any machine target
  {target, scriptPath:"/abs"}         → LOCAL script over stdin to a fixed bash -s (oneshot only; no cmd/stdin/spawn mix)
  {target:"ssh:dev4:pty[:label]", cmd?}    → create a PTY session on that machine and run cmd in it; no cmd = warm creation returning the id. Tab semantics: every creation call opens a NEW session — parallel is first-class (max 10 per Agent, ssh:dev4 and docker:corti alike).
  {target:"pty:<id|label>", cmd}           → run cmd in a live session (cwd/env survive; the receipt carries session, connection, commandId, cwd, env delta, idle-left)
  {spawn, target?:"pty[:<label>]"|"<label>"|"", cmd?}  → create a BYO pty from a spawn command (e.g. docker exec -it img bash; nested hops are dumb pipes). spawn present IS the BYO entry point; no target = auto id.
  {ssh:{...}, target?:"ssh[:<label>]"|"<label>"|"", cmd?}  → register a BYO ssh identity (ssh present IS the entry point); the label then works everywhere ssh: aliases do (roster marks it "built on"); ssh:<label>:pty opens a session on it. key is an existing origin file, never inline material; nothing is persisted; a new Agent registers again.
  {action:"close", target:"pty:<id|label>", force?}  → close a session. Idempotent (unknown id → closed:false). Default rejects while a job is running and names it (job_kill it first, or wait); force:true closes the tab and kills the group in one step.
  {action:"copy"|"rsync", src, dst, argv?}  → file transfer (see the action/src/dst fields)
Bare names address ONE unified pool (machines + identities + sessions — roster lists it; a machine losing its bare name to an earlier claim is shown prefixed docker-foo / incus-foo). Prefixes ssh: / docker: / incus: / hub: force a channel. Creation always claims a fresh name: a taken label answers [E_LABEL_IN_USE] — address it without creation params, or pick another (specs are never compared). PTY sessions idle out after 15 min (running commands exempt; reads do not reset the clock).

oneshot: stdout/stderr separate, exit code verbatim. Supervision prefers a pinned superd-run helper cached on the endpoint (~/.cache/superd/run; first call uploads it over the same exec lane) and falls back to a POSIX wrapper everywhere else — the receipt field "runner" says which ran. Helper or wrapper, backgrounded children are reaped on completion and the whole group is killed on timeout/cancel; the endpoint needs bash only (no Python).

PTY is the stateful superset of oneshot: every command returns synchronously with exit + cwd + an env delta (NAMES only — added/changed/removed; values never leave the endpoint; fetch a value yourself if you need it). A command that outlives its timeout is NOT killed — it hands off as a running job: poll job_output <commandId>, cancel with job_kill (Ctrl-C first; the session survives). run_in_background uses the same lane and its jobId IS the commandId. A busy session rejects new commands ([E_SESSION_BUSY] names the running id and the ways out: job_output / job_kill / another session or oneshot).

Output: pty tails at ~30k chars ("[truncated: …]" header) — redirect bulk output to a file. Hard retention 4,000,000 UTF-16 units per stream (Hub 4MiB bytes); outputStats reports the rest; restart cannot recover discarded output. stdin feeds the command (pty: REPL-style right after the command line — only helps commands that read stdin there). timeout (seconds, default 120): oneshot interrupts then kills the whole group; pty hands off. Native transport errors pass through verbatim — self-correct from them.`

/**
 * execute 实现放独立函数 + 结构类型（RemoteArgs/ExecLike）：defineTool 字面量与 typert
 * 生成类型的组合下，直接引用上游类型会触发 dsh-tools 双实例身份冲突（TS2719，
 * 2026-10-19 实测多轮二分；schema×execute×import 链组合触发，无单一根因）。
 * 运行时语义不变——字面量里的 execute 只是三行委托。
 */
interface RemoteArgs {
  action?: 'copy' | 'rsync' | 'close'
  force?: boolean
  src?: string
  dst?: string
  argv?: string[]
  pullArgv?: string[]
  pushArgv?: string[]
  verify?: boolean
  mkdir?: boolean
  run_in_background?: boolean
  target?: string
  ssh?: { host: string; user?: string; port?: number; key?: string; proxyJump?: string }
  spawn?: string
  cmd?: string
  scriptPath?: string
  stdin?: string
  timeout?: number
}
type ExecLike = { signal: AbortSignal; agent?: { id: string; ctx: { get(key: 'jobs'): unknown } } }
/** 结构性 JobRegistry（与 dsh-jobs 同构）：与 ExecLike 一起隔离上游类型身份。 */
type JobRegistryLike = import('@deepseek-ai/dsh-jobs').JobRegistry

async function remoteExecute(ENV: { driver: RemoteDriver; getSessionKey: (exec: ExecLike) => string }, args: RemoteArgs, exec: ExecLike): Promise<RemoteToolValue> {
  if (args.action === 'copy' || args.action === 'rsync') {
    if (!args.src || !args.dst) throw new Error(`${args.action} requires src and dst absolute endpoints`)
    if ([args.cmd,args.scriptPath,args.stdin,args.spawn,args.ssh,args.target,args.timeout,args.run_in_background,args.force].some(value => value !== undefined)) throw new Error(`${args.action} cannot be combined with execution/PTY/job arguments`)
    // No legacy aliases and no silent no-ops: dsh-tools passes unknown root
    // parameters through, so this surface rejects every key it does not
    // declare (native options go through argv).
    const KNOWN_PARAMS = new Set(['action','force','src','dst','argv','pullArgv','pushArgv','verify','mkdir','run_in_background','target','ssh','spawn','cmd','scriptPath','stdin','timeout'])
    for (const key of Object.keys(args)) {
      if (!KNOWN_PARAMS.has(key)) throw new Error(`remote: unknown parameter "${key}" — this surface has no legacy aliases; pass native CLI options through argv instead`)
    }
    if (args.action === 'rsync') {
      if (args.pullArgv !== undefined || args.pushArgv !== undefined) throw new Error('rsync takes argv only; pullArgv/pushArgv are copy-only fields')
      if ([args.verify,args.mkdir].some(value => value !== undefined)) throw new Error('rsync cannot be combined with copy verify/mkdir options; the Hub/local staged lane is copy-only')
      const start = Date.now()
      const receipt = await ENV.driver.rsync({src:args.src,dst:args.dst,...(args.argv === undefined ? {} : {argv:args.argv})},exec.signal,{sessionKey:ENV.getSessionKey(exec)})
      const rsyncReceipt = receipt as { ok?: boolean; exit?: number | null }
      if (rsyncReceipt.ok === false || receipt.exit !== 0) throw new Error(JSON.stringify(receipt))
      const rsyncDuration = Date.now() - start
      return {kind:'rsync',text:formatTransferLine('rsync', receipt, rsyncDuration),receipt:receipt as unknown as import('@deepseek-ai/dsh-util-values').JsonValue,exit:receipt.exit,durationMs:rsyncDuration}
    }
    const copyStart = Date.now()
    const receipt = await ENV.driver.copy({ src:args.src,dst:args.dst,...(args.verify === undefined ? {} : {verify:args.verify}),...(args.mkdir === undefined ? {} : {mkdir:args.mkdir}),...(args.argv === undefined ? {} : {argv:args.argv}),...(args.pullArgv === undefined ? {} : {pullArgv:args.pullArgv}),...(args.pushArgv === undefined ? {} : {pushArgv:args.pushArgv}) },exec.signal,{sessionKey:ENV.getSessionKey(exec)})
    // F2 (2026-10-14 user acceptance): copy failures must be fail-loud, same
    // contract as rsync — a native non-zero exit previously came back as a
    // normal-looking result with the error buried in receipt stderr.
    const asReceipt = receipt as { ok?: boolean; exits?: (number | null)[] }
    const exits = asReceipt.exits ?? []
    if (asReceipt.ok === false || exits.some(code => code !== 0)) throw new Error(JSON.stringify(receipt))
    const copyDuration = Date.now() - copyStart
    return { kind:'copy', text: formatTransferLine('copy', receipt, copyDuration), receipt:receipt as unknown as import('@deepseek-ai/dsh-util-values').JsonValue, exit:exits.length > 0 ? 0 : null, durationMs:copyDuration }
  }
  if (args.action === 'close') {
    if (typeof args.target !== 'string' || args.target.length === 0) throw new Error('close requires target pty:<id|label>')
    if ([args.cmd,args.scriptPath,args.stdin,args.spawn,args.ssh,args.timeout,args.run_in_background].some(value => value !== undefined)) throw new Error('[E_PARAMS] close cannot be combined with execution/PTY/job arguments')
    const r = ENV.driver.closePty(args.target.startsWith('pty:') ? args.target.slice(4) : args.target, ENV.getSessionKey(exec), args.force === true)
    const text = r.closed
      ? `closed ${r.session} (${r.connection})${r.killed.length > 0 ? ` — killed running job ${r.killed.join(', ')}` : ''}`
      : `${r.session}: not closed (${r.reason}) — ${r.message ?? 'no live session'}`
    return { kind: 'close', text, exit: null, durationMs: 0, session: r.session, closed: r.closed, ...(r.reason !== undefined ? { reason: r.reason } : {}), killed: r.killed }
  }
  if ([args.src,args.dst,args.argv,args.pullArgv,args.pushArgv,args.verify,args.mkdir,args.force].some(value => value !== undefined)) throw new Error('file/force fields require an action (copy / rsync / close)')
  const hasCmd = typeof args.cmd === 'string' && args.cmd.length > 0
  const hasTarget = typeof args.target === 'string' && args.target.length > 0
  const hasSpawn = typeof args.spawn === 'string' && args.spawn.length > 0
  if (args.spawn !== undefined && !hasSpawn) throw new Error('[E_PARAMS] remote: spawn must be a non-empty command string')
  if (args.scriptPath !== undefined && (hasSpawn || /^pty:/.test(args.target ?? '') || /:pty/.test(args.target ?? '')))
    throw new Error('[E_SCRIPT_PARAMS] remote: scriptPath is oneshot-only — PTY lanes take cmd')
  if (args.run_in_background) {
    if (!hasCmd && args.scriptPath === undefined) throw new Error('remote: background requires cmd or scriptPath')
    const jobs = exec.agent?.ctx.get('jobs') as unknown as JobRegistryLike | undefined
    if (!jobs) throw new Error('remote: background requires the official DSH jobs service and job_output/job_kill controller; foreground execution remains available')
    // PTY lane：先把会话占位（不拨号），回执才能给出可寻址的 session/connection（R2 复核 P1-4）。
    const lane = await ENV.driver.preparePtyLane({ target: args.target, spawn: args.spawn, cmd: args.cmd, scriptPath: args.scriptPath, ssh: args.ssh, stdin: args.stdin, timeout: args.timeout }, { sessionKey: ENV.getSessionKey(exec) })
    let jobId: string
    try {
      jobId = startRemoteJob(jobs as JobRegistry, lane !== undefined
        ? lane.input
        : { target: args.target, spawn: args.spawn, cmd: args.cmd, scriptPath: args.scriptPath, ssh: args.ssh, stdin: args.stdin, timeout: args.timeout }, exec as never, ENV.driver)
    } catch (error) {
      lane?.cleanup()
      throw error
    }
    const where = lane === undefined ? '' : ` on ${lane.session}${lane.label !== undefined ? ` (${lane.label})` : ''} (${lane.connection})`
    return {
      kind: 'job', jobId, exit: null, durationMs: 0,
      text: `Started ${jobId}${where}. Use job_output to read and job_kill to cancel; completion is reported by the host.`,
      ...(lane !== undefined ? { session: lane.session, connection: lane.connection, ...(lane.label !== undefined ? { label: lane.label } : {}) } : {}),
    }
  }
  // cmd 缺省：PTY 形态（创建/复用/注册）走 ENV.driver.call；机器面走 status probe；空 = roster。
  if (!hasCmd && args.scriptPath === undefined) {
    if (args.stdin !== undefined)
      throw new Error('[E_STDIN_WITHOUT_CMD] remote: stdin requires cmd — status probes take no input')
    // 形态粗分类只管路由（ENV.driver.parseTargetForm 是权威解析）；正则在这里也避免了
    // typert 参数类型与本文件 import 链的多版本身份冲突（TS2719，2026-10-19 实测）。
    const t = args.target ?? ''
    const byo = hasSpawn || args.ssh !== undefined
    if (byo || /^pty:/.test(t) || (/:pty(:|$)/.test(t) && !t.startsWith('hub:'))) {
      const r = await ENV.driver.call({ target: args.target, spawn: args.spawn, ssh: args.ssh, cmd: '', stdin: undefined }, { sessionKey: ENV.getSessionKey(exec) })
      return workbenchValue(r)
    }
    if (!hasTarget)
      return { kind: 'roster', text: await ENV.driver.roster({ sessionKey: ENV.getSessionKey(exec) }), exit: null, durationMs: 0 }
    const text = await ENV.driver.status(args.target as string, { sessionKey: ENV.getSessionKey(exec) })
    return { kind: 'status', text, exit: null, durationMs: 0 }
  }
  const r: RemoteCallResult = await ENV.driver.call(
    {
      target: args.target, spawn: args.spawn, ssh: args.ssh, cmd: args.cmd, scriptPath: args.scriptPath,
      stdin: args.stdin, timeout: args.timeout,
    },
    { sessionKey: ENV.getSessionKey(exec) },
  )
  const v = workbenchValue(r)
  if (r.running === true && r.ptyJob !== undefined) {
    const jobs = exec.agent?.ctx.get('jobs') as unknown as JobRegistryLike | undefined
    if (jobs) {
      const jobId = adoptRunningPtyJob(jobs as JobRegistry, exec as never, `${r.target}: ${args.cmd}`, r.ptyJob)
      v.jobId = jobId
      v.running = true
      if (r.commandId !== undefined && jobId !== r.commandId) ENV.driver.attachPtyJob(r.commandId, jobId, ENV.getSessionKey(exec))
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
      action: { type: 'string', enum: ['copy', 'rsync', 'close'], description: 'Optional action; omit for execution/status/roster. close takes target + optional force.' },
      force: { type: 'boolean', description: 'close only: default false — a session with a running job is refused (job_kill it first). true = kill the group and close in one step; the receipt lists what was killed.' },
      src: { type: 'string', description: 'copy/rsync source [target:]absolute path; rsync retains trailing-slash semantics' },
      dst: { type: 'string', description: 'copy/rsync destination [target:]absolute path' },
      argv: { type: 'array', items: { type: 'string' }, description: 'Ordered native CLI options and values for one-command routes (e.g. rsync ["-a","--partial","--dry-run"], scp ["-p","-r"], docker cp ["-a"], incus file push/pull). One element = one argv token, appended verbatim before src/dst; no shell parsing, no whitelist, no forced defaults — unknown options fail in the native CLI itself. rsync only (SSH endpoints): explicit -e/--rsh overrides the tool\'s SSH wiring. docker cp: pass -L to follow symlinks (a symlink source like /etc/os-release fails without it). Two-segment cross-endpoint copy uses pullArgv/pushArgv instead.' },
      pullArgv: { type: 'array', items: { type: 'string' }, description: 'Options for the PULL half (source endpoint → origin staging) of a two-command cross-endpoint copy (e.g. SSH↔Docker, SSH↔Incus, Docker↔Incus). Mutually exclusive with argv; must be paired with pushArgv. Only options valid for the pull half\'s CLI.' },
      pushArgv: { type: 'array', items: { type: 'string' }, description: 'Options for the PUSH half (origin staging → destination endpoint) of a two-command cross-endpoint copy. Mutually exclusive with argv; must be paired with pullArgv.' },
      verify: { type: 'boolean', description: 'copy only. Receipts name the verification tier actually performed (D1=A): native CLI routes are "native-exit-only" (no independent check — self-verify via oneshot digest commands when needed); the Hub↔local staged lane computes independent SHA-256 digests by default and verify:false skips them ("not-applicable"). No hash tier exists on native routes.' },
      mkdir: { type: 'boolean', description: 'copy only, all routes. Default true: before transfer, one best-effort exec pre-hop ensures the destination\'s PARENT directory exists (the operand itself is never pre-created — each CLI\'s own layout semantics stay byte-identical). Receipt created field: true (parent created this call) / false (already existed) / "n-a" (skipped or pre-hop unavailable, e.g. docker exec on a stopped container — the native CLI then reports the real error itself). false skips the pre-hop.' },
      run_in_background: { type: 'boolean', description: 'oneshot AND pty: return a native jobId immediately, read with job_output, cancel with job_kill; output is available while running. On pty lanes the jobId IS the commandId — it tracks the running command inside a persistent session; job_kill sends Ctrl-C and the session survives. Hub-machine PTY has no background lane. Requires the official jobs service/controller.' },
      target: { type: 'string', description: 'Single entry point. Machine targets: bare pool name, ssh:<name>, docker:<name>, incus:<name>, hub:<m4>. PTY: append :pty to create (ssh:dev4:pty, ssh:dev4:pty:build — label optional, every creation opens a new session) or address a live one with pty:<id|label>. BYO: pass spawn (pty) or ssh (identity) and the label lives in the same pool. Omit target → roster (or BYO auto-id when spawn/ssh present).' },
      ssh: { type: 'object', description: 'BYO ssh registration — the field present IS the entry point. First call registers (no cmd = register only); later calls reuse the label with ssh omitted. No inline keys or arbitrary SSH options.', additionalProperties: false, properties: {
        host: { type: 'string', required: true, description: 'SSH hostname, IP or native config alias.' },
        user: { type: 'string', description: 'Login user; omitted preserves native SSH config.' },
        port: { type: 'integer', description: 'SSH port 1–65535; omitted preserves native SSH config.' },
        key: { type: 'string', description: 'Existing origin private-key file path, not key contents; never copied or persisted.' },
        proxyJump: { type: 'string', description: 'Official ProxyJump: comma-separated [user@]host[:port] or native aliases; jump identity remains in origin SSH config.' },
      } },
      spawn: { type: 'string', description: 'BYO pty creation — the field present IS the entry point: the full command that starts an interactive shell (e.g. "docker exec -it img bash"). Pairs with target pty[:<label>] / a bare <label> / nothing (auto id). Nested hops are dumb pipes (only the innermost bash frames).' },
      cmd: { type: 'string', description: "One raw shell string parsed by the remote bash (multi-line = one compound; exit = last command's). Omit with target → status/card; omit everything → roster." },
      scriptPath: { type: 'string', description: 'LOCAL absolute script path. Read before any dialing, sent literally over stdin to fixed bash -s. Oneshot only (no PTY lanes); cannot combine with cmd, stdin or spawn. Hub inline cmd remains limited to 4096; script body is not argv.' },
      stdin: { type: 'string', description: 'Input fed to the command. oneshot: piped to stdin. pty: written right after the command line (REPL-style). Requires cmd.' },
      timeout: { type: 'number', description: 'Per-command timeout in seconds (default 120). oneshot: interrupts then kills the whole group. pty: the command is NOT killed on timeout — it hands off to a running job you can poll (job_output) and cancel (job_kill = Ctrl-C first; the session survives an interrupt).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['exec', 'status', 'roster', 'job', 'copy', 'rsync', 'close'] },
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
          envDelta: { type: 'json', description: 'names only: {added,changed,removed}' },
          created: { type: 'boolean' },
          notice: { type: 'string' },
          runner: { type: 'string', description: 'oneshot supervision path: superd-run <ver> (<triple>) or posix-shim' },
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
  Object.defineProperty(tool, 'description', { enumerable: true, get: () => description + (driver.hasHub() ? '\nHub transport available: hub:<m4> selects a paired remote machine (never self). {} includes the Hub directory even when empty. Uses authenticated Hub HTTP oneshot / persistent WS PTY (hub:<m4>:pty selects the PTY lane); no SSH alias needed. Hub failures never fall back to SSH.' : '') })
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

/** S8 (2026-10-17): copy/rsync render as one formatted line; the full receipt
 * stays in the receipt field — raw-JSON dumps are gone from text. */
function formatTransferLine(action: 'copy' | 'rsync', receipt: unknown, durationMs: number): string {
  const r = receipt as { ok?: boolean; reason?: string; src?: string; dst?: string; route?: string; exits?: (number | null)[]; exit?: number | null; verification?: string; created?: boolean | 'n-a'; cleanup?: string; bytes?: number; entries?: number; note?: string }
  const parts: string[] = []
  if (r.ok === false) parts.push(`✗ ${r.reason ?? 'failed'}`)
  parts.push(`${action} ${r.src} → ${r.dst}`)
  if (r.route !== undefined && r.route !== '') parts.push(`route ${r.route}`)
  if (r.exits !== undefined) parts.push(`exits [${r.exits.join(',')}]`)
  else if (r.exit !== undefined) parts.push(`exit ${r.exit}`)
  if (r.verification !== undefined) parts.push(`verification ${r.verification}`)
  if (r.created === true) parts.push('created yes')
  else if (r.created === false) parts.push('created pre-existing')
  else if (r.created === 'n-a') parts.push('created n-a')
  if (r.cleanup !== undefined && r.cleanup !== 'none-required') parts.push(`cleanup ${r.cleanup}`)
  if (typeof r.bytes === 'number') parts.push(`${r.bytes} bytes / ${r.entries} entries`)
  parts.push(`${(durationMs / 1_000).toFixed(1)}s`)
  if (r.note !== undefined && r.note.length > 0) parts.push(`(${r.note})`)
  return parts.join(' · ')
}

function renderEnvDelta(d: EnvDelta): string | undefined {
  const bits: string[] = []
  if (d.added.length > 0) bits.push(`+${d.added.join(',+')}`)
  if (d.changed.length > 0) bits.push(`~${d.changed.join(',~')}`)
  if (d.removed.length > 0) bits.push(`-${d.removed.join(',-')}`)
  return bits.length > 0 ? bits.join(' ') : undefined
}

function renderValue(v: RemoteToolValue): string {
  if (v.kind === 'status' || v.kind === 'roster' || v.kind === 'job' || v.kind === 'copy' || v.kind === 'rsync' || v.kind === 'close') return v.text
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
