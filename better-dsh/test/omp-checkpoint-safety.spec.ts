import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DashrRuntime } from '../src/runtime.ts'
import { KERNEL_PYTHON, setupRuntime } from './helpers.ts'

function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'better-checkpoint-safety-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function manifest(dir: string) { return JSON.parse(readFileSync(join(dir, 's', 'manifest.json'), 'utf8')) }
const request = (program: string) => ({ program, principal: 's', bindings: [] })

describe('checkpoint safety and truthful outcomes', () => {
  it('omits captured proxies and transitive missing globals but permits fresh global tools', async () => {
    const snapshotDir = directory()
    const first = await setupRuntime({ snapshotDir })
    const bindings = [{ global: 'tool', callable: true as const, functions: { call: async () => 'old' } }]
    const save = await first.runtime.run({ ...request([
      'good = [1]', 'alias = good', 'class Bad:', '    def __reduce__(self): raise TypeError("bad value")',
      'bad = Bad()', 'dependent = lambda: bad', 'indirect = lambda: dependent()',
      'class Getter:', '    def get(self): return bad', 'getter = Getter()',
      'def capture(value): return lambda: value', 'captured = capture(tool)',
      'fresh = lambda: tool({})', '_user_private = 7',
    ].join('\n')), bindings })
    expect(save.error).toBeUndefined()
    expect(save.logs.join('\n')).toMatch(/partial.*bad/s)
    await first.fiber.dispose()
    const second = await setupRuntime({ snapshotDir })
    const result = await second.runtime.run({ ...request('[good is alias, await fresh(), _user_private, "dependent" in globals(), "indirect" in globals(), "getter" in globals(), "captured" in globals()]'), bindings: [{ ...bindings[0]!, functions: { call: async () => 'fresh' } }] })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual([true, 'fresh', 7, false, false, false, false])
    const names = await second.runtime.queryVar('', 's')
    expect(names.kind).toBe('names')
    if (names.kind === 'names') expect(names.names).not.toEqual(expect.arrayContaining(['tool', '__omp_with_call_site__']))
  })

  it.each(['manifest', 'payload', 'environment'])('rejects corrupt %s before restoring and stays usable', async mode => {
    const snapshotDir = directory()
    const first = await setupRuntime({ snapshotDir })
    await first.runtime.run(request('kept = 9'))
    await first.fiber.dispose()
    const m = manifest(snapshotDir)
    if (mode === 'manifest') writeFileSync(join(snapshotDir, 's', 'manifest.json'), '{broken')
    else if (mode === 'payload') writeFileSync(join(snapshotDir, 's', m.payload), 'broken')
    else { m.pythonVersion = '0.0.0'; writeFileSync(join(snapshotDir, 's', 'manifest.json'), JSON.stringify(m)) }
    const second = await setupRuntime({ snapshotDir })
    const result = await second.runtime.run(request('"kept" in globals()'))
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(false)
    expect(result.logs.join('\n')).toMatch(/snapshot.*(failed|not replayable|unavailable)/i)
  })

  it('retains the previous generation on cap and serialization timeout', async () => {
    const snapshotDir = directory()
    const first = await setupRuntime({ snapshotDir, snapshotSizeCapBytes: 5000, snapshotTimeoutMs: 300 })
    await first.runtime.run(request('kept = 11'))
    const committed = readFileSync(join(snapshotDir, 's', 'manifest.json'), 'utf8')
    const cap = await first.runtime.run(request('huge = "x" * 20000'))
    expect(cap.logs.join('\n')).toMatch(/snapshot.*skipped/)
    expect(readFileSync(join(snapshotDir, 's', 'manifest.json'), 'utf8')).toBe(committed)
    const slow = await first.runtime.run(request('del huge\nimport time\nclass Slow:\n    def __reduce__(self):\n        time.sleep(5)\n        return (int, (3,))\nslow = Slow()'))
    expect(slow.logs.join('\n')).toMatch(/snapshot.*failed/)
    expect(readFileSync(join(snapshotDir, 's', 'manifest.json'), 'utf8')).toBe(committed)
    expect((await first.runtime.queryVar('kept', 's')).kind).toBe('json')
    process.kill(first.runtime.kernelPids[0]!, 'SIGKILL')
    const second = await setupRuntime({ snapshotDir })
    expect((await second.runtime.run(request('kept'))).value).toBe(11)
  })

  it('raw reset removes prior generations and preserves callable helpers', async () => {
    const snapshotDir = directory()
    const { runtime } = await setupRuntime({ snapshotDir })
    await runtime.run(request('old = 1'))
    const old = manifest(snapshotDir).payload
    const result = await runtime.run(request('%reset\nnew = 2'))
    expect(result.error).toBeUndefined()
    expect(existsSync(join(snapshotDir, 's', old))).toBe(false)
    expect((await runtime.queryVar('', 's'))).toEqual({ kind: 'names', names: ['new'] })
    expect(manifest(snapshotDir).names).toEqual(['new'])
    expect(statSync(join(snapshotDir, 's')).mode & 0o777).toBe(0o700)
    for (const name of readdirSync(join(snapshotDir, 's'))) expect(statSync(join(snapshotDir, 's', name)).mode & 0o777).toBe(0o600)
  })

  it('does not replay or deny a side effect performed by the dying cell', async () => {
    const snapshotDir = directory()
    const marker = join(snapshotDir, 'side-effect.txt')
    const { runtime } = await setupRuntime({ snapshotDir })
    await runtime.run(request('kept = 17'))
    const died = await runtime.run(request(`import os\nwith open(${JSON.stringify(marker)}, "a") as output:\n    output.write("once")\nprint("side effect written", flush=True)\nos._exit(1)`))
    expect(died.error?.kind).toBe('worker-exit')
    expect(died.logs).toContain('side effect written')
    expect(died.error?.message).toMatch(/may have executed|partially executed/)
    expect(died.error?.message).not.toMatch(/must be replayed|did not execute/)
    expect(readFileSync(marker, 'utf8')).toBe('once')
    expect((await runtime.run(request('kept'))).value).toBe(17)
    expect(readFileSync(marker, 'utf8')).toBe('once')
  })

  it('refuses an aggregate graph failure without replacing the checkpoint', async () => {
    const snapshotDir = directory()
    const { runtime } = await setupRuntime({ snapshotDir })
    await runtime.run(request('kept = 23'))
    const previous = readFileSync(join(snapshotDir, 's', 'manifest.json'), 'utf8')
    const result = await runtime.run(request('class Unstable:\n    calls = 0\n    def __reduce__(self):\n        type(self).calls += 1\n        if type(self).calls > 1: raise ValueError("aggregate failure")\n        return (int, (4,))\nunstable = Unstable()'))
    expect(result.logs.join(' ')).toMatch(/snapshot failed.*aggregate failure/)
    expect(readFileSync(join(snapshotDir, 's', 'manifest.json'), 'utf8')).toBe(previous)
  })

  it('retains the checkpoint even when a reducer catches its timeout interrupt', async () => {
    const snapshotDir = directory()
    const { runtime } = await setupRuntime({ snapshotDir, snapshotTimeoutMs: 300 })
    await runtime.run(request('kept = 29'))
    const previous = readFileSync(join(snapshotDir, 's', 'manifest.json'), 'utf8')
    const result = await runtime.run(request('import time\nclass Slow:\n    def __reduce__(self):\n        try: time.sleep(0.4)\n        except KeyboardInterrupt: pass\n        return (int, (4,))\nslow = Slow()'))
    expect(result.logs.join(' ')).toMatch(/snapshot failed/)
    expect(readFileSync(join(snapshotDir, 's', 'manifest.json'), 'utf8')).toBe(previous)
  })

  it('rejects internal setVar names while retaining genuine private user names', async () => {
    const { runtime } = await setupRuntime()
    await runtime.run(request('value = 1'))
    for (const name of ['__name__', '__builtins__', '__omp_magic']) {
      await expect(runtime.setVar(name, 7, 's')).rejects.toThrow(/reserved/)
    }
    await runtime.setVar('_private', 9, 's')
    expect(await runtime.queryVar('', 's')).toEqual({ kind: 'names', names: ['_private', 'value'] })
    expect((await runtime.run(request('value + _private'))).value).toBe(10)
  })

  it('retains at most two immutable generations after successful commits', async () => {
    const snapshotDir = directory()
    const { runtime } = await setupRuntime({ snapshotDir })
    for (let n = 0; n < 5; n++) await runtime.run(request(`kept = ${n}`))
    const files = readdirSync(join(snapshotDir, 's')).filter(name => name.endsWith('.dill'))
    expect(files).toHaveLength(2)
    expect(files).toContain(manifest(snapshotDir).payload)
  })

  it('rejects a symlinked manifest instead of importing another session', async () => {
    const snapshotDir = directory()
    const first = await setupRuntime({ snapshotDir })
    await first.runtime.run(request('kept = 1'))
    await first.fiber.dispose()
    const outside = join(snapshotDir, 'external.json')
    const path = join(snapshotDir, 's', 'manifest.json')
    writeFileSync(outside, readFileSync(path))
    rmSync(path)
    symlinkSync(outside, path)
    const second = await setupRuntime({ snapshotDir })
    const result = await second.runtime.run(request('"kept" in globals()'))
    expect(result.value).toBe(false)
    expect(result.logs.join(' ')).toMatch(/symlink/)
  })

  it('reports missing current host bindings when restoring dependent functions', async () => {
    const snapshotDir = directory()
    const first = await setupRuntime({ snapshotDir })
    await first.runtime.run({ ...request('fresh = lambda: tool({})'), bindings: [{ global: 'tool', callable: true, functions: { call: async () => 1 } }] })
    await first.fiber.dispose()
    const second = await setupRuntime({ snapshotDir })
    const result = await second.runtime.run(request('"fresh" in globals()'))
    expect(result.value).toBe(false)
    expect(result.logs.join(' ')).toMatch(/missing.*binding.*tool/)
  })

  it('serializes queries, assignments and reset around an active cell', async () => {
    const snapshotDir = directory()
    const { runtime } = await setupRuntime({ snapshotDir })
    const running = runtime.run(request('import asyncio\nx = 1\nawait asyncio.sleep(0.05)\nx = 2'))
    const queried = runtime.queryVar('x', 's')
    const assigned = runtime.setVar('x', 3, 's')
    const reset = runtime.run({ ...request('"x" in globals()'), reset: true })
    expect((await running).error).toBeUndefined()
    expect(await queried).toEqual({ kind: 'json', text: '2' })
    await assigned
    expect((await reset).value).toBe(false)
    expect((await runtime.queryVar('x', 's')).kind).toBe('missing')
  })

  it('uses official profile home and respects explicit disable', async () => {
    const home = directory()
    const profileDir = join(home, 'profiles', 'work')
    const root = join(home, 'better-dsh', 'python-repl', createHash('sha256').update(profileDir).digest('hex'))
    const ctx = new Context()
    const profile = { home, dir: profileDir, name: 'work', patchPath: join(profileDir, 'cordis.patch.yml'), installAnchor: profileDir, cwd: home, startedBundles: [], overlays: [], telemetryDisabledEnv: '1' } satisfies ProfileContext
    ctx.provide('profileContext', profile)
    const fiber = await ctx.plugin(DashrRuntime, { python: KERNEL_PYTHON })
    onTestFinished(() => fiber.dispose())
    await ctx.replRuntime.run(request('kept = 1'))
    expect(existsSync(join(root, 's', 'manifest.json'))).toBe(true)
    await fiber.dispose()
    const disabled = new Context()
    disabled.provide('profileContext', profile)
    const other = await disabled.plugin(DashrRuntime, { python: KERNEL_PYTHON, snapshotDir: '' })
    onTestFinished(() => other.dispose())
    const result = await disabled.replRuntime.run(request('"kept" in globals()'))
    expect(result.value).toBe(false)
  })
})
