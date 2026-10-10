import { expect, it } from 'vitest'
import * as processes from '../../src/remote/oneshot.ts'
import { readFile } from 'node:fs/promises'
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)) }
  throw new Error('condition not reached')
}
async function alive(pid: number) {
  try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return !/\) Z /.test(stat) } catch { return false }
}
it('streams before completion, reads nonconsuming UTF8 cursors and kills the whole live process group', async () => {
  expect(processes).toHaveProperty('startOneShot')
  const proc = processes.startOneShot(['bash', '-c', `printf 'first中'; bash -c 'trap "" TERM; sleep 30' >/dev/null 2>&1 & printf '%s' "$!" >&2; wait`])
  let completed = false
  void proc.done.then(() => { completed = true })
  try {
    await until(() => proc.read('stderr', 0).text.length > 0)
    const first = proc.read('stdout', 0)
    expect(first.text).toBe('first中'); expect(first.nextOffset).toBe(8)
    expect(proc.read('stdout', 0)).toEqual(first)
    expect(proc.read('stdout', first.nextOffset).text).toBe('')
    expect(completed).toBe(false)
    const pid = Number(proc.read('stderr', 0).text)
    expect(await alive(pid)).toBe(true)
    proc.cancel(); proc.cancel()
    await proc.done
    expect(await alive(pid)).toBe(false)
  } finally { proc.cancel(); await proc.done }
})
it('spawn failure diagnostics are outside stream bytes and done never rejects', async () => {
  expect(processes).toHaveProperty('startOneShot')
  const proc = processes.startOneShot(['/missing-task4-executable'])
  expect(await proc.done).toMatchObject({ exit: null })
  expect(proc.read('stderr', 0)).toMatchObject({ text: '', nextOffset: 0, diagnostic: expect.stringContaining('ENOENT'), stats: { total: 0 } })
})
