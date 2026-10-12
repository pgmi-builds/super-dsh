import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveKernelEnv } from '../src/kernel-env.ts'
import { setupRuntime } from './helpers.ts'

// Real executable discovery under an isolated PATH; no subprocess mocks.
const systemPython = execFileSync(process.env.DASHR_TEST_PYTHON ?? 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
const dirs: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'better-python-discovery-')); dirs.push(dir)
  vi.stubEnv('PATH', dir); vi.stubEnv('VIRTUAL_ENV', ''); vi.stubEnv('CONDA_PREFIX', '')
  const marker = join(dir, 'uv-was-called')
  writeFileSync(join(dir, 'uv'), `#!/bin/sh\necho called > '${marker}'\nexit 99\n`, { mode: 0o755 })
  return { dir, marker, python(name = 'python3') { const p = join(dir, name); mkdirSync(join(p, '..'), { recursive: true }); symlinkSync(systemPython, p); return p } }
}

describe.skipIf(process.platform === 'win32')('Existing Python environment discovery', () => {
  it('uses PATH python3 directly even when uv is installed', async () => {
    const f = fixture(), python = f.python()
    const before = readdirSync(f.dir)
    const env = await resolveKernelEnv({ cwd: f.dir })
    expect(env.python).toBe(python)
    expect(env.version).toMatch(/^3\./)
    expect(readdirSync(f.dir)).toEqual(before)
    expect(existsSync(f.marker)).toBe(false)
  })
  it('uses PATH python when python3 is absent', async () => {
    const f = fixture(), python = f.python('python')
    expect((await resolveKernelEnv({ cwd: f.dir })).python).toBe(python)
  })
  it('tries python after an unusable python3', async () => {
    const f = fixture(), python = f.python('python')
    writeFileSync(join(f.dir, 'python3'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    expect((await resolveKernelEnv({ cwd: f.dir })).python).toBe(python)
  })
  it('reports missing Python without running the installed uv', async () => {
    const f = fixture()
    await expect(resolveKernelEnv({ cwd: f.dir })).rejects.toThrow(/No working Python.*python3.*python/s)
    expect(existsSync(f.marker)).toBe(false)
  })
  it('treats explicitly configured python3 as an executable, not a provisioning sentinel', async () => {
    const f = fixture(), python = f.python()
    expect((await resolveKernelEnv({ python: 'python3', cwd: f.dir })).python).toBe(python)
    expect(existsSync(f.marker)).toBe(false)
  })
  it('does not silently replace a broken explicit interpreter', async () => {
    const f = fixture(); f.python()
    await expect(resolveKernelEnv({ python: './absent', cwd: f.dir })).rejects.toThrow(/absent/)
    expect(existsSync(f.marker)).toBe(false)
  })
  it('uses an existing project venv and activates its subprocess environment', async () => {
    const f = fixture(); f.python()
    const python = f.python('.venv/bin/python')
    const env = await resolveKernelEnv({ cwd: f.dir })
    expect(env.python).toBe(python)
    expect(env.env?.VIRTUAL_ENV).toBe(join(f.dir, '.venv'))
    expect(env.env?.PATH?.split(':')[0]).toBe(join(f.dir, '.venv/bin'))
  })
  it('prefers the active environment over the project environment', async () => {
    const f = fixture(); f.python('.venv/bin/python')
    const python = f.python('active/bin/python'); vi.stubEnv('VIRTUAL_ENV', join(f.dir, 'active'))
    expect((await resolveKernelEnv({ cwd: f.dir })).python).toBe(python)
  })
  it('falls back from a broken existing environment without repairing it', async () => {
    const f = fixture(), python = f.python(); mkdirSync(join(f.dir, '.venv/bin'), { recursive: true })
    writeFileSync(join(f.dir, '.venv/bin/python'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    expect((await resolveKernelEnv({ cwd: f.dir })).python).toBe(python)
    expect(existsSync(f.marker)).toBe(false)
  })
  it('resolves explicit relative interpreters against the session workspace', async () => {
    const f = fixture(), python = f.python('custom/bin/python')
    expect((await resolveKernelEnv({ python: './custom/bin/python', cwd: f.dir })).python).toBe(python)
  })
  it('executes sessions with their own existing project environments', async () => {
    const f = fixture(); f.python()
    const first = join(f.dir, 'first'), second = join(f.dir, 'second')
    f.python('first/.venv/bin/python'); f.python('second/.venv/bin/python')
    const { runtime } = await setupRuntime({ python: undefined })
    for (const [principal, cwd] of [['first', first], ['second', second]]) {
      const result = await runtime.run({ principal, cwd, program: 'import os\nos.environ.get("VIRTUAL_ENV")', bindings: [] })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe(join(cwd!, '.venv'))
    }
  })
})
