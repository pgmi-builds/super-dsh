import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRealRemoteHarness } from './real-harness.ts'

it('rejects unavailable Hub explicitly without falling back to SSH and keeps BYO working', async () => {
  const h = await createRealRemoteHarness({ copies: 1, driverOptions: { rosterRunner: async () => ({ exit: 1, stdout: '', stderr: '', timedOut: false, durationMs: 0 }), oneshotArgvFor: () => { throw new Error('WRONG SSH FALLBACK') } } })
  try {
    const a = await h.createAgent('absent')
    await expect(h.invoke(a, { action: 'exec', target: 'hub:abcd', cmd: 'printf forbidden' })).rejects.toThrow(/Hub.*unavailable/)
    await h.invoke(a, { action: 'add', target: 'pty:t', spawn: 'bash' })
    expect(await h.invoke(a, { action: 'exec', target: 'pty:t', cmd: 'printf ready' })).toMatchObject({ text: 'ready' })
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
    expect(await h.invoke(a, { action: 'status' })).toMatchObject({ text: expect.stringContaining('hub machines: none') })
    const { ensureSelf } = await import('../../../super-dsh/superd-hub/dist/machines.js')
    await expect(h.invoke(a, { action: 'exec', target: `hub:${ensureSelf(home, 'local').id}`, cmd: 'printf forbidden' })).rejects.toThrow(/remote machine|local execution/)
    await provider.dispose()
    expect(description()).not.toContain('hub:<m4>')
    expect(changes).toBeGreaterThanOrEqual(2)
    await expect(h.invoke(a, { action: 'exec', target: 'hub:abcd', cmd: 'printf forbidden' })).rejects.toThrow(/Hub.*unavailable/)
  } finally { await provider?.dispose(); await h.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('real scoped Hub calls preserve shell state, isolate Agent incarnations and leave provider alive when tool row exits', async () => {
  const { createServer } = await import('node:http')
  const { registerPtyExecutor } = await import('../../../super-dsh/superd-hub/dist/exec-pty-rpc.js')
  const { upsertRemote } = await import('../../../super-dsh/superd-hub/dist/machines.js')
  const { installHubRemoteTransport } = await import('../../../super-dsh/superd-hub/dist/remote-row.js')
  const home = await mkdtemp(join(tmpdir(), 'remote-hub-scoped-'))
  const h = await createRealRemoteHarness({ copies: 2, driverOptions: { execTimeoutSec: 1 } })
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
    const firstPty = await h.invoke(first, { action: 'exec', target: 'hub:peer', cmd: 'cd /tmp; export OWNER_VALUE=old; printf first' })
    // 0.3.2-c：hub PTY = canonical 会话——回执有身份与 cwd，不再有「no session id」横幅。
    expect(firstPty).toMatchObject({ cwd: '/tmp' })
    expect(firstPty).toHaveProperty('session')
    expect(firstPty.text).toContain('first')
    expect(firstPty.text).not.toContain('no session id')
    const sessionId = (firstPty as unknown as { session: string }).session
    // 会话内状态跨 dispatch 存活（复用按 id 寻址，与 ssh/docker 同形）。
    expect((await h.invoke(first, { action: 'exec', target: sessionId, cmd: 'printf %s "$OWNER_VALUE"' })).text).toContain('old')
    // P4/P5：超时不杀，handoff 成 running job（timedOut 如实，会话存活）。
    expect(((await h.invoke(first, { action: 'exec', target: sessionId, cmd: 'sleep 2' })) as { notice?: string }).notice ?? '').toContain('interrupted')
    // spec 2026-11-01: the timed-out session is still the machine's busy default — hand it off, then the machine exec opens a fresh one
    await h.invoke(first, { action: 'handoff', target: 'hub:peer' })
    const full = await h.invoke(first, { action: 'exec', target: 'hub:peer', cmd: 'printf %150s | tr " " x' })
    expect(full.text).toBe('x'.repeat(150)) // 0.3.2-e: 自有窗口已删——全量返回，无 banner
    // Agent 隔离：另一个 Agent incarnation 摸不到本 Agent 的会话（owner-scoped 池）。
    const other = await h.createAgent('other-session')
    await expect(h.invoke(other, { action: 'exec', target: sessionId, cmd: 'true' })).rejects.toThrow(/E_NO_SESSION/)
    await h.disposeAgent(other)
    // 行退出 → 工具面卸载，transport 服务存活；新 Agent 拿到全新 hub shell（旧 owner 的 env 不泄漏）。
    await h.rows[0]!.dispose()
    expect(h.ctx.get('superdRemoteTransport')).toBeDefined()
    expect(h.visibleTools(first).some(t => t.name === 'remote')).toBe(false)
    const fresh = await h.createAgent('fresh')
    expect((await h.invoke(fresh, { action: 'exec', target: 'hub:peer', cmd: 'printf "%s" "${OWNER_VALUE-empty}"' })).text).toContain('empty')
  } finally {
    await h.dispose(); await providerRow.dispose(); off()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
})
