import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as rpc from '../dist/remote-row.js'
import { createHubRemoteTransport } from '../dist/remote-provider.js'
import { upsertRemote } from '../dist/machines.js'
const alive = pid => { try { return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return false } }
async function until(fn, attempts = 200) { for (let i = 0; i < attempts; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 15)) } throw new Error('condition not reached') }

test('authenticated Hub task streams before completion, fences owner/cookie and cancel stops real remote descendants', async t => {
  assert.equal(typeof rpc.createRemoteJobExecutor, 'function')
  const executor = rpc.createRemoteJobExecutor()
  const home = mkdtempSync(join(tmpdir(), 'hub-job-'))
  let rejectCancel = false, cancelRequests = 0
  let startBody
  const server = createServer(async (req, res) => {
    if (!['paired=one', 'paired=two'].includes(req.headers.cookie)) { res.writeHead(401); res.end(); return }
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks))
    if (body.op === 'start') startBody = body
    if (body.op === 'cancel' && rejectCancel) { cancelRequests++; res.writeHead(503); res.end('cancel unavailable'); return }
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    const response = await executor.handle(new Request('http://peer' + req.url, { method: req.method, headers: req.headers, body: Buffer.concat(chunks), signal: abort.signal }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  upsertRemote(home, { id: 'peer', name: 'peer', origin, cookie: 'paired=one', enabled: true, addedAt: Date.now() })
  const provider = createHubRemoteTransport(home)
  t.after(async () => { await provider.dispose(); await executor.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(home, { recursive: true, force: true }) })
  const proc = await provider.start('peer', { target: 'hub:peer', cmd: `printf first; bash -c 'trap "" TERM; sleep 30' >/dev/null 2>&1 & printf '%s' "$!" >&2; wait`, mode: 'oneshot' }, 'owner-a')
  let done = false; void proc.done.then(() => { done = true })
  await until(() => proc.read('stderr', 0).text !== '')
  assert.equal(proc.read('stdout', 0).text, 'first'); assert.equal(done, false)
  const pid = Number(proc.read('stderr', 0).text); assert.equal(alive(pid), true)
  const control = (op, cookie, owner) => fetch(origin + '/api/superd/exec/task', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ op, owner, id: startBody.id }) })
  assert.equal((await control('read', 'paired=two', 'owner-a')).status, 404)
  assert.equal((await control('read', 'paired=one', 'wrong-owner')).status, 404)
  await control('cancel', 'paired=two', 'owner-a')
  await control('cancel', 'paired=one', 'wrong-owner')
  assert.equal(alive(pid), true)
  assert.equal((await (await control('read', 'paired=one', 'owner-a')).json()).stdout.text, 'first')
  const cursor = proc.read('stdout', 0).nextOffset
  assert.equal(proc.read('stdout', cursor).text, '')
  await provider.releaseOwner('other-owner'); assert.equal(alive(pid), true)
  proc.cancel(); proc.cancel(); await proc.done
  assert.equal(alive(pid), false)
  assert.equal(proc.read('stdout', 0).stats.unit, 'bytes')
  rejectCancel = true
  const failedCancel = await provider.start('peer', { target: 'hub:peer', cmd: 'printf ready; sleep 0.2', mode: 'oneshot' }, 'cancel-error')
  await until(() => failedCancel.read('stdout', 0).text === 'ready')
  failedCancel.cancel(); await failedCancel.done
  assert.equal(cancelRequests, 1, 'cancellation is never retried')
  assert.match(failedCancel.read('stderr', 0).diagnostic, /503/)
  rejectCancel = false
  // The old driver's teardown cannot touch a new incarnation, even while old start is awaiting HTTP admission.
  const old = await provider.start('peer', { target: 'hub:peer', cmd: 'sleep 30', mode: 'oneshot' }, 'old-driver')
  const fresh = await provider.start('peer', { target: 'hub:peer', cmd: 'printf fresh; sleep 30', mode: 'oneshot' }, 'new-driver')
  await provider.releaseOwner('old-driver')
  assert.equal((await old.done).cancelled, true)
  await until(() => fresh.read('stdout', 0).text === 'fresh')
  let freshDone = false; void fresh.done.then(() => { freshDone = true })
  assert.equal(freshDone, false)
  await provider.dispose(); assert.equal((await fresh.done).cancelled, true)
  await assert.rejects(provider.start('peer', { target: 'hub:peer', cmd: 'true' }, 'later'), /disposed/)
  // Disconnecting a raw authenticated task stream reaches the receiving executor's group cancellation.
  const abort = new AbortController()
  const preparation = await fetch(origin + '/api/superd/exec/task', { method: 'POST', headers: { cookie: 'paired=one', 'content-type': 'application/json' }, body: JSON.stringify({ op: 'prepare', owner: 'disconnected-driver', id: 'task-disconnect' }) }).then(r => r.json())
  const response = await fetch(origin + '/api/superd/exec/task', { method: 'POST', headers: { cookie: 'paired=one', 'content-type': 'application/json' }, body: JSON.stringify({ op: 'start', token: preparation.lease.token, owner: 'disconnected-driver', id: 'task-disconnect', input: { cmd: 'printf "%s" "$$"; sleep 30' } }), signal: abort.signal })
  const reader = response.body.getReader()
  let remotePid
  while (!remotePid) { const { value } = await reader.read(); for (const line of Buffer.from(value).toString().trim().split('\n')) { const frame = JSON.parse(line); if (frame.stdout.text) remotePid = Number(frame.stdout.text) } }
  assert.equal(alive(remotePid), true)
  abort.abort(); await reader.cancel().catch(() => {}); reader.releaseLock()
  await until(() => !alive(remotePid))
})

test('dispose during ordinary buffered request.json cannot admit a process afterwards', async () => {
  const executor = rpc.createRemoteJobExecutor()
  const responsePending = executor.handle(new Request('http://peer/api/superd/exec/task', { method: 'POST', headers: { cookie: 'paired=race' }, body: JSON.stringify({ op: 'start', owner: 'race-owner', id: 'race-task', input: { cmd: 'sleep 30' } }) }))
  await executor.dispose()
  const response = await responsePending
  try { assert.equal(response.status, 503) }
  finally { await response.body?.cancel(); await executor.dispose() }
})

for (const fault of ['healthy', 'partitioned', 'lost-renewal', 'late-renewal', 'lost-start-response', 'renewing']) test(`cleanup barrier survives cancel 503 with ${fault} stream and no natural exit`, { timeout: 15000 }, async t => {
  const breakStream = fault === 'partitioned'
  const executor = rpc.createRemoteJobExecutor()
  const home = mkdtempSync(join(tmpdir(), 'hub-lease-fault-'))
  let streamResponse, cancelCount = 0, renewed = false, observedPid = 0
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.cookie, 'paired=fault')
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    if (body.op === 'cancel') { cancelCount++; if (fault !== 'renewing') { res.writeHead(503); res.end('cancel unavailable'); return } }
    if (body.op === 'renew' && fault === 'late-renewal') await new Promise(r => setTimeout(r, 2500))
    // Fault proxy intentionally does NOT forward downstream disconnect to receiver.
    // The receiver must enforce its own lease, not assume the partition is immediately observed.
    const response = await executor.handle(new Request('http://receiver' + req.url, { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }))
    if (body.op === 'renew' && fault === 'late-renewal') renewed = true
    if (body.op === 'renew' && fault === 'lost-renewal') { await response.body.cancel(); renewed = true; res.destroy(); return }
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (body.op === 'start') streamResponse = res
    for await (const chunk of response.body) {
      if (body.op === 'start') { const frame = JSON.parse(Buffer.from(chunk).toString()); if (frame.stdout.text) observedPid = Number(frame.stdout.text) }
      if (!res.destroyed && !(body.op === 'start' && fault === 'lost-start-response')) res.write(chunk)
    }
    if (!res.destroyed) res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  upsertRemote(home, { id: 'peer', name: 'peer', origin: `http://127.0.0.1:${server.address().port}`, enabled: true, cookie: 'paired=fault', addedAt: Date.now() })
  const provider = createHubRemoteTransport(home)
  t.after(async () => { await executor.dispose(); await provider.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(home, { recursive: true, force: true }) })
  const proc = await provider.start('peer', { target: 'hub:peer', cmd: `trap '' TERM; printf %s $$; while :; do sleep 1; done`, mode: 'oneshot' }, 'fault-owner')
  await until(() => observedPid !== 0)
  const pid = observedPid
  assert.equal(alive(pid), true)
  let settled = false, released = false
  void proc.done.then(() => { settled = true })
  if (fault === 'renewing') { await new Promise(r => setTimeout(r, 7000)); assert.equal(alive(pid), true); assert.equal(settled, false) }
  if (fault === 'lost-renewal' || fault === 'late-renewal') await until(() => renewed, 500)
  if (fault === 'lost-start-response') await new Promise(r => setTimeout(r, 1700))
  if (breakStream) streamResponse.destroy()
  const teardown = provider.releaseOwner('fault-owner').then(() => { released = true })
  await new Promise(r => setTimeout(r, 150))
  assert.equal(alive(pid), true)
  assert.equal(settled, false, 'must retain process ownership while receiving work is live')
  assert.equal(released, false, 'owner cleanup must not finish before the work stops')
  await Promise.race([Promise.all([proc.done, teardown]), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('cleanup exceeded 11s')), 11000); timer.unref() })])
  assert.equal(alive(pid), false)
  assert.equal(Number.isInteger((await proc.done).durationMs), true, 'tool duration schema remains integer')
  assert.equal(cancelCount, 1)
})

test('expired preparation cannot admit a delayed initial start', { timeout: 10000 }, async () => {
  const executor = rpc.createRemoteJobExecutor()
  const request = body => new Request('http://peer/api/superd/exec/task', { method: 'POST', headers: { cookie: 'paired=delayed' }, body: JSON.stringify({ owner: 'delayed-owner', id: 'delayed-task', ...body }) })
  try {
    const preparation = await (await executor.handle(request({ op: 'prepare' }))).json()
    await new Promise(r => setTimeout(r, preparation.lease.leaseMs + 50))
    const response = await executor.handle(request({ op: 'start', token: preparation.lease.token, input: { cmd: 'sleep 30' } }))
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /lease/)
  } finally { await executor.dispose() }
})

test('lost prepare response never permits initial execution', { timeout: 6000 }, async t => {
  const executor = rpc.createRemoteJobExecutor(), home = mkdtempSync(join(tmpdir(), 'hub-prepare-loss-'))
  let starts = 0, preparations = 0
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    if (body.op === 'start') starts++
    const response = await executor.handle(new Request('http://receiver' + req.url, { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }))
    await response.body.cancel()
    if (body.op === 'prepare') { preparations++; await new Promise(r => setTimeout(r, 2200)) }
    if (!res.destroyed) { res.writeHead(503); res.end() }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  upsertRemote(home, { id: 'peer', name: 'peer', origin: `http://127.0.0.1:${server.address().port}`, enabled: true, cookie: 'paired=lost-prepare', addedAt: Date.now() })
  const provider = createHubRemoteTransport(home)
  t.after(async () => { await executor.dispose(); await provider.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(home, { recursive: true, force: true }) })
  const proc = await provider.start('peer', { target: 'hub:peer', cmd: 'sleep 30', mode: 'oneshot' }, 'lost-prepare-owner')
  await proc.done
  await new Promise(r => setTimeout(r, 800))
  assert.equal(preparations, 1); assert.equal(starts, 0)
  assert.match(proc.read('stderr', 0).diagnostic, /timeout/)
})

for (const scenario of ['ACK', 'stream', 'evicted', 'snapshot-unavailable']) test(`cancel preserves real terminal output when ${scenario} arrives first`, { timeout: 10000 }, async t => {
  const delayedStream = scenario !== 'stream', evicted = scenario === 'evicted'
  const executor = rpc.createRemoteJobExecutor(), home = mkdtempSync(join(tmpdir(), 'hub-cancel-final-'))
  let cancelSeen = false, finalFrame, releaseStream
  const held = new Promise(r => { releaseStream = r })
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.cookie, 'paired=terminal')
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    if (body.op === 'cancel') cancelSeen = true
    const response = await executor.handle(new Request('http://receiver' + req.url, { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (body.op === 'cancel' && scenario === 'snapshot-unavailable') { await response.body.cancel(); res.end(JSON.stringify({ done: true })); return }
    if (body.op === 'cancel' && !delayedStream) await new Promise(r => setTimeout(r, 100))
    const queued = []
    for await (const chunk of response.body) {
      if (body.op === 'start') {
        const frame = JSON.parse(Buffer.from(chunk).toString())
        if (frame.done) finalFrame = frame
        if (delayedStream && cancelSeen) { queued.push(chunk); continue }
      }
      if (!res.destroyed) res.write(chunk)
    }
    if (queued.length) { await held; for (const chunk of queued) if (!res.destroyed) res.write(chunk) }
    if (!res.destroyed) res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  upsertRemote(home, { id: 'peer', name: 'peer', origin: `http://127.0.0.1:${server.address().port}`, enabled: true, cookie: 'paired=terminal', addedAt: Date.now() })
  const provider = createHubRemoteTransport(home)
  t.after(async () => { releaseStream(); await executor.dispose(); await provider.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(home, { recursive: true, force: true }) })
  const terminal = evicted ? 'head -c 4259840 /dev/zero | tr \"\\0\" x; printf TAIL中' : 'printf TAIL中'
  const proc = await provider.start('peer', { target: 'hub:peer', cmd: `trap '${terminal}; printf "ERR🙂" >&2; exit 7' TERM; printf first; while :; do :; done`, mode: 'oneshot' }, 'terminal-owner')
  await until(() => proc.read('stdout', 0).text === 'first')
  const before = proc.read('stdout', 0)
  proc.cancel()
  await proc.done
  await until(() => finalFrame !== undefined)
  assert.equal(finalFrame.done.exit, 7, 'real receiver captured the TERM trap outcome')
  assert.equal(finalFrame.stdout.stats.total, evicted ? 4259852 : 12)
  assert.equal(finalFrame.stderr.stats.total, 7)
  if (scenario === 'snapshot-unavailable') {
    assert.equal(proc.read('stdout', 0).text, 'first')
    assert.equal(proc.read('stdout', 0).stats, undefined, 'partial counters are not presented as final totals')
    assert.equal(proc.read('stdout', 0).lossy, true)
    assert.match(proc.read('stderr', 0).diagnostic, /final output unavailable/)
    return
  }
  if (evicted) {
    const tail = proc.read('stdout', before.nextOffset)
    assert.equal(tail.text, 'x'.repeat(4194304 - 7) + 'TAIL中')
    assert.equal(tail.lossy, true)
    assert.equal(tail.nextOffset, 4259852)
    assert.deepEqual(tail.stats, { unit: 'bytes', total: 4259852, retained: 4194304, dropped: 65548, returned: 4194304, retentionLimit: 4194304 })
    assert.equal(proc.read('stdout', tail.nextOffset).text, '')
    assert.equal(proc.read('stderr', 0).text, 'ERR🙂')
    return
  }
  assert.equal(proc.read('stdout', before.nextOffset).text, 'TAIL中')
  assert.equal(proc.read('stdout', 0).text, 'firstTAIL中')
  assert.equal(proc.read('stdout', 0).stats.total, 12)
  assert.equal(proc.read('stderr', 0).text, 'ERR🙂')
  assert.equal(proc.read('stderr', 0).stats.total, 7)
  assert.equal((await proc.done).exit, 7)
  assert.equal(proc.read('stdout', 12).text, '')
})


test('cancel recovers completed receiver output within its existing bounded lease', async () => {
  const executor = rpc.createRemoteJobExecutor()
  const request = body => new Request('http://peer/api/superd/exec/task', { method: 'POST', headers: { cookie: 'paired=completed' }, body: JSON.stringify({ owner: 'completed-owner', id: 'completed-task', ...body }) })
  try {
    const prepared = await (await executor.handle(request({ op: 'prepare' }))).json()
    const stream = await executor.handle(request({ op: 'start', token: prepared.lease.token, input: { cmd: 'printf DONE中; printf ERR🙂 >&2; exit 7' } }))
    const frames = (await stream.text()).trim().split('\n').map(JSON.parse)
    assert.equal(frames.at(-1).done.exit, 7)
    const ack = await (await executor.handle(request({ op: 'cancel' }))).json()
    assert.equal(ack.snapshot.stdout.text, 'DONE中')
    assert.equal(ack.snapshot.stdout.nextOffset, 7)
    assert.equal(ack.snapshot.stdout.stats.total, 7)
    assert.equal(ack.snapshot.stderr.text, 'ERR🙂')
    assert.equal(ack.snapshot.result.exit, 7)
  } finally { await executor.dispose() }
})
