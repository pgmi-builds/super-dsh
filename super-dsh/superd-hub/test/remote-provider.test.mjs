import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubRemoteTransport } from '../dist/remote-provider.js'
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
  t.after(async () => { await provider.dispose(); await executor.dispose(); off(); await new Promise(resolve => http.close(resolve)); rmSync(home, { recursive: true, force: true }) })
  return { home, row, provider, counts: () => ({ upgrades, posts }), lastExec: () => lastExec }
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
  const first = await b.provider.pty('peer', 'cd /tmp; export HUB_TASK2_VALUE=preserved; printf first', 'owner-a', {})
  assert.equal(first.cwd, '/tmp')
  const second = await b.provider.pty('peer', 'printf "%s:%s" "$HUB_TASK2_VALUE" "$PWD"', 'owner-a', {})
  assert.equal(second.stdout, 'preserved:/tmp')
  assert.equal(b.counts().upgrades, 1)
  upsertRemote(b.home, { ...b.row, execEnabled: false })
  await assert.rejects(b.provider.pty('peer', 'printf forbidden', 'owner-a', {}), /disabled/)
  upsertRemote(b.home, { ...b.row, enabled: false })
  await assert.rejects(b.provider.start('peer', { cmd: 'printf forbidden', target: 'hub:peer', mode: 'oneshot' }, 'owner-a'), /disabled/)
  removeRemote(b.home, 'peer')
  await assert.rejects(b.provider.pty('peer', 'printf forbidden', 'owner-a', {}), /unknown machine/)
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
  await b.provider.pty('peer', 'export OWNER_VALUE=old', 'old-driver', {})
  await b.provider.pty('peer', 'export OWNER_VALUE=new', 'new-driver', {})
  await b.provider.releaseOwner('old-driver')
  assert.equal((await b.provider.pty('peer', 'printf %s "$OWNER_VALUE"', 'new-driver', {})).stdout, 'new')
  assert.equal(b.counts().upgrades, 2)
})
