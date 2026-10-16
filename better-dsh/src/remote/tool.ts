import { startRemoteJob } from './jobs.ts'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { RECONNECT_NOTICE } from './pty-session.ts'
import type { RemoteCallResult, RemoteDriver } from './driver.ts'
import type { StreamOutputStats } from './hub-contract.ts'

interface RemoteToolValue {
  kind: 'exec' | 'status' | 'roster' | 'job' | 'copy' | 'rsync'
  receipt?: import('@deepseek-ai/dsh-util-values').JsonValue
  jobId?: string
  text: string
  exit: number | null
  durationMs: number
  /** 唯一偏离 brief 处（类型面）：brief 写 `cwd?: string | null`，但 output.schema 的 `cwd: { type: 'string' }`
   * 经 defineTool 推断为 `cwd?: string`——null 连运行期 schema 校验一起违反；照 RM0 样板收窄为 `string`，
   * 驱动侧的 null 在赋值处过滤。运行时语义不变（render 本就只认 string）。 */
  cwd?: string
  stderr?: string
  timedOut?: boolean
  reconnected?: boolean
  truncated?: number
  outputStats?: StreamOutputStats
  outputStatsUnavailable?: boolean
  /** `byop:<label>` 调用面的 label（模型自选、即复用入口）。 */
  session?: string
  /** 引导/教学行（同 label 重复 spawn 的「可省略」提示等）；无则省略。 */
  /** 引导/教学行（同 label 重复给 spawn 时的「可省略 spawn」提示等）；无则省略。 */
  notice?: string
  /** oneshot 监督路径：`superd-run <ver> (<triple>)` 或 `posix-shim`。 */
  runner?: string
}

const NO_SESSION_KEY = 'remote:no-session'

/**
 * The model-visible surface of the `remote` tool. Kept as ONE template
 * literal so it can be edited here directly — no string concatenation and no
 * apostrophe escaping. Plain text only: no backticks and no "${" inside.
 */
const REMOTE_TOOL_DESCRIPTION = `Remote execution and file transfer over ssh / docker / incus, plus persistent named shells. Pick the call shape:
  {}                       → roster (local scan, no dialing)
  {target}                 → status probe: reachable / unreachable — <native error>, or container state + session layer
  {target, cmd}            → run cmd — oneshot by default; mode "pty" for a persistent shell
  {target, script:"/abs"}  → LOCAL script over stdin to a fixed bash -s (oneshot only; no cmd/stdin/spawn/mode mix)
  {target:"byossh:lbl", ssh:{host,user?,port?,key?,proxyJump?}} → register this Agent's SSH identity (no cmd = register only); reuse the target later with ssh omitted. Same spec idempotent; different spec refused — use another label. key is an existing origin file, never inline material; nothing written or persisted; a new Agent registers again.
  {target:"byop:lbl", spawn, cmd} → create the named shell once; reuse as {target:"byop:lbl", cmd} (no spawn)
Bare names resolve ssh config → docker → incus → live pty; unmatched goes to ssh and its native error surfaces. Prefixes ssh: / docker: / incus: / byop: force a channel. byop: same spawn repeated is reused; a different spawn is refused ([E_LABEL_CONFLICT], nothing runs); unknown or idle-expired → [E_NO_SESSION] (spawn is not retained — pass it again); a failed spawn frees the label.

oneshot: stateless bash -lc, stdout/stderr separate, exit code verbatim. Supervision prefers a pinned superd-run helper cached on the endpoint (~/.cache/superd/run; first call uploads it over the same exec lane) and falls back to a POSIX wrapper everywhere else — the result field "runner" says which ran. Helper or wrapper, backgrounded children are reaped on completion and the whole group is killed on timeout/cancel; the endpoint needs bash only (no Python).

Files — {action:"copy" | "rsync", src:"[target:]abs", dst:"[target:]abs", argv:["-a"]}: argv tokens pass verbatim before src/dst — no whitelist, no forced defaults (dry run = pass "--dry-run" yourself); the CLI's own exit code and stderr come back in the receipt. copy: local↔SSH scp; SSH↔SSH scp -3 through the origin (identities stay local); docker cp; incus file push/pull; any other pair = two commands with origin staging (per-half options via pullArgv/pushArgv, exclusive with argv); scp -R (uppercase — scp's remote-client mode) is refused; copy of a directory from a LOCAL source auto-appends the route's recursive flag (-r, shown in the receipt argv); from a REMOTE source pass -r yourself or use rsync; success is NOT independently verified; verify/mkdir only on the Hub↔local lane. rsync: local↔SSH, or SSH↔SSH with one protocol conversation between the peers (real delta; forwarding denied → honest error, never full copy). rsync src trailing slash copies contents, no slash the directory itself.

Output: pty tails at ~30k chars ("[truncated: …]" header) — redirect bulk output to a file. Hard retention 4,000,000 UTF-16 units per stream (Hub 4MiB bytes); outputStats reports the rest; restart cannot recover discarded output. stdin feeds the command; timeout (seconds) interrupts then kills. run_in_background:true (oneshot) → jobId for job_output/job_kill. Native transport errors pass through verbatim — self-correct from them.`

export function createRemoteTool(
  driver: RemoteDriver,
  opts: { getSessionKey?: (exec: ToolRunContext) => string } = {},
): ToolDefinition {
  const getSessionKey = opts.getSessionKey ?? ((exec: ToolRunContext) => exec.agent?.id ?? NO_SESSION_KEY)
  const tool = defineTool({
    name: 'remote',
    description: REMOTE_TOOL_DESCRIPTION,

    parameters: {
      action: { type: 'string', enum: ['copy', 'rsync'], description: 'Optional file action; omit for execution/status/roster.' },
      src: { type: 'string', description: 'copy/rsync source [target:]absolute path; rsync retains trailing-slash semantics' },
      dst: { type: 'string', description: 'copy/rsync destination [target:]absolute path' },
      argv: { type: 'array', items: { type: 'string' }, description: 'Ordered native CLI options and values for one-command routes (e.g. rsync ["-a","--partial","--dry-run"], scp ["-p","-r"], docker cp ["-a"], incus file push/pull). One element = one argv token, appended verbatim before src/dst; no shell parsing, no whitelist, no forced defaults — unknown options fail in the native CLI itself. rsync only (SSH endpoints): explicit -e/--rsh overrides the tool\'s SSH wiring. docker cp: pass -L to follow symlinks (a symlink source like /etc/os-release fails without it). Two-segment cross-endpoint copy uses pullArgv/pushArgv instead.' },
      pullArgv: { type: 'array', items: { type: 'string' }, description: 'Options for the PULL half (source endpoint → origin staging) of a two-command cross-endpoint copy (e.g. SSH↔Docker, SSH↔Incus, Docker↔Incus). Mutually exclusive with argv; must be paired with pushArgv. Only options valid for the pull half\'s CLI.' },
      pushArgv: { type: 'array', items: { type: 'string' }, description: 'Options for the PUSH half (origin staging → destination endpoint) of a two-command cross-endpoint copy. Mutually exclusive with argv; must be paired with pullArgv. Only options valid for the push half\'s CLI.' },
      verify: { type: 'boolean', description: 'copy only, Hub↔local↔local staged lane only: independent SHA-256 verification (default true). Native CLI routes do not verify and report that fact.' },
      mkdir: { type: 'boolean', description: 'copy only, Hub↔local↔local staged lane only: create missing destination parents (default true). Native CLI routes let the CLI decide.' },
      run_in_background: { type: 'boolean', description: 'Oneshot only: return a native jobId immediately, read with job_output, cancel with job_kill; output is available while running. Requires official jobs service/controller.' },
      target: { type: 'string', description: 'Single entry point. byossh:<label> reuses this Agent-scoped registered SSH identity (pass ssh on first call; no cmd registers only). Bare name / IP / domain matches in order: ssh config, then docker, then incus, then a live pty label (a collision goes to the earlier source). "byop:<label>" / "docker:<name>" / "incus:<name>" / "ssh:<name>" force a channel. For "byop:<label>", pass spawn the first time to create it and omit spawn afterwards to reuse it. Omit cmd → status probe.' },
      ssh: { type: 'object', description: 'Only for byossh:<label>: register origin-side connection; omit on reuse. No inline keys or arbitrary SSH options.', additionalProperties: false, properties: {
        host: { type: 'string', required: true, description: 'SSH hostname, IP or native config alias.' },
        user: { type: 'string', description: 'Login user; omitted preserves native SSH config.' },
        port: { type: 'integer', description: 'SSH port 1–65535; omitted preserves native SSH config.' },
        key: { type: 'string', description: 'Existing origin private-key file path, not key contents; never copied or persisted.' },
        proxyJump: { type: 'string', description: 'Official ProxyJump: comma-separated [user@]host[:port] or native aliases; jump identity remains in origin SSH config.' },
      } },
      spawn: { type: 'string', description: 'Only valid together with a "byop:<label>" target, and required the first time that label is created: the full command that starts an interactive shell (e.g. "docker exec -it img bash"). It is not retained — pass it again if the label answers [E_NO_SESSION]. Requires cmd; mode is locked to pty; nested hops are dumb pipes (only the innermost bash frames).' },
      cmd: { type: 'string', description: "One raw shell string parsed by the remote bash (multi-line = one compound; exit = last command's). Omit with target → status probe; omit everything → roster." },
      script: { type: 'string', description: 'LOCAL absolute script path. Read before any dialing, sent literally over stdin to fixed bash -s. Oneshot only; cannot combine with cmd, stdin, spawn, pty mode or byop target. Hub inline cmd remains limited to 4096; script body is not argv.' },
      mode: { type: 'string', enum: ['oneshot', 'pty'], description: "'oneshot' (default): stateless `bash -lc`, stdout/stderr separate, exit code is the process's own. 'pty': one persistent shell per (agent, target), cwd/env survive, streams merge, idle TTL 600s. A \"byop:<label>\" target locks mode to 'pty'." },
      stdin: { type: 'string', description: 'Input fed to the command. oneshot: piped to stdin. pty: written right after the command line (REPL-style) — only helps commands that read stdin there. Requires cmd.' },
      timeout: { type: 'number', description: 'Per-command timeout in seconds (default 120, row-configurable). pty: Ctrl-C first, then kill; an interrupt does not kill the session.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['exec', 'status', 'roster', 'job', 'copy', 'rsync'] },
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
          session: { type: 'string' },
          notice: { type: 'string' },
          runner: { type: 'string', description: 'oneshot supervision path: superd-run <ver> (<triple>) or posix-shim' },
        },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: renderValue(value as RemoteToolValue) }],
    },
    async execute(args, exec): Promise<RemoteToolValue> {
      if (args.action === 'copy' || args.action === 'rsync') {
        if (!args.src || !args.dst) throw new Error(`${args.action} requires src and dst absolute endpoints`)
        if ([args.cmd,args.script,args.stdin,args.spawn,args.ssh,args.target,args.mode,args.timeout,args.run_in_background].some(value => value !== undefined)) throw new Error(`${args.action} cannot be combined with execution/PTY/job arguments; register byossh separately first`)
        // Removed high-level file switches: parameter roots are open, so these
        // must be rejected here, before any dialing (spec: no silent retention).
        for (const legacy of ['dryRun', 'delete', 'excludes', 'preserve'] as const) {
          const value = (args as Record<string, unknown>)[legacy]
          if (value !== undefined) throw new Error(`${legacy} was removed: pass native options through argv instead (e.g. ${legacy === 'dryRun' ? '"--dry-run"' : legacy === 'delete' ? '"--delete"' : legacy === 'excludes' ? '"--exclude=<pattern>"' : '"-a" / "-r"'})`)
        }
        if (args.action === 'rsync') {
          if (args.pullArgv !== undefined || args.pushArgv !== undefined) throw new Error('rsync takes argv only; pullArgv/pushArgv are copy-only fields')
          if ([args.verify,args.mkdir].some(value => value !== undefined)) throw new Error('rsync cannot be combined with copy verify/mkdir options; the Hub/local staged lane is copy-only')
          const start = Date.now()
          const receipt = await driver.rsync({src:args.src,dst:args.dst,...(args.argv === undefined ? {} : {argv:args.argv})},exec.signal,{sessionKey:getSessionKey(exec)})
          if (receipt.exit !== 0) throw new Error(JSON.stringify(receipt))
          return {kind:'rsync',text:JSON.stringify(receipt),receipt:receipt as unknown as import('@deepseek-ai/dsh-util-values').JsonValue,exit:receipt.exit,durationMs:Date.now()-start}
        }
        const copyStart = Date.now()
        const receipt = await driver.copy({ src:args.src,dst:args.dst,...(args.verify === undefined ? {} : {verify:args.verify}),...(args.mkdir === undefined ? {} : {mkdir:args.mkdir}),...(args.argv === undefined ? {} : {argv:args.argv}),...(args.pullArgv === undefined ? {} : {pullArgv:args.pullArgv}),...(args.pushArgv === undefined ? {} : {pushArgv:args.pushArgv}) },exec.signal,{sessionKey:getSessionKey(exec)})
        // F2 (2026-10-14 user acceptance): copy failures must be fail-loud, same
        // contract as rsync — a native non-zero exit previously came back as a
        // normal-looking result with the error buried in receipt stderr.
        const exits = (receipt as { exits?: number[] }).exits ?? []
        if (exits.some(code => code !== 0)) throw new Error(JSON.stringify(receipt))
        return { kind:'copy',text:JSON.stringify(receipt),receipt:receipt as unknown as import('@deepseek-ai/dsh-util-values').JsonValue,exit:exits.length > 0 ? 0 : null,durationMs:Date.now()-copyStart }
      }
      if ([args.src,args.dst,args.argv,args.pullArgv,args.pushArgv,args.verify,args.mkdir].some(value => value !== undefined)) throw new Error('file fields require action copy or rsync')
      const hasCmd = typeof args.cmd === 'string' && args.cmd.length > 0
      const hasTarget = typeof args.target === 'string' && args.target.length > 0
      const hasSpawn = typeof args.spawn === 'string' && args.spawn.length > 0
      // fail-loud 三闸：垃圾 mode 不静默降级；status 面不吃 stdin。
      if (args.mode !== undefined && args.mode !== 'oneshot' && args.mode !== 'pty')
        throw new Error(`[E_BAD_MODE] remote: mode must be 'oneshot' or 'pty' (got ${JSON.stringify(args.mode)})`)
      if (args.ssh !== undefined && (!args.target?.startsWith('byossh:') || hasSpawn))
        throw new Error('[E_SSH_PARAMS] remote: ssh requires a byossh:<label> target; spawn is only for byop:<label>')
      if (args.run_in_background) {
        if (!hasCmd && args.script === undefined) throw new Error('remote: background requires cmd or script')
        if (args.mode === 'pty' || hasSpawn || args.target?.startsWith('byop:')) throw new Error('remote: background requires oneshot; PTY and BYO-PTY are unsupported')
        const jobs = exec.agent?.ctx.get('jobs')
        if (!jobs) throw new Error('remote: background requires the official DSH jobs service and job_output/job_kill controller; foreground execution remains available')
        const jobId = startRemoteJob(jobs, { target: args.target, cmd: args.cmd, script: args.script, ssh: args.ssh, stdin: args.stdin, mode: 'oneshot', timeout: args.timeout }, exec, driver)
        return { kind: 'job', jobId, text: `Started ${jobId}. Use job_output to read and job_kill to cancel; completion is reported by the host.`, exit: null, durationMs: 0 }
      }
      // cmd 缺省 + target 在场 = on-demand status（Ruling 16/17）；spawn 无可探测物。
      // （守卫上方已排除 undefined/空串；类型面不收窄，照 RM0 样板以 as string 落地。）
      if (!hasCmd && args.script === undefined) {
        if (args.stdin !== undefined)
          throw new Error('[E_STDIN_WITHOUT_CMD] remote: stdin requires cmd — status probes take no input')
        if (hasSpawn)
          throw new Error('[E_PARAMS] remote: spawn is an exec channel — pass cmd (there is nothing to probe for BYO-PTY)')
        if (args.ssh !== undefined)
          return { kind: 'status', text: driver.registerSsh(args.target!, args.ssh), exit: null, durationMs: 0 }
        // Ruling P19：空调用 = roster（注意力入口——本地扫描列名字，零拨号）；
        // 有 target = 单点 on-demand probe（第二现场）。
        if (!hasTarget)
          return { kind: 'roster', text: await driver.roster({ sessionKey: getSessionKey(exec) }), exit: null, durationMs: 0 }
        const text = await driver.status(args.target as string, { sessionKey: getSessionKey(exec) })
        return { kind: 'status', text, exit: null, durationMs: 0 }
      }
      const r: RemoteCallResult = await driver.call(
        {
          target: args.target, spawn: args.spawn, ssh: args.ssh, cmd: args.cmd, script: args.script,
          mode: args.mode === 'oneshot' || args.mode === 'pty' ? args.mode : undefined,
          stdin: args.stdin, timeout: args.timeout,
        },
        { sessionKey: getSessionKey(exec) },
      )
      const v: RemoteToolValue = { kind: 'exec', text: r.stdout, exit: r.exit, durationMs: r.durationMs }
      if (r.cwd !== null) v.cwd = r.cwd
      if (r.stderr !== undefined) v.stderr = r.stderr
      if (r.timedOut) v.timedOut = true
      if (r.reconnected) v.reconnected = true
      if (r.truncated !== undefined) v.truncated = r.truncated
      if (r.outputStats !== undefined) v.outputStats = r.outputStats
      if (r.outputStatsUnavailable) v.outputStatsUnavailable = true
      if (r.session !== undefined) v.session = r.session
      if (r.notice !== undefined) v.notice = r.notice
      if (r.runner !== undefined) v.runner = r.runner
      return v
    },
  })
  const description = tool.description
  Object.defineProperty(tool, 'description', { enumerable: true, get: () => description + (driver.hasHub() ? '\nHub transport available: hub:<m4> selects a paired remote machine (never self). {} includes the Hub directory even when empty. Uses authenticated Hub HTTP oneshot / persistent WS PTY; no SSH alias needed. Hub failures never fall back to SSH.' : '') })
  return tool
}

function renderValue(v: RemoteToolValue): string {
  if (v.kind === 'status' || v.kind === 'roster' || v.kind === 'job' || v.kind === 'copy' || v.kind === 'rsync') return v.text
  const parts: string[] = []
  if (v.reconnected === true) parts.push(RECONNECT_NOTICE)
  if (typeof v.notice === 'string' && v.notice.length > 0) parts.push(v.notice)
  parts.push(v.text)
  const secs = ((v.durationMs ?? 0) / 1_000).toFixed(1)
  const markers: string[] = []
  if (v.timedOut === true) markers.push('interrupted')
  if (v.truncated !== undefined) markers.push(`truncated, ${v.outputStatsUnavailable ? 'returned peer tail' : 'original'} ${v.truncated} ${v.outputStats?.stdout.unit === 'bytes' ? 'bytes' : 'chars'}`)
  if (v.outputStatsUnavailable) markers.push('peer output totals/retention unavailable; returned tail only')
  const suffix = markers.length > 0 ? ` · ${markers.join(' · ')}` : ''
  const cwdTag = typeof v.cwd === 'string' && v.cwd.length > 0 ? ` · cwd ${v.cwd}` : ''
  const sessionTag = typeof v.session === 'string' && v.session.length > 0 ? ` · ${v.session}` : ''
  const runnerTag = typeof v.runner === 'string' && v.runner.length > 0 ? ` · runner ${v.runner}` : ''
  parts.push(`[exit ${v.exit} · ${secs}s${suffix}${cwdTag}${sessionTag}${runnerTag}]`)
  if (v.stderr !== undefined && v.stderr.length > 0) parts.push('[stderr]', v.stderr)
  return parts.join('\n')
}
