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

/** Workbench 目标语法（spec remote-default-pty §1/§2，2026-11-01）：`<machine>` = 默认 PTY 槽（mode:"oneshot" 显式无状态），
 * `pty:<id|label>` 复用已隔离会话，裸名池直达；旧 `<machine>:pty[:label]` 创建语法与 `hub:<m4>:pty` 已移除（handoff 取得可寻址会话）。 */
export type TargetForm =
  | { form: 'empty' }
  | { form: 'bare'; name: string }
  | { form: 'ssh-prefix' }                                                     // 'ssh'：仅 ssh 参数在场时有义（BYO 自动 id）
  | { form: 'pty-selector'; idOrLabel?: string }                               // 'pty' / 'pty:<id|label>'
  | { form: 'direct'; transport: 'ssh' | 'docker' | 'incus'; name: string }     // ssh:dev4（经统一池解析，含 BYO 身份）
  | { form: 'hub'; machine: string }

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
    if (segs.length > 1) throw new TargetFormatError(`[E_TARGET_FORMAT] remote: ${JSON.stringify(target)} — hub takes a machine id (hub:<m4>); a hub machine's exec opens its default PTY, and handoff detaches it as pty:<id>`)
  }
  for (const transport of TRANSPORTS) {
    if (!target.startsWith(`${transport}:`)) continue
    const rest = target.slice(transport.length + 1)
    if (rest.length === 0) throw new TargetFormatError(`[E_TARGET_FORMAT] remote: ${JSON.stringify(target)} — ${transport} takes a name`)
    if (/(^|:)pty(:|$)/.test(rest))
      throw new TargetFormatError(`[E_TARGET_FORMAT] remote: ${JSON.stringify(target)} — the :pty creation suffix is gone; a machine's exec opens its default PTY and handoff detaches it as pty:<id>`)
    return { form: 'direct', transport, name: rest }
  }
  if (target.includes(':'))
    throw new TargetFormatError(`[E_TARGET_FORMAT] remote: unknown target ${JSON.stringify(target)} — transports are ssh: / docker: / incus: / hub:, the PTY selector is pty:<id|label>; a machine's exec opens its default PTY and handoff detaches it (the old :pty creation suffix is gone)`)
  return { form: 'bare', name: target }
}
