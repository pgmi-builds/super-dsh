import type { SshConnection } from './ssh-targets.ts'
/** 解析后的传输计划：三种 CLI 传输之一。 */
export type TargetPlan =
  | { kind: 'ssh'; host: string; connection?: SshConnection }
  | { kind: 'docker'; container: string }
  | { kind: 'incus'; container: string }

export class TargetFormatError extends Error {
  readonly code = 'E_TARGET_FORMAT'
  constructor(message: string) { super(message); this.name = 'TargetFormatError' }
}

/** 显式协议选择器（Ruling P16）：可扩展新协议——加一个词即一条新传输腿。 */
const PREFIX_RE = /^(docker|incus|ssh):(.+)$/

/** spec §二.2 智能路由（Ruling P18）：显式选择器 > ssh 缺省；无别名表面——容器一律显式前缀，发现走 on-demand probe。 */
export function resolveTarget(target: string): TargetPlan {
  const raw = target.trim()
  if (raw.length === 0) throw new TargetFormatError('[E_TARGET_FORMAT] remote: empty target')
  const direct = PREFIX_RE.exec(raw)
  if (direct !== null) {
    if (direct[1] === 'ssh') return { kind: 'ssh', host: direct[2]! }
    return { kind: direct[1] as 'docker' | 'incus', container: direct[2]! }
  }
  return { kind: 'ssh', host: raw }
}

/** Workbench 目标语法（plan 2026-10-19-pty-workbench §1/§2）：结构化形态，route 的唯一输入。
 * `mode` 已退休：`<transport-target>:pty[:label]` 创建、`pty:<id|label>` 复用、裸 label 池直达。 */
export type TargetForm =
  | { form: 'empty' }
  | { form: 'bare'; name: string }
  | { form: 'ssh-prefix' }                                                     // 'ssh'：仅 ssh 参数在场时有义（BYO 自动 id）
  | { form: 'pty-selector'; idOrLabel?: string }                               // 'pty' / 'pty:<id|label>'
  | { form: 'direct'; transport: 'ssh' | 'docker' | 'incus'; name: string }     // ssh:dev4（经统一池解析，含 BYO 身份）
  | { form: 'create-pty'; transport: 'ssh' | 'docker' | 'incus'; name: string; label?: string } // ssh:dev4:pty[:label]
  | { form: 'hub'; machine: string }
  | { form: 'hub-pty'; machine: string; label?: string }                          // hub:<m4>:pty[:label]（0.3.2-c 起入统一会话池）

const TRANSPORTS = ['ssh', 'docker', 'incus'] as const

export function parseTargetForm(target: string | undefined): TargetForm {
  if (target === undefined || target.length === 0) return { form: 'empty' }
  if (target === 'pty') return { form: 'pty-selector' }
  if (target.startsWith('pty:')) {
    const rest = target.slice(4)
    if (rest.length === 0 || rest.includes(':'))
      throw new TargetFormatError(`[E_TARGET_FORMAT] remote: ${JSON.stringify(target)} — the pty selector takes exactly one id or label ("pty:p-1a2b", "pty:build")`)
    return { form: 'pty-selector', idOrLabel: rest }
  }
  if (target === 'ssh') return { form: 'ssh-prefix' }
  if (target === 'docker' || target === 'incus' || target === 'hub')
    throw new TargetFormatError(`[E_TARGET_FORMAT] remote: ${JSON.stringify(target)} is a transport prefix — pass ${target === 'hub' ? 'hub:<machine>' : `${target}:<name>`}`)
  if (target.startsWith('hub:')) {
    const segs = target.slice(4).split(':')
    if (segs[0] === undefined || segs[0].length === 0) throw new TargetFormatError(`[E_TARGET_FORMAT] remote: ${JSON.stringify(target)} — hub takes a machine id`)
    if (segs.length === 1) return { form: 'hub', machine: segs[0]! }
    if (segs.length === 2 && segs[1] === 'pty') return { form: 'hub-pty', machine: segs[0]! }
    if (segs.length === 3 && segs[1] === 'pty') {
      if (segs[2] === undefined || segs[2]!.length === 0) throw new TargetFormatError(`[E_TARGET_FORMAT] remote: ${JSON.stringify(target)} — empty label after ":pty:"`)
      return { form: 'hub-pty', machine: segs[0]!, label: segs[2]! }
    }
    throw new TargetFormatError(`[E_TARGET_FORMAT] remote: ${JSON.stringify(target)} — hub PTY is hub:<m4>:pty[:label]`)
  }
  for (const transport of TRANSPORTS) {
    if (!target.startsWith(`${transport}:`)) continue
    const rest = target.slice(transport.length + 1)
    if (rest.length === 0) throw new TargetFormatError(`[E_TARGET_FORMAT] remote: ${JSON.stringify(target)} — ${transport} takes a name`)
    const ptyAt = rest.lastIndexOf(':pty')
    if (ptyAt === -1) return { form: 'direct', transport, name: rest }
    const base = rest.slice(0, ptyAt)
    if (base.length === 0) throw new TargetFormatError(`[E_TARGET_FORMAT] remote: ${JSON.stringify(target)} — ":pty" needs a transport target before it ("ssh:pty" is the host named pty)`)
    const tail = rest.slice(ptyAt + 4)
    if (tail.startsWith(':')) {
      if (tail.length === 1) throw new TargetFormatError(`[E_TARGET_FORMAT] remote: ${JSON.stringify(target)} — empty label after ":pty:"`)
      return { form: 'create-pty', transport, name: base, label: tail.slice(1) }
    }
    if (tail.length > 0) throw new TargetFormatError(`[E_TARGET_FORMAT] remote: ${JSON.stringify(target)} — unexpected ${JSON.stringify(tail)} after ":pty"`)
    return { form: 'create-pty', transport, name: base }
  }
  if (target.includes(':'))
    throw new TargetFormatError(`[E_TARGET_FORMAT] remote: unknown target ${JSON.stringify(target)} — transports are ssh: / docker: / incus: / hub:, the PTY selector is pty:<id|label>, creation appends :pty (roster lists names)`)
  return { form: 'bare', name: target }
}
