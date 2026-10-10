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
  notice?: string
}

const NO_SESSION_KEY = 'remote:no-session'

export function createRemoteTool(
  driver: RemoteDriver,
  opts: { getSessionKey?: (exec: ToolRunContext) => string } = {},
): ToolDefinition {
  const getSessionKey = opts.getSessionKey ?? ((exec: ToolRunContext) => exec.agent?.id ?? NO_SESSION_KEY)
  const tool = defineTool({
    name: 'remote',
    description:
      'Native rsync: {action:"rsync",src:"[target:]/absolute/path",dst:"[target:]/absolute/path",dryRun:true,delete:false,excludes:["pattern"],preserve:true}. SSH/byossh only, optionally one local endpoint; no Docker/Incus/Hub/BYO-PTY and no copy fallback. Requires Bash/native rsync on the origin; SSH endpoints need Bash 4.1+ coprocess/dynamic-FD support and Python 3.7+ (macOS 3.10+) shared cross-process non-adjustable monotonic clock and Unix fcntl.flock (preflighted, no auto-install). Default dry-run makes no destination data changes; deletion is opt-in; preserve uses native archive (-a), false uses recursive (-r). Source trailing slash copies contents; no slash copies the named directory. Local↔SSH supports native files/new destinations. SSH↔SSH requires an existing non-symlink destination directory (files/new paths, percent-containing paths and trim-sensitive/newline destinations refused, module never widened); source symlinks are refused before transfer because its confined non-chroot daemon cannot preserve their values. Use an ordinary local↔SSH rsync leg or materialize files first. Relay source inspection also requires native find. Two-remote relay SOURCE uses a task-owned Python loopback byte proxy over its authenticated SSH work stream, bridged on the origin into the destination SSH -L tunnel; no source Linux /proc, pidfd, privileged sshd descriptor access or remote forwarding is required. Native find remains required for source inspection. The exact route must return a real rsync greeting before transfer. Identities stay on the origin, agent forwarding and reusable multiplexing are disabled; native SSH config/ProxyJump remain honored. Normal two-remote startup uses 12 SSH launches: source prerequisite/inspection clock/inspection (3), source+destination prerequisites (2), destination clock/daemon+tunnel (2), source proxy clock/owner/work (3), source rsync clock/work (2). Lost admission may require additional authenticated cleanup reconnects; no transfer retry. Native delta is uncompressed; receipt includes real exit/stdout/stderr, itemized changes and native byte stats when available. Receipt stdout/stderr retain at most 2,097,152 UTF-16 code units each; outputTruncated marks trimmed tails (changes/stats may then be incomplete). Operation/disposal settlement waits for owned tunnels/daemon/config cleanup, not pre-existing SSH sessions. Each owned command uses an extra clock-only SSH round trip and a private transient receiving lock/record. If startup loses its closed control channel before a receipt, cancellation reconnects using the same SSH identity, fences late entry through the original 8-second entry cutoff, and waits for actual owned cleanup. Restore control connectivity if observation is pending; recovery never restarts the transfer. A still-live but hidden startup or unavailable cleanup helper can keep settlement pending; receiver progress and usable authenticated control connectivity are required.\n' +
      'Copy files/trees: {action:"copy",src:"[target:]/absolute/path",dst:"[target:]/absolute/path",verify:true,mkdir:true}. Local/SSH/byossh/Docker/Incus/Hub binary transport; BYO-PTY unsupported. CLI peers require Bash 4.1+, Python 3.7+ (macOS 3.10+), Unix fcntl.flock/shared non-adjustable monotonic clock and mktemp/mv/rm/sleep; Linux containers additionally require stdlib ctypes/permitted PR_SET_CHILD_SUBREAPER. No auto-install or origin Python requirement. Each remote export/import/digest uses three native transport starts (clock, receiving owner, raw binary work), with extra authenticated cleanup recovery only on faults. A verified local-to-CLI copy uses six starts (import plus destination digest); CLI-to-local uses six (export plus source digest); CLI-to-CLI uses twelve. verify:false skips digests, reducing these counts to three/three/six. Cancellation/failure settlement waits for actual receiving helper/group/temp cleanup. Normal binary success requires complete stream drain; there is no successful truncated-output timeout. Local/Hub file lanes are unchanged. Full origin staging, no delta/resume. Directories merge without deletion; SHA-256 verifies transferred entries only. Receipt sourceDigest/destinationDigest are canonical transferred-entry manifest digests, not a raw file sha256sum, even for one file. Copy has no dryRun; omit all rsync-only options including dryRun:false. Failures report retained scratch for diagnosis; success removes owned staging. Symlinks must resolve through incoming tree entries only; dangling links and destination aliases are rejected.\n' +
      'Owned SSH/byossh oneshot commands (foreground, background, script and stdin) require remote Bash 4.1+, Python 3.7+ (macOS 3.10+), Unix fcntl.flock with a shared non-adjustable monotonic clock, and mktemp/mv/rm/sleep. No rsync is needed for ordinary commands; no new origin Python prerequisite or Linux/pidfd requirement. Each command uses three SSH startups: clock-only prerequisite, separate receiving owner/control, and literal-stdio work. Cancellation/timeout/Agent or plugin disposal waits for receiving helper and child/group cleanup; a lost startup receipt can require same-identity cleanup reconnect and restored connectivity. Receiver progress is required, not a hard-real-time guarantee. Work output gets up to 2500ms to drain after cleanup proof; unavailable drain reports incomplete output separately, and counters describe only received data. PTY/BYO-PTY behavior is unchanged.\n' +
      'Docker/Incus oneshot commands use the same receiving owner: remote Bash 4.1+, Python 3.7+, fcntl/shared monotonic clock and mktemp/mv/rm/sleep; three native exec startups per command (clock, owner, work). Linux containers additionally require Python stdlib ctypes and permitted unprivileged PR_SET_CHILD_SUBREAPER, checked before business work; the helper reaps its own/adopted descendants, including containers without an init. No image/config installation, origin Python, rsync or pidfd is added. PTY paths are unchanged.\n' +
      'Remote execution over three transports (ssh / docker / incus) plus named persistent BYO shells. Pick the call shape first:\n' +
      '  {}                                 → roster: known target names from a local scan (no dialing)\n' +
      '  {target}                           → on-demand status probe of that one target (for "byop:<label>": its session state)\n' +
      '  {target:"byossh:<label>", ssh:{host,user?,port?,key?,proxyJump?}, cmd?} → register SSH identity in this Agent; optional cmd executes. No cmd means register only, no dialing. Later omit ssh and reuse target. Same spec is idempotent; different spec conflicts: use another label. key is an existing file on the origin, never inline private key. Native SSH config and ProxyJump are honored; no config writes, copied keys or credential persistence. Cold/new Agent must register again.\n' +
      '  {target, cmd}                      → run cmd — oneshot by default; mode "pty" for a persistent shell\n' +
      '  {target, script:"/absolute/path.sh"} → read a LOCAL script before dialing; oneshot only, sent raw over stdin to fixed `bash -s`. No cmd/stdin/spawn/PTY combination. Large scripts do not expand into argv.\n' +
      '  {target:"byop:<label>", spawn, cmd} → BYO-PTY: create the persistent shell you named <label>\n' +
      '  {target:"byop:<label>", cmd}        → reuse that shell (spawn is only needed to create)\n' +
      'BYO-PTY labels are yours to choose, and the label alone is the whole reuse mechanism: "byop:dev3" is created once ' +
      'with `spawn` (the command that starts an interactive shell, e.g. "docker exec -it img bash"), and from then on you ' +
      'address it as {target:"byop:dev3", cmd} with no spawn. Repeating the same spawn for a live label is reused and the ' +
      'result tells you to drop it; repeating a *different* spawn is refused with [E_LABEL_CONFLICT] and nothing runs — ' +
      'reuse the label, or pick a new one. A label that was never created, or was reaped after the idle TTL, answers ' +
      '[E_NO_SESSION]: spawn is not retained, so pass it again to re-create. A spawn that fails to come up (e.g. a ' +
      'bad host) leaves nothing behind either — the label stays free, so just retry with a corrected spawn. ' +
      'Bare names match in order — ssh config, then docker, then incus, then a live pty label (on a collision the earlier ' +
      'source wins; a name matching none of them goes to ssh and its native error surfaces). "byop:<label>" / ' +
      '"docker:<name>" / "incus:<name>" / "ssh:<name>" force a channel when you must be explicit. oneshot: stateless ' +
      '`bash -lc`, stdout/stderr separate, the exit code is the remote process\'s own. pty: one persistent shell per ' +
      '(agent, target) — cwd/env survive across calls, streams merge, Ctrl-C interrupts without killing the session, ' +
      'idle sessions are reaped after 600s (a reconnect notice precedes the fresh shell). Output is tail-truncated at ' +
      '~30k chars with a "[truncated: …]" header — redirect bulk output to a file yourself. Native/PTY hard retention is 4,000,000 UTF-16 code units per stream, not bytes; Hub oneshot is 4MiB bytes per stream. outputStats reports total/retained/dropped/returned and units; restart cannot recover discarded output. `stdin` feeds the command; ' +
      '`timeout` (seconds) interrupts then kills. Native transport errors pass through verbatim — self-correct from them. ' +
      'run_in_background:true starts an official DSH job (oneshot only); use job_output/job_kill and host completion notices. Requires the jobs service and controller. Background has no default foreground timeout; an explicit timeout still applies. Status probes report ' +
      '"reachable"/"unreachable — <native error>" or the factual container state plus the session layer ' +
      '("idle Ns" / "busy" / "none — dials on first exec"), always probed at call time.',
    parameters: {
      action: { type: 'string', enum: ['copy', 'rsync'], description: 'Optional file action; omit for execution/status/roster.' },
      src: { type: 'string', description: 'copy/rsync source [target:]absolute path; rsync retains trailing-slash semantics' },
      dst: { type: 'string', description: 'copy/rsync destination [target:]absolute path' },
      verify: { type: 'boolean', description: 'copy independent SHA-256 verification (default true)' },
      mkdir: { type: 'boolean', description: 'copy create missing destination parents (default true)' },
      dryRun: { type: 'boolean', description: 'rsync native dry-run (default true); false permits writes' },
      delete: { type: 'boolean', description: 'rsync delete extraneous destination entries (default false)' },
      excludes: { type: 'array', items: { type: 'string' }, description: 'rsync native exclude patterns, passed as separate argv options' },
      preserve: { type: 'boolean', description: 'rsync archive -a (default true) versus recursive -r; remote relay refuses source symlinks' },
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
        },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: renderValue(value as RemoteToolValue) }],
    },
    async execute(args, exec): Promise<RemoteToolValue> {
      if (args.action === 'copy' || args.action === 'rsync') {
        if (!args.src || !args.dst) throw new Error(`${args.action} requires src and dst absolute endpoints`)
        if ([args.cmd,args.script,args.stdin,args.spawn,args.ssh,args.target,args.mode,args.timeout,args.run_in_background].some(value => value !== undefined)) throw new Error(`${args.action} cannot be combined with execution/PTY/job arguments; register byossh separately first`)
        if (args.action === 'rsync') {
          if ([args.verify,args.mkdir].some(value => value !== undefined)) throw new Error('rsync cannot be combined with copy verify/mkdir options')
          const start = Date.now()
          const receipt = await driver.rsync({src:args.src,dst:args.dst,dryRun:args.dryRun,delete:args.delete,excludes:args.excludes,preserve:args.preserve},exec.signal,{sessionKey:getSessionKey(exec)})
          if (receipt.exit !== 0) throw new Error(JSON.stringify(receipt))
          return {kind:'rsync',text:JSON.stringify(receipt),receipt:receipt as unknown as import('@deepseek-ai/dsh-util-values').JsonValue,exit:receipt.exit,durationMs:Date.now()-start}
        }
        if ([args.dryRun,args.delete,args.excludes,args.preserve].some(value => value !== undefined)) throw new Error('copy cannot be combined with rsync options')
        const receipt = await driver.copy({ src:args.src,dst:args.dst,verify:args.verify,mkdir:args.mkdir },exec.signal,{sessionKey:getSessionKey(exec)})
        return { kind:'copy',text:JSON.stringify(receipt),receipt:receipt as unknown as import('@deepseek-ai/dsh-util-values').JsonValue,exit:null,durationMs:0 }
      }
      if ([args.src,args.dst,args.verify,args.mkdir,args.dryRun,args.delete,args.excludes,args.preserve].some(value => value !== undefined)) throw new Error('file fields require action copy or rsync')
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
  parts.push(`[exit ${v.exit} · ${secs}s${suffix}${cwdTag}${sessionTag}]`)
  if (v.stderr !== undefined && v.stderr.length > 0) parts.push('[stderr]', v.stderr)
  return parts.join('\n')
}
