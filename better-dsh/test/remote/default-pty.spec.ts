import { describe, expect, it } from 'vitest'
import { RemoteDriver } from '../../src/remote/driver.ts'

const driverWith = (over: Partial<ConstructorParameters<typeof RemoteDriver>[0]> = {}): RemoteDriver =>
  new RemoteDriver({
    ptyArgvFor: () => ['bash'],
    spawnArgvFor: () => ['bash'],
    idleTtlSec: 600,
    ...over,
  })

const scanStub = {
  rosterRunner: async () => ({ exit: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 }),
  sshConfigReader: async () => 'Host dev4\n',
}

describe('default PTY slot (spec remote-default-pty §1)', () => {
  it('machine exec reuses one default shell per machine: consecutive execs share the session and keep cwd/env', async () => {
    const d = driverWith(scanStub)
    const first = await d.call({ target: 'ssh:dev4', cmd: 'cd /tmp && export MARK=slot' }, { sessionKey: 'a1' })
    expect(first.mode).toBe('pty')
    expect(first.session).toMatch(/^pty:pty-[a-z0-9]{4}$/)
    expect(first.connection).toBe('ssh:dev4')
    const second = await d.call({ target: 'ssh:dev4', cmd: 'echo "$MARK" && pwd' }, { sessionKey: 'a1' })
    expect(second.session).toBe(first.session) // same default shell
    expect(second.stdout.trim()).toBe('slot\n/tmp') // echo $MARK && pwd - env and cwd both survive
    expect(second.cwd).toBe('/tmp')
    await d.dispose()
  })

  it('bare name and prefixed alias resolve to the SAME default slot (machine key normalization)', async () => {
    const d = driverWith(scanStub)
    const viaPrefix = await d.call({ target: 'ssh:dev4', cmd: 'cd /tmp' }, { sessionKey: 'a1' })
    const viaBare = await d.call({ target: 'dev4', cmd: 'pwd' }, { sessionKey: 'a1' })
    expect(viaBare.session).toBe(viaPrefix.session)
    expect(viaBare.cwd).toBe('/tmp')
    await d.dispose()
  })

  it('mode:"oneshot" is fully isolated: no slot is created or touched', async () => {
    const d = driverWith({ ...scanStub, oneshotArgvFor: () => ['bash', '-c', 'echo isolated'] })
    const one = await d.call({ target: 'ssh:dev4', cmd: 'x', mode: 'oneshot' }, { sessionKey: 'a1' })
    expect(one.mode).toBe('oneshot')
    expect(one.session).toBeUndefined()
    const pty = await d.call({ target: 'ssh:dev4', cmd: 'echo first' }, { sessionKey: 'a1' }) // first exec opens the default slot
    expect(pty.mode).toBe('pty')
    const roster = await d.roster({ sessionKey: 'a1' })
    expect(roster).toContain('default on ssh:dev4')
    await d.dispose()
  })

  it('default slots are per Agent: another agent gets its own shell and never sees this one', async () => {
    const d = driverWith(scanStub)
    const mine = await d.call({ target: 'ssh:dev4', cmd: 'export MARK=mine' }, { sessionKey: 'a1' })
    const theirs = await d.call({ target: 'ssh:dev4', cmd: 'echo "[$MARK]"' }, { sessionKey: 'a2' })
    expect(theirs.session).not.toBe(mine.session)
    expect(theirs.stdout.trim()).toBe('[]')
    const r2 = await d.roster({ sessionKey: 'a2' })
    expect(r2).not.toContain(mine.session!.slice(4))
    await d.dispose()
  })
})

describe('handoff (spec §1, 2026-11-01 rulings)', () => {
  it('idle handoff detaches the same session reference: machine exec then opens a fresh default, the detached one keeps cwd', async () => {
    const d = driverWith(scanStub)
    const first = await d.call({ target: 'ssh:dev4', cmd: 'cd /tmp' }, { sessionKey: 'a1' })
    const h = await d.handoff('ssh:dev4', { sessionKey: 'a1' })
    expect(h.session).toBe(first.session)
    expect(h.created).toBeUndefined()
    expect(h.stdout).toContain("next exec opens a fresh default PTY")
    const second = await d.call({ target: 'ssh:dev4', cmd: 'pwd' }, { sessionKey: 'a1' })
    expect(second.session).not.toBe(first.session) // fresh default
    expect(second.cwd).not.toBe('/tmp') // fresh shell starts at its default cwd; the detached one keeps /tmp
    await d.dispose()
  })

  it('fresh handoff creates a ready idle shell then detaches it', async () => {
    const d = driverWith(scanStub)
    const h = await d.handoff('ssh:dev4', { sessionKey: 'a1' })
    expect(h.created).toBe(true)
    expect(h.session).toMatch(/^pty:pty-[a-z0-9]{4}$/)
    const addressed = await d.call({ target: `pty:${h.session!.slice(4)}`, cmd: 'echo alive' }, { sessionKey: 'a1' })
    expect(addressed.stdout.trim()).toBe('alive')
    const machine = await d.call({ target: 'ssh:dev4', cmd: 'echo fresh' }, { sessionKey: 'a1' }) // machine got a NEW default
    expect(machine.session).not.toBe(h.session)
    await d.dispose()
  })

  it('fresh handoff on an unreachable target reports honestly and leaves no slot behind', async () => {
    let argv: string[] = ['bash']
    const d = driverWith({ ...scanStub, ptyArgvFor: () => argv })
    argv = ['bash', '-c', 'exit 3']
    await expect(d.handoff('ssh:dev4', { sessionKey: 'a1' })).rejects.toThrow(/E_SESSION_DIED/)
    const roster = await d.roster({ sessionKey: 'a1' })
    expect(roster).toContain('pty sessions: none')
    await expect(d.handoff('ssh:dev4', { sessionKey: 'a1' })).rejects.toThrow(/E_SESSION_DIED/) // no stale slot: same honest failure again
    await d.dispose()
  })

  it('busy handoff keeps the running command bound to the detached session and frees the machine slot', async () => {
    const d = driverWith(scanStub)
    const started = await d.call({ target: 'ssh:dev4', cmd: 'sleep 3; echo late', timeout: 1 }, { sessionKey: 'a1' })
    expect(started.running).toBe(true) // timeout handoff per P4
    const h = await d.handoff('ssh:dev4', { sessionKey: 'a1' })
    expect(h.running).toBe(true)
    expect(h.commandId).toBe(started.commandId)
    expect(h.session).toBe(started.session)
    const next = await d.call({ target: 'ssh:dev4', cmd: 'echo newshell' }, { sessionKey: 'a1' }) // machine slot free immediately
    expect(next.session).not.toBe(started.session)
    await expect(d.call({ target: `pty:${h.session!.slice(4)}`, cmd: 'echo busy' }, { sessionKey: 'a1' })).rejects.toThrow(/E_SESSION_BUSY/) // single ownership: detached shell still busy
    await started.ptyJob!.done
    await d.dispose()
  }, 15_000)

  it('handoff takes a machine target only', async () => {
    const d = driverWith(scanStub)
    await expect(d.handoff('pty:pty-0000', { sessionKey: 'a1' })).rejects.toThrow(/E_TARGET_FORMAT/)
    await expect(d.handoff('ssh:dev4:pty', { sessionKey: 'a1' })).rejects.toThrow(/E_TARGET_FORMAT/)
    await d.dispose()
  })
})

describe('close via machine target (spec §1) + quota 30 (round-2 ruling)', () => {
  it('machine close closes ONLY the default slot; idempotent not-found after', async () => {
    const d = driverWith(scanStub)
    const s = await d.call({ target: 'ssh:dev4', cmd: 'echo hi' }, { sessionKey: 'a1' })
    const r = await d.close('ssh:dev4', 'a1')
    expect(r).toMatchObject({ closed: true })
    expect(r.session).toBe(s.session)
    const again = await d.close('ssh:dev4', 'a1')
    expect(again).toMatchObject({ closed: false, reason: 'not-found' })
    await expect(d.call({ target: `pty:${s.session!.slice(4)}`, cmd: 'echo gone' }, { sessionKey: 'a1' })).rejects.toThrow(/E_NO_SESSION/)
    await d.dispose()
  })

  it('busy default slot refuses close without force; force kills the job and closes', async () => {
    const d = driverWith({ ...scanStub, spawnArgvFor: () => ['bash'] })
    const started = await d.call({ target: 'ssh:dev4', cmd: 'sleep 30', timeout: 1 }, { sessionKey: 'a1' })
    expect(started.running).toBe(true)
    await expect(d.close('ssh:dev4', 'a1')).rejects.toThrow(/E_SESSION_BUSY[\s\S]*job_kill/)
    const forced = await d.close('ssh:dev4', 'a1', true)
    expect(forced.closed).toBe(true)
    expect(forced.killed.length).toBe(1)
    await d.dispose()
  }, 15_000)

  it('quota: default slots count toward the per-Agent global 30', async () => {
    const d = driverWith(scanStub)
    await d.call({ target: 'ssh:dev4', cmd: 'echo slot' }, { sessionKey: 'a1' }) // 1 default
    for (let i = 0; i < 29; i++) await d.call({ spawn: 'bash' }, { sessionKey: 'a1' }) // +29 = 30
    await expect(d.call({ spawn: 'bash' }, { sessionKey: 'a1' })).rejects.toThrow(/E_SESSION_LIMIT[\s\S]*per-Agent session global limit/)
    await expect(d.call({ target: 'ssh:mac2', cmd: 'echo over' }, { sessionKey: 'a1' })).rejects.toThrow(/E_SESSION_LIMIT/)
    const other = await d.call({ target: 'ssh:dev4', cmd: 'echo ok' }, { sessionKey: 'a2' }) // another agent unaffected
    expect(other.mode).toBe('pty')
    await d.dispose()
  }, 30_000)
})

describe('run_in_background on a default PTY = submit + same-operation handoff (Task C)', () => {
  it('ptyBackground dispatch detaches the slot in the same operation; the machine gets a fresh default', async () => {
    const d = driverWith(scanStub)
    const r = await d.call({ target: 'ssh:dev4', cmd: 'sleep 2; echo late' }, { sessionKey: 'a1', ptyBackground: true, commandId: 'remote-bgtest' })
    expect(r.running).toBe(true)
    expect(r.commandId).toBe('remote-bgtest')
    const next = await d.call({ target: 'ssh:dev4', cmd: 'echo fresh' }, { sessionKey: 'a1' })
    expect(next.session).not.toBe(r.session) // the submit itself freed the machine slot
    const roster = await d.roster({ sessionKey: 'a1' })
    expect(roster).toContain('default on ssh:dev4') // the NEW default is the fresh shell
    await r.ptyJob!.done
    await d.dispose()
  }, 15_000)

  it('a failed background dispatch (busy slot) does NOT detach it', async () => {
    const d = driverWith(scanStub)
    const started = await d.call({ target: 'ssh:dev4', cmd: 'sleep 3', timeout: 1 }, { sessionKey: 'a1' }) // sync timeout -> detached job, slot stays bound & busy
    expect(started.running).toBe(true)
    await expect(d.call({ target: 'ssh:dev4', cmd: 'echo second' }, { sessionKey: 'a1', ptyBackground: true, commandId: 'remote-bgbusy' })).rejects.toThrow(/E_SESSION_BUSY/)
    // the slot is STILL the default (not detached by the failed background attempt): machine close targets that busy session and is refused
    await expect(d.close('ssh:dev4', 'a1')).rejects.toThrow(new RegExp(`E_SESSION_BUSY[\\s\\S]*${started.commandId}`))
    await d.close('ssh:dev4', 'a1', true)
    await d.dispose()
  }, 15_000)
})
