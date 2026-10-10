import { expect, it } from 'vitest'

it('exports a bounded ring whose UTF8 cursors do not confuse UTF16 positions', async () => {
  const mod = await import('../../src/remote/plugin.ts')
  expect(mod).toHaveProperty('Utf16TailRing')
  const { Utf16TailRing } = mod as typeof import('../../src/remote/plugin.ts') & { Utf16TailRing: new (cap: number) => { push(text: string): void; text: string; read(fromByte: number): { text: string; nextOffset: number; lossy: boolean }; stats(): unknown } }
  const ring = new Utf16TailRing(5)
  ring.push('A中🙂B') // 5 UTF16 units, 9 UTF8 bytes
  expect(ring.read(1)).toMatchObject({ text: '中🙂B', nextOffset: 9, lossy: false })
  expect(ring.read(2)).toMatchObject({ text: '🙂B', nextOffset: 9, lossy: true })
  ring.push('C')
  expect(ring.text).toBe('中🙂BC')
  expect(ring.stats()).toMatchObject({ total: 6, retained: 5, dropped: 1 })
  expect(ring.read(0)).toMatchObject({ text: '中🙂BC', nextOffset: 10, lossy: true })
  ring.push('DE') // eviction cuts into a surrogate pair: omit the whole codepoint
  expect(ring.text).toBe('BCDE')
  expect(ring.stats()).toMatchObject({ total: 8, retained: 4, dropped: 4 })
  expect(ring.read(10)).toMatchObject({ text: 'DE', nextOffset: 12, lossy: false })
})

it('byte ring UTF8 cursors defer incomplete codepoints and count byte eviction independently', async () => {
  const { ByteTailRing } = await import('../../src/remote/plugin.ts')
  const ring = new ByteTailRing(8)
  ring.push(Buffer.from([0x41, 0xe4, 0xb8]))
  expect(ring.read(0)).toEqual({ text: 'A', nextOffset: 1, lossy: false })
  ring.push(Buffer.from([0xad, 0xf0, 0x9f, 0x99, 0x82, 0x42]))
  expect(ring.read(1)).toEqual({ text: '中🙂B', nextOffset: 9, lossy: false })
  expect(ring.stats()).toEqual({ unit: 'bytes', total: 9, retained: 8, dropped: 1, returned: 8, retentionLimit: 8 })
  ring.push(Buffer.from('C'))
  expect(ring.read(0)).toEqual({ text: '🙂BC', nextOffset: 10, lossy: true })
  expect(ring.tail().toString()).toBe('🙂BC')
  expect(ring.stats()).toMatchObject({ total: 10, retained: 8, dropped: 2, returned: 6 })
})

it('empty-channel updates retain no zero-byte chunk metadata', async () => {
  const { ByteTailRing } = await import('../../src/remote/plugin.ts')
  const ring = new ByteTailRing(16)
  for (let i = 0; i < 100_000; i++) ring.push(Buffer.alloc(0))
  // Direct retention inspection is the resource invariant: zero bytes must retain zero chunks.
  expect(Reflect.get(ring, 'chunks')).toHaveLength(0)
  expect(ring.read(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
  ring.push(Buffer.from('kept'))
  for (let i = 0; i < 100_000; i++) ring.push(Buffer.alloc(0))
  expect(Reflect.get(ring, 'chunks')).toHaveLength(1)
  expect(ring.tail().toString()).toBe('kept')
})
