import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSshBackend } from '../../src/remote/backend.ts'
import type { ConnState, ExecOutcome, RemoteError } from '../../src/remote/backend.ts'
import { createMemoryHostKeyStore } from '../../src/remote/hostkeys.ts'
import type { HostKeyStore } from '../../src/remote/hostkeys.ts'
import type { RemoteTargetSpec } from '../../src/remote/registry.ts'
import { createSshServerFixture } from './fixtures/ssh-server.ts'
import type { SshServerFixture } from './fixtures/ssh-server.ts'

// 夹具与目标常量；负路径各自起独立夹具（随机端口，无冲突），try/finally 保证回收。
const NAME = 'fixture-host'
const EXEC_TIMEOUT = 30_000

let fixture: SshServerFixture
let port = 0
let fingerprint = ''
let clientKeyPath = ''

beforeAll(async () => {
  fixture = createSshServerFixture()
  const started = await fixture.start()
  port = started.port
  fingerprint = started.hostKeyFingerprint
  clientKeyPath = fixture.clientPrivateKeyPath
})

afterAll(async () => {
  await fixture.stop()
})

function makeTarget(overrides: Partial<RemoteTargetSpec> = {}): RemoteTargetSpec {
  return {
    name: NAME,
    backend: 'ssh',
    host: '127.0.0.1',
    port,
    user: 'fixture',
    identityFile: clientKeyPath,
    ...overrides,
  }
}

function makeBackend(
  store: HostKeyStore = createMemoryHostKeyStore(),
  overrides: Partial<RemoteTargetSpec> = {},
) {
  return createSshBackend(makeTarget(overrides), { hostKeyStore: store })
}

/** 断言 promise 以带 code 的错误拒绝，并返回该错误（错误码语义是本套件的核心契约）。 */
async function rejectWithCode<T>(p: Promise<T>, code: string): Promise<RemoteError> {
  const settled = await p.then(
    () => null,
    (err: RemoteError) => err,
  )
  if (settled === null) throw new Error(`expected rejection with ${code}, but resolved`)
  expect(settled.code).toBe(code)
  return settled
}

/** 占住一个随机端口后立刻释放，返回该端口号（E_CONNECT：无监听 → ECONNREFUSED）。 */
async function grabFreePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const p = (srv.address() as { port: number }).port
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  return p
}

describe('SshBackend degraded exec', () => {
  it('runs a command with cwd tracking and reports exitCode/output/cwdAfter', async () => {
    const backend = makeBackend()
    expect(backend.connState()).toBe<ConnState>('idle')
    const out: ExecOutcome = await backend.exec('echo hi', { cwd: '/tmp', timeoutMs: EXEC_TIMEOUT })
    expect(out.exitCode).toBe(0)
    expect(out.output.trim()).toBe('hi')
    expect(out.cwdAfter).toBe('/tmp')
    expect(backend.connState()).toBe<ConnState>('ready')
    await backend.close()
  })

  it('reports exit code of the command (exit 7)', async () => {
    const backend = makeBackend()
    const out = await backend.exec('exit 7', { cwd: '/tmp', timeoutMs: EXEC_TIMEOUT })
    expect(out.exitCode).toBe(7)
    await backend.close()
  })

  it('rejects E_CWD_GONE with the target cwd verbatim when the cwd is gone', async () => {
    const backend = makeBackend()
    const err = await rejectWithCode(
      backend.exec('echo x', { cwd: '/no/such/dir', timeoutMs: EXEC_TIMEOUT }),
      'E_CWD_GONE',
    )
    expect(err.message).toContain('/no/such/dir')
    await backend.close()
  })

  it('passes call env through to the command', async () => {
    const backend = makeBackend()
    const out = await backend.exec('printf %s "$BAKE_TEST_VAR"', {
      cwd: '/tmp',
      timeoutMs: EXEC_TIMEOUT,
      env: { BAKE_TEST_VAR: 'baked-42' },
    })
    expect(out.output).toBe('baked-42')
    await backend.close()
  })
})

describe('SshBackend PTY shell session', () => {
  it('boots a session, tracks cwd over OSC 7 and injects env', async () => {
    const backend = makeBackend()
    const session = await backend.openShellSession({ BAKE_TEST_VAR: 'baked-42' })
    const first = await session.run('cd /tmp && pwd')
    expect(first.output).toContain('/tmp')
    expect(session.cwd()).toBe('/tmp')
    const second = await session.run('echo $BAKE_TEST_VAR')
    expect(second.output.trim()).toBe('baked-42')
    await session.dispose()
    await backend.close()
  })
})

describe('SshBackend connection pooling', () => {
  it('reuses ONE TCP connection across execs and a full shell session', async () => {
    const solo = createSshServerFixture()
    try {
      const { port: p } = await solo.start()
      // 独立夹具有自己的客户端钥 — identityFile 必须指到它，而不是主夹具的
      const backend = makeBackend(createMemoryHostKeyStore(), {
        port: p,
        identityFile: solo.clientPrivateKeyPath,
      })
      await backend.exec('true', { cwd: '/tmp', timeoutMs: EXEC_TIMEOUT })
      await backend.exec('true', { cwd: '/tmp', timeoutMs: EXEC_TIMEOUT })
      const session = await backend.openShellSession({ BAKE_TEST_VAR: '1' })
      await session.run('true')
      await session.run('true')
      await session.dispose()
      await backend.close()
      expect(solo.connectionCount).toBe(1)
    } finally {
      await solo.stop()
    }
  })
})

describe('SshBackend TOFU host keys', () => {
  it('pins the fingerprint on first connect (store was empty)', async () => {
    const store = createMemoryHostKeyStore()
    expect(store.get(NAME)).toBeUndefined()
    const backend = makeBackend(store)
    await backend.exec('true', { cwd: '/tmp', timeoutMs: EXEC_TIMEOUT })
    expect(store.get(NAME)).toBe(fingerprint)
    await backend.close()
  })

  it('rejects E_HOSTKEY_CHANGED on mismatch and keeps the stored pin', async () => {
    const store = createMemoryHostKeyStore()
    store.set(NAME, 'SHA256:tampered-fingerprint')
    const backend = makeBackend(store)
    await rejectWithCode(
      backend.exec('true', { cwd: '/tmp', timeoutMs: EXEC_TIMEOUT }),
      'E_HOSTKEY_CHANGED',
    )
    expect(store.get(NAME)).toBe('SHA256:tampered-fingerprint')
    await backend.close()
  })
})

describe('SshBackend error paths', () => {
  it('rejects E_AUTH when the server refuses our key', async () => {
    const refusing = createSshServerFixture({ rejectKeyAuth: true })
    try {
      const { port: p } = await refusing.start()
      const backend = makeBackend(createMemoryHostKeyStore(), {
        port: p,
        identityFile: refusing.clientPrivateKeyPath,
      })
      await rejectWithCode(
        backend.exec('true', { cwd: '/tmp', timeoutMs: EXEC_TIMEOUT }),
        'E_AUTH',
      )
      await backend.close()
    } finally {
      await refusing.stop()
    }
  })

  it('rejects E_PROXY_UNSUPPORTED immediately (fail-loud, no TCP)', async () => {
    const backend = makeBackend(createMemoryHostKeyStore(), { proxyJump: 'jump@elsewhere:22' })
    await rejectWithCode(
      backend.exec('true', { cwd: '/tmp', timeoutMs: EXEC_TIMEOUT }),
      'E_PROXY_UNSUPPORTED',
    )
    expect(backend.connState()).toBe<ConnState>('idle')
  })

  it('rejects E_KEY_UNREADABLE when identityFile does not exist', async () => {
    const backend = makeBackend(createMemoryHostKeyStore(), { identityFile: '/no/such/identity' })
    await rejectWithCode(
      backend.exec('true', { cwd: '/tmp', timeoutMs: EXEC_TIMEOUT }),
      'E_KEY_UNREADABLE',
    )
  })

  it('rejects E_CONNECT when nothing listens on the port', async () => {
    const deadPort = await grabFreePort()
    const backend = makeBackend(createMemoryHostKeyStore(), { port: deadPort })
    await rejectWithCode(
      backend.exec('true', { cwd: '/tmp', timeoutMs: EXEC_TIMEOUT }),
      'E_CONNECT',
    )
    expect(backend.connState()).toBe<ConnState>('idle')
  })
})
