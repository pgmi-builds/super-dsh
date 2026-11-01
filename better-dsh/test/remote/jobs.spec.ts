import { expect, it } from 'vitest'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { createRealRemoteHarness } from './real-harness.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** One model-direct tool call through the staged pipeline (0.2.2); returns the call's own result. */
async function callTool(agent: Agent, name: string, args: unknown) {
  return executeToolFixture(agent.ctx, {
    callId: `${name}-test` as never,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
}

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
    const value = await h.invoke(a, { action: 'exec', target: 'ssh:x', cmd: 'printf first; printf %s $$ >&2; sleep 30; printf last', mode: 'oneshot', run_in_background: true }) as unknown as { jobId: string }
    expect(value.jobId).toMatch(/^remote-/)
    const id = JobId(value.jobId), registry = a.ctx.get('jobs')!
    let text = ''
    for (let i = 0; i < 100 && !text.includes('first'); i++) { text += registry.read(id, a.id).chunks.map(c => c.text).join(''); await new Promise(r => setTimeout(r, 20)) }
    expect(text).toContain('first'); await new Promise(r => setTimeout(r, 100)); expect(registry.get(id, a.id).status).toBe('running')
    const pid = Number(registry.readAt(id, 0, a.id).chunks.filter(c => c.channel === 'stderr').map(c => c.text).join(''))
    expect(pid).toBeGreaterThan(0)
    expect(registry.read(id, a.id).chunks).toEqual([])
    expect(() => registry.read(id, b.id)).toThrow(); expect(() => registry.kill(id, b.id)).toThrow()
    const killed = await callTool(a, 'job_kill', { job_id: id })
    expect(killed.isError).toBeFalsy()
    expect((await registry.wait(id, 5000, a.id)).status).toBe('killed')
    await expect(readFile(`/proc/${pid}/stat`, 'utf8')).rejects.toThrow(/ENOENT/)
    const output = await callTool(a, 'job_output', { job_id: id })
    expect(output.value).toMatchObject({ text: '', job: { status: 'killed' } })
  } finally { await h.dispose() }
}, 10000)

it('PTY background jobs: live merged output, interrupt cancels with exit 130, session survives; sync timeout hands off with a pollable jobId (P4/P5)', async () => {
  const h = await harness(true, { execTimeoutSec: 2, ptyArgvFor: () => ['script', '-qfec', 'bash', '/dev/null'], spawnArgvFor: () => ['script', '-qfec', 'bash', '/dev/null'] })
  try {
    const a = await h.createAgent('pty-jobs')
    const registry = a.ctx.get('jobs')!
    await h.invoke(a, { action: 'add', target: 'pty:bg1', spawn: 'script-bash' })
    const value = await h.invoke(a, { action: 'exec', target: 'pty:bg1', cmd: 'printf first; sleep 30', run_in_background: true }) as unknown as { jobId: string }
    expect(value.jobId).toMatch(/^remote-/)
    const id = JobId(value.jobId)
    let text = ''
    for (let i = 0; i < 100 && !text.includes('first'); i++) { text += registry.read(id, a.id).chunks.map(c => c.text).join(''); await new Promise(r => setTimeout(r, 20)) }
    expect(text).toContain('first')
    expect(registry.get(id, a.id).status).toBe('running')
    const killed = await callTool(a, 'job_kill', { job_id: id })
    expect(killed.isError).toBeFalsy()
    expect(await registry.wait(id, 5_000, a.id)).toMatchObject({ status: 'killed' })
    const after = await h.invoke(a, { action: 'exec', target: 'pty:bg1', cmd: 'echo alive' }) as unknown as { text: string }
    expect(after.text).toContain('alive')
    const handed = await h.invoke(a, { action: 'exec', target: 'pty:bg1', cmd: 'sleep 2; printf tardy', timeout: 1 }) as unknown as { jobId: string; running?: boolean }
    expect(handed.jobId).toMatch(/^remote-/)
    expect(handed.running).toBe(true) // rendered model surface reads 'still running — poll job_output <id>'; the value carries running+jobId fields
    expect(await registry.wait(JobId(handed.jobId), 5_000, a.id)).toMatchObject({ status: 'completed' })
  } finally { await h.dispose() }
}, 20_000)
it('default-PTY background (spec remote-default-pty Task C): submit + same-operation handoff — addressable session, native from-0 output, machine gets a fresh slot', async () => {
  const h = await harness(true, { ptyArgvFor: () => ['script', '-qfec', 'bash', '/dev/null'] })
  try {
    const a = await h.createAgent('bg-default')
    const registry = a.ctx.get('jobs')!
    const started = await h.invoke(a, { action: 'exec', target: 'ssh:dev4', cmd: 'printf first; sleep 1; printf last', run_in_background: true }) as unknown as { jobId: string; session: string }
    expect(started.jobId).toMatch(/^remote-/)
    expect(started.session).toMatch(/^pty:pty-[a-z0-9]{4}$/) // addressable immediately
    const id = JobId(started.jobId)
    let text = ''
    for (let i = 0; i < 150 && !text.includes('first'); i++) { text += registry.read(id, a.id).chunks.map(c => c.text).join(''); await new Promise(r => setTimeout(r, 20)) }
    expect(text).toContain('first') // live merged output, native from-0 read
    expect(registry.get(id, a.id).status).toBe('running')
    // same-operation handoff: the machine's next exec opens a FRESH default; the detached one stays busy with the job
    const next = await h.invoke(a, { action: 'exec', target: 'ssh:dev4', cmd: 'echo fresh' }) as unknown as { session: string; text: string }
    expect(next.session).not.toBe(started.session)
    expect(next.text).toContain('fresh')
    await expect(h.invoke(a, { action: 'exec', target: `pty:${started.session!.slice(4)}`, cmd: 'echo busy' })).rejects.toThrow(/E_SESSION_BUSY/)
    expect(await registry.wait(id, 10_000, a.id)).toMatchObject({ status: 'completed' })
    const out = await callTool(a, 'job_output', { job_id: id })
    expect((out.value as { text: string }).text).toContain('last') // incremental tail after consumed reads
  } finally { await h.dispose() }
}, 20_000)

it('background + scriptPath (F3 fix, 2026-11-01 re-test): the lane carries the prepared carrier — script actually runs, with and without business stdin', async () => {
  const h = await harness(true, { ptyArgvFor: () => ['script', '-qfec', 'bash', '/dev/null'] })
  const dir = await mkdtemp(join(tmpdir(), 'remote-bg-script-'))
  const readScript = join(dir, 'read.sh'), plainScript = join(dir, 'plain.sh')
  await writeFile(readScript, 'printf BG-SCRIPT; IFS= read -r v; printf "GOT:%s" "$v"\n', 'utf8')
  await writeFile(plainScript, 'printf PLAIN-BG\n', 'utf8')
  try {
    const a = await h.createAgent('bg-script')
    const registry = a.ctx.get('jobs')!
    // with business stdin: the script's read consumes it (old shape failed E_STDIN_WITHOUT_CMD after "Started")
    const s1 = await h.invoke(a, { action: 'exec', target: 'ssh:dev4', run_in_background: true, scriptPath: readScript, stdin: 'z\n' }) as unknown as { jobId: string }
    const id1 = JobId(s1.jobId!)
    expect(await registry.wait(id1, 15_000, a.id)).toMatchObject({ status: 'completed' })
    expect((await callTool(a, 'job_output', { job_id: id1 })).value as { text: string }).toMatchObject({ text: expect.stringContaining('BG-SCRIPTGOT:z') })
    // without stdin: plain script runs to completion (old shape failed "pty dispatch did not hand off a running job")
    const s2 = await h.invoke(a, { action: 'exec', target: 'ssh:dev4', run_in_background: true, scriptPath: plainScript }) as unknown as { jobId: string }
    const id2 = JobId(s2.jobId!)
    expect(await registry.wait(id2, 15_000, a.id)).toMatchObject({ status: 'completed' })
    expect(((await callTool(a, 'job_output', { job_id: id2 })).value as { text: string }).text).toContain('PLAIN-BG')
  } finally { await h.dispose(); await rm(dir, { recursive: true, force: true }) }
}, 25_000)

it('refuses admission before discovery and keeps foreground without jobs', async () => {
  const h = await harness(false)
  try {
    const a = await h.createAgent('refusal')
    await expect(h.invoke(a, { action: 'exec', target: 'bare', cmd: 'true', mode: 'oneshot', run_in_background: true })).rejects.toThrow(/controller/)
    // controller-less harness: registry admission refuses ALL backgrounds (gate precedes routing) —
    // byop-without-spawn reaching E_NO_SESSION as a failed job is covered by admission order, not testable here
  } finally { await h.dispose() }
  const plain = await createRealRemoteHarness({ copies: 1, driverOptions: { oneshotArgvFor: (_p, cmd) => ['bash', '-c', cmd] } })
  try {
    const a = await plain.createAgent('without-jobs')
    await expect(plain.invoke(a, { action: 'exec', target: 'ssh:x', cmd: 'true', mode: 'oneshot', run_in_background: true })).rejects.toThrow(/jobs/)
    expect(await plain.invoke(a, { action: 'exec', target: 'ssh:x', cmd: 'printf foreground', mode: 'oneshot' })).toMatchObject({ text: 'foreground' })
  } finally { await plain.dispose() }
}, 10000)

it('final drains exit output once and reports nonzero exit', async () => {
  const h = await harness()
  try {
    const a = await h.createAgent('outcomes')
    Object.assign(a, { inject() {} }) // No model turn: Task8 tests actual model notification delivery.
    const registry = a.ctx.get('jobs')!
    const v = await h.invoke(a, { action: 'exec', target: 'ssh:x', cmd: 'printf last; printf err >&2; exit 7', mode: 'oneshot', run_in_background: true }) as unknown as { jobId: string }
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
    const v = await h.invoke(a, { action: 'exec', target: 'ssh:x', cmd: 'sleep 30', mode: 'oneshot', run_in_background: true }) as unknown as { jobId: string }
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
    const value = await h.invoke(a, { action: 'exec', target: 'ssh:x', cmd: 'true', mode: 'oneshot', run_in_background: true }) as unknown as { jobId: string }
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
    const value = await h.invoke(a, { action: 'exec', target: 'hub:peer', cmd: `trap 'printf TAIL中; printf ERR🙂 >&2; exit 7' TERM; printf first; printf %s $$ >&2; while :; do :; done`, mode: 'oneshot', run_in_background: true }) as unknown as { jobId: string }
    const registry = a.ctx.get('jobs')!, id = JobId(value.jobId)
    let pid = 0
    for (let i = 0; i < 100 && !pid; i++) { pid = Number(registry.readAt(id, 0, a.id).chunks.filter(c => c.channel === 'stderr').map(c => c.text).join('')); await new Promise(r => setTimeout(r, 20)) }
    expect(pid).toBeGreaterThan(0)
    const call = (name: string) => callTool(a, name, { job_id: id })
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

it('interactive stdin over official jobs: exec → prompt → exec stdin-only → job_output → stdin-only → original job completes (spec 2026-11-01)', async () => {
  const h = await harness(true, { execTimeoutSec: 2, ptyArgvFor: () => ['script', '-qfec', 'bash', '/dev/null'], spawnArgvFor: () => ['script', '-qfec', 'bash', '/dev/null'] })
  try {
    const a = await h.createAgent('pty-ix'), b = await h.createAgent('pty-ix-other')
    const registry = a.ctx.get('jobs')!
    await h.invoke(a, { action: 'add', target: 'pty:ix', spawn: 'bash' })
    const started = await h.invoke(a, { action: 'exec', target: 'pty:ix', cmd: `printf 'Password:'; IFS= read -s -r pw; printf '\\nOTP:'; IFS= read -s -r otp; [ "$pw" = demo ] && [ "$otp" = 123456 ] && printf '\\nACCEPTED\\n'`, run_in_background: true }) as unknown as { jobId: string; commandId: string }
    expect(started.jobId).toMatch(/^remote-/)
    expect(started.commandId).toBe(started.jobId) // background lane: commandId IS the registry jobId
    const id = JobId(started.jobId)
    const readAll = (jid: JobId = id): string => registry.readAt(jid, 0, a.id).chunks.map((c: { text: string }) => c.text).join('')
    for (let i = 0; i < 200 && !readAll().includes('Password:'); i++) await new Promise((r) => setTimeout(r, 20))
    expect(readAll()).toContain('Password:')
    // busy teaches the ways out, stdin-only included
    await expect(h.invoke(a, { action: 'exec', target: 'pty:ix', cmd: 'echo nope' })).rejects.toThrow(/E_SESSION_BUSY/)
    const w1 = await h.invoke(a, { action: 'exec', target: 'pty:ix', stdin: 'demo\n' }) as unknown as { kind: string; writtenBytes: number; jobId: string; commandId: string; session: string }
    expect(w1).toMatchObject({ kind: 'input', writtenBytes: 5, jobId: started.jobId, commandId: started.commandId })
    expect(w1.session).toMatch(/^pty:pty-/)
    expect(JSON.stringify(w1)).not.toContain('demo') // the receipt never echoes the stdin body
    for (let i = 0; i < 200 && !readAll().includes('OTP:'); i++) await new Promise((r) => setTimeout(r, 20))
    expect(readAll()).toContain('OTP:')
    await h.invoke(a, { action: 'exec', target: 'pty:ix', commandId: started.commandId, stdin: '123456\n' })
    const outcome = await registry.wait(id, 10_000, a.id)
    expect(outcome.status).toBe('completed')
    const final = readAll()
    expect(final).toContain('ACCEPTED')
    expect(final).not.toContain('demo')
    // cross-Agent fencing: another Agent's pool has no such session
    await expect(h.invoke(b, { action: 'exec', target: 'pty:ix', stdin: 'x\n' })).rejects.toThrow(/E_NO_SESSION/)
    // stale commandId guard + completion release
    const started2 = await h.invoke(a, { action: 'exec', target: 'pty:ix', cmd: `IFS= read -s -r v; printf 'OK:%s' "$v"`, run_in_background: true }) as unknown as { jobId: string; commandId: string }
    await expect(h.invoke(a, { action: 'exec', target: 'pty:ix', commandId: started.commandId, stdin: 'x\n' })).rejects.toThrow(/E_COMMAND_MISMATCH/)
    await h.invoke(a, { action: 'exec', target: 'pty:ix', stdin: 'go\n' })
    expect((await registry.wait(JobId(started2.jobId), 10_000, a.id)).status).toBe('completed')
    expect(readAll(JobId(started2.jobId))).toContain('OK:go')
    await expect(h.invoke(a, { action: 'exec', target: 'pty:ix', stdin: 'x\n' })).rejects.toThrow(/E_SESSION_NOT_RUNNING/)
    // ledger grew by dispatched commands only (busy rejects and inputs add no entries); card teaches, never hides
    const card = await h.invoke(a, { action: 'status', target: 'pty:ix' }) as unknown as { text: string }
    expect(card.text).not.toContain('echo nope')
    expect(card.text).not.toContain('demo')
    // cancel race: kill a waiting reader, then input honestly refuses
    const started3 = await h.invoke(a, { action: 'exec', target: 'pty:ix', cmd: 'IFS= read -s -r v; echo stuck', run_in_background: true }) as unknown as { jobId: string }
    const kill = await callTool(a, 'job_kill', { job_id: JobId(started3.jobId) })
    expect(kill.isError).toBeFalsy()
    await registry.wait(JobId(started3.jobId), 5_000, a.id)
    await expect(h.invoke(a, { action: 'exec', target: 'pty:ix', stdin: 'x\n' })).rejects.toThrow(/E_SESSION_NOT_RUNNING/)
  } finally { await h.dispose() }
}, 30_000)
