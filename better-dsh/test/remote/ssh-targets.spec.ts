import { describe, expect, it } from 'vitest'
import { access, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import Remote from '../../src/remote/plugin.ts'
import type { Context } from '@deepseek-ai/cordis'
import { SshTargets } from '../../src/remote/ssh-targets.ts'
import { RemoteDriver } from '../../src/remote/driver.ts'
import { runOneShot } from '../../src/remote/oneshot.ts'
import { createRealRemoteHarness } from './real-harness.ts'
import { withSshFixture } from './ssh-fixture.ts'
import { buildOneShotArgv, buildPtyArgv } from '../../src/remote/transports.ts'

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
        expect((await h.invoke(a, { target: 'byossh:build', ssh: fixture.destination, cmd })).text).toContain(` ${fixture.destination.port}`)
        expect((await h.invoke(a, { target: 'byossh:build', cmd })).text).toContain(` ${fixture.destination.port}`)
        expect((await h.invoke(a, { target: 'byossh:build', ssh: fixture.destination, cmd })).text).toContain(` ${fixture.destination.port}`)
        await expect(h.invoke(a, { target: 'byossh:build', ssh: fixture.jump, cmd })).rejects.toThrow(/conflict/i)
        expect((await h.invoke(a, { target: 'byossh:build', cmd })).text).toContain(` ${fixture.destination.port}`)
        expect((await h.invoke(b, { target: 'byossh:build', ssh: fixture.jump, cmd })).text).toContain(` ${fixture.jump.port}`)
        expect((await h.invoke(a, { target: 'fixture-native', cmd })).text).toContain(` ${fixture.destination.port}`)
        const roster = (await h.invoke(a, {})).text
        expect(roster).toContain('byossh:build')
        expect(roster).not.toContain(fixture.destination.key)
        expect(roster).not.toContain(`${fixture.destination.port}`)
        const cold = await h.createAgent('ssh-cold', 'resume')
        await expect(h.invoke(cold, { target: 'byossh:build', cmd })).rejects.toThrow(/not registered/i)
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
        const registration = await h.invoke(agent, { target: 'byossh:jumped', ssh: { ...fixture.destination, proxyJump: 'fixture-jump' } })
        expect(registration.text).toMatch(/registered.*no.*dial/i)
        expect((await h.invoke(agent, { target: 'byossh:jumped', cmd: 'printf jumped' })).text).toBe('jumped')
        expect((await h.invoke(agent, { target: 'byossh:jumped', mode: 'pty', cmd: 'export SSH_TEST=kept; printf first' })).text).toBe('first')
        expect((await h.invoke(agent, { target: 'byossh:jumped', mode: 'pty', cmd: 'printf "%s" "$SSH_TEST"' })).text).toBe('kept')
        const invalid = await h.invoke(agent, { target: 'byossh:offline', ssh: { host: 'unused.invalid', port: 1 } })
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
        ]) await expect(h.invoke(agent, { target: 'byossh:bad', ssh, cmd: 'true' })).rejects.toThrow()
        await expect(access(marker)).rejects.toThrow()
        await expect(h.invoke(agent, { target: 'byossh:bad label', ssh: fixture.destination })).rejects.toThrow(/label/i)
        await expect(h.invoke(agent, { target: 'ssh:anything', ssh: fixture.destination })).rejects.toThrow(/byossh/i)
        await expect(h.invoke(agent, { target: 'byossh:bad', spawn: 'bash', ssh: fixture.destination, cmd: 'true' })).rejects.toThrow(/spawn/i)
      } finally { await h?.dispose() }
    })
  }, 20000)
})


describe('SSH target identity contract', () => {
  it('does not replace an existing SSH identity under the same label', () => {
    const targets = new SshTargets();
    targets.register('build', {host:'dev3',port:2222});
    expect(() => targets.register('build',{host:'dev4',port:2222})).toThrow(/conflict/);
    expect(targets.get('build')).toEqual({host:'dev3',port:2222});
  });
  it('normalizes relative key references and protects the registered spec from callers', async () => {
    await withSshFixture(async fixture => {
      const targets = new SshTargets()
      const source = { ...fixture.destination, key: relative(process.cwd(), fixture.destination.key) }
      const registered = targets.register('origin', source)
      expect(registered.key).toBe(fixture.destination.key)
      source.host = 'changed.invalid'
      expect(targets.register('origin', fixture.destination)).toBe(registered)
      expect(Object.isFrozen(registered)).toBe(true)
      expect(targets.entries()).toEqual([['origin', fixture.destination]])
      expect(() => targets.register('unknown', { host: 'dev3', proxyCommand: 'touch marker' } as never)).toThrow(/field/i)
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
        driver.registerSsh('byossh:origin', fixture.destination)
        const plan = await driver.resolveConnectionTarget('byossh:origin')
        expect(plan).toMatchObject({ kind: 'ssh', host: '127.0.0.1', connection: fixture.destination })
        expect(await driver.status('byossh:origin')).toContain('probe: reachable')
        const script = join(fixture.directory, 'script.sh')
        const { writeFile } = await import('node:fs/promises')
        await writeFile(script, 'printf script')
        expect(await driver.call({ target: 'byossh:script', ssh: fixture.destination, script })).toMatchObject({ exit: 0, stdout: 'script' })
        const process = await driver.start({ target: 'byossh:start', ssh: fixture.destination, cmd: 'printf canonical' }, new AbortController().signal)
        expect(await process.done).toMatchObject({ exit: 0 })
        expect(process.read('stdout', 0).text).toBe('canonical')
        await driver.dispose()
        await expect(driver.resolveConnectionTarget('byossh:origin')).rejects.toThrow(/DISPOSED/)
      } finally { await driver?.dispose() }
    })
  }, 20000)
})

describe('SSH text boundaries', () => {
  it.each(['label', 'host', 'user', 'proxyJump'])('rejects a trailing newline in %s before registration', async field => {
    const h = await createRealRemoteHarness({ copies: 1 })
    try {
      const agent = await h.createAgent('text-boundary')
      const target = field === 'label' ? 'byossh:invalid\n' : 'byossh:invalid'
      const ssh = { host: 'unused.invalid', ...(field === 'label' ? {} : { [field]: 'unused\n' }) }
      await expect(h.invoke(agent, { target, ssh })).rejects.toThrow()
    } finally { await h.dispose() }
  })
})
