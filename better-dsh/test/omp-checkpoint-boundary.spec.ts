import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { IpyKernelBridge } from '../src/kernel.ts'
import { setupRuntime } from './helpers.ts'

function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'better-checkpoint-boundary-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const request = (program: string) => ({ program, principal: 's', bindings: [] })
const contents = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name)).toString('base64')]))
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, 's', 'manifest.json'), 'utf8'))

describe('best-effort checkpoint boundary', () => {
  it('returns completed values and stdout despite an unavailable checkpoint directory, then remains usable', async () => {
    const snapshotDir = join(directory(), 'blocked')
    writeFileSync(snapshotDir, 'regular file blocks directory preparation')
    const { runtime } = await setupRuntime({ snapshotDir })
    const result = await runtime.run(request('important_value = 73\nprint("completed once")\nimportant_value'))
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(73)
    expect(result.logs.join('\n')).toContain('completed once')
    expect(result.logs.join('\n')).toMatch(/snapshot failed:.*(?:ENOTDIR|not a directory).*no successful checkpoint available/i)
    expect(await runtime.queryVar('important_value', 's')).toEqual({ kind: 'json', text: '73' })
    const next = await runtime.run(request('important_value += 1\nimportant_value'))
    expect(next.error).toBeUndefined()
    expect(next.value).toBe(74)
    expect(next.logs.join('\n')).toMatch(/snapshot failed/)
    rmSync(snapshotDir)
    const recovered = await runtime.run(request('important_value'))
    expect(recovered.error).toBeUndefined()
    expect(recovered.value).toBe(74)
    expect(recovered.logs.join('\n')).not.toMatch(/snapshot failed/)
    expect(manifest(snapshotDir).turn).toBe(3)
  })

  it('preserves user exceptions, preceding stdout and mutations when directory preparation fails', async () => {
    const snapshotDir = join(directory(), 'blocked')
    writeFileSync(snapshotDir, 'regular file blocks directory preparation')
    const { runtime } = await setupRuntime({ snapshotDir })
    const result = await runtime.run(request('before_error = 73\nprint("before user error")\nraise ValueError("user failure")'))
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('ValueError: user failure')
    expect(result.logs.join('\n')).toContain('before user error')
    expect(result.logs.join('\n')).toMatch(/snapshot failed:.*no successful checkpoint available/)
    expect(await runtime.queryVar('before_error', 's')).toEqual({ kind: 'json', text: '73' })
    const next = await runtime.run(request('before_error + 1'))
    expect(next.error).toBeUndefined()
    expect(next.value).toBe(74)
  })

  it('resolves an applied setVar and reports the retained checkpoint after directory preparation fails', async () => {
    const snapshotDir = directory()
    const { runtime } = await setupRuntime({ snapshotDir })
    expect((await runtime.run(request('kept = 1'))).error).toBeUndefined()
    const sessionDir = join(snapshotDir, 's')
    const saved = contents(sessionDir)
    const retainedDir = join(snapshotDir, 'retained')
    renameSync(sessionDir, retainedDir)
    writeFileSync(sessionDir, 'regular file blocks directory preparation')
    await expect(runtime.setVar('from_host', { value: 42 }, 's')).resolves.toBeUndefined()
    expect(await runtime.queryVar('from_host', 's')).toEqual({ kind: 'json', text: '{"value": 42}' })
    const next = await runtime.run(request('[kept, from_host["value"]]'))
    expect(next.error).toBeUndefined()
    expect(next.value).toEqual([1, 42])
    expect(next.logs.filter(line => /snapshot failed:.*latest successful checkpoint is turn-1/.test(line))).toHaveLength(2)
    expect(contents(retainedDir)).toEqual(saved)
    rmSync(sessionDir)
    renameSync(retainedDir, sessionDir)
    expect(manifest(snapshotDir).turn).toBe(1)
    const recovered = await runtime.run(request('from_host["value"]'))
    expect(recovered.error).toBeUndefined()
    expect(recovered.value).toBe(42)
    expect(recovered.logs.join('\n')).not.toMatch(/snapshot failed/)
    expect(manifest(snapshotDir).turn).toBe(3)
  })

  it.each(['throw', 'reject'] as const)('contains a snapshot dispatch %s after real execution and setVar, preserving prior files', async (failure) => {
    const snapshotDir = directory()
    const { runtime, fiber } = await setupRuntime({ snapshotDir })
    expect((await runtime.run(request('kept = 1'))).error).toBeUndefined()
    const saved = contents(join(snapshotDir, 's'))
    // Only the host dispatch failure is injected; execution, assignment,
    // queries, checkpoint recovery and cold restore use the real child.
    const dispatch = vi.spyOn(IpyKernelBridge.prototype, 'snapshotState').mockImplementation(() => {
      const error = new Error('injected snapshot dispatch failure')
      if (failure === 'throw') throw error
      return Promise.reject(error)
    })
    onTestFinished(() => dispatch.mockRestore())
    const result = await runtime.run(request('kept += 1\nprint("executed once")\nkept'))
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(2)
    expect(result.logs.join('\n')).toContain('executed once')
    expect(result.logs.join('\n')).toMatch(/snapshot failed: injected snapshot dispatch failure; latest successful checkpoint is turn-1/)
    await expect(runtime.setVar('from_host', 42, 's')).resolves.toBeUndefined()
    expect(await runtime.queryVar('from_host', 's')).toEqual({ kind: 'json', text: '42' })
    const next = await runtime.run(request('[kept, from_host]'))
    expect(next.error).toBeUndefined()
    expect(next.value).toEqual([2, 42])
    expect(next.logs.filter(line => /snapshot failed:.*latest successful checkpoint is turn-1/.test(line))).toHaveLength(2)
    expect(contents(join(snapshotDir, 's'))).toEqual(saved)
    dispatch.mockRestore()
    const recovered = await runtime.run(request('[kept, from_host]'))
    expect(recovered.error).toBeUndefined()
    expect(recovered.value).toEqual([2, 42])
    expect(recovered.logs.join('\n')).not.toMatch(/snapshot failed/)
    expect(manifest(snapshotDir).turn).toBe(4)
    await fiber.dispose()
    const fresh = await setupRuntime({ snapshotDir })
    const restored = await fresh.runtime.run(request('[kept, from_host]'))
    expect(restored.error).toBeUndefined()
    expect(restored.value).toEqual([2, 42])
    expect(restored.logs.join('\n')).toContain('restored from the turn-4 snapshot')
  })
})
