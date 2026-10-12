/** Discover an existing Python runtime; never provision an interpreter or venv. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
const exec = promisify(execFile)
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export interface KernelEnv {
  python: string
  env: NodeJS.ProcessEnv
  version: string
}
export interface ResolveKernelEnvOptions {
  /** An explicit path or executable name bypasses automatic discovery. */
  python?: string
  /** Session workspace, used for existing project environments and relative paths. */
  cwd?: string
}
function venvPython(dir: string): string { return join(dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') }
function activate(dir: string): NodeJS.ProcessEnv {
  const bin = dirname(venvPython(dir))
  return { ...process.env, VIRTUAL_ENV: dir, PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter) }
}
function explicitPath(python: string, cwd: string): string {
  const expanded = python === '~' ? homedir() : python.startsWith('~/') ? join(homedir(), python.slice(2)) : python
  return isAbsolute(expanded) || /[/\\]/.test(expanded) ? resolve(cwd, expanded) : expanded
}
async function probe(python: string, env: NodeJS.ProcessEnv, cwd: string): Promise<KernelEnv> {
  const { stdout } = await exec(python, ['-c', 'import ast, asyncio, json, sys; assert sys.version_info >= (3, 9), "Packaged dill checkpoints require Python >=3.9"; print(json.dumps({"python": sys.executable, "version": sys.version.split()[0]}))'], {
    timeout: 15_000, cwd, env: { ...env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const result = JSON.parse(stdout.trim()) as { python: string, version: string }
  if (!isAbsolute(result.python) || !result.version) throw new Error('Interpreter did not report an absolute executable and version')
  return { ...result, env }
}
export async function resolveKernelEnv(options: ResolveKernelEnvOptions = {}): Promise<KernelEnv> {
  const cwd = resolve(options.cwd ?? process.cwd())
  if (options.python) {
    const python = explicitPath(options.python, cwd)
    const venv = dirname(dirname(python))
    const env = isAbsolute(python) && existsSync(join(venv, 'pyvenv.cfg')) ? activate(venv) : { ...process.env }
    try { return await probe(python, env, cwd) }
    catch (error) { throw new Error(`Could not use configured Python ${JSON.stringify(options.python)}: ${error instanceof Error ? error.message : String(error)}. Configure python with a working Python >=3.9 interpreter.`) }
  }
  // Match OMP's reuse of active/project environments. Discovery never creates or repairs them.
  const active = process.env.VIRTUAL_ENV || process.env.CONDA_PREFIX
  const project = [join(cwd, '.venv'), join(cwd, 'venv')].find(existsSync)
  const venv = active || project
  const candidates: { python: string, env: NodeJS.ProcessEnv }[] = []
  if (venv && existsSync(venvPython(venv))) candidates.push({ python: venvPython(venv), env: activate(venv) })
  for (const python of ['python3', 'python']) candidates.push({ python, env: { ...process.env } })
  const failures: string[] = []
  for (const candidate of candidates) {
    try { return await probe(candidate.python, candidate.env, cwd) }
    catch (error) { failures.push(`${candidate.python}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  throw new Error(`No working Python interpreter found. Tried: ${failures.join('; ')}. Install Python >=3.9 on PATH (python3 or python), or configure python with an existing interpreter. Better does not install Python automatically.`)
}
