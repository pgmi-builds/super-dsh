// 0.3.2-c hub-remote-parity: the fork (exec-pty-session/-channel) is deleted —
// hub PTY is now a CANONICAL closure session whose child is the pump
// (hub-pty-pump.mjs) over one WebSocket to the dumb peer executor
// (exec-pty-rpc.ts, unchanged). These tests drive the real lane in-process:
// canonical PtySession → buildHubPtyArgv → pump child → ws → executor →
// `script -qfec bash /dev/null`. The framing/parser/session-machine suites
// live in better-dsh (canonical source); only the lane itself is proven here.
import test from 'node:test'
import assert from 'assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { registerPtyExecutor, PTY_EXEC_PATH } from '../dist/exec-pty-rpc.js'
import { PtySession, buildHubPtyArgv, hubPtyAssets } from '../../remote/plugin.js'

const wsModulePath = createRequire(import.meta.url).resolve('ws')

const spinExecutor = async (authorize) => {
  const http = createServer()
  let upgradeHandler = undefined
  const disposeReg = await registerPtyExecutor({
    registerUpgrade: ({ handler }) => { upgradeHandler = handler; return () => { upgradeHandler = undefined } },
  }, { authorize })
  http.on('upgrade', (req, socket, head) => upgradeHandler?.(req, socket, head))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  return {
    port: http.address().port,
    async close() { disposeReg(); await new Promise((resolve) => http.close(resolve)) },
  }
}

const hubSession = (port, overrides = {}) => new PtySession({
  key: 'hub-pty-test',
  argv: buildHubPtyArgv({ url: `ws://127.0.0.1:${port}${PTY_EXEC_PATH}`, cookie: '', wsPath: wsModulePath }, hubPtyAssets()),
  id: 'p-test0001',
  connection: 'hub:t-0001',
  idleTtlSec: 900,
  ...overrides,
})

const genCommandId = () => `remote-${process.hrtime.bigint().toString(16).slice(-16)}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- local argv (sanity: canonical session, no fork)

test('canonical session (local argv): cwd persists across dispatches on a REAL host PTY', { timeout: 30_000 }, async () => {
  const session = new PtySession({ key: 'local', argv: ['script', '-qfec', 'bash', '/dev/null'], id: 'p-local001', connection: 'local', idleTtlSec: 600 })
  const r1 = await session.dispatch('cd /tmp && echo pty-local-ok', { commandId: genCommandId() })
  assert.equal(r1.exit, 0)
  assert.match(r1.output, /pty-local-ok/)
  const r2 = await session.dispatch('pwd', { commandId: genCommandId() })
  assert.equal(r2.exit, 0)
  assert.equal(r2.cwd, '/tmp', 'the shell STATE survived the first dispatch')
  await session.dispose()
})

// ---------------------------------------------------------------- executor end-to-end (pump + real WS)

test('executor e2e: canonical session over pump child + WS to the dumb pump (init → dispatch → cwd persists)', { timeout: 30_000 }, async () => {
  const exec = await spinExecutor(() => true)
  try {
    const session = hubSession(exec.port)
    const r1 = await session.dispatch('echo ws-pty-ok', { commandId: genCommandId() })
    assert.equal(r1.exit, 0)
    assert.match(r1.output, /ws-pty-ok/)
    assert.ok(r1.cwd !== null && r1.cwd.length > 0)
    const r2 = await session.dispatch('cd /tmp && pwd', { commandId: genCommandId() })
    assert.equal(r2.exit, 0)
    assert.equal(r2.cwd, '/tmp', 'state persisted across the wire (pump + WS leg)')
    await session.dispose()
  } finally {
    await exec.close()
  }
})

test('executor e2e: interactive stdin over the hub lane (input → two-prompt fixture → ACCEPTED)', { timeout: 30_000 }, async () => {
  const exec = await spinExecutor(() => true)
  try {
    const session = hubSession(exec.port)
    const cmd = `printf 'Password:'; IFS= read -s -r pw; printf '\\nOTP:'; IFS= read -s -r otp; printf '\\n' ; [ "$pw" = demo ] && [ "$otp" = 123456 ] && echo ACCEPTED || echo DENIED`
    const r = await session.dispatch(cmd, { commandId: genCommandId(), timeoutSec: 15 })
    assert.match(r.output, /Password:/, 'the first prompt reached the receipt')
    const receipt = await session.input({ stdin: 'demo\n', commandId: r.commandId })
    assert.equal(receipt.writtenBytes, 5)
    const receipt2 = await session.input({ stdin: '123456\n', commandId: r.commandId })
    assert.equal(receipt2.writtenBytes, 7)
    const settle = await r.job?.done
    assert.equal(settle?.exit ?? r.exit, 0)
    assert.match(settle?.output ?? r.output, /ACCEPTED/, 'credentials crossed the pump + WS leg and the fixture accepted')
    await session.dispose()
  } finally {
    await exec.close()
  }
})

// ------------------------------------------------------- control bytes over the hub lane (0.3.2-d F4)
// 旧 wrapper（stty -echo，无 raw）下这四条全部打死会话：0x03 在本地行规程变 SIGINT 杀泵、
// 0x04 变 EOF 结束泵 stdin（复测 2026-10-26 §4.1 四连）。raw 修复后字节原样过线，解释权
// 在对端 canonical pty——^C/^D 在对端成 SIGINT/EOF，会话存活。

test('F4 pin 1: input 0x03 crosses to the peer as a byte — bare Ctrl-C keeps the job running (F1 honest), the interrupt rescue settles exit 130, the session survives', { timeout: 30_000 }, async () => {
  const exec = await spinExecutor(() => true)
  try {
    const session = hubSession(exec.port)
    const r = await session.dispatch('cd /tmp && sleep 30', { commandId: genCommandId(), background: true })
    await sleep(600)
    const rc = await session.input({ stdin: '\x03', commandId: r.commandId })
    assert.equal(rc.writtenBytes, 1)
    // 旧 wrapper：泵被本地 SIGINT 杀死 → 会话死 → job 以 exit null 结算（'settled'）。
    // raw 后：字节过线、对端 ISIG 打断 sleep，但裸 ^C 无 marker——作业保持 running（F1 如实）。
    const still = await Promise.race([r.job.done.then(() => 'settled'), sleep(1_500).then(() => 'running')])
    assert.equal(still, 'running')
    r.job.interrupt()
    const done = await r.job.done
    assert.equal(done.exit, 130)
    const next = await session.dispatch('pwd', { commandId: genCommandId() })
    assert.equal(next.exit, 0)
    assert.equal(next.cwd, '/tmp', 'same shell — no reconnect, state kept')
    await session.dispose()
  } finally {
    await exec.close()
  }
})

test('F4 pin 2: input 0x04 reaches the peer as terminal EOF — two-step Ctrl-D ends a remote cat, the session survives', { timeout: 30_000 }, async () => {
  const exec = await spinExecutor(() => true)
  try {
    const session = hubSession(exec.port)
    const r = await session.dispatch('cat', { commandId: genCommandId(), background: true })
    await session.input({ stdin: 'abc', commandId: r.commandId })
    await session.input({ stdin: '\x04', commandId: r.commandId }) // non-empty line: delivers 'abc', no EOF yet
    await sleep(500)
    assert.match(r.job.read(0).text, /abc/, "cat echoed the delivered line (the peer's EOF rules, not a local one)")
    const state = await Promise.race([r.job.done.then(() => 'settled'), sleep(500).then(() => 'running')])
    assert.equal(state, 'running', 'first Ctrl-D delivered the line; cat keeps waiting')
    await session.input({ stdin: '\x04', commandId: r.commandId }) // emptied line → real EOF
    const done = await r.job.done
    assert.equal(done.exit, 0)
    const next = await session.dispatch('echo ALIVE-EOF', { commandId: genCommandId() })
    assert.equal(next.exit, 0)
    assert.match(next.output, /ALIVE-EOF/)
    await session.dispose()
  } finally {
    await exec.close()
  }
})

test('F4 pin 3: interrupt of a running command settles exit 130 and the session stays ready', { timeout: 30_000 }, async () => {
  const exec = await spinExecutor(() => true)
  try {
    const session = hubSession(exec.port)
    const r = await session.dispatch('sleep 30', { commandId: genCommandId(), background: true })
    await sleep(600)
    r.job.interrupt()
    const done = await r.job.done
    assert.equal(done.exit, 130)
    const next = await session.dispatch('echo ALIVE-KILL', { commandId: genCommandId() })
    assert.equal(next.exit, 0)
    assert.match(next.output, /ALIVE-KILL/)
    await session.dispose()
  } finally {
    await exec.close()
  }
})

test('F4 pin 4: timeout handoff then interrupt — same identity, exit 130, session survives', { timeout: 30_000 }, async () => {
  const exec = await spinExecutor(() => true)
  try {
    const session = hubSession(exec.port)
    const r = await session.dispatch('sleep 30', { commandId: genCommandId(), timeoutSec: 2 })
    assert.equal(r.running, true)
    r.job.interrupt()
    const done = await r.job.done
    assert.equal(done.exit, 130)
    const next = await session.dispatch('echo ALIVE-HANDOFF', { commandId: genCommandId() })
    assert.equal(next.exit, 0)
    assert.equal(next.reconnected, false)
    await session.dispose()
  } finally {
    await exec.close()
  }
})

test('executor gate: authorize=false rejects the upgrade; the session dies before initializing with pump diagnostics', { timeout: 15_000 }, async () => {
  const exec = await spinExecutor(() => false)
  try {
    const session = hubSession(exec.port, { initTimeoutSec: 6 })
    await assert.rejects(
      () => session.dispatch('echo nope', { commandId: genCommandId() }),
      /did not initialize|died before initializing/i,
    )
    // 嵌套 PTY 固有形状：script 把子进程 0/1/2 全挂 pty slave——泵的 stderr 进字节流而非
    // 会话 diag 管道，初始化失败以诚实的 E_SESSION_* 面世（cause 诊断见验收报告披露）。
    await session.dispose()
  } finally {
    await exec.close()
  }
})
