import { describe, expect, it } from 'vitest'
import { deferredTargetResolution, killReturnedShell } from './disposal-fixture.ts'
import { RemoteDriver, type RemoteAuditRecord } from '../../src/remote/driver.ts'

const driverWith = (over: Partial<ConstructorParameters<typeof RemoteDriver>[0]> = {}): RemoteDriver =>
  new RemoteDriver({
    oneshotArgvFor: () => ['bash', '-lc', 'echo fixed'],
    ptyArgvFor: () => ['bash'],
    spawnArgvFor: () => ['bash'],
    idleTtlSec: 600,
    ...over,
  })

const scanStub = {
  rosterRunner: async () => ({ exit: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 }),
}

describe('RemoteDriver validation', () => {
  it('rejects spawn on machine targets and neither target nor BYO entry (E_PARAMS), and bad timeout', async () => {
    const d = driverWith()
    await expect(d.call({ target: 'ssh:dev4', spawn: 'bash', cmd: 'x' })).rejects.toThrow(/E_PARAMS/)
    await expect(d.call({ cmd: 'x' })).rejects.toThrow(/E_PARAMS/)
    await expect(d.call({ target: 'dev4', spawn: 'bash', ssh: { host: 'h' }, cmd: 'x' })).rejects.toThrow(/E_PARAMS/)
    await expect(d.call({ target: 'dev4', cmd: 'x', timeout: 0 })).rejects.toThrow(/E_BAD_TIMEOUT/)
    await expect(d.call({ target: 'dev4', cmd: 'x', timeout: Number.POSITIVE_INFINITY })).rejects.toThrow(/E_BAD_TIMEOUT/)
    await d.dispose()
  })
  it('a pty selector addresses; "pty" alone and spawn+ssh combos are refused', async () => {
    const d = driverWith()
    await expect(d.call({ target: 'pty', cmd: 'echo hi' })).rejects.toThrow(/E_PARAMS/)
    await expect(d.call({ target: 'docker:c', spawn: 'bash', cmd: 'x' })).rejects.toThrow(/E_PARAMS/)
    await expect(d.call({ target: 'pty:x', ssh: { host: 'h' }, cmd: 'x' })).rejects.toThrow(/E_PARAMS/)
    await d.dispose()
  })
  it('rejects malformed PTY labels before touching the pool', async () => {
    const d = driverWith()
    for (const bad of ['has space', '-lead'])
      await expect(d.call({ target: bad, spawn: 'bash', cmd: 'echo hi' })).rejects.toThrow(/E_BAD_LABEL/)
    await expect(d.call({ target: 'a:b', spawn: 'bash', cmd: 'echo hi' })).rejects.toThrow(/E_TARGET_FORMAT/)
    await expect(d.call({ target: 'pty:a:b', cmd: 'echo hi' })).rejects.toThrow(/E_TARGET_FORMAT/)
    await expect(d.call({ target: 'pty:pty-1a2b', spawn: 'bash', cmd: 'echo hi' })).rejects.toThrow(/E_BAD_LABEL/)
    await d.dispose()
  })
})

describe('RemoteDriver routing', () => {
  it('explicit oneshot mode: runs the transport argv, returns binary exit + split stderr', async () => {
    const seen: string[][] = []
    const d = new RemoteDriver({
      oneshotArgvFor: (_plan, cmd) => { seen.push(['oneshot', cmd]); return ['bash', '-c', 'echo out; echo err >&2; exit 3'] },
    })
    const r = await d.call({ target: 'dev4', cmd: 'git status', mode: 'oneshot' })
    expect(r.mode).toBe('oneshot')
    expect(r.exit).toBe(3)
    expect(r.stdout).toBe('out\n')
    expect(r.stderr).toBe('err\n')
    expect(seen).toEqual([['oneshot', 'git status']])
    await d.dispose()
  })
  it('the :pty creation suffix is gone (spec 2026-11-01): E_TARGET_FORMAT teaches default + handoff; a machine keeps ONE default session across agents', async () => {
    const d = driverWith()
    await expect(d.call({ target: 'ssh:dev4:pty', cmd: 'cd /tmp' }, { sessionKey: 'a1' })).rejects.toThrow(/:pty creation suffix is gone/)
    await expect(d.call({ target: 'hub:m:pty:lbl' }, { sessionKey: 'a1' })).rejects.toThrow(/handoff detaches it as pty:<id>/)
    const c1 = await d.call({ target: 'ssh:dev4', cmd: 'cd /tmp' }, { sessionKey: 'a1' }) // machine exec = default slot
    expect(c1.connection).toBe('ssh:dev4')
    const r = await d.call({ target: `pty:${c1.session!.slice(4)}`, cmd: 'pwd' }, { sessionKey: 'a1' })
    expect(r.cwd).toBe('/tmp')
    const again = await d.call({ target: 'ssh:dev4', cmd: 'pwd' }, { sessionKey: 'a1' })
    expect(again.session).toBe(c1.session) // the default reuses until handoff/close
    await expect(d.call({ target: `pty:${c1.session!.slice(4)}`, cmd: 'pwd' }, { sessionKey: 'a2' })).rejects.toThrow(/E_NO_SESSION/)
    await d.dispose()
  })
  it('0.3.2-e: no self-made window — output returns IN FULL; retention (4M) is the only bound, stats report total', async () => {
    const d = new RemoteDriver({
      oneshotArgvFor: () => ['bash', '-c', 'printf "x%.0s" $(seq 1 100)'],
    })
    const r = await d.call({ target: 'dev4', cmd: 'x', mode: 'oneshot' })
    expect(r.truncated).toBeUndefined()
    expect(r.stdout).toBe('x'.repeat(100))
    expect(r.stdout).not.toContain('[truncated')
    expect(r.outputStats?.stdout).toMatchObject({ total: 100, returned: 100, dropped: 0 })
    await d.dispose()
  })
  it('emits one audit record per attempt (success, nonzero exit, and error paths)', async () => {
    const audit: RemoteAuditRecord[] = []
    const d = driverWith({ onAudit: (r) => audit.push(r) })
    await d.call({ target: 'dev4', cmd: 'echo ok', mode: 'oneshot' })
    const d255 = new RemoteDriver({
      onAudit: (r) => audit.push(r),
      oneshotArgvFor: () => ['bash', '-c', 'exit 255'],
    })
    await d255.call({ target: 'no-such-host-xyz', cmd: 'echo no', mode: 'oneshot' }).catch(() => {})
    await expect(d.call({ target: 'docker:c', spawn: 'bash', cmd: 'x' })).rejects.toThrow(/E_PARAMS/)
    expect(audit[0]).toMatchObject({ target: 'dev4', cmd: 'echo ok', exit: 0 })
    expect(audit[1]).toMatchObject({ target: 'no-such-host-xyz', exit: 255 })
    expect(audit[2]).toMatchObject({ target: 'docker:c', cmd: 'x', error: expect.stringContaining('E_PARAMS') })
    await d.dispose(); await d255.dispose()
  })
})

describe('RemoteDriver BYO pty via spawn (label in the session pool)', () => {
  it('creates with a label, then reuses by label alone (cwd/env survive); session carries identity', async () => {
    const d = driverWith()
    const created = await d.call({ target: 'pty:dev3', spawn: 'bash', cmd: 'cd /tmp && export MARK=live' })
    expect(created.session).toMatch(/^pty:pty-[a-z0-9]{4}$/)
    expect(created.label).toBe('dev3')
    expect(created.connection).toBe('BYOP')
    expect(created.byoTag).toBe('byo-pty')
    expect(created.commandId).toMatch(/^remote-/)
    const reused = await d.call({ target: 'pty:dev3', cmd: 'echo "$MARK" && pwd' })
    expect(reused.session).toBe(created.session)
    expect(reused.stdout).toContain('live')
    expect(reused.cwd).toBe('/tmp')
    await d.dispose()
  })
  it('spawn with no target = auto id; warm creation (no cmd) returns the id without running', async () => {
    const d = driverWith()
    const warm = await d.call({ spawn: 'bash' })
    expect(warm.created).toBe(true)
    expect(warm.session).toMatch(/^pty:pty-[a-z0-9]{4}$/)
    expect(warm.label).toBeUndefined()
    // R2：warm 回执必须带整段 TTL（刚起好的会话还没 idle 过）= 本驱动配置的 idleTtlSec
    expect(warm.ttlSec).toBe(600)
    const run = await d.call({ target: `pty:${warm.session!.slice(4)}`, cmd: 'echo hi' })
    expect(run.stdout.trim()).toBe('hi')
    await d.dispose()
  })
  it('label namespace is per agent session: the same label is free for another agent', async () => {
    const d = driverWith()
    await d.call({ target: 'pty:dev3', spawn: 'bash', cmd: 'export MARK=mine' }, { sessionKey: 'a1' })
    await expect(d.call({ target: 'pty:dev3', cmd: 'echo "$MARK"' }, { sessionKey: 'a2' })).rejects.toThrow(/E_NO_SESSION/)
    const fresh = await d.call({ target: 'pty:dev3', spawn: 'bash', cmd: 'echo "$MARK"done' }, { sessionKey: 'a2' })
    expect(fresh.stdout.trim()).toBe('done')
    await d.dispose()
  })
  it('repeating spawn on a live label = E_LABEL_IN_USE (no spec comparison), teaching the shorter form', async () => {
    const d = driverWith()
    await d.call({ target: 'pty:dev3', spawn: 'bash', cmd: 'export MARK=kept' })
    await expect(d.call({ target: 'pty:dev3', spawn: 'bash', cmd: 'echo x' })).rejects.toThrow(/E_LABEL_IN_USE/)
    await expect(d.call({ target: 'pty:dev3', spawn: 'bash -l', cmd: 'echo x' })).rejects.toThrow(/E_LABEL_IN_USE/)
    const after = await d.call({ target: 'pty:dev3', cmd: 'echo "$MARK"' })
    expect(after.stdout).toContain('kept')
    await d.dispose()
  })
  it('an unknown label answers E_NO_SESSION with the create shape', async () => {
    const d = driverWith()
    await expect(d.call({ target: 'pty:never', cmd: 'echo hi' })).rejects.toThrow(/E_NO_SESSION/)
    await expect(d.call({ target: 'pty:never', cmd: 'echo hi' })).rejects.toThrow(/ssh:dev4:pty/)
    await d.dispose()
  })
  it('label with no cmd = session card (ledger + connection); unknown label says so without dialing', async () => {
    const d = driverWith()
    await d.call({ target: 'pty:dev3', spawn: 'bash', cmd: 'echo warm' })
    const card = await d.call({ target: 'pty:dev3', cmd: '' })
    expect(card.stdout).toContain('BYOP (byo-pty)')
    expect(card.stdout).toContain('no command running')
    await expect(d.call({ target: 'pty:never', cmd: '' })).rejects.toThrow(/E_NO_SESSION/)
    await d.dispose()
  })
  it('session limit: the 31st session is refused with the live inventory; close frees a slot', async () => {
    const d = driverWith()
    const warm: string[] = []
    for (let i = 0; i < 30; i++) warm.push((await d.call({ spawn: 'bash' })).session!.slice(4))
    await expect(d.call({ spawn: 'bash' })).rejects.toThrow(/E_SESSION_LIMIT[\s\S]*pty-/)
    await expect(d.call({ target: 'ssh:macq', cmd: 'echo x' })).rejects.toThrow(/E_SESSION_LIMIT/)
    d.closePty(warm[0]!, 'no-session')
    const ok = await d.call({ spawn: 'bash' })
    expect(ok.created).toBe(true)
    await d.dispose()
  }, 20_000)
  it('close: idempotent; refuses while a job runs and names it; force kills and closes', async () => {
    const d = driverWith({ spawnArgvFor: () => ['script', '-qfec', 'bash', '/dev/null'] }) // CF 需要 ^C 真成 SIGINT：真 script pty，非管道 bash
    const warm = await d.call({ spawn: 'bash' })
    const id = warm.session!.slice(4)
    const r = await d.call({ target: `pty:${id}`, cmd: 'sleep 30 ; echo late', timeout: 1 })
    expect(r.running).toBe(true)
    expect(() => d.closePty(id, 'no-session')).toThrow(/E_SESSION_BUSY[\s\S]*job_kill/)
    const forced = d.closePty(id, 'no-session', true)
    expect(forced).toMatchObject({ closed: true })
    expect(forced.killed.length).toBe(1)
    // CF（0.3.2-d）：force-close 先走两段 interrupt 再收组——detached job 结算 killed 族
    // （marker 帧先于 1s TERM 到达 → exit 130；帧不可达时 exit null + timedOut），
    // 不再裸死成 failed/session died。夹具用 sleep 30 保证 interrupt 时命令真在跑。
    const done = await r.ptyJob!.done
    expect(done.timedOut).toBe(true)
    expect(done.exit).toBe(130)
    const again = d.closePty(id, 'no-session')
    expect(again).toMatchObject({ closed: false, reason: 'not-found' })
    await d.dispose()
  }, 20_000)
  it('roster names sessions by label/id, never by the spawn command; caller-scoped', async () => {
    const d = driverWith(scanStub)
    await d.call({ target: 'pty:mine', spawn: 'UNIQUESPAWNMARKER bash', cmd: 'echo hi' }, { sessionKey: 'a1' })
    await d.call({ target: 'pty:theirs', spawn: 'bash', cmd: 'echo hi' }, { sessionKey: 'a2' })
    const a1 = await d.roster({ sessionKey: 'a1' })
    expect(a1).toMatch(/pty:pty-[a-z0-9]{4} \(label mine\)/)
    expect(a1).not.toContain('label theirs')
    expect(a1).not.toContain('UNIQUESPAWNMARKER')
    const a2 = await d.roster({ sessionKey: 'a2' })
    expect(a2).toMatch(/pty:pty-[a-z0-9]{4} \(label theirs\)/)
    expect(a2).not.toContain('label mine')
    expect(a1).toContain('incus containers')
    await d.dispose()
  })
  it('a bare name reaches a live session label (claim shadows machines)', async () => {
    const d = driverWith({ ...scanStub, sshConfigReader: async () => 'Host dev3\n' })
    await d.call({ target: 'pty:lab', spawn: 'bash', cmd: 'export MARK=bare' }, { sessionKey: 'a1' })
    const viaBare = await d.call({ target: 'lab', cmd: 'echo "$MARK"' }, { sessionKey: 'a1' })
    expect(viaBare.mode).toBe('pty')
    expect(viaBare.label).toBe('lab')
    expect(viaBare.stdout).toContain('bare')
    await d.dispose()
  })
  it('a spawn that never initializes leaves no claim behind — the label is immediately reusable', async () => {
    let argv = ['bash', '-c', 'exit 3']
    const d = driverWith({ spawnArgvFor: () => argv })
    await expect(d.call({ target: 'pty:x', spawn: 'broken', cmd: 'echo hi' })).rejects.toThrow(/E_SESSION_DIED/)
    await expect(d.call({ target: 'pty:x', cmd: 'echo hi' })).rejects.toThrow(/E_NO_SESSION/)
    argv = ['bash']
    const ok = await d.call({ target: 'pty:x', spawn: 'good', cmd: 'echo alive' })
    expect(ok.label).toBe('x')
    expect(ok.stdout).toContain('alive')
    await d.dispose()
  })
  it('a ready-then-killed session stays in the pool and still reconnects (unchanged)', async () => {
    const d = driverWith()
    await d.call({ target: 'pty:r', spawn: 'bash', cmd: 'echo warm' })
    await d.call({ target: 'pty:r', cmd: 'kill -9 $$' })
    const back = await d.call({ target: 'pty:r', cmd: 'echo back' })
    expect(back.reconnected).toBe(true)
    expect(back.stdout).toContain('back')
    await d.dispose()
  })
  it('the init-failure message names the session id, never the internal pool key', async () => {
    const d = driverWith({ spawnArgvFor: () => ['bash', '-c', 'exit 3'] })
    const msg = await d
      .call({ target: 'pty:x', spawn: 'broken', cmd: 'echo hi' }, { sessionKey: 'sess-abc' })
      .then(() => '', (e: Error) => e.message)
    expect(msg).toMatch(/E_SESSION_DIED/)
    expect(msg).toMatch(/pty-/)
    expect(msg).not.toContain('sess-abc')
    expect(msg).not.toContain('|p:')
    await d.dispose()
  })
})

describe('RemoteDriver terminal disposal', () => {
  it.each(['oneshot'] as const)('does not launch %s work after disposal while target discovery is pending', async mode => {
    const gate = deferredTargetResolution()
    const driver = driverWith(gate.options)
    let result: Awaited<ReturnType<RemoteDriver['call']>> | undefined
    try {
      const pending = driver.call({ target: 'delayed', mode, cmd: 'printf %s "$$"' })
        .then(value => { result = value; return { value } }, error => ({ error }))
      await gate.entered
      await driver.dispose()
      gate.release()
      expect(await pending).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining('E_REMOTE_DISPOSED') }) })
      await expect(driver.call({ spawn: 'bash', cmd: 'echo should-not-run' })).rejects.toThrow('E_REMOTE_DISPOSED')
    } finally {
      gate.release()
      killReturnedShell(result?.stdout)
      await driver.dispose()
    }
  })

  it('concurrent disposal calls share completion and settle only after the live shell exits', async () => {
    const driver = driverWith()
    try {
      const result = await driver.call({ spawn: 'bash', cmd: 'printf %s "$$"' })
      const pid = Number(result.stdout)
      const first = driver.dispose(), second = driver.dispose()
      expect(second).toBe(first)
      await Promise.all([first, second])
      expect(() => process.kill(pid, 0)).toThrow()
      expect(driver.dispose()).toBe(first)
    } finally { await driver.dispose() }
  })
})

describe('RemoteDriver input (interactive stdin, 2026-10-25)', () => {
  it('stdin-only routing (spec 2026-11-01): pty selector / bare pty label / machine default slot; no slot is created, discovery never dials', async () => {
    const d = driverWith({ rosterRunner: async () => { throw new Error('DISCOVERY MUST NOT RUN') } })
    await expect(d.input('ssh:dev4', { stdin: 'x\n' })).rejects.toThrow(/no default PTY on ssh:dev4 yet/) // machine: honest, no lazy creation
    await expect(d.input('dev4', { stdin: 'x\n' })).rejects.toThrow(/no default PTY on/) // bare machine name resolves the same key (local, zero dialing)
    await expect(d.input('ssh:dev4:pty', { stdin: 'x\n' })).rejects.toThrow(/:pty creation suffix is gone/)
    await expect(d.input('hub:m4', { stdin: 'x\n' })).rejects.toThrow(/E_HUB_UNAVAILABLE/) // hub transport gates before the slot lookup
    await expect(d.input('pty:nosuch', { stdin: 'x\n' })).rejects.toThrow(/E_NO_SESSION/)
    await expect(d.input('pty', { stdin: 'x\n' })).rejects.toThrow(/E_PARAMS/)
    await d.dispose()
  })
  it('writes into the running command of a live session; receipt carries identity and no guessed jobId; owner-scoped', async () => {
    const d = driverWith({ spawnArgvFor: () => ['script', '-qfec', 'bash', '/dev/null'] })
    try {
      const warm = await d.call({ target: 'pty:ix1', spawn: 'bash' })
      expect(warm.created).toBe(true)
      const pending = d.call({ target: 'pty:ix1', cmd: `printf 'P:'; IFS= read -s -r v; printf 'OK:%s' "$v"`, timeout: 30 })
      for (let i = 0; i < 200 && !(await d.status('pty:ix1')).includes('busy'); i++) await new Promise((r) => setTimeout(r, 20))
      const receipt = await d.input('pty:ix1', { stdin: 'val\n' })
      expect(receipt.session).toMatch(/^pty:pty-/)
      expect(receipt.label).toBe('ix1')
      expect(receipt.connection).toBe('BYOP')
      expect(receipt.writtenBytes).toBe(4)
      expect(receipt.commandId).toMatch(/^remote-/)
      expect(receipt.jobId).toBeUndefined() // no official job exists in the sync window — never guess one
      await expect(d.input('pty:ix1', { stdin: 'x\n' }, { sessionKey: 'someone-else' })).rejects.toThrow(/E_NO_SESSION/)
      const r = await pending
      expect(r.stdout).toContain('OK:val')
      await expect(d.input('pty:ix1', { stdin: 'x\n' })).rejects.toThrow(/E_SESSION_NOT_RUNNING/) // idle: never an implicit shell command
    } finally { await d.dispose() }
  }, 15_000)
})

describe('hub PTY canonical sessions + oneshot disclosure (0.3.2-c)', () => {
  const fakeProcess = () => ({
    cancel: () => {},
    done: Promise.resolve({ exit: 0, timedOut: false, durationMs: 1 }),
    read: () => ({ text: 'hub-out', nextOffset: 7, lossy: false }),
  })
  const hubStub = (mutate?: (machine: string) => void) => ({
    protocol: 1 as const,
    listTargets: () => [{ id: 'm', label: 'peer', execEnabled: true }],
    start: async () => fakeProcess() as never,
    ptyEndpoint: (machine: string) => {
      if (mutate) mutate(machine)
      return { url: 'ws://127.0.0.1:1/api/superd/exec/pty', cookie: 'c=1', wsPath: '/nowhere/ws' }
    },
    fileEndpoint: () => { throw new Error('not needed') },
    releaseOwner: async () => {},
  })

  it('hub machine default PTY (spec 2026-11-01): exec opens the default session; handoff detaches it as pty:<id> and the machine gets a fresh one', async () => {
    const d = driverWith({ getHub: () => hubStub() as never, hubPtyArgvFor: () => ['script', '-qfec', 'bash', '/dev/null'] })
    try {
      await expect(d.call({ target: 'hub:m:pty:lbl', cmd: undefined })).rejects.toThrow(/handoff detaches it as pty:<id>/) // old creation form is gone
      const r1 = await d.call({ target: 'hub:m', cmd: 'cd /tmp && printf hub-ok' })
      expect(r1.connection).toBe('hub:m')
      expect(r1.stdout).toContain('hub-ok')
      const h = await d.handoff('hub:m')
      expect(h.session).toBe(r1.session)
      const r2 = await d.call({ target: r1.session!, cmd: 'pwd' }) // the detached session keeps state
      expect(r2).toMatchObject({ cwd: '/tmp' })
      const fresh = await d.call({ target: 'hub:m', cmd: 'pwd' }) // machine got a fresh default
      expect(fresh.session).not.toBe(r1.session)
    } finally { await d.dispose() }
  })

  it('P10: pairing is re-validated on EVERY dispatch into a hub session — reuse is not exempt', async () => {
    let revoked = false
    const d = driverWith({ getHub: () => hubStub(() => { if (revoked) throw new Error('exec is disabled for machine "m"') }) as never, hubPtyArgvFor: () => ['script', '-qfec', 'bash', '/dev/null'] })
    try {
      const r = await d.call({ target: 'hub:m', cmd: 'printf first' })
      const id = (r as unknown as { session: string }).session
      revoked = true
      await expect(d.call({ target: id, cmd: 'printf second' })).rejects.toThrow(/disabled for machine/)
    } finally { await d.dispose() }
  })

  it('hub sessions share the per-Agent quota with every other transport', async () => {
    const d = driverWith({ getHub: () => hubStub() as never, hubPtyArgvFor: () => ['script', '-qfec', 'bash', '/dev/null'] })
    try {
      for (let i = 0; i < 30; i++) await d.handoff(`hub:q${i}`)
      await expect(d.handoff('hub:over')).rejects.toThrow(/E_SESSION_LIMIT/)
    } finally { await d.dispose() }
  })

  it('hub oneshot receipts disclose the peer-native supervision (runner field)', async () => {
    const d = driverWith({ getHub: () => hubStub() as never })
    try {
      const r = await d.call({ target: 'hub:m', cmd: 'printf hub-out', mode: 'oneshot' })
      expect(r).toMatchObject({ mode: 'oneshot', runner: 'hub-lease (peer bash -lc, peer Node supervision)' })
      expect(r.stdout).toContain('hub-out')
    } finally { await d.dispose() }
  })
})

describe('scriptPath over the hub lane + two-clock timeout (0.3.2-c pin)', () => {
  it('scriptPath rides the hub oneshot as bash -s + literal stdin (no argv quoting of the body)', async () => {
    const seen: Array<{ cmd: string; stdin?: string }> = []
    const hub = {
      protocol: 1 as const,
      listTargets: () => [{ id: 'm', label: 'peer', execEnabled: true }],
      start: async (_machine: string, input: { cmd: string; stdin?: string }) => {
        seen.push({ cmd: input.cmd, stdin: input.stdin })
        return { cancel: () => {}, done: Promise.resolve({ exit: 0, timedOut: false, durationMs: 1 }), read: () => ({ text: 'ok', nextOffset: 2, lossy: false }) } as never
      },
      ptyEndpoint: () => ({ url: 'ws://x', cookie: 'c', wsPath: '/w' }),
      fileEndpoint: () => { throw new Error('not needed') },
      releaseOwner: async () => {},
    }
    const script = await mkdtempScript()
    const d = driverWith({ getHub: () => hub as never })
    try {
      const r = await d.call({ target: 'hub:m', scriptPath: script, mode: 'oneshot' })
      expect(r).toMatchObject({ mode: 'oneshot', exit: 0 })
      // F1/F2 fix：载体 = 一条 bash -c 引号命令（argv 通道）；业务 stdin 不再与脚本正文拼接
      expect(seen.at(-1)!.cmd.startsWith("bash -c '")).toBe(true)
      expect(seen.at(-1)!.cmd).toContain("SCRIPT-BODY-7f3a")
      expect(seen.at(-1)!.cmd).toContain("'\\''") // shQuote 单引号转义（'\''）
      expect(seen.at(-1)!.stdin).toBeUndefined()
    } finally { await d.dispose(); await rm(dirname(script), { recursive: true, force: true }) }
  })
})

describe('scriptPath carrier regressions (F1/F2 fix, 2026-11-01 independent re-test)', () => {
  it('PTY: a script settles on its own (no interactive bash -s takeover), cd/export never leak into the session shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remote-script-pty-'))
    const script = join(dir, 'leak.sh')
    await writeFile(script, 'cd /tmp\nexport LEAK=1\nprintf IN-SCRIPT\n', 'utf8')
    const d = driverWith({ ptyArgvFor: () => ['bash'] })
    try {
      const r = await d.call({ target: 'ssh:s1', scriptPath: script, timeout: 15 })
      expect(r.exit).toBe(0) // settles — the F1 hang (exit null + still running) is gone
      expect(r.stdout).toContain('IN-SCRIPT')
      const after = await d.call({ target: 'ssh:s1', cmd: 'printf "LEAK=%s cwd=%s" "${LEAK:-unset}" "$(basename "$(pwd)")"' })
      expect(after.stdout).toContain('LEAK=unset') // export stayed inside the child bash -c
      expect(after.stdout).not.toContain('cwd=tmp') // cd stayed inside the child bash -c
      expect(after.session).toBe(r.session) // same default session, not a nested takeover
    } finally { await d.dispose(); await rm(dir, { recursive: true, force: true }) }
  })

  it('PTY + oneshot stdin separation: a mid-script read consumes ONLY the business stdin, never script bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remote-script-read-'))
    const script = join(dir, 'read.sh')
    await writeFile(script, 'IFS= read -r v\necho "GOT:$v"\n', 'utf8')
    const d = driverWith({ ptyArgvFor: () => ['bash'], oneshotArgvFor: (_plan, cmd) => ['bash', '-c', cmd] })
    try {
      const pty = await d.call({ target: 'ssh:s1', scriptPath: script, stdin: 'hello-pty\n', timeout: 15 })
      expect(pty.exit).toBe(0)
      expect(pty.stdout.trim()).toBe('GOT:hello-pty') // read got the business stdin, not the next script line
      const one = await d.call({ target: 'ssh:s1', scriptPath: script, stdin: 'hello-one\n', mode: 'oneshot' })
      expect(one).toMatchObject({ exit: 0, stdout: 'GOT:hello-one\n' })
    } finally { await d.dispose(); await rm(dir, { recursive: true, force: true }) }
  })
})

import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
async function mkdtempScript(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'remote-hub-script-'))
  const p = join(dir, 'body.sh')
  await writeFile(p, "printf 'SCRIPT-BODY-7f3a %s' \"$(echo quoted)\"\n", 'utf8')
  return p
}
