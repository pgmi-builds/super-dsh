import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubRemoteTransport, createHubExec } from '../dist/remote-provider.js'
import { ensureSelf, upsertRemote, removeRemote } from '../dist/machines.js'
import { registerPtyExecutor } from '../dist/exec-pty-rpc.js'
import { createRemoteJobExecutor } from '../dist/remote-row.js'
import { Readable } from 'node:stream'

async function peer(t, { cwd } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hub-provider-'))
  let upgrades = 0, posts = 0, handler, lastExec
  const executor = createRemoteJobExecutor()
  const http = createServer(async (req, res) => {
    assert.equal(req.headers.cookie, 'paired=fixture')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks))
    if (input.op === 'start') posts++
    if (cwd !== undefined && input.input) input.input.cwd = cwd
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    const response = await executor.handle(new Request('http://peer' + req.url, { method: req.method, headers: req.headers, body: JSON.stringify(input), signal: abort.signal }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    Readable.fromWeb(response.body).pipe(res)
  })
  const off = await registerPtyExecutor({ registerUpgrade(route) { handler = route.handler; return () => { handler = undefined } } }, {
    authorize(req) { assert.equal(req.headers.cookie, 'paired=fixture'); upgrades++; return true },
  })
  http.on('upgrade', (req, socket, head) => handler?.(req, socket, head))
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const row = { id: 'peer', name: 'paired-only-no-ssh', origin: `http://127.0.0.1:${http.address().port}`, enabled: true, addedAt: Date.now(), cookie: 'paired=fixture' }
  ensureSelf(home, 'origin')
  upsertRemote(home, row)
  const provider = createHubRemoteTransport(home)
  const execFace = createHubExec(home)
  t.after(async () => { await provider.dispose(); await execFace.dispose(); await executor.dispose(); off(); await new Promise(resolve => http.close(resolve)); rmSync(home, { recursive: true, force: true }) })
  return { home, row, provider, face: execFace.face, exec: execFace, counts: () => ({ upgrades, posts }), lastExec: () => lastExec }
}

test('spawn-error adapter preserves executor diagnostic separately from zero process-output byte counters', async t => {
  const b = await peer(t, { cwd: '/missing-task3-review-cwd' })
  const proc = await b.provider.start('peer', { target: 'hub:peer', mode: 'oneshot', cmd: 'true' }, 'owner')
  assert.equal((await proc.done).exit, null)
  const out = proc.read('stderr', 0)
  assert.match(out.diagnostic, /exec: spawn failed.*missing-task3-review-cwd/)
  assert.equal(out.text, '')
  assert.equal(out.nextOffset, 0)
  assert.deepEqual(out.stats, { unit: 'bytes', total: 0, retained: 0, dropped: 0, returned: 0, retentionLimit: 4_194_304 })
})

test('paired-only Hub reuses authenticated WS PTY cwd/env and checks latest exec policy on warm sessions', { timeout: 10000 }, async t => {
  const b = await peer(t)
  assert.deepEqual(b.provider.listTargets(), [{ id: 'peer', label: 'paired-only-no-ssh', execEnabled: true }])
  const first = await b.face.pty('owner-a', 'peer', 'cd /tmp; export HUB_TASK2_VALUE=preserved; printf first', {})
  assert.equal(first.cwd, '/tmp')
  const second = await b.face.pty('owner-a', 'peer', 'printf "%s:%s" "$HUB_TASK2_VALUE" "$PWD"', {})
  assert.equal(second.output, 'preserved:/tmp')
  assert.equal(b.counts().upgrades, 1)
  upsertRemote(b.home, { ...b.row, execEnabled: false })
  await assert.rejects(b.face.pty('owner-a', 'peer', 'printf forbidden', {}), /disabled/)
  upsertRemote(b.home, { ...b.row, enabled: false })
  await assert.rejects(b.provider.start('peer', { cmd: 'printf forbidden', target: 'hub:peer', mode: 'oneshot' }, 'owner-a'), /disabled/)
  removeRemote(b.home, 'peer')
  await assert.rejects(b.face.pty('owner-a', 'peer', 'printf forbidden', {}), /unknown machine/)
  assert.equal(b.counts().upgrades, 1)
})

test('HTTP task adapter runs receiving executor and exposes the independent binary lane', async t => {
  const b = await peer(t)
  const process = await b.provider.start('peer', { target: 'hub:peer', mode: 'oneshot', cmd: 'printf hello; printf err >&2; exit 7' }, 'owner')
  assert.equal((await process.done).exit, 7)
  assert.equal(process.read('stdout', 0).text, 'hello')
  assert.equal(process.read('stderr', 0).text, 'err')
  assert.doesNotThrow(() => process.cancel())
  assert.equal(typeof b.provider.fileEndpoint('peer').importTree, 'function')
  assert.throws(() => b.provider.fileEndpoint(ensureSelf(b.home, 'origin').id), /local execution/)
  await assert.rejects(b.provider.start(ensureSelf(b.home, 'origin').id, { cmd: 'printf forbidden', target: 'hub:self', mode: 'oneshot' }, 'owner'), /local execution/)
  assert.equal(b.counts().posts, 1)
})

test('authenticated foreground wire carries literal stdin and real byte output statistics', async t => {
  const b = await peer(t)
  const proc = await b.provider.start('peer', { target: 'hub:peer', mode: 'oneshot', cmd: 'bash -s', stdin: '#'.repeat(5000) + "\nprintf '%s' 'literal $HOME `x` 中🙂'\n" }, 'owner')
  assert.equal((await proc.done).exit, 0)
  const out = proc.read('stdout', 0)
  assert.equal(out.text, 'literal $HOME `x` 中🙂')
  assert.equal(out.stats.unit, 'bytes')
  assert.equal(out.stats.total, 25)
  assert.equal(b.counts().posts, 1)
})

test('old owner cleanup cannot destroy another Agent incarnation shell', async t => {
  const b = await peer(t)
  await b.face.pty('old-driver', 'peer', 'export OWNER_VALUE=old', {})
  await b.face.pty('new-driver', 'peer', 'export OWNER_VALUE=new', {})
  await b.exec.releaseOwner("old-driver")
  assert.equal((await b.face.pty('new-driver', 'peer', 'printf %s "$OWNER_VALUE"', {})).output, 'new')
  assert.equal(b.counts().upgrades, 2)
})

test('two-clock pin: the PEER clock owns hub-lease timeouts (sleep 8 / timeoutSec 1 settles near 1s, timedOut honest)', { timeout: 15000 }, async t => {
  const b = await peer(t)
  const proc = await b.provider.start('peer', { target: 'hub:peer', mode: 'oneshot', cmd: 'sleep 8', timeout: 1 }, 'owner')
  const done = await proc.done
  assert.equal(done.timedOut, true)
  assert.ok(done.durationMs < 4000, `peer kill should settle near 1s, took ${done.durationMs}ms`)
  assert.equal(b.counts().posts, 1)
})
