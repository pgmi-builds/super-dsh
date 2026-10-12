import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveKernelEnv, uvToolEnv, uvVenvArgs, venvFallbackArgs } from '../src/kernel-env.ts'

describe('Python environment resolution without consumer kernel packages', () => {
  it('accepts an explicit stdlib-only venv without installing pip packages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'better-env-'))
    try {
      execFileSync('python3', ['-m', 'venv', '--without-pip', dir])
      const python = join(dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      const env = await resolveKernelEnv({ python })
      expect(env.python).toBe(python)
      expect(env.managed).toBe(false)
      expect(env.version).toMatch(/^3\./)
      expect(execFileSync(python, ['-c', 'import importlib.util; print(any(importlib.util.find_spec(x) for x in ["pip", "ipykernel", "jupyter_client", "zmq", "dill"]))'], { encoding: 'utf8' }).trim()).toBe('False')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('reports an actionable interpreter error', async () => {
    await expect(resolveKernelEnv({ python: '/nonexistent/better-python' })).rejects.toThrow(/Python >=3.9.*Configure python/)
  })
  it('redirects uv caches next to the venv', () => {
    const env = uvToolEnv('/pkg/.venv-kernel')
    expect(env.UV_CACHE_DIR).toBe('/pkg/.uv-cache')
    expect(env.UV_PYTHON_INSTALL_DIR).toBe('/pkg/.uv-cache/python')
    expect(env.UV_LINK_MODE).toBe('copy')
  })
  it('creates environments without pip and retains configured uv Python selection', () => {
    expect(venvFallbackArgs('/pkg/env')).toEqual(['-m', 'venv', '--without-pip', '/pkg/env'])
    expect(uvVenvArgs('/pkg/env', '3.11')).toEqual(['venv', '/pkg/env', '--python', '3.11'])
  })
})
