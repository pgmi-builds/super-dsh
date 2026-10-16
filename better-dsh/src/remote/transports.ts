import type { HelperAssets } from './helper.ts'
import { sshArgv } from './ssh-targets.ts'
import type { TargetPlan } from './target.ts'

/** POSIX 单引号机械转义（唯一一层转义，spec §三"一层机械转义"）。 */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** One-shot（§五.1）：不分配 tty，收尾 = 子进程退出码，零字符串扫描。
 * POSIX wrapper（无远端 Python/owner/lease）：
 *  - wrapper 跑在 setsid 的私有会话里：sshd 会话进程与命令共享进程组，
 *    不隔离的话 kill 0 会把连接一起带走。
 *  - EXIT trap（自免疫后杀组）：命令正常结束时回收后台化子孙——它们不
 *    越过调用存活，也不会攥住 stdout 拖住收尾；退出码原样透传。
 *  - cleanupTag：远端把 wrapper 的 pgid 写进 pidfile；本地取消/超时后经
 *    独立清理会话按组 kill（与 rsync daemon 的远端清理同构——实证 sshd
 *    对无 PTY 会话断连不发信号，本地 killpg 杀不到远端）。 */
export function buildOneShotArgv(plan: TargetPlan, cmd: string, options: { cleanupTag?: string } = {}): string[] {
  const tag = options.cleanupTag
  const pidfile = tag === undefined ? '' : `printf '%s' "$(ps -o pgid= -p $$ | tr -d ' ')" > "\${TMPDIR:-/tmp}/superd-oneshot-${tag}.pgid"\n`
  // The EXIT trap removes its own pidfile on normal completion (the local
  // killer's rm stays as the fallback for the SIGKILL path, where this trap
  // never runs).
  const rmPidfile = tag === undefined ? '' : `; rm -f "\${TMPDIR:-/tmp}/superd-oneshot-${tag}.pgid"`
  const wrapped = `${pidfile}trap 'trap "" TERM HUP INT; kill -TERM 0 2>/dev/null; exit 143' TERM HUP INT
trap 'trap "" TERM HUP INT; kill -TERM 0 2>/dev/null${rmPidfile}' EXIT
bash -lc ${shQuote(cmd)}`
  // The wrapper runs in its OWN session (setsid): sshd's session process
  // shares the command's process group, so an unqualified `kill 0` would take
  // the connection down with the group. In the private session kill 0 stays
  // scoped to wrapper + command + descendants.
  const sessioned = ['setsid', '--wait', 'bash', '-c', wrapped]
  switch (plan.kind) {
    case 'ssh':
      // ssh 把 host 后的 argv 用空格拼接交远端 shell 解析——预先整体 shQuote，
      // 远端只做这一层解析。
      return sshArgv(plan.connection ?? { host: plan.host }, { command: `setsid --wait bash -c ${shQuote(wrapped)}` })
    case 'docker':
      return ['docker', 'exec', '-i', '--', plan.container, ...sessioned]
    case 'incus':
      return ['incus', 'exec', '--force-noninteractive', plan.container, '--', ...sessioned]
  }
}

/** Persistent pty（Ruling 2）：ssh/incus 走宿主管道，docker 经 script(1) 托管宿主 PTY。 */
export function buildPtyArgv(plan: TargetPlan): string[] {
  switch (plan.kind) {
    case 'ssh':
      return sshArgv(plan.connection ?? { host: plan.host }, { tty: true, command: 'bash' })
    case 'docker':
      return ['script', '-qfec', `stty -echo 2>/dev/null ; exec docker exec -it -- ${shQuote(plan.container)} bash`, '/dev/null']
    case 'incus':
      return ['incus', 'exec', '--force-interactive', plan.container, '--', 'bash']
  }
}

/** BYO-PTY（§三 spawn）：工具只提供 PTY 托管 + Nonce 注入 + 收帧。 */
export function buildSpawnArgv(spawnCommand: string): string[] {
  return ['script', '-qfec', `stty -echo 2>/dev/null ; exec ${spawnCommand}`, '/dev/null']
}

/** superd-run helper argv (spec: docs/specs/remote-rescope §5). Probe and upload are single
 *  `sh -c` hops (busybox/alpine/darwin-safe); run/killgroup over ssh go through exactly one
 *  remote-shell parse, same discipline as buildOneShotArgv. */
export function buildHelperProbeArgv(plan: TargetPlan, assets: HelperAssets): string[] {
  const { ver, targets } = assets.manifest
  const checks = Object.entries(targets)
    .map(([triple, t]) => `d="$HOME/.cache/superd/run/${triple}-${ver}"; [ -x "$d/${t.file}" ] && { echo "SUPERD-READY $d/${t.file}"; "$d/${t.file}" banner; exit 0; };`)
    .join(' ')
  const script = `${checks} echo "SUPERD-PROBE $(uname -s 2>/dev/null || echo unknown) $(uname -m 2>/dev/null || echo unknown)"; exit 90`
  return helperShellArgv(plan, script)
}

export function buildHelperUploadArgv(plan: TargetPlan, triple: string, file: string, assets: HelperAssets): string[] {
  const dir = `$HOME/.cache/superd/run/${triple}-${assets.manifest.ver}`
  const script = `mkdir -p "${dir}" && cat > "${dir}/${file}.tmp" && chmod 0755 "${dir}/${file}.tmp" && mv -f "${dir}/${file}.tmp" "${dir}/${file}"`
  return helperShellArgv(plan, script)
}

export function buildHelperOneShotArgv(plan: TargetPlan, binPath: string, options: { tag: string; cmd: string }): string[] {
  const { tag, cmd } = options
  switch (plan.kind) {
    case 'ssh':
      // `exec` makes the helper the direct child of sshd's session process — the PDEATHSIG
      // anchor (spec §5.6). One remote-shell parse, same as buildOneShotArgv.
      return sshArgv(plan.connection ?? { host: plan.host }, { command: `exec ${shQuote(binPath)} run --tag ${shQuote(tag)} -- bash -lc ${shQuote(cmd)}` })
    case 'docker':
      return ['docker', 'exec', '-i', '--', plan.container, binPath, 'run', '--tag', tag, '--', 'bash', '-lc', cmd]
    case 'incus':
      return ['incus', 'exec', '--force-noninteractive', plan.container, '--', binPath, 'run', '--tag', tag, '--', 'bash', '-lc', cmd]
  }
}

export function buildHelperKillgroupArgv(plan: TargetPlan, binPath: string, tag: string): string[] {
  switch (plan.kind) {
    case 'ssh':
      return sshArgv(plan.connection ?? { host: plan.host }, { command: `${shQuote(binPath)} killgroup --tag ${shQuote(tag)}` })
    case 'docker':
      return ['docker', 'exec', '--', plan.container, binPath, 'killgroup', '--tag', tag]
    case 'incus':
      return ['incus', 'exec', '--force-noninteractive', plan.container, '--', binPath, 'killgroup', '--tag', tag]
  }
}

function helperShellArgv(plan: TargetPlan, script: string): string[] {
  switch (plan.kind) {
    case 'ssh':
      return sshArgv(plan.connection ?? { host: plan.host }, { command: script })
    case 'docker':
      return ['docker', 'exec', '-i', '--', plan.container, 'sh', '-c', script]
    case 'incus':
      return ['incus', 'exec', '--force-noninteractive', plan.container, '--', 'sh', '-c', script]
  }
}
