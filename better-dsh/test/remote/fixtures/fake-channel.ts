/**
 * 进程内 {@link ShellChannel} 假件 — `EventEmitter` 双工。`script(chunks)` 把
 * 数据段按序排队，由 `next()`/`flush()` 回放（测试借此控制跨 chunk 时机）；
 * `feed()` 绕过队列立即投递一段；`close(err)` 模拟通道关闭。
 *
 * @module dashr/remote/fixtures/fake-channel
 */
import { EventEmitter } from 'node:events'
import type { ShellChannel } from '../../../src/remote/session.ts'

export class FakeChannel extends EventEmitter implements ShellChannel {
  /** write() 收到的全部字符串（按序）— 断言命令原文与 `\x03` 用。 */
  readonly writes: string[] = []
  /** end() 已被调用（wedge 复位 / dispose）。 */
  ended = false
  /** close(err) 已被模拟。 */
  closed = false

  private queue: string[] = []

  /** 按序排队数据段；由 next()/flush() 回放。 */
  script(chunks: string[]): void {
    this.queue.push(...chunks)
  }

  /** 立即投递一段数据（绕过队列；string → Buffer 走 ShellChannel 真实形态）。 */
  feed(chunk: string): void {
    this.feedBytes(Buffer.from(chunk, 'utf8'))
  }

  /** 立即投递原始字节 — 跨 chunk 断在多字节字符中间的回归测试用。 */
  feedBytes(data: Buffer): void {
    this.emit('data', data)
  }

  /** 回放队列中的下一段；队列空则 no-op。 */
  next(): void {
    const chunk = this.queue.shift()
    if (chunk !== undefined) this.feed(chunk)
  }

  /** 按序回放完整个队列。 */
  flush(): void {
    while (this.queue.length > 0) this.next()
  }

  /** 模拟通道关闭（对齐 ssh2 channel 的 'close' 事件形态）。 */
  close(err?: Error): void {
    this.closed = true
    this.emit('close', err)
  }

  write(data: string): void {
    this.writes.push(data)
  }

  end(): void {
    this.ended = true
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.on('data', cb)
  }

  onClose(cb: (err?: Error) => void): void {
    this.on('close', cb)
  }
}
