import { expect, it } from 'vitest'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { readFile } from 'node:fs/promises'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { createRealRemoteHarness } from './real-harness.ts'

async function harness(controller = true, driverOptions: Record<string, unknown> = {}) {
  const h = await createRealRemoteHarness({ copies: 1, driverOptions: { execTimeoutSec: 0.05, oneshotArgvFor: (_p, cmd) => ['bash', '-c', cmd], rosterRunner: async () => { throw new Error('DISCOVERY BEFORE ADMISSION') }, ...driverOptions } })
  const jobs = await h.ctx.plugin(LocalJobs, { pumpPollMs: 10 })
  const tools = controller ? await h.ctx.plugin(ToolJobs, { completionDelivery: 'quiet' }) : undefined
  return { ...h, async dispose() { await h.dispose(); await tools?.dispose(); await jobs.dispose() } }
}
it('exposes live output through native jobs with owner fencing, consuming reads, kill and final drain', async () => {
  const h = await harness()
  try {
    const a = await h.createAgent('jobs-a'), b = await h.createAgent('jobs-b')
    const value = await h.invoke(a, { target: 'ssh:x', cmd: 'printf first; printf %s $$ >&2; sleep 30; printf last', run_in_background: true }) as unknown as { jobId: string }
    expect(value.jobId).toMatch(/^remote-/)
    const id = JobId(value.jobId), registry = a.ctx.get('jobs')!
    let text = ''
    for (let i = 0; i < 100 && !text.includes('first'); i++) { text += registry.read(id, a.id).chunks.map(c => c.text).join(''); await new Promise(r => setTimeout(r, 20)) }
    expect(text).toContain('first'); await new Promise(r => setTimeout(r, 100)); expect(registry.get(id, a.id).status).toBe('running')
    const pid = Number(registry.readAt(id, 0, a.id).chunks.filter(c => c.channel === 'stderr').map(c => c.text).join(''))
    expect(pid).toBeGreaterThan(0)
    expect(registry.read(id, a.id).chunks).toEqual([])
    expect(() => registry.read(id, b.id)).toThrow(); expect(() => registry.kill(id, b.id)).toThrow()
    const killed = await a.ctx.tools.execute({ name: 'job_kill', arguments: { job_id: id }, agent: a, signal: new AbortController().signal, callId: 'kill-test' as never })
    expect(killed.isError).toBeFalsy()
    expect((await registry.wait(id, 5000, a.id)).status).toBe('killed')
    await expect(readFile(`/proc/${pid}/stat`, 'utf8')).rejects.toThrow(/ENOENT/)
    const output = await a.ctx.tools.execute({ name: 'job_output', arguments: { job_id: id }, agent: a, signal: new AbortController().signal, callId: 'output-test' as never })
    expect(output.value).toMatchObject({ text: '', job: { status: 'killed' } })
  } finally { await h.dispose() }
}, 10000)

it('PTY background jobs: live merged output, interrupt cancels with exit 130, session survives; sync timeout hands off with a pollable jobId (P4/P5)', async () => {
  const h = await harness(true, { execTimeoutSec: 2, ptyArgvFor: () => ['script', '-qfec', 'bash', '/dev/null'] })
  try {
    const a = await h.createAgent('pty-jobs')
    const registry = a.ctx.get('jobs')!
    const value = await h.invoke(a, { target: 'ssh:x', mode: 'pty', cmd: 'printf first; sleep 30', run_in_background: true }) as unknown as { jobId: string }
    expect(value.jobId).toMatch(/^remote-/)
    const id = JobId(value.jobId)
    let text = ''
    for (let i = 0; i < 100 && !text.includes('first'); i++) { text += registry.read(id, a.id).chunks.map(c => c.text).join(''); await new Promise(r => setTimeout(r, 20)) }
    expect(text).toContain('first')
    expect(registry.get(id, a.id).status).toBe('running')
    const killed = await a.ctx.tools.execute({ name: 'job_kill', arguments: { job_id: id }, agent: a, signal: new AbortController().signal, callId: 'pty-kill' as never })
    expect(killed.isError).toBeFalsy()
    expect(await registry.wait(id, 5_000, a.id)).toMatchObject({ status: 'killed' })
    const after = await h.invoke(a, { target: 'ssh:x', mode: 'pty', cmd: 'echo alive' }) as unknown as { text: string }
    expect(after.text).toContain('alive')
    const handed = await h.invoke(a, { target: 'ssh:x', mode: 'pty', cmd: 'sleep 2; printf tardy', timeout: 1 }) as unknown as { jobId: string; running?: boolean }
    expect(handed.jobId).toMatch(/^remote-/)
    expect(handed.running).toBe(true) // rendered model surface reads 'still running — poll job_output <id>'; the value carries running+jobId fields
    expect(await registry.wait(JobId(handed.jobId), 5_000, a.id)).toMatchObject({ status: 'completed' })
  } finally { await h.dispose() }
}, 20_000)
it('refuses admission before discovery, refuses hub PTY backgrounds, and keeps foreground without jobs', async () => {
  const h = await harness(false)
  try {
    const a = await h.createAgent('refusal')
    await expect(h.invoke(a, { target: 'bare', cmd: 'true', run_in_background: true })).rejects.toThrow(/controller/)
    await expect(h.invoke(a, { target: 'hub:m', mode: 'pty', cmd: 'true', run_in_background: true })).rejects.toThrow(/hub/)
    // controller-less harness: registry admission refuses ALL backgrounds (gate precedes routing) —
    // byop-without-spawn reaching E_NO_SESSION as a failed job is covered by admission order, not testable here
  } finally { await h.dispose() }
  const plain = await createRealRemoteHarness({ copies: 1, driverOptions: { oneshotArgvFor: (_p, cmd) => ['bash', '-c', cmd] } })
  try {
    const a = await plain.createAgent('without-jobs')
    await expect(plain.invoke(a, { target: 'ssh:x', cmd: 'true', run_in_background: true })).rejects.toThrow(/jobs/)
    expect(await plain.invoke(a, { target: 'ssh:x', cmd: 'printf foreground' })).toMatchObject({ text: 'foreground' })
  } finally { await plain.dispose() }
}, 10000)

it('final drains exit output once and reports nonzero exit', async () => {
  const h = await harness()
  try {
    const a = await h.createAgent('outcomes')
    Object.assign(a, { inject() {} }) // No model turn: Task8 tests actual model notification delivery.
    const registry = a.ctx.get('jobs')!
    const v = await h.invoke(a, { target: 'ssh:x', cmd: 'printf last; printf err >&2; exit 7', run_in_background: true }) as unknown as { jobId: string }
    const id = JobId(v.jobId)
    expect(await registry.wait(id, 5000, a.id)).toMatchObject({ status: 'completed', detail: 'exit code: 7' })
    const read = registry.read(id, a.id)
    expect(read.chunks.filter(c => c.channel === 'stdout').map(c => c.text).join('')).toBe('last')
    expect(read.chunks.filter(c => c.channel === 'stderr').map(c => c.text).join('')).toBe('err')
    expect(registry.read(id, a.id).chunks).toEqual([])
  } finally { await h.dispose() }
})
it('plugin disposal and immediate job kill settle only after real process cleanup', async () => {
  const h = await harness()
  try {
    const a = await h.createAgent('dispose-jobs')
    Object.assign(a, { inject() {} })
    const v = await h.invoke(a, { target: 'ssh:x', cmd: 'sleep 30', run_in_background: true }) as unknown as { jobId: string }
    const registry = a.ctx.get('jobs')!, id = JobId(v.jobId)
    await h.rows[0]!.dispose()
    expect((await registry.wait(id, 5000, a.id)).status).toBe('killed')
  } finally { await h.dispose() }
}, 10000)

it('spawn failure reaches failed job detail without repeated synthetic stderr chunks', async () => {
  const h = await createRealRemoteHarness({ copies: 1, driverOptions: { oneshotArgvFor: () => ['/missing-task4-executable'] } })
  const jobs = await h.ctx.plugin(LocalJobs, { pumpPollMs: 10 })
  const tools = await h.ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  try {
    const a = await h.createAgent('spawn-failure')
    Object.assign(a, { inject() {} })
    const value = await h.invoke(a, { target: 'ssh:x', cmd: 'true', run_in_background: true }) as unknown as { jobId: string }
    const registry = a.ctx.get('jobs')!, id = JobId(value.jobId)
    expect(await registry.wait(id, 5000, a.id)).toMatchObject({ status: 'failed', detail: expect.stringContaining('ENOENT') })
    expect(registry.read(id, a.id).chunks).toEqual([])
    expect(registry.read(id, a.id).chunks).toEqual([])
  } finally { await h.dispose(); await tools.dispose(); await jobs.dispose() }
})

it('native jobs final-drain real Hub TERM output when cancel ACK outruns the stream', async () => {
  const { createServer } = await import('node:http')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createRemoteJobExecutor, installHubRemoteTransport } = await import('../../../super-dsh/superd-hub/dist/remote-row.js')
  const { upsertRemote } = await import('../../../super-dsh/superd-hub/dist/machines.js')
  const executor = createRemoteJobExecutor()
  let cancelSeen = false, receiverTerminal = '', releaseFrames!: () => void
  const held = new Promise<void>(resolve => { releaseFrames = resolve })
  const server = createServer(async (req, res) => {
    if (req.headers.cookie !== 'paired=jobs') { res.writeHead(401); res.end(); return }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    const op = JSON.parse(Buffer.concat(chunks).toString()).op
    if (op === 'cancel') cancelSeen = true
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    const response = await executor.handle(new Request('http://peer' + req.url, { method: 'POST', headers: req.headers as Record<string, string>, body: Buffer.concat(chunks), signal: abort.signal }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    const queued: Uint8Array[] = []
    for await (const chunk of response.body!) {
      if (op === 'start' && cancelSeen) {
        receiverTerminal += JSON.parse(Buffer.from(chunk).toString()).stdout.text
        queued.push(chunk); continue
      }
      if (!res.destroyed) res.write(chunk)
    }
    if (queued.length) { await held; for (const chunk of queued) if (!res.destroyed) res.write(chunk) }
    if (!res.destroyed) res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const home = await mkdtemp(join(tmpdir(), 'native-hub-job-'))
  upsertRemote(home, { id: 'peer', name: 'peer', origin: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, enabled: true, addedAt: Date.now(), cookie: 'paired=jobs' })
  const h = await harness()
  const row = await h.ctx.plugin({ name: 'task4-real-hub', apply: ctx => installHubRemoteTransport(ctx, { home }) })
  try {
    const a = await h.createAgent('hub-job')
    const value = await h.invoke(a, { target: 'hub:peer', cmd: `trap 'printf TAIL中; printf ERR🙂 >&2; exit 7' TERM; printf first; printf %s $$ >&2; while :; do :; done`, run_in_background: true }) as unknown as { jobId: string }
    const registry = a.ctx.get('jobs')!, id = JobId(value.jobId)
    let pid = 0
    for (let i = 0; i < 100 && !pid; i++) { pid = Number(registry.readAt(id, 0, a.id).chunks.filter(c => c.channel === 'stderr').map(c => c.text).join('')); await new Promise(r => setTimeout(r, 20)) }
    expect(pid).toBeGreaterThan(0)
    const call = (name: string) => a.ctx.tools.execute({ name, arguments: { job_id: id }, agent: a, signal: new AbortController().signal, callId: 'hub-job-control' as never })
    expect((await call('job_output')).value).toMatchObject({ text: expect.stringContaining('first'), job: { status: 'running' } })
    expect((await call('job_output')).value).toMatchObject({ text: '' })
    expect((await call('job_kill')).isError).toBeFalsy()
    expect((await registry.wait(id, 5000, a.id)).status).toBe('killed')
    await expect(readFile(`/proc/${pid}/stat`, 'utf8')).rejects.toThrow(/ENOENT/)
    expect(receiverTerminal).toContain('TAIL中')
    expect((await call('job_output')).value).toMatchObject({ text: 'TAIL中\n[stderr]\nERR🙂' })
    expect((await call('job_output')).value).toMatchObject({ text: '' })
  } finally {
    releaseFrames()
    await h.dispose(); await row.dispose(); await executor.dispose()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
}, 10000)
