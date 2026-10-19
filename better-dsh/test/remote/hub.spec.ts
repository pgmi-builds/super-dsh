import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRealRemoteHarness } from './real-harness.ts'

it('rejects unavailable Hub explicitly without falling back to SSH and keeps BYO working', async () => {
  const h = await createRealRemoteHarness({ copies: 1, driverOptions: { rosterRunner: async () => ({ exit: 1, stdout: '', stderr: '', timedOut: false, durationMs: 0 }), oneshotArgvFor: () => { throw new Error('WRONG SSH FALLBACK') } } })
  try {
    const a = await h.createAgent('absent')
    await expect(h.invoke(a, { target: 'hub:abcd', cmd: 'printf forbidden' })).rejects.toThrow(/Hub.*unavailable/)
    expect(await h.invoke(a, { target: 'pty:t', spawn: 'bash', cmd: 'printf ready' })).toMatchObject({ text: 'ready' })
  } finally { await h.dispose() }
})

it('optional real Hub registration updates existing scoped catalog, keeps empty directory, rejects self and unmounts cleanly', async () => {
  const h = await createRealRemoteHarness({ copies: 1 })
  const home = await mkdtemp(join(tmpdir(), 'remote-hub-surface-'))
  let provider: { dispose(): Promise<void> } | undefined
  try {
    const a = await h.createAgent('existing')
    const description = () => h.visibleTools(a).find(t => t.name === 'remote')!.description
    expect(description()).not.toContain('hub:<m4>')
    const module = await import('../../../super-dsh/superd-hub/dist/remote-row.js').catch(() => ({}))
    expect(module).toHaveProperty('installHubRemoteTransport')
    const { installHubRemoteTransport } = module as typeof import('../../../super-dsh/superd-hub/dist/remote-row.js')
    let changes = 0
    a.ctx.on('tools/change', () => { changes++ })
    provider = await h.ctx.plugin({ name: 'real-hub', apply: (ctx) => installHubRemoteTransport(ctx, { home }) })
    expect(description()).toContain('hub:<m4>')
    expect(await h.invoke(a, {})).toMatchObject({ text: expect.stringContaining('hub machines: none') })
    const { ensureSelf } = await import('../../../super-dsh/superd-hub/dist/machines.js')
    await expect(h.invoke(a, { target: `hub:${ensureSelf(home, 'local').id}`, cmd: 'printf forbidden' })).rejects.toThrow(/remote machine|local execution/)
    await provider.dispose()
    expect(description()).not.toContain('hub:<m4>')
    expect(changes).toBeGreaterThanOrEqual(2)
    await expect(h.invoke(a, { target: 'hub:abcd', cmd: 'printf forbidden' })).rejects.toThrow(/Hub.*unavailable/)
  } finally { await provider?.dispose(); await h.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('real scoped Hub calls preserve shell state, isolate Agent incarnations and leave provider alive when tool row exits', async () => {
  const { createServer } = await import('node:http')
  const { registerPtyExecutor } = await import('../../../super-dsh/superd-hub/dist/exec-pty-rpc.js')
  const { upsertRemote } = await import('../../../super-dsh/superd-hub/dist/machines.js')
  const { installHubRemoteTransport } = await import('../../../super-dsh/superd-hub/dist/remote-row.js')
  const home = await mkdtemp(join(tmpdir(), 'remote-hub-scoped-'))
  const h = await createRealRemoteHarness({ copies: 2, driverOptions: { maxOutputChars: 100, execTimeoutSec: 1 } })
  const server = createServer()
  let handler: Parameters<Parameters<typeof registerPtyExecutor>[0]['registerUpgrade']>[0]['handler'] | undefined
  const off = await registerPtyExecutor({ registerUpgrade: route => { handler = route.handler; return () => { handler = undefined } } } as Parameters<typeof registerPtyExecutor>[0], { authorize: req => (req as import('node:http').IncomingMessage).headers.cookie === 'paired=fixture' })
  server.on('upgrade', (req, socket, head) => handler?.(req as never, socket as never, head as never))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as import('node:net').AddressInfo
  upsertRemote(home, { id: 'peer', name: 'no-ssh', origin: `http://127.0.0.1:${address.port}`, cookie: 'paired=fixture', enabled: true, addedAt: Date.now() })
  const providerRow = await h.ctx.plugin({ name: 'real-hub', apply: ctx => installHubRemoteTransport(ctx, { home }) })
  try {
    const first = await h.createAgent('same-session')
    const firstPty = await h.invoke(first, { target: 'hub:peer:pty', cmd: 'cd /tmp; export OWNER_VALUE=old; printf first' })
    // R2：hub PTY 回执自带通道标记（无 session 概念，与 oneshot 区分）
    expect(firstPty.text).toContain('[hub:peer pty — no session id, no parallel, no background]')
    expect(firstPty).toMatchObject({ cwd: '/tmp' })
    expect(firstPty.text).toContain('first')
    expect(await h.invoke(first, { target: 'hub:peer:pty', cmd: 'sleep 2' })).toHaveProperty('timedOut', true)
    const capped = await h.invoke(first, { target: 'hub:peer:pty', cmd: 'printf %150s | tr " " x' })
    expect(capped.text).toContain('[truncated: showing last 100 of 150 chars]')
    const oldDisposal = h.disposeAgent(first)
    const next = await h.createAgent('same-session', 'resume')
    expect((await h.invoke(next, { target: 'hub:peer:pty', cmd: 'export OWNER_VALUE=new; printf second' })).text).toContain('second')
    await oldDisposal
    await h.disposeAgent(first)
    expect((await h.invoke(next, { target: 'hub:peer:pty', cmd: 'printf %s "$OWNER_VALUE"' })).text).toContain('new')
    await h.rows[0]!.dispose()
    expect(h.ctx.get('superdRemoteTransport')).toBeDefined()
    expect(h.visibleTools(next).some(t => t.name === 'remote')).toBe(false)
    const fresh = await h.createAgent('fresh')
    expect((await h.invoke(fresh, { target: 'hub:peer:pty', cmd: 'printf "%s" "${OWNER_VALUE-empty}"' })).text).toContain('empty')
  } finally {
    await h.dispose(); await providerRow.dispose(); off()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
})
