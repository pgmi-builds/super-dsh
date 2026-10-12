import { describe, expect, it } from 'vitest'
import { setupRuntime } from './helpers.ts'
import { IpyKernelBridge } from '../src/kernel.ts'

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('OMP runner adaptation boundaries', () => {
  it('stops native foreground shell descendants before returning timeout and retains the runner', async () => {
    if (process.platform !== 'linux') return
    const { runtime } = await setupRuntime({ runTimeoutMs: 250, interruptGraceMs: 800, interruptConfirmMs: 20 })
    await runtime.run({ program: '42', bindings: [] })
    const runnerPid = runtime.kernelPid
    const result = await runtime.run({ program: '!echo $$; sleep 20', bindings: [] })
    expect(result.error?.kind).toBe('timeout')
    const shellPid = Number(result.logs.find(line => /^\d+$/.test(line.trim())))
    expect(shellPid).toBeGreaterThan(0)
    expect(alive(shellPid)).toBe(false)
    const after = await runtime.run({ program: '42', bindings: [] })
    expect(after.error).toBeUndefined()
    expect(after.value).toBe(42)
    expect(runtime.kernelPid).toBe(runnerPid)
  })

  it('kills new Popen descendants ignoring SIGINT and SIGTERM before returning timeout', async () => {
    if (process.platform !== 'linux') return
    const { runtime } = await setupRuntime({ runTimeoutMs: 300, interruptGraceMs: 800, interruptConfirmMs: 20 })
    const persistent = await runtime.run({ program: 'import subprocess,sys\nprior = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"])\nprior.pid', bindings: [] })
    const priorPid = Number(persistent.value)
    expect(priorPid).toBeGreaterThan(0)
    const runnerPid = runtime.kernelPid
    const childCode = 'import signal,time; signal.signal(signal.SIGINT,signal.SIG_IGN); signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(20)'
    const result = await runtime.run({ program: [
      'import subprocess,sys,time',
      `p = subprocess.Popen([sys.executable, "-c", ${JSON.stringify(childCode)}])`,
      'print(p.pid, flush=True)',
      'time.sleep(20)',
    ].join('\n'), bindings: [] })
    expect(result.error?.kind).toBe('timeout')
    const childPid = Number(result.logs.find(line => /^\d+$/.test(line.trim())))
    expect(childPid).toBeGreaterThan(0)
    expect(alive(childPid)).toBe(false)
    expect(alive(priorPid)).toBe(true)
    const after = await runtime.run({ program: 'prior.terminate()\nprior.wait()\n42', bindings: [] })
    expect(after.error).toBeUndefined()
    expect(after.value).toBe(42)
    expect(runtime.kernelPid).toBe(runnerPid)
  })

  it('cleans new subprocesses even when user code catches the timeout KeyboardInterrupt', async () => {
    if (process.platform !== 'linux') return
    const { runtime } = await setupRuntime({ runTimeoutMs: 250, interruptGraceMs: 800, interruptConfirmMs: 20 })
    await runtime.run({ program: '42', bindings: [] })
    const runnerPid = runtime.kernelPid
    const result = await runtime.run({ program: [
      'import subprocess,sys,time',
      'p = subprocess.Popen([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(20)"])',
      'print(p.pid, flush=True)',
      'try:',
      '    time.sleep(20)',
      'except KeyboardInterrupt:',
      '    pass',
      '"caught"',
    ].join('\n'), bindings: [] })
    expect(result.error?.kind).toBe('timeout')
    const childPid = Number(result.logs.find(line => /^\d+$/.test(line.trim())))
    expect(childPid).toBeGreaterThan(0)
    expect(alive(childPid)).toBe(false)
    const after = await runtime.run({ program: '42', bindings: [] })
    expect(after.error).toBeUndefined()
    expect(after.value).toBe(42)
    expect(runtime.kernelPid).toBe(runnerPid)
  })

  it('runs native tool.read through the runner call-site helper and preserves typed rejection', async () => {
    const { runtime } = await setupRuntime()
    const calls: unknown[] = []
    const bindings = [{ global: 'tool', functions: { read: async (args: unknown) => {
      calls.push(args)
      if ((args as { path?: string }).path === 'bad') throw new Error('read rejected')
      return { content: 'read-ok' }
    } }, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }]
    const result = await runtime.run({ program: 'await tool.read({"path": "ok"})', bindings })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ content: 'read-ok' })
    const rejected = await runtime.run({ program: [
      'try:',
      '    await tool.read({"path": "bad"})',
      'except ToolCallError as error:',
      '    caught = {"name": error.toolName, "message": str(error)}',
      'caught',
    ].join('\n'), bindings })
    expect(rejected.error).toBeUndefined()
    expect(rejected.value).toEqual({ name: 'read', message: 'read rejected' })
    expect(calls).toEqual([{ path: 'ok' }, { path: 'bad' }])
  })

  it('reinstalls the input guard immediately after native %reset in the same cell', async () => {
    const { runtime } = await setupRuntime({ runTimeoutMs: 150, interruptGraceMs: 150, interruptConfirmMs: 20 })
    const result = await runtime.run({ program: '%reset\ninput("question")', bindings: [] })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('Interactive stdin is unsupported')
    const after = await runtime.run({ program: '42', bindings: [] })
    expect(after.error).toBeUndefined()
    expect(after.value).toBe(42)
  })

  it('reinstalls current tool bindings immediately after native %reset', async () => {
    const { runtime } = await setupRuntime()
    const result = await runtime.run({ program: '%reset\nawait tool.read({"path": "ok"})',
      bindings: [{ global: 'tool', functions: { read: async () => 'ok' } }] })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('ok')
  })

  it('keeps synthetic execution file metadata out of the user namespace', async () => {
    const { runtime } = await setupRuntime()
    await runtime.run({ program: '42', bindings: [] })
    const names = await runtime.queryVar('')
    expect(names).toEqual({ kind: 'names', names: [] })
  })

  it('runs binding fanout concurrently and preserves gather order', async () => {
    const { runtime } = await setupRuntime()
    let active = 0
    let peak = 0
    const result = await runtime.run({
      program: 'import asyncio\nawait asyncio.gather(tools.echo(1), tools.echo(2), tools.echo(3))',
      bindings: [{ global: 'tools', functions: { echo: async value => {
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 40))
        active--
        return Number(value)
      } } }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual([1, 2, 3])
    expect(peak).toBe(3)
  })

  it('rejects detached old-cell callbacks before invoking the host', async () => {
    const { runtime } = await setupRuntime()
    let calls = 0
    const bindings = [{ global: 'tools', functions: { echo: async () => { calls++; return 1 } } }]
    const first = await runtime.run({ program: [
      'import asyncio',
      'async def later():',
      '    await asyncio.sleep(0.1)',
      '    try:',
      '        await tools.echo({})',
      '    except Exception:',
      '        pass',
      'background = asyncio.create_task(later())',
    ].join('\n'), bindings })
    expect(first.error).toBeUndefined()
    const after = await runtime.run({ program: 'await asyncio.sleep(0.2)\n42', bindings })
    expect(after.error).toBeUndefined()
    expect(after.value).toBe(42)
    expect(calls).toBe(0)
  })

  it('captures native subprocess stdout without corrupting JSON protocol', async () => {
    const { runtime } = await setupRuntime()
    const result = await runtime.run({ program: 'import subprocess, sys\nsubprocess.run([sys.executable, "-c", "print(12345)"], check=True)\nawait __import__("asyncio").sleep(0.05)\n42', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.logs.join('\n')).toContain('12345')
    expect(result.value).toBe(42)
  })

  it('rejects interactive input immediately with an actionable message', async () => {
    const { runtime } = await setupRuntime()
    const result = await runtime.run({ program: 'input("prompt")', bindings: [] })
    expect(result.error?.message).toContain('Interactive stdin is unsupported')
    const after = await runtime.run({ program: '42', bindings: [] })
    expect(after.value).toBe(42)
  })

  it('reaps an interrupt-resistant child before returning cancellation', async () => {
    if (process.platform === 'win32') return
    const bridge = new IpyKernelBridge({ python: 'python3', startupTimeoutMs: 3_000,
      disposeTimeoutMs: 1_000, interruptConfirmMs: 10, snapshotTimeoutMs: 3_000, username: 'test' })
    try {
      await bridge.start()
      const pid = bridge.pid!
      const result = await bridge.executeCell('import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\ntime.sleep(30)', {
        timeoutMs: 100, interruptGraceMs: 100, interruptConfirmMs: 10,
      })
      expect(result.outcome).toBe('forced')
      expect(bridge.isDead).toBe(true)
      expect(alive(pid)).toBe(false)
    } finally { await bridge.dispose() }
  })
})
