import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { withSshFixture } from './ssh-fixture.ts'
import { RemoteDriver } from '../../src/remote/driver.ts'
import { buildOneShotArgv } from '../../src/remote/transports.ts'

// Pure-CLI oneshot: ssh/docker/incus argv + a POSIX wrapper that kills the
// remote process group on session teardown. No Python owner/lease on any end.


it('runs a one-shot command with stdin, exit code and output verbatim', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ oneshotArgvFor: (plan, cmd, o) => plan.kind === 'ssh' ? f.isolate(buildOneShotArgv(plan, cmd, o)) : buildOneShotArgv(plan, cmd, o) })
    try {
      await d.call({ target: 'ssh:p', ssh: f.destination })
      const pidfiles = async () => Number((await d.call({ target: 'ssh:p', cmd: `ls "\${TMPDIR:-/tmp}"/superd-oneshot-*.pgid 2>/dev/null | wc -l` })).stdout.trim())
      const before = await pidfiles()
      const file = `/tmp/oneshot-${randomUUID()}.txt`
      const r = await d.call({ target: 'ssh:p', cmd: `cat > ${file}; printf 'code=%s\\n' "$?"`, stdin: 'one-shot-payload' })
      expect(r.exit).toBe(0)
      expect(r.stdout.trim()).toBe('code=0')
      const { readFile } = await import('node:fs/promises')
      expect(await readFile(file, 'utf8')).toBe('one-shot-payload')
      await d.call({ target: 'ssh:p', cmd: `rm -f ${file}` })
      // Nonzero exit passes through the wrapper untouched (wait $! → exit code).
      const fail = await d.call({ target: 'ssh:p', cmd: 'exit 42' })
      expect(fail.exit).toBe(42)
      // Normal completion must remove its own pidfile (regression: every
      // completed oneshot used to leak one /tmp/superd-oneshot-*.pgid). The
      // count may not grow across this test's completed calls (earlier tests'
      // async cleanup killers may still be in flight, hence relative, not 0).
      expect(await pidfiles()).toBe(before)
    } finally { await d.dispose() }
  })
}, 30000)

it('a TERM delivered on the endpoint kills the whole command process group (wrapper trap)', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ oneshotArgvFor: (plan, cmd, o) => plan.kind === 'ssh' ? f.isolate(buildOneShotArgv(plan, cmd, o)) : buildOneShotArgv(plan, cmd, o) })
    try {
      await d.call({ target: 'ssh:p', ssh: f.destination })
      const tag = `sog${randomUUID().slice(0, 8)}`
      const { startOwnedNativeProcess } = await import('../../src/remote/ssh-process.ts')
      const r = await startOwnedNativeProcess(
        { kind: 'ssh', host: f.destination.host, connection: f.destination },
        `ps -o pgid= -p $$ | tr -d ' ' > /tmp/${tag}.pgid; sleep 300; sleep 301`,
        { signal: new AbortController().signal, argvFor: (plan, command, o) => f.isolate(buildOneShotArgv(plan, command, o)) })
      await new Promise(resolve => setTimeout(resolve, 1500))
      // Deliver TERM to the command's whole process group (what sshd does on
      // session teardown): the wrapper trap must reap both sleeps and exit 143.
      const pgid = (await d.call({ target: 'ssh:p', cmd: `cat /tmp/${tag}.pgid` })).stdout.trim()
      await d.call({ target: 'ssh:p', cmd: `kill -TERM -${pgid} 2>/dev/null || true; rm -f /tmp/${tag}.pgid` })
      const done = await r.done
      // 143 = the wrapper's trap path; 255 = sshd-session shares the group and
      // drops the channel first. Either way the group was signalled.
      expect([143, 255]).toContain(done.exit)
      let gone = false
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 300))
        const check = await d.call({ target: 'ssh:p', cmd: `ps -eo pgid= | tr -d ' ' | grep -cx ${pgid} || true` })
        if (check.stdout.trim() === '0') { gone = true; break }
      }
      expect(gone).toBe(true)
    } finally { await d.dispose() }
  })
}, 40000)

it('applies the caller timeout and fails the call', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ oneshotArgvFor: (plan, cmd, o) => plan.kind === 'ssh' ? f.isolate(buildOneShotArgv(plan, cmd, o)) : buildOneShotArgv(plan, cmd, o) })
    try {
      await d.call({ target: 'ssh:p', ssh: f.destination })
      const r = await d.call({ target: 'ssh:p', cmd: 'sleep 30', timeout: 2 })
      expect(r.exit).not.toBe(0)
    } finally { await d.dispose() }
  })
}, 30000)

it('ssh argv keeps BatchMode and the wrapper stays Python-free', async () => {
  await withSshFixture(async f => {
    const argv = buildOneShotArgv({ kind: 'ssh', host: f.destination.host, connection: f.destination }, 'true')
    expect(argv[0]).toBe('ssh')
    expect(argv).toContain('BatchMode=yes')
    const remote = argv.slice(argv.indexOf('--') + 2).join(' ')
    expect(remote).toContain('kill -TERM 0')
    expect(remote.toLowerCase()).not.toContain('python')
  })
}, 10000)

// Regression 1 (first-person report): timeout/cancel must not orphan the
// remote process tree — sshd delivers no signal on a no-PTY session teardown,
// so the wrapper's stdin-EOF watchdog is the kill path.
it('timeout kills the remote tree: no orphaned wrapper or sleep after the local transport dies', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ oneshotArgvFor: (plan, cmd, o) => plan.kind === 'ssh' ? f.isolate(buildOneShotArgv(plan, cmd, o)) : buildOneShotArgv(plan, cmd, o) })
    try {
      await d.call({ target: 'ssh:p', ssh: f.destination })
      const tag = `sot${randomUUID().slice(0, 8)}`
      const r = await d.call({ target: 'ssh:p', cmd: `sleep 120; # ${tag}`, timeout: 3 })
      expect(r.exit).not.toBe(0)
      let gone = false
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 300))
        const check = await d.call({ target: 'ssh:p', cmd: `pgrep -fc 'sleep 12[0]'` })
        if (Number(check.stdout.trim()) === 0) { gone = true; break }
      }
      expect(gone).toBe(true)
    } finally { await d.dispose() }
  })
}, 30000)

// Regression 2 (first-person report): a backgrounded child must not outlive a
// normally-completing command (EXIT trap), and must not hold the channel open.
it('normally-completing command reaps its backgrounded children and returns promptly', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ oneshotArgvFor: (plan, cmd, o) => plan.kind === 'ssh' ? f.isolate(buildOneShotArgv(plan, cmd, o)) : buildOneShotArgv(plan, cmd, o) })
    try {
      await d.call({ target: 'ssh:p', ssh: f.destination })
      const tag = `sob${randomUUID().slice(0, 8)}`
      const started = Date.now()
      const r = await d.call({ target: 'ssh:p', cmd: `sleep 300 >/dev/null 2>&1 & echo done; # ${tag}` })
      const elapsed = Date.now() - started
      expect(r.exit).toBe(0)
      expect(r.stdout.trim()).toBe('done')
      expect(elapsed).toBeLessThan(15000)
      let gone = false
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 300))
        const check = await d.call({ target: 'ssh:p', cmd: `pgrep -fc 'sleep 12[0]'` })
        if (Number(check.stdout.trim()) === 0) { gone = true; break }
      }
      expect(gone).toBe(true)
    } finally { await d.dispose() }
  })
}, 40000)
