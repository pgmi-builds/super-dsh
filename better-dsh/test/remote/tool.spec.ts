import { describe, expect, it } from 'vitest'
import { createRemoteTool } from '../../src/remote/tool.ts'
import { createRemoteTransferTool } from '../../src/remote/transfer-tool.ts'
import { RemoteDriver } from '../../src/remote/driver.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const fakeDriver = (): RemoteDriver =>
  new RemoteDriver({
    oneshotArgvFor: () => ['bash', '-c', 'echo out'],
    ptyArgvFor: () => ['bash'],
    spawnArgvFor: () => ['bash'],
  })

const fakeExec = (): ToolRunContext => ({ agent: { id: 'agent-1' } }) as unknown as ToolRunContext

describe('createRemoteTool', () => {
  it('registers under the name "remote" and starts with a required action', () => {
    const tool = createRemoteTool(fakeDriver())
    expect(tool.name).toBe('remote')
    const { required, properties } = tool.parameters as unknown as { required?: string[]; properties: Record<string, { enum?: string[] }> }
    expect(required).toEqual(['action'])
    expect(properties.action?.enum).toEqual(['exec', 'handoff', 'add', 'status', 'close'])
  })
  it('executes through the driver and returns the value envelope', async () => {
    const tool = createRemoteTool(fakeDriver())
    const exec = fakeExec()
    const v = await tool.execute!({ action: 'exec', target: 'dev4', cmd: 'echo out' } as never, exec) as { text: string; exit: number | null }
    expect(v.text).toBe('out\n')
    expect(v.exit).toBe(0)
  })
  it('renders output + footer (+cwd), stderr block, and the reconnect notice line', async () => {
    const tool = createRemoteTool(fakeDriver())
    const blocks = tool.output!.render!({} as never, {
      kind: 'exec', text: 'hello', exit: 0, durationMs: 1500, cwd: '/data', reconnected: true,
    } as never)
    const text = (blocks[0] as { type: string; text: string }).text
    expect(text).toContain('[remote: session reconnected to fresh shell; cwd reset to default]')
    expect(text).toContain('hello')
    expect(text).toContain('[cwd /data · exit 0 · 1.5s]')
    const blocks2 = tool.output!.render!({} as never, {
      kind: 'exec', text: 'x', exit: 1, durationMs: 100, stderr: 'boom', timedOut: true, truncated: 999,
    } as never)
    const text2 = (blocks2[0] as { type: string; text: string }).text
    expect(text2).toContain('interrupted')
    expect(text2).toContain('truncated, original 999 chars')
    expect(text2).toContain('[stderr]\nboom')
  })
  it('action is the only dispatch dimension: absent, unknown, and foreign fields all fail loud', async () => {
    const tool = createRemoteTool(fakeDriver())
    const exec = fakeExec()
    await expect(tool.execute!({ target: 'dev4', cmd: 'x' } as never, exec)).rejects.toThrow(/missing required property "action"/)
    await expect(tool.execute!({ action: 'create', target: 'dev4' } as never, exec)).rejects.toThrow(/must be one of|unknown action/)
    await expect(tool.execute!({ action: 'exec', target: 'dev4', spawn: 'bash', cmd: 'x' } as never, exec)).rejects.toThrow(/E_PARAMS/)
    await expect(tool.execute!({ action: 'exec', cmd: 'x' } as never, exec)).rejects.toThrow(/requires target/)
    await expect(tool.execute!({ action: 'exec', target: 'dev4' } as never, exec)).rejects.toThrow(/must execute something/)
    await expect(tool.execute!({ action: 'add', spawn: '' } as never, exec)).rejects.toThrow(/E_PARAMS/)
    await expect(tool.execute!({ action: 'add' } as never, exec)).rejects.toThrow(/registers a BYO endpoint/)
    await expect(tool.execute!({ action: 'status', cmd: 'x' } as never, exec)).rejects.toThrow(/does not belong to action "status"/)
    await expect(tool.execute!({ action: 'add', spawn: 'bash', cmd: 'x' } as never, exec)).rejects.toThrow(/does not belong to action "add"/)
  })
  it('status without target returns the roster (attention entry, local scan)', async () => {
    const d = new RemoteDriver({
      sshConfigReader: async () => '',
      rosterRunner: async (argv: string[]) =>
        ({ exit: 0, timedOut: false, stdout: argv[0] === 'docker' ? 'corti	running\n' : 'ctr-1,RUNNING\n', stderr: '', durationMs: 5 }),
    })
    const tool = createRemoteTool(d)
    const exec = fakeExec()
    const v = await tool.execute!({ action: 'status' } as never, exec) as unknown as { kind: string; text: string }
    expect(v.kind).toBe('roster')
    expect(v.text).toContain('ssh hosts')
    expect(v.text).toContain('docker containers: corti (running)')
    expect(v.text).toContain('incus containers: ctr-1 (RUNNING)')
    expect(v.text).toContain('pty sessions: none')
    const blocks = tool.output!.render!({} as never, v as never)
    const rendered = (blocks[0] as { type: string; text: string }).text
    expect(rendered).toBe(v.text)
    expect(rendered).not.toContain('[exit')
  })
  it('status with target = on-demand probe, honest vocabulary, never "offline"', async () => {
    const d = new RemoteDriver({
      probeRunner: async () => ({ exit: 0, timedOut: false, stdout: '', stderr: '', durationMs: 240 }),
    })
    const tool = createRemoteTool(d)
    const exec = fakeExec()
    const v = await tool.execute!({ action: 'status', target: 'dev4' } as never, exec) as { kind: string; text: string }
    expect(v.kind).toBe('status')
    expect(v.text).toContain('dev4 — ssh host')
    expect(v.text).toContain('reachable')
    expect(v.text).toContain('pty sessions on this connection: none')
    expect(v.text).not.toContain('offline')
  })
  it('close mutex and oneshot stdin-without-cmd fail loud before any execution', async () => {
    const tool = createRemoteTool(fakeDriver())
    const exec = fakeExec()
    await expect(tool.execute!({ action: 'close', target: 'pty:x', cmd: 'x' } as never, exec)).rejects.toThrow(/E_PARAMS/)
    await expect(tool.execute!({ action: 'exec', target: 'dev4', stdin: 's', mode: 'oneshot' } as never, exec)).rejects.toThrow(/E_STDIN_WITHOUT_CMD/)
    await expect(tool.execute!({ action: 'exec', target: 'ssh:dev4:pty', cmd: 'x' } as never, exec)).rejects.toThrow(/E_TARGET_FORMAT/) // :pty creation suffix removed (spec 2026-11-01)
    await expect(tool.execute!({ action: 'exec', target: 'dev4', cmd: 'x', scriptPath: '/tmp/x.sh' } as never, exec)).rejects.toThrow(/E_SCRIPT_PARAMS/)
  })
  it('exec stdin-only (raw write): schema and execute layers agree (spec remote-default-pty)', async () => {
    const tool = createRemoteTool(fakeDriver())
    const { properties } = tool.parameters as unknown as { properties: Record<string, { enum?: string[]; type?: string }> }
    expect(properties.commandId).toBeDefined()
    expect(properties.mode).toBeDefined()
    const exec = fakeExec()
    await expect(tool.execute!({ action: 'exec', target: 'pty:x' } as never, exec)).rejects.toThrow(/must execute something/)
    await expect(tool.execute!({ action: 'exec', target: 'dev4', stdin: 's', mode: 'oneshot' } as never, exec)).rejects.toThrow(/E_STDIN_WITHOUT_CMD/)
    await expect(tool.execute!({ action: 'exec', target: 'pty:x', stdin: 'x\n', run_in_background: true } as never, exec)).rejects.toThrow(/cannot go background/)
    await expect(tool.execute!({ action: 'exec', target: 'pty:x', stdin: 'x\n', cmd: 'y', commandId: 'c' } as never, exec)).rejects.toThrow(/commandId guards a raw stdin write/)
    await expect(tool.execute!({ action: 'exec', target: 'pty:x', stdin: 'x\n', commandId: '' } as never, exec)).rejects.toThrow(/commandId/)
    await expect(tool.execute!({ action: 'handoff', target: 'pty:x' } as never, exec)).rejects.toThrow(/E_TARGET_FORMAT/)
    // unknown sessions fail loud without dialing
    await expect(tool.execute!({ action: 'exec', target: 'pty:nosuch', stdin: 'x\n' } as never, exec)).rejects.toThrow(/E_NO_SESSION/)
  })
  it('input receipts render the passthrough text and never echo the stdin body', async () => {
    const tool = createRemoteTool(fakeDriver())
    const blocks = tool.output!.render!({} as never, {
      kind: 'input', text: 'wrote 5 bytes into pty:pty-a1 for command remote-x — read the response with job_output remote-x',
      exit: null, durationMs: 0, session: 'pty:pty-a1', commandId: 'remote-x', jobId: 'remote-x', writtenBytes: 5,
    } as never)
    const rendered = (blocks[0] as { type: string; text: string }).text
    expect(rendered).toContain('wrote 5 bytes')
    expect(rendered).not.toContain('exit null') // input is a structured write receipt, not an exec receipt
  })
  it('add registers a BYO pty into the pool; the next exec addresses it by session id', async () => {
    const tool = createRemoteTool(fakeDriver())
    const exec = fakeExec()
    const added = await tool.execute!({ action: 'add', spawn: 'bash' } as never, exec) as { text: string; session?: string; created?: boolean; notice?: string }
    expect(added.created).toBe(true)
    expect(added.session).toMatch(/^pty:pty-[a-z0-9]{4}$/)
    expect(added.notice).toBeUndefined() // 0.3.2-d: spawn 创建的回执由 [session created] 行 + 标记承载，不再叠加 registered notice
    const v = await tool.execute!({ action: 'exec', target: added.session!, cmd: 'echo out' } as never, exec) as { text: string; session?: string; label?: string; connection?: string; commandId?: string }
    expect(v.text).toBe('out\n')
    expect(v.session).toBe(added.session)
    expect(v.connection).toBe('BYOP')
    expect(v.commandId).toMatch(/^remote-/)
    const blocks = tool.output!.render!({} as never, {
      kind: 'exec', text: 'hello', exit: 0, durationMs: 1500, session: 'pty:pty-7k2m', label: 'build', connection: 'ssh:dev4', commandId: 'remote-3fb2', notice: '[remote: keep the id]',
    } as never)
    const text = (blocks[0] as { type: string; text: string }).text
    expect(text).toContain('[remote: keep the id]')
    expect(text).toContain('pty:pty-7k2m (build) · conn ssh:dev4 · cmd remote-3fb2 · exit 0 · 1.5s')
  })
  it('the roster call carries the calling agent session key (scope plumbing)', async () => {
    const seen: Array<{ sessionKey?: string } | undefined> = []
    const spy = {
      roster: async (ctx?: { sessionKey?: string }) => { seen.push(ctx); return 'roster-text' },
    } as unknown as RemoteDriver
    const tool = createRemoteTool(spy)
    const v = await tool.execute!({ action: 'status' } as never, fakeExec()) as { kind: string; text: string }
    expect(v.kind).toBe('roster')
    expect(v.text).toBe('roster-text')
    expect(seen[0]?.sessionKey).toBe('agent-1')
  })
  it('the description teaches the reviewed surface (spec remote-default-pty, 2026-11-01): default PTY, went-async + completion notice, verbatim bytes, busy exits, close has no job id', () => {
    const description = createRemoteTool(fakeDriver()).description
    expect(description).toContain('PTY:\n- stateful oneshot, interact-able stdin, managed output, persistent env')
    expect(description).toContain('- run_in_background = the command went async (not bash &): a job handle returns immediately and a completion notification will follow — no polling required.')
    expect(description).toContain('verbatim always: "\\n" submits; "\\u0003" Ctrl-C; "\\u0004" Ctrl-D; "" writes zero bytes.')
    expect(description).toContain('Busy PTY rejects new cmds')
    expect(description).toContain('mode:"oneshot" = isolated, stateless')
    expect(description).toContain('PTY stdin alone (no cmd/scriptPath) = raw write into the command currently running in that PTY')
    expect(description).toContain('a prompt on a oneshot means cancel (job_kill) and switch to PTY')
    expect(description).toContain('no Python')
    expect(description).toContain("cancelling a running command is job_kill's job — close takes no job id")
    expect(description).not.toContain('action:"copy"')
    expect(description).not.toContain(':pty"') // the creation suffix is gone from the surface (session ids like pty:pty-irsq are fine)
    expect(description).not.toContain(':pty:')
  })
  it('examples stay format-true to the code: action verbs declared, transfer tool separated, receipts match renderValue', () => {
    const description = createRemoteTool(fakeDriver()).description
    expect(description).toContain('remote { "action": "exec", "target": "ssh:dev4", "cmd": "cd /srv/app && pwd" }')
    expect(description).toContain('[pty:pty-irsq · conn ssh:dev4 · cmd remote-0d89215d1cc64cdc · cwd /srv/app · idle-left ~15m · exit 0 · 0.3s]')
    expect(description).toContain('remote { "action": "exec", "target": "ssh:dev4", "cmd": "make test", "run_in_background": true }')
    expect(description).toContain('completion is reported by the host.')
    expect(description).toContain('remote { "action": "handoff", "target": "ssh:dev4" }')
    expect(description).toContain('remote { "action": "add", "spawn": "ssh -t pc ssh -t dev4", "target": "pty:dev4via" }')
    expect(description).toContain('remote { "action": "exec", "target": "pty:dev4via"')
    expect(description).toContain('remote { "action": "exec", "target": "ssh:dev4", "mode": "oneshot", "cmd": "uname -a" }')
    expect(description).toContain('remote_transfer { "mode": "rsync", "src": "ssh:lab:/var/log/app/", "dst": "/home/u1/app-logs/", "argv": ["-a"] }')
  })
})

describe('createRemoteTransferTool', () => {
  it('is a separate tool with a required mode enum and no execution fields', () => {
    const tool = createRemoteTransferTool(fakeDriver())
    expect(tool.name).toBe('remote_transfer')
    const { required, properties } = tool.parameters as unknown as { required?: string[]; properties: Record<string, { enum?: string[] }> }
    expect(properties.mode?.enum).toEqual(['copy', 'rsync'])
    expect(required).toEqual(['mode'])
    for (const field of ['target', 'cmd', 'ssh', 'spawn', 'run_in_background', 'timeout']) expect(properties[field]).toBeUndefined()
    const description = tool.description
    expect(description).toContain('Every call declares its mode')
    expect(description).not.toContain('PTY IS A STATEFUL ONESHOT')
  })
  it('mode is required and every unknown parameter is rejected', async () => {
    const tool = createRemoteTransferTool(fakeDriver())
    const exec = fakeExec()
    await expect(tool.execute!({ src: '/a', dst: '/b' } as never, exec)).rejects.toThrow(/missing required property "mode"/)
    await expect(tool.execute!({ mode: 'scp', src: '/a', dst: '/b' } as never, exec)).rejects.toThrow()
    await expect(tool.execute!({ mode: 'copy', src: '/a' } as never, exec)).rejects.toThrow(/requires src and dst/)
    await expect(tool.execute!({ mode: 'copy', src: '/a', dst: '/b', cmd: 'true' } as never, exec)).rejects.toThrow(/unknown parameter "cmd"/)
    await expect(tool.execute!({ mode: 'rsync', src: '/a', dst: '/b', verify: true } as never, exec)).rejects.toThrow(/rsync cannot be combined/)
    await expect(tool.execute!({ mode: 'rsync', src: '/a', dst: '/b', pullArgv: ['-a'], pushArgv: ['-b'] } as never, exec)).rejects.toThrow(/copy-only/)
  })
})
