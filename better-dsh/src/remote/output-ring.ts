import type { OutputStats } from './hub-contract.ts'

const continuation = (byte: number): boolean => (byte & 0xc0) === 0x80
function completeUtf8End(bytes: Buffer): number {
  if (!bytes.length) return 0
  let start = bytes.length - 1
  while (start > 0 && continuation(bytes[start]!) && bytes.length - start < 4) start--
  const lead = bytes[start]!
  const width = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1
  return bytes.length - start < width ? start : bytes.length
}
/** Byte-addressed decoded output: mid-codepoint cursors skip forward and explicitly report loss. */
export function readUtf8Tail(bytes: Buffer, totalBytes: number, fromByte: number): { text: string; nextOffset: number; lossy: boolean } {
  if (!Number.isSafeInteger(fromByte) || fromByte < 0) throw new Error('Output cursor must be a non-negative safe byte offset')
  const start = totalBytes - bytes.length
  let offset = Math.max(0, Math.min(bytes.length, fromByte - start))
  let lossy = fromByte < start
  while (offset < bytes.length && continuation(bytes[offset]!)) { offset++; lossy = true }
  const end = completeUtf8End(bytes)
  return { text: bytes.subarray(Math.min(offset, end), end).toString('utf8'), nextOffset: start + end, lossy }
}

/** Native/PTY retention is UTF16 units; cursor offsets remain real UTF8 bytes. Input is decoded text. */
export class Utf16TailRing {
  text = ''
  total = 0
  private totalBytes = 0
  constructor(readonly capacity = 4_000_000) {}
  push(text: string): void {
    this.total += text.length
    this.totalBytes += Buffer.byteLength(text)
    this.text = (this.text + text).slice(-this.capacity)
    if (this.text.charCodeAt(0) >= 0xdc00 && this.text.charCodeAt(0) <= 0xdfff) this.text = this.text.slice(1)
  }
  stats(returned = this.text.length): OutputStats {
    return { unit: 'utf16', total: this.total, retained: this.text.length, dropped: this.total - this.text.length, returned, retentionLimit: this.capacity }
  }
  read(fromByte: number): ReturnType<typeof readUtf8Tail> { return readUtf8Tail(Buffer.from(this.text), this.totalBytes, fromByte) }
}

/** Raw byte retention for Hub oneshot. Tail/read starts skip partial UTF8 prefixes, never invent replacement characters. */
export class ByteTailRing {
  total = 0
  private chunks: Buffer[] = []
  private retained = 0
  constructor(readonly capacity = 4 * 1024 * 1024) {}
  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.total += chunk.length
    this.chunks.push(chunk)
    this.retained += chunk.length
    let drop = this.retained - this.capacity
    while (drop > 0) {
      const head = this.chunks[0]!
      const count = Math.min(drop, head.length)
      if (count === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(count)
      this.retained -= count
      drop -= count
    }
  }
  tail(maxBytes = this.retained): Buffer {
    let skip = Math.max(0, this.retained - maxBytes)
    const out: Buffer[] = []
    for (const chunk of this.chunks) {
      if (skip >= chunk.length) { skip -= chunk.length; continue }
      out.push(chunk.subarray(skip)); skip = 0
    }
    const bytes = Buffer.concat(out)
    let offset = 0
    while (offset < bytes.length && continuation(bytes[offset]!)) offset++
    return bytes.subarray(offset, completeUtf8End(bytes))
  }
  stats(returned: number = this.tail().length): OutputStats {
    return { unit: 'bytes', total: this.total, retained: this.retained, dropped: this.total - this.retained, returned, retentionLimit: this.capacity }
  }
  read(fromByte: number): ReturnType<typeof readUtf8Tail> { return readUtf8Tail(Buffer.concat(this.chunks), this.total, fromByte) }
}
