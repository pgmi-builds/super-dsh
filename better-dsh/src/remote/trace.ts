/**
 * R1 定位轮插桩（2026-11-01）：`SUPERD_REMOTE_TRACE=<file>` 时输出 JSONL 事件，否则全 no-op。
 * 动机：rig-only「PTY background + startup stdin」丢失只在 rig 长驻进程复现（bg-read 形状 13/13），
 * 本地全组合 0 复现——必须在实际 rig 宿主进程内拿到第一手事件流。
 *
 * 设计约束：
 *  - 热路径（write/onOutput）零同步 IO：事件先进内存缓冲，异步 flush（settle/dispose/满 200 条）。
 *  - env 未设置时每个入口都是一次函数调用 + 立即 return，不改变交付语义。
 *  - 失败静默（trace 永不破坏工具行为）；缓冲上限 5000 条防失控。
 */
const TRACE_PATH = process.env.SUPERD_REMOTE_TRACE ?? ''
const ENABLED = TRACE_PATH !== ''

let buf: string[] = []
let flushing = false

function serialize(ev: string, fields: Record<string, unknown>): string {
  let s: string
  try {
    s = JSON.stringify({ t: Date.now(), mono: Number(process.hrtime.bigint() / 1_000_000n), ev, ...fields })
  } catch {
    s = JSON.stringify({ t: Date.now(), ev, err: 'unserializable-fields' })
  }
  return s ?? `{\"t\":${Date.now()},\"ev\":${JSON.stringify(ev)},\"err\":\"null\"}`
}

export function trace(ev: string, fields: Record<string, unknown> = {}): void {
  if (!ENABLED) return
  buf.push(serialize(ev, fields))
  if (buf.length > 5_000) buf.splice(0, buf.length - 5_000)
  if (buf.length >= 200) void traceFlush()
}

export async function traceFlush(): Promise<void> {
  if (!ENABLED || flushing || buf.length === 0) return
  flushing = true
  const out = buf.splice(0).join('\n') + '\n'
  try {
    const [{ appendFile }, { dirname }] = await Promise.all([import('node:fs/promises'), import('node:path')])
    const dir = dirname(TRACE_PATH)
    try { await (await import('node:fs/promises')).mkdir(dir, { recursive: true }) } catch { /* 父目录已存在或不可建 */ }
    await appendFile(TRACE_PATH, out)
  } catch { /* 静默：诊断设施不得影响工具 */ }
  flushing = false
  if (buf.length > 0) void traceFlush()
}

/** 事件里的字节安全截断表示（JSON 转义 + 长度上限）。 */
export function traceRepr(s: string, max: number): string {
  const j = JSON.stringify(s) ?? 'null'
  return j.length > max ? `${j.slice(0, max)}…` : j
}
