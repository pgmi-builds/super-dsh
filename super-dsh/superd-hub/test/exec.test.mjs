// P4 one-shot exec (spec §8.1): parser rules, executor behavior (tail window,
// ring cap, two-stage group kill, cwd, bash -lc), the /api/superd/exec
// handler contract, and the cross-machine wire leg.
import test from 'node:test'
import assert from 'assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseOneShotExecBody,
  runOneShotExec,
  postOneShotExec,
  EXEC_TAIL_WINDOW,
  EXEC_API_BASE,
} from '../dist/exec.js'
import { handleExecPost } from '../dist/mesh-rpc.js'

const req = (method, body, url = `http://x${EXEC_API_BASE}`) =>
  new Request(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

// ---------------------------------------------------------------- parser

test('parseOneShotExecBody: accepts minimal and full shapes, rejects every rule break', () => {
  assert.deepEqual(parseOneShotExecBody({ cmd: 'ls' }), { ok: true, value: { cmd: 'ls' } })
  assert.deepEqual(
    parseOneShotExecBody({ cmd: 'ls', cwd: '/tmp', timeoutSec: 30 }),
    { ok: true, value: { cmd: 'ls', cwd: '/tmp', timeoutSec: 30 } },
  )
  for (const body of [null, 'x', [], {}, { cmd: '' }, { cmd: '   ' }, { cmd: 7 }]) {
    assert.equal(parseOneShotExecBody(body).ok, false, JSON.stringify(body))
  }
  assert.equal(parseOneShotExecBody({ cmd: 'x'.repeat(4097) }).ok, false)
  assert.equal(parseOneShotExecBody({ cmd: 'ls', cwd: 'relative' }).ok, false)
  assert.equal(parseOneShotExecBody({ cmd: 'ls', timeoutSec: 0 }).ok, false)
  assert.equal(parseOneShotExecBody({ cmd: 'ls', timeoutSec: 601 }).ok, false)
  assert.equal(parseOneShotExecBody({ cmd: 'ls', timeoutSec: 1.5 }).ok, false)
  assert.equal(parseOneShotExecBody({ cmd: 'ls', nope: 1 }).ok, false, 'unknown fields are rejected (exact-shape discipline)')
})

// ---------------------------------------------------------------- executor

test('runOneShotExec: exit code, stdout/stderr separation, bash -lc, cwd', async () => {
  const ok = await runOneShotExec({ cmd: 'echo out; echo err >&2; exit 7' })
  assert.equal(ok.exit, 7)
  assert.equal(ok.stdout.trim(), 'out')
  assert.equal(ok.stderr.trim(), 'err')
  assert.equal(ok.truncated, false)
  assert.equal(ok.timedOut, false)
  assert.ok(ok.durationMs >= 0)

  const home = await runOneShotExec({ cmd: 'echo "$HOME"' })
  assert.ok(home.stdout.trim().length > 0, 'bash -lc loads the login environment')

  const d = mkdtempSync(join(tmpdir(), 'superd-exec-'))
  try {
    const pwd = await runOneShotExec({ cmd: 'pwd', cwd: d })
    assert.equal(pwd.stdout.trim(), d)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('runOneShotExec: output beyond the tail window is truncated to the LAST 30k', async () => {
  const big = await runOneShotExec({
    cmd: `head -c 100000 /dev/zero | tr '\\0' a; head -c 60000 /dev/zero | tr '\\0' x`,
  })
  assert.equal(big.exit, 0)
  assert.equal(big.stdout.length, EXEC_TAIL_WINDOW)
  assert.ok(big.stdout.endsWith('x'), 'the window keeps the TAIL, not the head')
  assert.ok(!big.stdout.includes('a'), 'the dropped head must not leak into the window')
  assert.equal(big.truncated, true)
})

test('runOneShotExec: the 4M ring cap never changes the tail semantics', async () => {
  const huge = await runOneShotExec({
    cmd: `head -c 100000 /dev/zero | tr '\\0' a; head -c 4500000 /dev/zero | tr '\\0' x`,
    timeoutSec: 60,
  })
  assert.equal(huge.exit, 0)
  assert.equal(huge.stdout.length, EXEC_TAIL_WINDOW)
  assert.ok(huge.stdout.split('').every((c) => c === 'x'), 'tail of the capped ring = tail of the stream')
  assert.equal(huge.truncated, true)
}, { timeout: 90_000 })

test('runOneShotExec: timeout → SIGTERM→SIGKILL group kill, timedOut, fast return', async () => {
  const started = Date.now()
  const slow = await runOneShotExec({ cmd: 'sleep 30 & wait', timeoutSec: 1 })
  assert.equal(slow.timedOut, true)
  assert.equal(slow.exit, null)
  assert.ok(Date.now() - started < 10_000, 'the group kill must not wait for the children')
  assert.ok(slow.durationMs < 10_000)
})

test('runOneShotExec: journal line lands (exec.run)', async () => {
  const lines = []
  await runOneShotExec({ cmd: 'true' }, (level, event, fields) => lines.push({ level, event, fields }))
  const hit = lines.find((l) => l.event === 'exec.run')
  assert.ok(hit, 'exec.run present')
  assert.equal(hit.level, 'info')
  assert.equal(hit.fields.cmd, 'true')
  assert.equal(hit.fields.exit, 0)
})

// ---------------------------------------------------------------- endpoint

test('handleExecPost: method gate + bad JSON + validation + a real run', async () => {
  const wrongMethod = await handleExecPost(req('GET'))
  assert.equal(wrongMethod.status, 405)

  const badJson = await handleExecPost(new Request(`http://x${EXEC_API_BASE}`, { method: 'POST', body: 'nope{' }))
  assert.equal(badJson.status, 400)

  const badBody = await handleExecPost(req('POST', { cmd: '' }))
  assert.equal(badBody.status, 400)
  assert.match((await badBody.json()).error, /cmd/)

  const lines = []
  const run = await handleExecPost(req('POST', { cmd: 'echo endpoint; exit 3' }), (l, e, f) => lines.push({ l, e, f }))
  assert.equal(run.status, 200)
  const body = await run.json()
  assert.equal(body.exit, 3)
  assert.equal(body.stdout.trim(), 'endpoint')
  assert.ok(lines.some((x) => x.e === 'exec.run'))
})

// ---------------------------------------------------------------- wire leg

test('postOneShotExec: cookie rides, result parses; typed errors on 4xx and unreachable', async () => {
  const posts = []
  const fetchImpl = async (url, init) => {
    posts.push({ url: String(url), init })
    return new Response(JSON.stringify({ exit: 5, stdout: 'o', stderr: 'e', durationMs: 9, truncated: true, timedOut: false, outcome: 'signaled' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const res = await postOneShotExec('http://peer:4999', { cmd: 'x', timeoutSec: 10 }, { cookie: 'dsh-auth-a=1', fetchImpl })
  assert.equal(res.exit, 5)
  assert.equal(res.truncated, true)
  assert.equal(res.outcome, 'signaled', 'the wire leg passes the peer outcome through')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, `http://peer:4999${EXEC_API_BASE}`)
  assert.equal(posts[0].init.headers.cookie, 'dsh-auth-a=1')
  assert.deepEqual(JSON.parse(posts[0].init.body), { cmd: 'x', timeoutSec: 10 })

  // a pre-0.1.7-e peer carries no outcome — derive the closest honest read
  const legacy = async (body) => postOneShotExec('http://peer:4999', { cmd: 'x' }, {
    fetchImpl: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.equal((await legacy({ exit: 0, stdout: '', stderr: '', durationMs: 1, truncated: false, timedOut: false })).outcome, 'exited')
  assert.equal((await legacy({ exit: null, stdout: '', stderr: '', durationMs: 1, truncated: false, timedOut: true })).outcome, 'timeout')
  assert.equal((await legacy({ exit: null, stdout: '', stderr: '', durationMs: 1, truncated: false, timedOut: false })).outcome, 'signaled', 'legacy spawn failure degrades honestly to signaled')

  const failing = (status, body) => async () => {
    await postOneShotExec('http://peer:4999', { cmd: 'x' }, {
      fetchImpl: async () => new Response(body === undefined ? '' : JSON.stringify(body), { status }),
    })
  }
  await assert.rejects(failing(400, { error: 'exec: cmd must be a non-empty string' }), /cmd must be a non-empty string/)
  await assert.rejects(failing(500), /status 500/)
  await assert.rejects(
    () => postOneShotExec('http://peer:4999', { cmd: 'x' }, { fetchImpl: async () => { throw new Error('ECONNREFUSED') } }),
    /unreachable.*ECONNREFUSED/,
  )
})

test('outcome matrix: exited / signaled / timeout / spawn-error are disambiguated (F1/F2)', async () => {
  const normal = await runOneShotExec({ cmd: 'exit 4' })
  assert.equal(normal.outcome, 'exited')
  assert.equal(normal.exit, 4)

  const signaled = await runOneShotExec({ cmd: 'kill -KILL $$' })
  assert.equal(signaled.outcome, 'signaled')
  assert.equal(signaled.exit, null)
  assert.equal(signaled.timedOut, false)

  const timed = await runOneShotExec({ cmd: 'sleep 10', timeoutSec: 1 })
  assert.equal(timed.outcome, 'timeout')
  assert.equal(timed.timedOut, true)

  // F1: a bad cwd used to be indistinguishable from a signal death —
  // spawn-error now names it and the diagnostic rides stderr.
  const spawnErr = await runOneShotExec({ cmd: 'pwd', cwd: '/nonexistent-xyz-777' })
  assert.equal(spawnErr.outcome, 'spawn-error')
  assert.equal(spawnErr.exit, null)
  assert.equal(spawnErr.timedOut, false)
  assert.match(spawnErr.stderr, /exec: spawn failed/)
  assert.match(spawnErr.stderr, /nonexistent-xyz-777/)
})
