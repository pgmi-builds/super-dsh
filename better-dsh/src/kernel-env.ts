/** Resolve a Python >=3.9 interpreter. The packaged OMP runner needs only stdlib. */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
const exec = promisify(execFile)
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const AUTO_PYTHON_SENTINEL = 'python3'
export const DEFAULT_KERNEL_PYTHON_VERSION = '3.11'
export const DILL_VERSION = '0.4.1'
export interface KernelEnv {
  python: string
  managed: boolean
  venvDir: string | undefined
  /** Snapshot implementation is packaged rather than installed into Python. */
  dill: boolean
  version: string
}
export interface ResolveKernelEnvOptions {
  python?: string
  venvDir?: string
  pythonVersion?: string
  autoInstall?: boolean
  log?: (level: 'info' | 'warn', message: string) => void
}
export function uvToolEnv(venvDir: string): NodeJS.ProcessEnv {
  const cache = join(dirname(venvDir), '.uv-cache')
  return { ...process.env, UV_CACHE_DIR: cache, UV_PYTHON_INSTALL_DIR: join(cache, 'python'), UV_LINK_MODE: 'copy' }
}
export function uvVenvArgs(dir: string, version: string): string[] { return ['venv', dir, '--python', version] }
export function venvFallbackArgs(dir: string): string[] { return ['-m', 'venv', '--without-pip', dir] }
function venvPython(dir: string): string { return join(dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') }
async function probe(python: string): Promise<string> {
  try {
    const { stdout } = await exec(python, ['-c', 'import ast, asyncio, json, sys; assert sys.version_info >= (3, 9), "Python >=3.9 required"; print(json.dumps(sys.version.split()[0]))'], { timeout: 15_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
    return JSON.parse(stdout.trim()) as string
  } catch (error) {
    throw new Error(`Better Python REPL requires Python >=3.9. Could not use ${JSON.stringify(python)}: ${error instanceof Error ? error.message : String(error)}. Configure python with a working interpreter path.`)
  }
}
export async function resolveKernelEnv(options: ResolveKernelEnvOptions = {}): Promise<KernelEnv> {
  if (options.python && options.python !== AUTO_PYTHON_SENTINEL) {
    return { python: options.python, managed: false, venvDir: undefined, dill: true, version: await probe(options.python) }
  }
  const venvDir = options.venvDir ?? join(PACKAGE_ROOT, '.venv-kernel')
  const python = venvPython(venvDir)
  if (!existsSync(python)) {
    if (options.autoInstall === false) throw new Error(`Better Python REPL managed interpreter is missing at ${python}; configure python or run npm run kernel:venv`)
    options.log?.('info', `Creating stdlib-only Python environment at ${venvDir} (no pip packages)`)
    let uv = false
    try { await exec('uv', ['--version'], { timeout: 10_000 }); uv = true } catch { /* system Python fallback */ }
    if (uv) {
      mkdirSync(join(dirname(venvDir), '.uv-cache'), { recursive: true })
      await exec('uv', uvVenvArgs(venvDir, options.pythonVersion ?? DEFAULT_KERNEL_PYTHON_VERSION), { timeout: 120_000, env: uvToolEnv(venvDir) })
    } else await exec('python3', venvFallbackArgs(venvDir), { timeout: 120_000 })
  }
  return { python, managed: true, venvDir, dill: true, version: await probe(python) }
}
