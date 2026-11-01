import { describe, expect, it } from 'vitest'
import { access, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import Remote from '../../src/remote/plugin.ts'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteDriver } from '../../src/remote/driver.ts'
import { runOneShot } from '../../src/remote/oneshot.ts'
import { createRealRemoteHarness } from './real-harness.ts'
import { withSshFixture } from './ssh-fixture.ts'
import { buildOneShotArgv, buildPtyArgv } from '../../src/remote/transports.ts'
import { normalizeSshConnection } from '../../src/remote/ssh-targets.ts'

// Missing registration, identity reuse or option safety breaks actual execution,
// not only an argv snapshot. Use real sshd and scoped tools.
describe('BYO-SSH scoped execution', () => {
  it.each(['source', 'better', 'super'])('%s: registers and executes, reuses without ssh, refuses replacement, and preserves native SSH config', async delivery => {
    await withSshFixture(async fixture => {
      let h: Awaited<ReturnType<typeof createRealRemoteHarness>> | undefined
      try {
        const driverOptions = {
          oneshotArgvFor: (plan: Parameters<typeof buildOneShotArgv>[0], cmd: string) => fixture.isolate(buildOneShotArgv(plan, cmd)),
          ptyArgvFor: (plan: Parameters<typeof buildPtyArgv>[0]) => fixture.isolate(buildPtyArgv(plan)),
          sshConfigReader: () => readFile(fixture.config, 'utf8'),
        }
        const plugin = delivery === 'source' ? Remote : delivery === 'better' ? (await import('../../lib/remote/plugin.js')).default : (await import('../../../super-dsh/remote/plugin.js')).default
        h = await createRealRemoteHarness({ plugins: [{ ...plugin, apply: (ctx: Context, config: Parameters<typeof Remote.apply>[1]) => plugin.apply(ctx, { ...config, ...driverOptions }) }] })
        const a = await h.createAgent('ssh-a'), b = await h.createAgent('ssh-b')
        const cmd = 'printf "%s" "$SSH_CONNECTION"'
        await h.invoke(a, { action: 'add', target: 'ssh:build', ssh: fixture.destination })
        expect((await h.invoke(a, { action: 'exec', target: 'ssh:build', cmd })).text).toContain(` ${fixture.destination.port}`)
        // v2（2026-10-19）：注册不做 spec 对比——同 label 再次带 ssh（哪怕同 spec）= E_LABEL_IN_USE
        await expect(h.invoke(a, { action: 'add', target: 'ssh:build', ssh: fixture.destination })).rejects.toThrow(/E_LABEL_IN_USE/)
        await expect(h.invoke(a, { action: 'add', target: 'ssh:build', ssh: fixture.jump })).rejects.toThrow(/E_LABEL_IN_USE/)
        expect((await h.invoke(a, { action: 'exec', target: 'ssh:build', cmd })).text).toContain(` ${fixture.destination.port}`)
        await h.invoke(b, { action: 'add', target: 'ssh:build', ssh: fixture.jump })
        expect((await h.invoke(b, { action: 'exec', target: 'ssh:build', cmd })).text).toContain(` ${fixture.jump.port}`)
        expect((await h.invoke(a, { action: 'exec', target: 'fixture-native', cmd })).text).toContain(` ${fixture.destination.port}`)
        const roster = (await h.invoke(a, { action: 'status' })).text
        expect(roster).toContain('build (built on)')
        expect(roster).not.toContain(fixture.destination.key)
        expect(roster).not.toContain(`${fixture.destination.port}`)
        const cold = await h.createAgent('ssh-cold', 'resume')
        expect((await h.invoke(cold, { action: 'exec', target: 'ssh:build', cmd, mode: 'oneshot' }) as unknown as { exit: number | null }).exit).not.toBe(0) // cold incarnation: the label is gone; ssh:build is just an unresolvable host — native exit 255, honestly
      } finally { await h?.dispose() }
    })
  }, 20000)

  it('register-only never dials, later uses ProxyJump/key/port for both oneshot and persistent shell', async () => {
    await withSshFixture(async fixture => {
      let h: Awaited<ReturnType<typeof createRealRemoteHarness>> | undefined
      try {
        h = await createRealRemoteHarness({ copies: 1, driverOptions: {
          oneshotArgvFor: (plan, cmd) => fixture.isolate(buildOneShotArgv(plan, cmd)),
          ptyArgvFor: plan => fixture.isolate(buildPtyArgv(plan)),
        } })
        const agent = await h.createAgent('jump')
        const registration = await h.invoke(agent, { action: 'add', target: 'ssh:jumped', ssh: { ...fixture.destination, proxyJump: 'fixture-jump' } })
        expect(registration.text).toMatch(/registered.*no.*dial/i)
        expect((await h.invoke(agent, { action: 'exec', target: 'ssh:jumped', cmd: 'printf jumped' })).text).toBe('jumped')
        const first = await h.invoke(agent, { action: 'exec', target: 'ssh:jumped', cmd: 'export SSH_TEST=kept; printf first' }) as unknown as { session: string; text: string }
        expect(first.text).toBe('first')
        expect(first.session).toMatch(/^pty:pty-/)
        expect((await h.invoke(agent, { action: 'exec', target: first.session, cmd: 'printf "%s" "$SSH_TEST"' })).text).toBe('kept')
        const invalid = await h.invoke(agent, { action: 'add', target: 'ssh:offline', ssh: { host: 'unused.invalid', port: 1 } })
        expect(invalid.text).toMatch(/registered.*no.*dial/i)
      } finally { await h?.dispose() }
    })
  }, 20000)

  it('rejects SSH option/shell injection before any local command can run', async () => {
    await withSshFixture(async fixture => {
      let h: Awaited<ReturnType<typeof createRealRemoteHarness>> | undefined
      try {
        h = await createRealRemoteHarness({ copies: 1 })
        const marker = join(fixture.directory, 'injected')
        const agent = await h.createAgent('injection')
        for (const ssh of [
          { host: `-oProxyCommand=touch ${marker}` },
          { host: '127.0.0.1', user: `x;touch ${marker}` },
          { host: '127.0.0.1', proxyJump: `x;touch ${marker}` },
          { host: '127.0.0.1', key: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret' },
          { host: '127.0.0.1', port: 65536 },
        ]) await expect(h.invoke(agent, { action: 'add', target: 'ssh:bad', ssh })).rejects.toThrow()
        await expect(access(marker)).rejects.toThrow()
        await expect(h.invoke(agent, { action: 'add', target: 'ssh:bad label', ssh: fixture.destination })).rejects.toThrow(/label/i)
        await expect(h.invoke(agent, { action: 'add', target: 'pty:anything', ssh: fixture.destination })).rejects.toThrow(/ssh registration pairs with ssh-form/i)
        await expect(h.invoke(agent, { action: 'add', target: 'ssh:bad', spawn: 'bash' })).rejects.toThrow(/spawn/i)
      } finally { await h?.dispose() }
    })
  }, 20000)
})


describe('SSH target identity contract', () => {
  it('normalizeSshConnection resolves relative keys and freezes the normalized spec', async () => {
    await withSshFixture(async fixture => {
      const source = { ...fixture.destination, key: relative(process.cwd(), fixture.destination.key) }
      const normalized = normalizeSshConnection(source)
      expect(normalized.key).toBe(fixture.destination.key)
      expect(Object.isFrozen(normalized)).toBe(true)
      expect(() => normalizeSshConnection({ host: 'dev3', proxyCommand: 'touch marker' } as never)).toThrow(/field/i)
    })
  })
  it('preserves registered connection for probes, script execution, canonical start and future file consumers', async () => {
    await withSshFixture(async fixture => {
      let driver: RemoteDriver | undefined
      try {
        driver = new RemoteDriver({
          oneshotArgvFor: (plan, cmd) => fixture.isolate(buildOneShotArgv(plan, cmd)),
          probeRunner: (argv, options) => runOneShot(fixture.isolate(argv), options),
        })
        await driver.call({ target: 'ssh:origin', ssh: fixture.destination }, { sessionKey: 'spec' })
        const plan = await driver.resolveConnectionTarget('ssh:origin', { sessionKey: 'spec' })
        expect(plan).toMatchObject({ kind: 'ssh', host: '127.0.0.1', connection: fixture.destination })
        expect(await driver.status('ssh:origin', { sessionKey: 'spec' })).toContain('probe: reachable')
        const script = join(fixture.directory, 'script.sh')
        const { writeFile } = await import('node:fs/promises')
        await writeFile(script, 'printf script')
        expect(await driver.call({ target: 'ssh:script', ssh: fixture.destination, scriptPath: script })).toMatchObject({ exit: 0, stdout: 'script' })
        // F2 回归（2026-11-01 复测）：真实 sshd 上脚本中途 read 只吃业务 stdin——旧形状里 read 吃掉脚本下一行、
        // 业务 stdin 被 bash 当命令执行（exit 127）。
        const readScript = join(fixture.directory, 'read.sh')
        await writeFile(readScript, 'IFS= read -r v\necho "READ:GOT:$v"\n')
        expect(await driver.call({ target: 'ssh:script', scriptPath: readScript, stdin: 'hello-f2\n', mode: 'oneshot' })).toMatchObject({ exit: 0, stdout: 'READ:GOT:hello-f2\n' }) // reuse the registered label, no re-registration
        const process = await driver.start({ target: 'ssh:start', ssh: fixture.destination, cmd: 'printf canonical' }, new AbortController().signal)
        expect(await process.done).toMatchObject({ exit: 0 })
        expect(process.read('stdout', 0).text).toBe('canonical')
        await driver.dispose()
        await expect(driver.resolveConnectionTarget('ssh:origin')).rejects.toThrow(/DISPOSED/)
      } finally { await driver?.dispose() }
    })
  }, 20000)
})

describe('SSH text boundaries', () => {
  it.each(['label', 'host', 'user', 'proxyJump'])('rejects a trailing newline in %s before registration', async field => {
    const h = await createRealRemoteHarness({ copies: 1 })
    try {
      const agent = await h.createAgent('text-boundary')
      const target = field === 'label' ? 'ssh:invalid\n' : 'ssh:invalid'
      const ssh = { host: 'unused.invalid', ...(field === 'label' ? {} : { [field]: 'unused\n' }) }
      await expect(h.invoke(agent, { action: 'add', target, ssh })).rejects.toThrow()
    } finally { await h.dispose() }
  })
})
