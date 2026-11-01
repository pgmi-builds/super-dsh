import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRealRemoteHarness } from './real-harness.ts'

it('Hub spawn-error diagnostic reaches scoped model rendering without fabricating process-output counts', async () => {
  const { createServer } = await import('node:http')
  const { createRemoteJobExecutor } = await import('../../../super-dsh/superd-hub/dist/remote-row.js')
  const executor = createRemoteJobExecutor()
  const { upsertRemote } = await import('../../../super-dsh/superd-hub/dist/machines.js')
  const { installHubRemoteTransport } = await import('../../../super-dsh/superd-hub/dist/remote-row.js')
  const dir = await mkdtemp(join(tmpdir(), 'remote-spawn-error-'))
  let originalDiagnostic = ''
  const server = createServer(async (req, res) => {
    if (req.headers.cookie !== 'paired=spawn-error') { res.writeHead(401); res.end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString())
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    if (input.input) input.input.cwd = '/missing-task3-review-cwd'
    const response = await executor.handle(new Request('http://peer' + req.url, { method: 'POST', headers: req.headers as Record<string, string>, body: JSON.stringify(input), signal: abort.signal }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    for await (const chunk of response.body!) {
      const frame = JSON.parse(Buffer.from(chunk).toString())
      if (frame.stderr?.diagnostic) originalDiagnostic = frame.stderr.diagnostic
      res.write(chunk)
    }
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  upsertRemote(dir, { id: 'peer', name: 'spawn-error', origin: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, cookie: 'paired=spawn-error', enabled: true, addedAt: Date.now() })
  const h = await createRealRemoteHarness({ copies: 1 })
  const row = await h.ctx.plugin({ name: 'real-spawn-error-hub', apply: ctx => installHubRemoteTransport(ctx, { home: dir }) })
  try {
    const a = await h.createAgent('spawn-error')
    const value = await h.invoke(a, { action: 'exec', target: 'hub:peer', cmd: 'true', mode: 'oneshot' })
    expect(originalDiagnostic).toContain('exec: spawn failed')
    const tool = h.host.tools.get('remote', a)!
    const rendered = tool.output!.render!({} as never, value as never)[0] as { text: string }
    expect(rendered.text).toContain(originalDiagnostic)
    expect(value).toMatchObject({ exit: null, outputStats: {
      stdout: { total: 0, retained: 0, dropped: 0, returned: 0 },
      stderr: { total: 0, retained: 0, dropped: 0, returned: 0 },
    } })
  } finally { await h.dispose(); await row.dispose(); await executor.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) }
})

it('runs a local large script once through scoped remote, preserving shell literals and Unicode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-script-'))
  const script = join(dir, 'source.sh'), once = join(dir, 'once')
  await writeFile(script, '#'.repeat(5000) + `\nprintf x >> '${once}'\ncat <<'LITERAL'\n$HOME $(printf WRONG) \`printf WRONG\` 中🙂\nLITERAL\nprintf 'err' >&2\n`)
  const h = await createRealRemoteHarness({ copies: 1, driverOptions: { oneshotArgvFor: (_plan, cmd) => ['bash', '-c', cmd] } })
  try {
    const a = await h.createAgent('script')
    expect(await h.invoke(a, { action: 'exec', target: 'ssh:fixture', scriptPath: script, mode: 'oneshot' })).toMatchObject({ text: '$HOME $(printf WRONG) `printf WRONG` 中🙂\n', stderr: 'err', exit: 0 })
    expect(await readFile(once, 'utf8')).toBe('x')
    expect(await h.invoke(a, { action: 'exec', target: 'ssh:fixture', cmd: 'cat', stdin: 'raw $HOME `x` 中🙂', mode: 'oneshot' })).toMatchObject({ text: 'raw $HOME `x` 中🙂' })
  } finally { await h.dispose(); await rm(dir, { recursive: true, force: true }) }
})

it('rejects script conflicts before file reads or dial, and read failures before target discovery', async () => {
  const h = await createRealRemoteHarness({ copies: 1, driverOptions: { oneshotArgvFor: () => { throw new Error('WRONG DIAL') }, rosterRunner: async () => { throw new Error('WRONG DISCOVERY') } } })
  try {
    const a = await h.createAgent('invalid-script')
    for (const args of [
      { action: 'exec', target: 'ssh:fixture', scriptPath: '/missing', cmd: 'true' },
      { action: 'exec', target: 'ssh:fixture', scriptPath: '/missing', stdin: '' },
      { action: 'exec', target: 'pty:build', scriptPath: '/missing' },
      { action: 'exec', target: 'ssh:dev4:pty:lbl', scriptPath: '/missing' },
      { action: 'exec', target: 'ssh:fixture', scriptPath: 'relative.sh' },
      { action: 'exec', target: 'ssh:fixture', scriptPath: '/nul\0.sh' },
    ]) await expect(h.invoke(a, args)).rejects.toThrow(/E_SCRIPT/)
    await expect(h.invoke(a, { action: 'exec', target: 'fixture', scriptPath: '/missing-task3-source.sh' })).rejects.toThrow(/E_SCRIPT_READ/)
  } finally { await h.dispose() }
})

it('script rides Hub HTTP as ONE quoted bash -c command (F1/F2 fix): body survives the wire, business stdin stays the script input, no expansion', async () => {
  const { createServer } = await import('node:http')
  const { createRemoteJobExecutor } = await import('../../../super-dsh/superd-hub/dist/remote-row.js')
  const executor = createRemoteJobExecutor()
  const { upsertRemote } = await import('../../../super-dsh/superd-hub/dist/machines.js')
  const { installHubRemoteTransport } = await import('../../../super-dsh/superd-hub/dist/remote-row.js')
  const dir = await mkdtemp(join(tmpdir(), 'remote-script-hub-'))
  const script = join(dir, 'source.sh'), once = join(dir, 'once')
  await writeFile(script, '#'.repeat(2000) + `\nprintf x >> '${once}'\ncat <<'LITERAL'\n$HOME $(printf WRONG) \`printf WRONG\` q't 中🙂\nLITERAL\n`) // 2000 < hub 4096 argv cap (script now IS argv)
  let posts = 0, legacyPeer = false
  const server = createServer(async (req, res) => {
    if (req.headers.cookie !== 'paired=script') { res.writeHead(401); res.end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    if (JSON.parse(Buffer.concat(chunks).toString()).op === 'start') posts++
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    const response = await executor.handle(new Request('http://peer' + req.url, { method: 'POST', headers: req.headers as Record<string, string>, body: Buffer.concat(chunks), signal: abort.signal }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    for await (const chunk of response.body!) {
      const frame = JSON.parse(Buffer.from(chunk).toString())
      if (legacyPeer) { if (frame.stdout) delete frame.stdout.stats; if (frame.stderr) delete frame.stderr.stats }
      res.write(JSON.stringify(frame) + '\n')
    }
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  upsertRemote(dir, { id: 'peer', name: 'no-ssh', origin: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, cookie: 'paired=script', enabled: true, addedAt: Date.now() })
  const h = await createRealRemoteHarness({ copies: 1, driverOptions: { oneshotArgvFor: () => { throw new Error('WRONG SSH FALLBACK') } } })
  const providerRow = await h.ctx.plugin({ name: 'real-script-hub', apply: ctx => installHubRemoteTransport(ctx, { home: dir }) })
  try {
    const a = await h.createAgent('hub-script')
    expect(await h.invoke(a, { action: 'exec', target: 'hub:peer', scriptPath: script, mode: 'oneshot' })).toMatchObject({ text: "$HOME $(printf WRONG) `printf WRONG` q't 中🙂\n", exit: 0, outputStats: { stdout: { unit: 'bytes' } } })
    expect(await readFile(once, 'utf8')).toBe('x')
    expect(await h.invoke(a, { action: 'exec', target: 'hub:peer', cmd: 'cat', stdin: 'raw 中🙂', mode: 'oneshot' })).toMatchObject({ text: 'raw 中🙂' })
    await expect(h.invoke(a, { action: 'exec', target: 'hub:peer', cmd: 'x'.repeat(4097), mode: 'oneshot' })).rejects.toThrow(/4096/)
    expect(posts).toBe(2)
    legacyPeer = true
    const legacy = await h.invoke(a, { action: 'exec', target: 'hub:peer', cmd: `head -c 3500001 /dev/zero | tr '\\0' x; printf LAST`, mode: 'oneshot' })
    expect(legacy).toMatchObject({ outputStatsUnavailable: true })
    expect(legacy).not.toHaveProperty('outputStats')
    expect(legacy).not.toHaveProperty('notice')
    expect(legacy.text).not.toContain('truncated') // 0.3.2-e: 客户端留存兜住 3.5M——全量返回，lossy 前缀仅在驱逐时出现
    expect(legacy.text.startsWith('x')).toBe(true)
    expect(legacy.text.endsWith('LAST')).toBe(true)
    const tool = h.host.tools.get('remote', a)!
    const rendered = tool.output!.render!({} as never, legacy as never)[0] as { text: string }
    expect(rendered.text).toContain('peer output totals/retention unavailable')
    expect(rendered.text).not.toContain('original 30000')
  } finally { await h.dispose(); await providerRow.dispose(); await executor.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) }
})
