import type { SshConnection } from './ssh-targets.ts'

/**
 * 统一 label 池（plan 2026-10-19-pty-workbench §2.5，user v2 裁决）：
 * **每 agent session 一个注册表**——机器名（ssh alias / docker / incus / hub）与认领
 * （BYO ssh 身份 / PTY 会话 label）共用一个命名空间，按到达顺序 first-mover-wins。
 * 机器名不落地存储：roster / 裸名 miss 时**按需现场采集**（与旧 resolveBareNode 的
 * on-demand 扫描同一逻辑），merge 进本 session 注册表；已立名字永不挪动——
 * 再次扫描时新出现的名字若撞上已立条目（哪怕是系统原生的 docker），对这个 session
 * 它就是 latecomer，加 `<transport>-<name>` 前缀。显式认领撞名直接 [E_LABEL_IN_USE]
 * （名字是模型选的，不自动改名）。无 spec 对比。
 */
export type PoolEntry =
  | { kind: 'ssh'; name: string; host: string }
  | { kind: 'ssh-byo'; name: string; connection: SshConnection }
  | { kind: 'docker'; name: string; container: string }
  | { kind: 'incus'; name: string; container: string }
  | { kind: 'hub'; name: string; machine: string }
  | { kind: 'pty'; name: string; id: string; label?: string; connection: string; byo: boolean }

export type Claim = Extract<PoolEntry, { kind: 'ssh-byo' | 'pty' }>

export interface MachineScan {
  sshHosts: readonly string[]
  docker: readonly string[]
  incus: readonly string[]
  hub: readonly string[]
}

/** label 字符集（与 BYO ssh label 同源）；禁 `pty` 与会话 id 形态（防 selector 歧义）。 */
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const PTY_ID_RE = /^pty-[a-z0-9]{4}$/
const RESERVED_LABELS = new Set(['pty'])

export function validateLabel(label: string): void {
  if (!LABEL_RE.test(label))
    throw new Error(`[E_BAD_LABEL] remote: label must match ${LABEL_RE.source} (got ${JSON.stringify(label)})`)
  if (RESERVED_LABELS.has(label) || PTY_ID_RE.test(label))
    throw new Error(`[E_BAD_LABEL] remote: ${JSON.stringify(label)} is reserved (session ids are auto-generated; pick a different label)`)
}

export function describeEntry(e: PoolEntry): string {
  switch (e.kind) {
    case 'ssh': return `ssh host ${e.name}`
    case 'ssh-byo': return `a BYO ssh identity (${e.name})`
    case 'docker': return `docker container ${e.container}`
    case 'incus': return `incus container ${e.container}`
    case 'hub': return `hub machine ${e.machine}`
    case 'pty': return `pty session ${e.id}${e.label !== undefined ? ` (label ${e.label})` : ''}`
  }
}

/** 机器身份键：同一实体重扫后名字保持稳定（按身份匹配，不按名字）。 */
const machineId = (e: PoolEntry): string | undefined =>
  e.kind === 'ssh' ? `ssh:${e.host}` : e.kind === 'docker' ? `docker:${e.container}` : e.kind === 'incus' ? `incus:${e.container}` : e.kind === 'hub' ? `hub:${e.machine}` : undefined

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export class LabelPool {
  /** 每 agent session 一个注册表：name → entry（机器 + 认领，到达序）。 */
  private readonly sessions = new Map<string, Map<string, PoolEntry>>()

  private registry(agent: string): Map<string, PoolEntry> {
    let reg = this.sessions.get(agent)
    if (reg === undefined) { reg = new Map(); this.sessions.set(agent, reg) }
    return reg
  }

  resolve(name: string, agent: string): PoolEntry | undefined {
    return this.sessions.get(agent)?.get(name)
  }

  /** 显式认领（BYO ssh / PTY label）：任何已立名字占用即拒——名字是模型选的，不自动改名。 */
  claim(name: string, agent: string, claim: Claim): void {
    const reg = this.registry(agent)
    const existing = reg.get(name)
    if (existing !== undefined)
      throw new Error(
        `[E_LABEL_IN_USE] remote: label ${JSON.stringify(name)} is already taken by ${describeEntry(existing)} — nothing was run.\n` +
        `  To address it:   use the name directly (creation always claims a fresh name — spawn/ssh never adopt)\n` +
        (existing.kind === 'pty' ? `  To free it:      close ${existing.id} ({action:"close", target:"pty:${existing.id}"}) — a session that died still holds its label until it is closed or reaped\n` : '') +
        `  To create new:   pick another label`,
      )
    reg.set(name, claim)
  }

  /** 生成不撞本 session 的 id（`pty-` PTY 会话 / `ssh-` BYO ssh 身份）。 */
  freshId(prefix: 'pty-' | 'ssh-', agent: string): string {
    const reg = this.registry(agent)
    for (;;) {
      let id = prefix
      for (let i = 0; i < 4; i++) id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
      if (!reg.has(id)) return id
    }
  }

  /**
   * 现场采集 merge（roster / 裸名 miss 触发）：按 ssh → docker → incus → hub 顺序并入。
   * 已立名字永不挪动：同一实体（身份键相同）保持原槽；新实体撞已立名字 = latecomer，
   * 自动加 `<transport>-<name>`（再冲突 -2/-3）——无论对方是认领还是更早的机器。
   * 本轮扫描里消失的机器出表（名字释放）；认领永远保留。
   */
  mergeScan(agent: string, scan: MachineScan): { renamed: Array<[PoolEntry, string]> } {
    const reg = this.registry(agent)
    const renamed: Array<[PoolEntry, string]> = []
    // 1. 身份匹配：本轮在场的机器若已注册（任意名字），保持原槽；缺席机器移出。
    const present = new Map<string, PoolEntry>()
    const addToPresent = (e: PoolEntry): void => { const id = machineId(e); if (id !== undefined) present.set(id, e) }
    for (const [name, e] of [...reg]) {
      const id = machineId(e)
      if (id === undefined) continue // 认领不动
      reg.delete(name)
      present.set(id, e)
    }
    // 2. 按加载序并入：身份已注册 → 原名回填；新名字空闲 → 占；占用 → latecomer 前缀。
    const place = (transport: 'ssh' | 'docker' | 'incus' | 'hub', raw: string, make: (name: string) => PoolEntry): void => {
      const id = `${transport}:${raw}`
      const known = present.get(id)
      if (known !== undefined) { reg.set(known.name, known); return }
      const fresh = make(raw)
      if (!reg.has(raw)) { reg.set(raw, fresh); return }
      let candidate = `${transport}-${raw}`, n = 2
      while (reg.has(candidate)) candidate = `${transport}-${raw}-${n++}`
      reg.set(candidate, make(candidate))
      renamed.push([fresh, candidate])
    }
    for (const host of scan.sshHosts) place('ssh', host, (name) => ({ kind: 'ssh', name, host }))
    for (const c of scan.docker) place('docker', c, (name) => ({ kind: 'docker', name, container: c }))
    for (const c of scan.incus) place('incus', c, (name) => ({ kind: 'incus', name, container: c }))
    for (const m of scan.hub) place('hub', m, (name) => ({ kind: 'hub', name, machine: m }))
    return { renamed }
  }

  /** 认领释放（会话 dispose/TTL；BYO 身份随 session 存亡）；幂等。 */
  release(name: string, agent: string): void {
    this.sessions.get(agent)?.delete(name)
  }

  /** roster 面：本 session 的全部条目（机器 + 认领，插入序）。 */
  list(agent: string): PoolEntry[] {
    return [...(this.sessions.get(agent)?.values() ?? [])]
  }

  /** driver dispose：全部 session 注册表清空。 */
  clear(): void { this.sessions.clear() }
}
