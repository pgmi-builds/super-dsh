import { expect, it } from 'vitest'
import { access } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { createRealRemoteHarness } from './real-harness.ts'
import { createSshFixture, withSshFixture } from './ssh-fixture.ts'

async function reachable(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}

// The break is skipping owned fixture cleanup when import/setup or disposal
// rejects. Real servers/keys must be gone, not merely a mocked cleanup call.
it.each(['import', 'harness setup', 'harness disposal'])('cleans real SSH listeners and keys after %s fails', async phase => {
  let fixture: Awaited<ReturnType<typeof createSshFixture>> | undefined
  try {
    const attempt = withSshFixture(async owned => {
      fixture = owned
      let h: Awaited<ReturnType<typeof createRealRemoteHarness>> | undefined
      try {
        expect(await reachable(owned.destination.port)).toBe(true)
        await access(owned.destination.key)
        if (phase === 'import') {
          // Actual missing delivery import after the fixture has started.
          await import(owned.directory + '/missing-entry.mjs')
        }
        h = await createRealRemoteHarness({ copies: 1 })
        if (phase === 'harness setup') {
          await h.ctx.plugin(() => { throw new Error('deliberate harness setup failure') })
        }
        if (phase === 'harness disposal') {
          const dispose = h.dispose
          h.dispose = async () => { await dispose(); throw new Error('deliberate harness disposal failure') }
        }
      } finally {
        await h?.dispose()
      }
    })
    await expect(attempt).rejects.toThrow(phase === 'import' ? /missing-entry/ : /deliberate harness/)
    expect(fixture).toBeDefined()
    await expect(access(fixture!.destination.key)).rejects.toThrow()
    await expect(access(fixture!.jump.key)).rejects.toThrow()
    await expect(access(fixture!.directory)).rejects.toThrow()
    expect(await reachable(fixture!.destination.port)).toBe(false)
    expect(await reachable(fixture!.jump.port)).toBe(false)
  } finally { await fixture?.cleanup() } // RED failure must not itself leave resources.
}, 10000)

it('bounds teardown of a real stopped SSH server and still removes private fixture keys', async () => {
  const fixture = await createSshFixture()
  let pid: number | undefined
  let shutdown: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { readFile } = await import('node:fs/promises')
    pid = Number(await readFile(fixture.directory + '/jump/pid', 'utf8'))
    process.kill(pid, 'SIGSTOP') // Real owned sshd cannot act on queued SIGTERM.
    shutdown = fixture.cleanup()
    const finished = await Promise.race([
      shutdown.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2500) }),
    ])
    expect(finished).toBe(true)
    await expect(access(fixture.jump.key)).rejects.toThrow()
    expect(await reachable(fixture.jump.port)).toBe(false)
  } finally {
    if (timer) clearTimeout(timer)
    if (pid) { try { process.kill(pid, 'SIGCONT') } catch { /* already killed */ } }
    if (shutdown) await shutdown
    else await fixture.cleanup()
  }
}, 10000)
