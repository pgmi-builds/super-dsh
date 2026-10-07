// P4 §8.2 PTY: framing parser (ported from better-dsh), the session state
// machine over a fake channel, a REAL local `script -qfec bash` integration,
// the dumb executor end-to-end over an in-process WebSocket, and the tool
// leg's value shape.
import test from 'node:test'
import assert from 'assert/strict'
import { createServer } from 'node:http'
import {
  buildInitCommand,
  createNonceFrameParser,
  genNonce,
  wrapPtyCommand,
  tailWindow,
} from '../dist/exec-pty-framing.js'
import { PtySession, PtyPool } from '../dist/exec-pty-session.js'
import { LocalScriptChannel, WsPtyChannel } from '../dist/exec-pty-channel.js'
import { registerPtyExecutor, PTY_EXEC_PATH } from '../dist/exec-pty-rpc.js'

const tick = () => new Promise((r) => setImmediate(r))
const until = async (cond, ms = 4000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('timed out')
}
const NONCE_OF = (line) => /(?:\x1b|\\033)\]133;D;([0-9a-f]+);/.exec(line)?.[1]

// ---------------------------------------------------------------- framing

test('framing: wrap/init roundtrip through the parser (exit + cwd; cwd may contain semicolons)', () => {
  const nonce = genNonce()
  let frame = null
  const out = []
  const parser = createNonceFrameParser(nonce, {
    onOutput: (t) => out.push(t),
    onFrame: (f) => { frame = f },
  })
  parser.feed(wrapPtyCommand('echo hi', nonce))
  parser.feed('hi\r\n')
  parser.feed(`\x1b]133;D;${nonce};0;/a;b/c\x07 trailing-junk-after-frame`)
  assert.equal(frame.exit, 0)
  assert.equal(frame.cwd, '/a;b/c')
  const text = out.join('')
  assert.match(text, /echo hi\n/, 'the streamed command text flows through (normalized)')
  assert.match(text, /hi\n$/, 'and the real output follows it')
  assert.ok(!text.includes('\x1b'), 'ANSI is stripped from the feed path')
})

test('framing: a WRONG nonce never frames (streams through as output); holdback keeps partial prefixes; flush emits raw', () => {
  const nonce = genNonce()
  const other = genNonce()
  let framed = 0
  const out = []
  const parser = createNonceFrameParser(nonce, { onOutput: (t) => out.push(t), onFrame: () => { framed++ } })
  const full = `\x1b]133;D;${other};0;/x\x07`
  const partial = full.slice(0, full.length - 3)
  parser.feed(partial)
  assert.equal(out.length, 0, 'a possible marker prefix is held back')
  parser.feed(full.slice(full.length - 3))
  assert.equal(framed, 0, 'foreign nonce marker is output, never a frame')
  assert.match(out.join(''), /\/x/, 'the foreign marker flows through as (normalized) output — its OSC shell is stripped')
  parser.flush()
})

test('framing: tailWindow keeps the tail and banners the counts', () => {
  assert.deepEqual(tailWindow('abc', 10), { text: 'abc' })
  const big = tailWindow('x'.repeat(50), 10)
  assert.equal(big.text.split('\n')[0], '[truncated: showing last 10 of 50 chars]')
  assert.ok(big.text.endsWith('xxxxxxxxxx'))
  assert.equal(big.truncated, 50)
})

// ---------------------------------------------------------------- session (fake channel)

class FakeChannel {
  constructor() {
    this.writes = []
    this.dataCb = null
    this.deadCb = null
    this.diag = ''
    this.killed = false
    this.closed = false
  }
  async open(onData) { this.dataCb = onData }
  write(s) { this.writes.push(s) }
  close() { this.closed = true }
  kill() { this.killed = true }
  onDead(cb) { this.deadCb = cb }
  feed(text) { this.dataCb?.(text) }
  die() { this.deadCb?.() }
}

const driveSession = async (session, channel, cmd, respond) => {
  const p = session.dispatch(cmd)
  await until(() => channel.writes.some((w) => w.includes(wrapPtyCommand(cmd, NONCE_OF(w) ?? '')) || (NONCE_OF(w) !== undefined && w.includes(cmd))))
  const line = channel.writes.find((w) => NONCE_OF(w) !== undefined && w.includes(cmd))
  const nonce = NONCE_OF(line)
  respond(nonce)
  return await p
}

test('session: init handshake → dispatch → frame settles {output, exit, cwd}; FIFO; same session reused', async () => {
  const channel = new FakeChannel()
  const session = new PtySession({ key: 'k1', channel, idleTtlSec: 600 })
  const first = session.dispatch('echo one')
  await until(() => channel.writes.length > 0 && NONCE_OF(channel.writes[0]) !== undefined)
  const initNonce = NONCE_OF(channel.writes[0])
  assert.ok(buildInitCommand(initNonce).includes('TERM=dumb'), 'the init line is the ported dumb-terminal setup')
  channel.feed(`\x1b]133;D;${initNonce};0;/home/u1\x07`)
  await until(() => channel.writes.length > 1)
  const cmdNonce = NONCE_OF(channel.writes[1])
  assert.ok(channel.writes[1].includes('echo one'))
  channel.feed('one\n')
  channel.feed(`\x1b]133;D;${cmdNonce};0;/home/u1\x07`)
  const r1 = await first
  assert.equal(r1.exit, 0)
  assert.equal(r1.cwd, '/home/u1')
  assert.equal(r1.output, 'one\n')
  assert.equal(r1.reconnected, false)
  assert.equal(session.sessionState, 'ready')

  // second dispatch: NO re-init — the session is reused, strictly FIFO
  const second = session.dispatch('echo two')
  await until(() => channel.writes.length > 2)
  const n2 = NONCE_OF(channel.writes[2])
  channel.feed(`\x1b]133;D;${n2};7;/tmp\x07`)
  const r2 = await second
  assert.equal(r2.exit, 7)
  assert.equal(r2.cwd, '/tmp')
  assert.equal(channel.writes.filter((w) => w.includes('TERM=dumb')).length, 1, 'init ran exactly once')
})

test('session: transport death settles in-flight dispatch honestly; the NEXT dispatch reconnects', async () => {
  const channel = new FakeChannel()
  const session = new PtySession({ key: 'k2', channel, idleTtlSec: 600 })
  const first = session.dispatch('echo never')
  await until(() => channel.writes.length > 0 && NONCE_OF(channel.writes[0]) !== undefined)
  channel.feed(`\x1b]133;D;${NONCE_OF(channel.writes[0])};0;/\x07`)
  await until(() => channel.writes.length > 1)
  channel.die()
  const dead = await first
  assert.equal(dead.exit, null)
  assert.equal(dead.timedOut, false, 'death is not a timeout')

  const second = session.dispatch('echo after-death')
  await until(() => channel.writes.length > 2 && NONCE_OF(channel.writes[2]) !== undefined)
  channel.feed(`\x1b]133;D;${NONCE_OF(channel.writes[2])};0;/\x07`)
  await until(() => channel.writes.length > 3)
  channel.feed(`\x1b]133;D;${NONCE_OF(channel.writes[3])};0;/\x07`)
  const r = await second
  assert.equal(r.reconnected, true, 'a dead session restarts transparently')
})

test('session: timeout = two-stage interrupt (\\x03 + injected 130 marker), frame 130 settles timedOut', async () => {
  const channel = new FakeChannel()
  const session = new PtySession({ key: 'k3', channel, idleTtlSec: 600 })
  const p = session.dispatch('sleep 30', { timeoutSec: 1 })
  await until(() => channel.writes.length > 0 && NONCE_OF(channel.writes[0]) !== undefined)
  channel.feed(`\x1b]133;D;${NONCE_OF(channel.writes[0])};0;/\x07`)
  await until(() => channel.writes.length > 1)
  const cmdNonce = NONCE_OF(channel.writes[1])
  await until(() => channel.writes.some((w) => w === '\x03'), 2500)
  const marker = channel.writes.find((w) => w.includes(`\\033]133;D;${cmdNonce};130`))
  assert.ok(marker, 'the injected 130-marker line follows the interrupt')
  channel.feed(`\x1b]133;D;${cmdNonce};130;/\x07`)
  const r = await p
  assert.equal(r.timedOut, true)
  assert.equal(r.exit, 130)
  assert.equal(session.sessionState, 'ready', 'the interrupt path keeps the session alive')
})

test('pool: getOrCreate keys sessions; dispose evicts', async () => {
  const pool = new PtyPool({ idleTtlSec: 600 })
  const a = pool.getOrCreate('s1|m:x', () => new FakeChannel())
  const same = pool.getOrCreate('s1|m:x', () => new FakeChannel())
  assert.equal(a, same)
  const other = pool.getOrCreate('s2|m:x', () => new FakeChannel())
  assert.notEqual(a, other)
  assert.equal(pool.size, 2)
  await pool.disposeAll()
  assert.equal(pool.size, 0)
})

// ---------------------------------------------------------------- local script integration (real PTY)

test('local script channel: cwd persists across dispatches on a REAL host PTY', { timeout: 30_000 }, async () => {
  const channel = new LocalScriptChannel()
  const session = new PtySession({ key: 'local', channel, idleTtlSec: 600 })
  const r1 = await session.dispatch('cd /tmp && echo pty-local-ok')
  assert.equal(r1.exit, 0)
  assert.match(r1.output, /pty-local-ok/)
  const r2 = await session.dispatch('pwd')
  assert.equal(r2.exit, 0)
  assert.equal(r2.cwd, '/tmp', 'the shell STATE survived the first dispatch')
  assert.match(r2.output, /\/tmp/)
  await session.dispose()
})

// ---------------------------------------------------------------- executor end-to-end (in-process WS)

test('executor e2e: session over a real WebSocket to the dumb pump (init → dispatch → exit → cwd)', { timeout: 30_000 }, async () => {
  const http = createServer()
  let upgradeHandler = undefined
  const disposeReg = await registerPtyExecutor({
    registerUpgrade: ({ handler }) => { upgradeHandler = handler; return () => { upgradeHandler = undefined } },
  }, { authorize: () => true })
  http.on('upgrade', (req, socket, head) => upgradeHandler?.(req, socket, head))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = http.address().port
  try {
    const channel = new WsPtyChannel(`ws://127.0.0.1:${port}${PTY_EXEC_PATH}`)
    const session = new PtySession({ key: 'ws-e2e', channel, idleTtlSec: 600 })
    const r1 = await session.dispatch('echo ws-pty-ok')
    assert.equal(r1.exit, 0)
    assert.match(r1.output, /ws-pty-ok/)
    assert.ok(r1.cwd !== null && r1.cwd.length > 0)
    const r2 = await session.dispatch('cd /tmp && pwd')
    assert.equal(r2.cwd, '/tmp', 'state persisted across the wire')
    await session.dispose()
  } finally {
    disposeReg()
    await new Promise((resolve) => http.close(resolve))
  }
})

test('executor gate: authorize=false rejects the upgrade before any ws handover', { timeout: 15_000 }, async () => {
  const http = createServer()
  let upgradeHandler = undefined
  const disposeReg = await registerPtyExecutor({
    registerUpgrade: ({ handler }) => { upgradeHandler = handler; return () => { upgradeHandler = undefined } },
  }, { authorize: () => false })
  http.on('upgrade', (req, socket, head) => upgradeHandler?.(req, socket, head))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  try {
    const channel = new WsPtyChannel(`ws://127.0.0.1:${http.address().port}${PTY_EXEC_PATH}`)
    await assert.rejects(
      () => new PtySession({ key: 'denied', channel, idleTtlSec: 600, initTimeoutSec: 3 }).dispatch('echo nope'),
      /closed before opening|did not initialize|died/i,
    )
  } finally {
    disposeReg()
    await new Promise((resolve) => http.close(resolve))
  }
})
