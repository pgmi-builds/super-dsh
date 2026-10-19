import { randomBytes } from 'node:crypto'
import type { OutputStats } from './hub-contract.ts'

/** 收帧帧体：退出码 + 只读回传的 cwd（Non-Goal ②：报告不重建）。 */
export interface PtyFrame { exit: number; cwd: string | null }

/** 8 字节随机串的 hex 形（spec §五.2：每次下发前生成）。 */
export function genNonce(bytes = 8): string {
  return randomBytes(bytes).toString('hex')
}

/** 命令整行：花括号复合体 + Nonce 收帧尾（spec §五.2 的 printf 逐字落地 + cwd 第三字段）。 */
export function wrapPtyCommand(cmd: string, nonce: string): string {
  return `{\n${cmd}\n} ; __superd_e=$? ; printf '\\033]133;E;${nonce};%s\\007' "$(env -0 | base64 | tr -d '\\n\\r')" ; printf '\\033]133;D;${nonce};%s;%s\\007' "$__superd_e" "$PWD" ; unset __superd_e\n`
}

/** init 整行：哑终端（echo/PS1/PS2/TERM）+ 固定 40×120（Non-Goal ③）+ INIT 帧。 */
export function buildInitCommand(nonce: string): string {
  return `stty -echo 2>/dev/null ; stty rows 40 cols 120 2>/dev/null ; PS1='' ; PS2='' ; export TERM=dumb ; printf '\\033]133;E;${nonce};%s\\007' "$(env -0 | base64 | tr -d '\\n\\r')" ; printf '\\033]133;D;${nonce};0;%s\\007' "$PWD"\n`
}

const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)?|\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

export function normalizePtyText(s: string): string {
  return stripAnsi(s).replace(/\r\n/g, '\n').replace(/\r/g, '')
}

export function tailWindow(text: string, cap: number, stats?: OutputStats): { text: string; truncated?: number; stats?: OutputStats } {
  let tail = text.slice(-cap)
  if (tail.charCodeAt(0) >= 0xdc00 && tail.charCodeAt(0) <= 0xdfff) tail = tail.slice(1)
  const returned = stats?.unit === 'bytes' ? Buffer.byteLength(tail) : tail.length
  const total = stats?.total ?? text.length
  const updated = stats === undefined ? {} : { stats: { ...stats, returned } }
  if (total <= returned) return { text: tail, ...updated }
  const unit = stats?.unit === 'bytes' ? 'bytes' : 'chars'
  const eviction = stats !== undefined && stats.dropped > 0 ? `; retained ${stats.retained}, dropped head ${stats.dropped}, retention limit ${stats.retentionLimit} ${stats.unit === 'bytes' ? 'bytes' : 'UTF-16 code units'}` : ''
  return { text: `[truncated: showing last ${returned} of ${total} ${unit}${eviction}]\n${tail}`, truncated: total, ...updated }
}

export interface FrameParserEvents {
  /** 输出文本：feed 路径经 normalize（剥 ANSI/规整换行）；flush 路径为**裸放出**（残余字节原样，勿假设已剥洗）。 */
  onOutput?(text: string): void
  onFrame(frame: PtyFrame): void
  /** env 侧信道（E 帧，`env -0 | base64`）：先于 D 帧到达，捕获后不入输出环。 */
  onEnv?(b64: string): void
}
export interface NonceFrameParser { feed(chunk: string): void; flush(): void }

const FRAME_BODY_RE = /^(\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/ // cwd 是尾字段：合法路径可含 `;`，只有 BEL/ESC 终止它
const ENV_BODY_RE = /^([A-Za-z0-9+/=]*)\x07/ // E 帧体 = 纯 base64（值不回传；名字+hash 差分在调用侧算）

/**
 * 单 nonce、单帧解析器：一轮 dispatch 一个实例。只认 `\x1b]133;D;<nonce>;`，
 * 错误 nonce 的静态/伪造 marker 永不匹配，按普通输出流过（再经 ANSI 剥洗）。
 * 缓冲尾若可能是 marker 前缀则扣留，flush() 时作为输出放出。
 */
export function createNonceFrameParser(nonce: string, events: FrameParserEvents): NonceFrameParser {
  const prefix = `\x1b]133;D;${nonce};`
  const prefixE = `\x1b]133;E;${nonce};`
  const prefixes = [prefix, prefixE]
  let buf = ''
  let done = false

  const emit = (raw: string): void => {
    const text = normalizePtyText(raw)
    if (text.length > 0) events.onOutput?.(text)
  }

  /** 缓冲尾若是任一候选前缀的真前缀则扣留（D/E 共用）；flush() 放出残余。 */
  const holdback = (): number => {
    let best = 0
    for (const p of prefixes) {
      const max = Math.min(buf.length, p.length - 1)
      for (let k = max; k > best; k--) if (buf.endsWith(p.slice(0, k))) { best = k; break }
    }
    return best
  }

  /** 扫描最早出现的帧：E（env 侧信道）先于 D 下发；D = settle，帧后字节丢弃。 */
  const consume = (): void => {
    if (done) return
    let idx = -1
    let isEnv = false
    for (const p of prefixes) {
      const i = buf.indexOf(p)
      if (i >= 0 && (idx === -1 || i < idx)) { idx = i; isEnv = p === prefixE }
    }
    if (idx < 0) {
      const keep = holdback()
      emit(buf.slice(0, buf.length - keep))
      buf = buf.slice(buf.length - keep)
      return
    }
    emit(buf.slice(0, idx))
    const rest = buf.slice(idx + (isEnv ? prefixE.length : prefix.length))
    if (isEnv) {
      const m = ENV_BODY_RE.exec(rest)
      if (m === null) { buf = buf.slice(idx); return } // E 帧体未到齐，整段扣留
      if (m[1]!.length > 0) events.onEnv?.(m[1]!)
      buf = rest.slice(m[0].length)
      consume()
      return
    }
    const m = FRAME_BODY_RE.exec(rest)
    if (m === null) { buf = buf.slice(idx); return } // 帧体未到齐，整段扣留
    events.onFrame({ exit: Number(m[1]!), cwd: m[2]!.length > 0 ? m[2]! : null })
    done = true // 帧后字节一律丢弃（下一轮是新解析器）
    buf = ''
  }

  return {
    feed(chunk: string): void { buf += chunk; consume() },
    // 流结束 = 裸放出扣留的残余（含未完成的 marker 前缀）：不经过 ANSI 剥洗——
    // stripAnsi 会把未闭合 OSC 整段吃掉，扣留字节就此蒸发，违背 flush 语义。
    flush(): void { if (buf.length > 0) events.onOutput?.(buf); buf = '' },
  }
}

/** E 帧 payload → name→value-hash（值不离开端点；hash 只为 changed 判定）。空/坏 payload → undefined。 */
export function decodeEnvSnapshot(b64: string): Map<string, number> | undefined {
  if (b64.length === 0) return undefined
  let text: string
  try { text = Buffer.from(b64, 'base64').toString('utf8') } catch { return undefined }
  const map = new Map<string, number>()
  for (const entry of text.split('\0')) {
    if (entry.length === 0) continue
    const eq = entry.indexOf('=')
    const name = eq === -1 ? entry : entry.slice(0, eq)
    if (name.startsWith('__superd')) continue // 侧信道自身的收帧变量（wrapPtyCommand 的 __superd_e）
    let h = 5381
    const value = eq === -1 ? '' : entry.slice(eq + 1)
    for (let i = 0; i < value.length; i++) h = ((h * 33) ^ value.charCodeAt(i)) >>> 0
    map.set(name, h)
  }
  return map.size > 0 ? map : undefined
}

export interface EnvDelta { added: string[]; changed: string[]; removed: string[] }

/** prev 未知（init 侧信道失败）时返回 undefined——不报告假 delta。 */
export function diffEnv(prev: Map<string, number> | undefined, next: Map<string, number>): EnvDelta | undefined {
  if (prev === undefined) return undefined
  const added: string[] = [], changed: string[] = [], removed: string[] = []
  for (const [name, h] of next) {
    if (!prev.has(name)) added.push(name)
    else if (prev.get(name) !== h) changed.push(name)
  }
  for (const name of prev.keys()) if (!next.has(name)) removed.push(name)
  added.sort(); changed.sort(); removed.sort()
  return { added, changed, removed }
}
