import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SshMux, SSH_MUX_CONTROL_PERSIST_SEC } from '../../src/remote/ssh-mux.ts'
import { buildOneShotArgv, buildPtyArgv, buildHelperProbeArgv, buildHelperUploadArgv, buildHelperOneShotArgv, buildHelperKillgroupArgv, helperShellArgv } from '../../src/remote/transports.ts'
import type { HelperAssets } from '../../src/remote/helper.ts'
import type { TargetPlan } from '../../src/remote/target.ts'
import { runOneShot } from '../../src/remote/oneshot.ts'
import { withSshFixture } from './ssh-fixture.ts'
import { createRealRemoteHarness } from './real-harness.ts'

// Task E（plan 2026-11-01）：SSH oneshot 执行链的 OpenSSH MUX 复用。单测锁 argv 形状/身份隔离/
// 目录纪律；真实 sshd 夹具锁首连-复用-并发-取消-master 存活-拆除的实测语义（探针基线：发起端
// OpenSSH 10.2p1，2026-11-01——master 与客户端进程组脱钩、残 socket 自愈、-O exit/到期自删）。

const SOCKET_RE = /^[0-9a-f]{16}$/

async function muxRoot(): Promise<string> { return await mkdtemp(join(tmpdir(), 'mux-spec-')) }

/** The single superd-mux-<owner8> dir under a custom root, plus its 16-hex socket leaves. */
async function socketsUnder(root: string): Promise<string[]> {
  const owners = await readdir(root)
  expect(owners, 'exactly one owner dir per SshMux instance').toHaveLength(1)
  const dir = join(root, owners[0]!)
  return (await readdir(dir)).filter(f => SOCKET_RE.test(f)).map(f => join(dir, f))
}

/** Raw control-client check: exit 0 + "Master running" proves a live master owns the socket. */
async function masterAlive(socket: string): Promise<boolean> {
  const r = await runOneShot(['ssh', '-o', `ControlPath=${socket}`, '-O', 'check', '127.0.0.1'], { timeoutSec: 5 })
  return r.exit === 0 && `${r.stdout}${r.stderr}`.includes('Master running') // -O check prints to stderr
}

describe('SshMux unit (no dialing)', () => {
  it('emits the three -o options, creates a 0700 dir lazily, and keeps socket paths short', async () => {
    const root = await muxRoot()
    try {
      const mux = new SshMux({ rootDir: root, persistSec: 45 })
      const argv = mux.argvFor({ target: 'ssh:dev4', connection: { host: 'dev4' } })
      expect(argv.slice(2, 6)).toEqual(['-o', 'ControlMaster=auto', '-o', 'ControlPersist=45'])
      expect(argv[0]).toBe('-o')
      const socket = argv[1]!.slice('ControlPath='.length)
      expect(socket).toMatch(/superd-mux-[0-9a-f]{8}\/[0-9a-f]{16}$/)
      expect(socket.length).toBeLessThanOrEqual(104)
      const dirStat = await stat(dirname(socket))
      expect(dirStat.mode & 0o777).toBe(0o700)
      const again = mux.argvFor({ target: 'ssh:dev4', connection: { host: 'dev4' } })
      expect(again[1]).toBe(argv[1]) // same identity → same master
      // socket leaf only appears when a real ssh master binds it (fixture tests cover that); here the 0700 dir existing is the fs contract
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('separates identities: raw target spelling and every connection field participate in the key', async () => {
    const root = await muxRoot()
    try {
      const mux = new SshMux({ rootDir: root })
      const sockOf = (target: string, connection: Record<string, unknown>) => mux.argvFor({ target, connection: connection as never })[1]
      const base = sockOf('ssh:dev4', { host: 'dev4' })
      expect(new Set([
        base,
        sockOf('dev4', { host: 'dev4' }), // 原始 target 拼法不同 → 不串 socket
        sockOf('ssh:dev4', { host: 'dev5' }),
        sockOf('ssh:dev4', { host: 'dev4', user: 'root' }),
        sockOf('ssh:dev4', { host: 'dev4', port: 2222 }),
        sockOf('ssh:dev4', { host: 'dev4', key: '/home/u1/.ssh/id_ed25519' }),
        sockOf('ssh:dev4', { host: 'dev4', proxyJump: 'bastion' }),
      ]).size).toBe(7)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('defaults to the bounded ControlPersist and degrades to plain connection when the path or dir is impossible', async () => {
    const root = await muxRoot()
    try {
      const argv = new SshMux({ rootDir: root }).argvFor({ target: 'ssh:dev4', connection: { host: 'dev4' } })
      expect(argv[5]).toBe(`ControlPersist=${SSH_MUX_CONTROL_PERSIST_SEC}`)
      const long = new SshMux({ rootDir: `${root}/${'x'.repeat(100)}` })
      expect(long.argvFor({ target: 'ssh:dev4', connection: { host: 'dev4' } })).toEqual([])
      const noDir = new SshMux({ rootDir: '/', runner: undefined })
      noDir.dispose()
      expect(noDir.argvFor({ target: 'ssh:dev4', connection: { host: 'dev4' } })).toEqual([]) // post-dispose: honest degrade
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('dispose: -O exit per socket (errors swallowed), then the whole owner dir is removed', async () => {
    const root = await muxRoot()
    let torn = 0
    const mux = new SshMux({
      rootDir: root, persistSec: 30,
      runner: async argv => { torn++; expect(argv[0]).toBe('ssh'); expect(argv).toContain('-O'); return { exit: 255 } }, // master already gone: still fine
    })
    mux.argvFor({ target: 'ssh:dev4', connection: { host: 'dev4' } })
    mux.argvFor({ target: 'ssh:dev5', connection: { host: 'dev5' } })
    await mux.dispose()
    expect(torn).toBe(2)
    await expect(readdir(root)).resolves.toEqual([]) // dir removed, not even the owner dir remains
  })

  it('builders: mux rides the SSH oneshot chain only — PTY and default helperShellArgv stay clean', () => {
    const muxArgv = ['-o', 'ControlPath=/tmp/mux-spec', '-o', 'ControlMaster=auto', '-o', 'ControlPersist=600']
    const plan: TargetPlan = { kind: 'ssh', host: 'dev4' }
    const assets = { dir: '/nonexistent', manifest: { format: 1, name: 'superd-run', ver: '1.0.0', protocol: 1, targets: { 'x86_64-unknown-linux-musl': { file: 'superd-run', bytes: 1, sha256: '00' } } } } as HelperAssets
    const oneShot = buildOneShotArgv(plan, 'echo hi', { muxArgv })
    expect(oneShot.join(' ')).toContain('-o BatchMode=yes -T -o ControlPath=/tmp/mux-spec')
    expect(oneShot.indexOf('--')).toBeGreaterThan(oneShot.indexOf('ControlPath=/tmp/mux-spec'))
    expect(buildHelperProbeArgv(plan, assets, muxArgv).join(' ')).toContain('ControlPath=/tmp/mux-spec')
    expect(buildHelperUploadArgv(plan, 'x86_64-unknown-linux-musl', 'superd-run', assets, muxArgv).join(' ')).toContain('ControlPath=/tmp/mux-spec')
    expect(buildHelperOneShotArgv(plan, '/remote/superd-run', { tag: 't1', cmd: 'echo hi', muxArgv }).join(' ')).toContain('ControlPath=/tmp/mux-spec')
    expect(buildHelperKillgroupArgv(plan, '/remote/superd-run', 't1', muxArgv).join(' ')).toContain('ControlPath=/tmp/mux-spec')
    // 不注入面：PTY 常驻、helperShellArgv 默认形（copy 的 mkdir pre-hop 走这里）
    expect(buildPtyArgv(plan).join(' ')).not.toContain('ControlMaster')
    expect(buildOneShotArgv(plan, 'echo hi').join(' ')).not.toContain('ControlMaster')
    expect(helperShellArgv(plan, 'mkdir -p /dst').join(' ')).not.toContain('ControlMaster')
    expect(buildOneShotArgv({ kind: 'docker', container: 'box' }, 'echo hi', { muxArgv })[0]).toBe('docker')
  })
})

describe('SSH oneshot MUX over a real sshd fixture', () => {
  it('oneshot chain shares one live master: reuse, concurrency, timeout-cancel survival, status probe, teardown', async () => {
    await withSshFixture(async fixture => {
      const root = await muxRoot()
      let h: Awaited<ReturnType<typeof createRealRemoteHarness>> | undefined
      try {
        h = await createRealRemoteHarness({
          copies: 1,
          driverOptions: {
            helperAssetsFor: () => null, // posix-shim lane for determinism
            sshMux: new SshMux({ rootDir: root }),
            oneshotArgvFor: (plan, cmd, options) => fixture.isolate(buildOneShotArgv(plan, cmd, options)), // opts threaded → mux + cleanupTag preserved
          },
        })
        const agent = await h.createAgent('mux-reuse')
        await h.invoke(agent, { action: 'add', target: 'ssh:lab', ssh: fixture.destination })
        // 首连：master 建立
        expect((await h.invoke(agent, { action: 'exec', target: 'ssh:lab', cmd: 'printf one', mode: 'oneshot' })).text).toBe('one')
        let sockets = await socketsUnder(root)
        expect(sockets).toHaveLength(1)
        expect(await masterAlive(sockets[0]!)).toBe(true)
        // 复用：同一 socket，不再新开
        expect((await h.invoke(agent, { action: 'exec', target: 'ssh:lab', cmd: 'printf two', mode: 'oneshot' })).text).toBe('two')
        sockets = await socketsUnder(root)
        expect(sockets).toHaveLength(1)
        // 并发 3 路：同一 master 上的并行多路复用会话
        const texts = await Promise.all([1, 2, 3].map(i =>
          h!.invoke(agent, { action: 'exec', target: 'ssh:lab', cmd: `printf c${i}`, mode: 'oneshot' }).then(r => r.text)))
        expect(texts).toEqual(['c1', 'c2', 'c3'])
        expect(await socketsUnder(root)).toHaveLength(1)
        // 超时取消：客户端被 killpg，master 必须存活（探针 T4b），后续 oneshot 照常
        const timed = await h.invoke(agent, { action: 'exec', target: 'ssh:lab', cmd: 'sleep 5; printf late', timeout: 1, mode: 'oneshot' }) as unknown as { timedOut: boolean }
        expect(timed.timedOut).toBe(true)
        expect((await h.invoke(agent, { action: 'exec', target: 'ssh:lab', cmd: 'printf after', mode: 'oneshot' })).text).toBe('after')
        sockets = await socketsUnder(root)
        expect(sockets).toHaveLength(1)
        expect(await masterAlive(sockets[0]!)).toBe(true)
        // status 探测同链复用（同身份 → 同 socket）
        const status = (await h.invoke(agent, { action: 'status', target: 'ssh:lab' })).text
        expect(status).toContain('reachable')
        expect(await socketsUnder(root)).toHaveLength(1)
        // teardown：harness dispose → driver dispose → mux dispose → 目录消失
        await h!.dispose(); h = undefined
        await expect(readdir(root)).resolves.toEqual([])
      } finally {
        await h?.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })
  }, 30000)

  it('identities never share masters; the PTY lane stays unmultiplexed in the same driver', async () => {
    await withSshFixture(async fixture => {
      const root = await muxRoot()
      const ptyArgv: string[][] = []
      let h: Awaited<ReturnType<typeof createRealRemoteHarness>> | undefined
      try {
        h = await createRealRemoteHarness({
          copies: 1,
          driverOptions: {
            helperAssetsFor: () => null,
            sshMux: new SshMux({ rootDir: root }),
            oneshotArgvFor: (plan, cmd, options) => fixture.isolate(buildOneShotArgv(plan, cmd, options)),
            ptyArgvFor: plan => { const argv = buildPtyArgv(plan); ptyArgv.push(argv); return fixture.isolate(argv) },
          },
        })
        const agent = await h.createAgent('mux-isolation')
        await h.invoke(agent, { action: 'add', target: 'ssh:a', ssh: fixture.destination })
        await h.invoke(agent, { action: 'add', target: 'ssh:b', ssh: fixture.jump })
        expect((await h.invoke(agent, { action: 'exec', target: 'ssh:a', cmd: 'printf A', mode: 'oneshot' })).text).toBe('A')
        expect((await h.invoke(agent, { action: 'exec', target: 'ssh:b', cmd: 'printf B', mode: 'oneshot' })).text).toBe('B')
        const sockets = await socketsUnder(root)
        expect(sockets).toHaveLength(2) // 不同 BYO 身份（host/port/key 全不同）绝不共 master
        expect(await masterAlive(sockets[0]!)).toBe(true)
        expect(await masterAlive(sockets[1]!)).toBe(true)
        // machine target 无 mode → 默认 PTY 槽（PTY 基座），argv 里没有任何 MUX 选项
        expect((await h.invoke(agent, { action: 'exec', target: 'ssh:a', cmd: 'printf pty' })).text).toBe('pty')
        expect(ptyArgv.length).toBeGreaterThan(0)
        for (const argv of ptyArgv) expect(argv.join(' ')).not.toContain('ControlMaster')
        expect(await socketsUnder(root)).toHaveLength(2) // PTY 没有新开 socket
      } finally {
        await h?.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })
  }, 30000)

  it('a stale socket (SIGKILLed master) self-heals: next oneshot re-masters transparently', async () => {
    await withSshFixture(async fixture => {
      const root = await muxRoot()
      let h: Awaited<ReturnType<typeof createRealRemoteHarness>> | undefined
      try {
        h = await createRealRemoteHarness({
          copies: 1,
          driverOptions: {
            helperAssetsFor: () => null,
            sshMux: new SshMux({ rootDir: root }),
            oneshotArgvFor: (plan, cmd, options) => fixture.isolate(buildOneShotArgv(plan, cmd, options)),
          },
        })
        const agent = await h.createAgent('mux-stale')
        await h.invoke(agent, { action: 'add', target: 'ssh:lab', ssh: fixture.destination })
        expect((await h.invoke(agent, { action: 'exec', target: 'ssh:lab', cmd: 'printf first', mode: 'oneshot' })).text).toBe('first')
        const [socket] = await socketsUnder(root)
        expect(socket).toBeDefined()
        // find the pid owning the socket (master) and SIGKILL it — leave the stale socket file behind
        const kill = await runOneShot(['bash', '-c', `pid=$(pgrep -f "^ssh: ${socket!} \\[mux\\]$" | head -1); [ -n "$pid" ] && kill -KILL "$pid" && echo killed || echo none`])
        expect(kill.stdout).toContain('killed')
        await new Promise(resolve => setTimeout(resolve, 300))
        // ControlMaster=auto self-heals over the stale socket (probe T5: exit 0, no error surfaced)
        expect((await h.invoke(agent, { action: 'exec', target: 'ssh:lab', cmd: 'printf healed', mode: 'oneshot' })).text).toBe('healed')
        expect(await masterAlive(socket!)).toBe(true)
      } finally {
        await h?.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })
  }, 30000)

  it('config Host alias + IdentityFile identity keeps working with MUX riding the same argv (isolation via -F)', async () => {
    await withSshFixture(async fixture => {
      const root = await muxRoot()
      let h: Awaited<ReturnType<typeof createRealRemoteHarness>> | undefined
      try {
        h = await createRealRemoteHarness({
          copies: 1,
          driverOptions: {
            helperAssetsFor: () => null,
            sshMux: new SshMux({ rootDir: root }),
            oneshotArgvFor: (plan, cmd, options) => fixture.isolate(buildOneShotArgv(plan, cmd, options)),
          },
        })
        const agent = await h.createAgent('mux-alias')
        // `fixture-native` 只在 fixture 的 ssh config 里存在（HostName/Port/IdentityFile 全靠 config 解析）；
        // CLI -o MUX 选项与 config 身份并存（last-option-wins 只覆盖同名项）。
        const first = await h.invoke(agent, { action: 'exec', target: 'ssh:fixture-native', cmd: 'printf "%s" "$SSH_CONNECTION"', mode: 'oneshot' })
        expect(first.text).toContain(` ${fixture.destination.port}`) // SSH_CONNECTION 末列为 server port，无尾随空格
        const sockets = await socketsUnder(root)
        expect(sockets).toHaveLength(1)
        expect(await masterAlive(sockets[0]!)).toBe(true)
        const second = await h.invoke(agent, { action: 'exec', target: 'ssh:fixture-native', cmd: 'printf reuse', mode: 'oneshot' })
        expect(second.text).toBe('reuse')
        expect(await socketsUnder(root)).toHaveLength(1) // 同一 alias 身份复用同一 master
      } finally {
        await h?.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })
  }, 30000)
})
