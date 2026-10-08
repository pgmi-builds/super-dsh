/** Register pack companions through the installed harness's native package operations. */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, mkdir, realpath, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Context } from '@deepseek-ai/cordis'
import * as AppBoot from '@deepseek-ai/dsh-app-boot'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-plugin-manager'

export const name = 'dashr-bundle-delivery'
export const inject = ['profileContext', 'appReady']
interface Manifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
  superd?: { delivery?: string }
}
interface Companion { name: string; version: string; tarball: string; sha256: string }
interface DeliveryResult { installed: string[]; restartRequired: boolean }
interface InstallExpectation {
  owner: string
  ownerSpec: string
  companion: Companion
  priorSpec?: string
}
type NativeDisposition = 'installed' | 'owner-changed' | 'companion-changed' | 'companion-removed'
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
// Refresh-capable hosts retain loaded package provenance: promoting the
// companion from its containing pack to a direct dependency needs a restart.
// Older hosts without this API keep their first-registration behavior.
const nativePackages = AppBoot.PluginPackages?.prototype
const restartForPromotion = nativePackages !== undefined && typeof Reflect.get(nativePackages, 'refresh') === 'function'
const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T
async function optionalJson<T>(path: string): Promise<T | undefined> {
  try { return await json<T>(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
async function contained(root: string, path: string): Promise<string> {
  if (isAbsolute(path)) throw new Error('Pack delivery path must be relative')
  const base = await realpath(root), file = await realpath(resolve(base, path))
  const rel = relative(base, file)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('Pack delivery path escapes its owner')
  return file
}

/** A child process avoids inheriting a running HMR transaction's AsyncLocalStorage. */
async function installNative(profile: ProfileContext, archive: string, expected: InstallExpectation, signal?: AbortSignal): Promise<NativeDisposition> {
  signal?.throwIfAborted()
  const childScript = fileURLToPath(new URL('../scripts/register-bundle.mjs', import.meta.url))
  return new Promise<NativeDisposition>((done, fail) => {
    const child = spawn(process.execPath, [childScript], { stdio: ['pipe', 'pipe', 'pipe'], cwd: profile.dir })
    let output = '', diagnostic = ''
    const abort = () => { child.kill('SIGTERM') }
    const timeout = setTimeout(abort, 360_000)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-32768) })
    child.stderr.setEncoding('utf8').on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096) })
    child.on('error', fail)
    child.on('close', code => {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort)
      if (signal?.aborted) { fail(signal.reason); return }
      if (code !== 0) { fail(new Error(`Native companion registration failed (${code}): ${diagnostic.trim() || output.trim()}`)); return }
      try {
        const result = JSON.parse(output) as { exitCode: number; logPath?: string; disposition: NativeDisposition }
        if (result.exitCode !== 0) fail(new Error(`Native companion registration failed (${result.exitCode}); diagnostics: ${result.logPath ?? 'unavailable'}`))
        else if (!['installed', 'owner-changed', 'companion-changed', 'companion-removed'].includes(result.disposition)) fail(new Error('Native companion registration returned an invalid disposition'))
        else done(result.disposition)
      } catch (error) { fail(error) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ profile, archive, expected }))
  })
}

/** First registration enables a companion; native reconciliation preserves retained disablement. */
export async function reconcileBundledDelivery(profile: ProfileContext, signal?: AbortSignal): Promise<DeliveryResult> {
  const directory = join(profile.home, 'bundle-artifacts')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const key = hash(profile.dir)
  return withFileLock(join(directory, key + '.delivery'), async () => {
    signal?.throwIfAborted()
    const receiptPath = join(directory, key + '.json')
    const receipts = await optionalJson<Record<string, string>>(receiptPath) ?? {}
    const manifest = await json<Manifest>(join(profile.dir, 'package.json'))
    const result: DeliveryResult = { installed: [], restartRequired: false }
    for (const owner of Object.keys(manifest.dependencies ?? {})) {
      const ownerDir = join(profile.dir, 'node_modules', owner)
      const ownerManifest = await optionalJson<Manifest>(join(ownerDir, 'package.json'))
      if (ownerManifest?.superd?.delivery === undefined) continue
      const descriptorPath = await contained(ownerDir, ownerManifest.superd.delivery)
      const descriptor = await json<{ companions: Companion[] }>(descriptorPath)
      if (!Array.isArray(descriptor.companions)) throw new Error('Invalid pack delivery descriptor')
      for (const item of descriptor.companions) {
        // This native component coordinates its own delivery, never another runtime's packages.
        if (item.name !== 'better-dsh' || item.version !== ownerManifest.dependencies?.[item.name]
          || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid companion identity/version/digest')
        const bytes = await readFile(await contained(dirname(descriptorPath), item.tarball))
        if (hash(bytes) !== item.sha256) throw new Error(`Pack companion SHA256 mismatch: ${item.name}`)
        const archive = join(directory, `${item.name}-${item.sha256}.tgz`)
        const cached = await optionalJson<Manifest>(join(profile.dir, 'node_modules', item.name, 'package.json'))
        const current = await json<Manifest>(join(profile.dir, 'package.json'))
        const ownerSpec = current.dependencies?.[owner]
        if (ownerSpec === undefined) continue
        const priorSpec = current.dependencies?.[item.name]
        const receiptKey = `${owner}:${item.name}`
        if (priorSpec === undefined && receipts[receiptKey] === item.sha256) continue // explicit same-artifact removal
        if (priorSpec === 'file:' + archive && cached?.name === item.name && cached.version === item.version) {
          // Recover the commit receipt if a previous process stopped after native installation.
          receipts[receiptKey] = item.sha256
          await writeFileAtomic(receiptPath, JSON.stringify(receipts) + '\n', { mode: 0o600 })
          continue
        }
        try {
          const existing = await readFile(archive)
          if (hash(existing) !== item.sha256) throw new Error(`Cached companion SHA256 mismatch: ${item.name}`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          const temporary = archive + '.' + randomUUID() + '.tmp'
          try {
            await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
            await rename(temporary, archive)
          } finally { await rm(temporary, { force: true }) }
        }
        signal?.throwIfAborted()
        const disposition = await installNative(profile, archive, { owner, ownerSpec, companion: item, ...priorSpec === undefined ? {} : { priorSpec } }, signal)
        if (disposition === 'owner-changed' || disposition === 'companion-changed') continue
        // The child confirms installation/removal under the native profile lock. Persist that
        // receipt even if a later user mutation has already removed its installed files.
        receipts[receiptKey] = item.sha256
        await writeFileAtomic(receiptPath, JSON.stringify(receipts) + '\n', { mode: 0o600 })
        if (disposition === 'companion-removed') continue
        result.installed.push(`${item.name}@${item.version}`)
        result.restartRequired ||= priorSpec !== undefined || restartForPromotion
      }
    }
    return result
  }, { waitMs: 120000 })
}

export function apply(ctx: Context): void {
  const signal = new AbortController()
  let started = false, running = false, again = false
  const reconcile = async () => {
    if (!started || signal.signal.aborted) return
    if (running) { again = true; return }
    running = true
    try {
      const result = await reconcileBundledDelivery(ctx.profileContext, signal.signal)
      if (result.installed.length) {
        ctx.logger.info(`Registered ${result.installed.join(', ')} from its containing local pack${result.restartRequired ? '; restart DSH to use the updated code' : ''}`)
        ctx.emit('plugin-manager/changed', { reason: 'install' })
      }
    } catch (error) {
      if (!signal.signal.aborted) ctx.logger.error('Local pack companion registration failed; retry by re-enabling the bundle', error)
    } finally {
      running = false
      if (again && !signal.signal.aborted) { again = false; void reconcile() }
    }
  }
  ctx.effect(() => {
    const offReady = ctx.appReady!.onReady(() => { started = true; void reconcile() })
    const offChange = ctx.on('plugin-manager/changed', () => { void reconcile() })
    return () => {
      offReady(); offChange(); signal.abort()
      // Never await a child here: manager HMR may be holding the profile lock it needs.
    }
  }, 'bundle-delivery: native registration')
}
export default { name, inject, apply }
