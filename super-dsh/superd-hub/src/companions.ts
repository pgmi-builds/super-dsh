/** Companion intent and the single native installation operation. */
import { createHash } from 'node:crypto'
import { readFile, mkdir, unlink, rmdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { PluginManager, ChangeResult } from '@deepseek-ai/dsh-plugin-manager'
import type { BetterDashStatus } from './companion-contract.js'

type Manager = Pick<PluginManager, 'listBundles' | 'installBundle'>
interface Intent { attempted: boolean; done?: boolean; error?: string; missingAfterFailure?: boolean }
// done marks a CONFIRMED first use (Better observed installed). A receipt with attempted
// but neither done nor error is an interrupted first use — e.g. killed by the restart
// that installing Super itself triggers — and must re-arm, not suppress, the retry.
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
async function optionalJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
function nativeFailure(result: ChangeResult): string | undefined {
  if ((result.application === 'applied' || result.application === 'restart-required') && result.error === undefined
    && (result.packageResult === undefined || result.packageResult.exitCode === 0)) return undefined
  return [result.application, result.error?.code, result.error?.diagnostic,
    result.packageResult?.kind, result.packageResult?.logPath].filter(Boolean).join(': ')
}

/** One controller per native profile; no package, registry, HMR or selection writer of its own. */
export class BetterDashCompanion {
  private readonly directory: string
  private readonly receipt: string
  private readonly legacy: string
  private initialized?: Promise<void>
  private intent: Intent = { attempted: false }
  private active?: Promise<BetterDashStatus>
  private stopped = false
  private restartNotice?: string

  constructor(profile: Pick<ProfileContext, 'home' | 'dir'>, private readonly version: string,
    private readonly manager: () => Manager | undefined) {
    const key = createHash('sha256').update(profile.dir).digest('hex') + '.json'
    this.directory = join(profile.home, 'superd', 'companions')
    this.receipt = join(this.directory, key)
    this.legacy = join(profile.home, 'companion-registration', key)
  }

  private initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      const saved = await optionalJson<Intent>(this.receipt)
      if (saved !== undefined) {
        // Never-resurrect applies only to a CONFIRMED first use or a recorded
        // failure; an interrupted first use (no done, no error) re-arms.
        this.intent = saved.attempted && saved.done !== true && saved.error === undefined
          ? { attempted: false } : saved
        await this.cleanLegacy(); return
      }
      const old = await optionalJson<Record<string, string>>(this.legacy)
      // Any old registration was first use. An absent Better now means removal,
      // including when Super has since changed version; never resurrect it.
      if (old?.['super-dsh:better-dsh'] !== undefined) {
        this.intent = { attempted: true }
        await this.save()
        await this.cleanLegacy()
      }
    })()
  }

  private async cleanLegacy(): Promise<void> {
    try { await unlink(this.legacy) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { await rmdir(dirname(this.legacy)) }
    catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }

  private async save(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.receipt, JSON.stringify(this.intent) + '\n', { mode: 0o600 })
  }

  async getBetterDash(): Promise<BetterDashStatus> {
    const status: BetterDashStatus = { installed: false, installing: this.active !== undefined, requestedVersion: this.version }
    try {
      await this.initialize()
      const manager = this.manager()
      if (manager === undefined) throw new Error('Native Plugin Manager is unavailable; enable it and retry Install in Settings.')
      const better = (await manager.listBundles()).find(bundle => bundle.name === 'better-dsh' && bundle.installed)
      if (better !== undefined) {
        status.installed = true
        if (better.version !== undefined) status.version = better.version
        status.enabled = better.enabled
        // An installed dependency alone does not prove application succeeded:
        // native configure can fail after writing that dependency. Only a
        // missing -> installed recovery clears a previous failure here.
        if (this.active === undefined && this.intent.attempted
          && (this.intent.done !== true || (this.intent.error !== undefined && this.intent.missingAfterFailure === true))) {
          this.intent.done = true
          delete this.intent.error
          delete this.intent.missingAfterFailure
          await this.save()
        }
      } else {
        this.restartNotice = undefined
        if (this.active === undefined && this.intent.error !== undefined && this.intent.missingAfterFailure !== true) {
          this.intent.missingAfterFailure = true
          await this.save()
        }
      }
      const error = this.intent.error ?? this.restartNotice
      if (error !== undefined) status.error = error
    } catch (error) { status.error = message(error) }
    return status
  }

  ensureAutomatic(): Promise<BetterDashStatus> { return this.run(false) }
  installBetterDash(): Promise<BetterDashStatus> { return this.run(true) }

  private run(manual: boolean): Promise<BetterDashStatus> {
    if (this.active !== undefined) return this.active
    const task = this.install(manual).catch(async error => {
      this.intent.error = `Better Dash installation failed: ${message(error)}. Check Better Dash in Plugin Manager; if missing, retry Install in Settings.`
      const status = await this.getBetterDash()
      this.intent.missingAfterFailure = !status.installed
      try { await this.save() } catch { /* Report the operation error even when persistence is unavailable. */ }
      return status
    }).then(status => ({ ...status, installing: false })).finally(() => { this.active = undefined })
    this.active = task
    return task
  }

  private async install(manual: boolean): Promise<BetterDashStatus> {
    await this.initialize()
    const before = await this.getBetterDash()
    if (this.stopped) return before
    if (before.installed) {
      this.intent.attempted = true
      this.intent.done = true
      if (this.intent.missingAfterFailure === true) {
        delete this.intent.error
        delete this.intent.missingAfterFailure
      }
      await this.save()
      return this.getBetterDash() // Native disablement and installed versions belong to the user.
    }
    // Native changed notifications enter through this operation, so its
    // read is active and deliberately cannot update the receipt itself.
    // Record removal here even when first-use installation is already done.
    if (this.intent.error !== undefined && this.intent.missingAfterFailure !== true) {
      this.intent.missingAfterFailure = true
      await this.save()
    }
    if (!manual && this.intent.attempted) return before
    this.intent = { attempted: true }
    await this.save() // First use is durable before native HMR can unload this row.
    const manager = this.manager()
    if (manager === undefined) throw new Error('Native Plugin Manager is unavailable')
    if (this.version === 'unknown' || this.version.trim() === '') throw new Error('The installed Super Dash package version could not be read')
    const failures: string[] = []
    for (const spec of [`better-dsh@${this.version}`, 'better-dsh@latest', 'better-dsh']) {
      if (this.stopped) break
      try {
        const result = await manager.installBundle(spec)
        const failure = nativeFailure(result)
        if (failure === undefined) {
          const after = await this.getBetterDash()
          if (after.installed) {
            this.intent.done = true
            delete this.intent.error
            delete this.intent.missingAfterFailure
            this.restartNotice = result.application === 'restart-required'
              ? 'Better Dash is installed; restart DSH to apply the native change.' : undefined
            await this.save()
            return this.getBetterDash()
          }
          failures.push(`${spec}: native manager reported ${result.application}, but Better Dash is not installed`)
        } else failures.push(`${spec}: ${failure}`)
      } catch (error) { failures.push(`${spec}: ${message(error)}`) }
    }
    throw new Error(failures.join('; ') || 'Super Dash companion component was unloaded')
  }

  /** Read-only observation: an intermediate native event must never trigger reinstatement. */
  async observeNativeChange(): Promise<BetterDashStatus> { return this.getBetterDash() }
  dispose(): void { this.stopped = true }
}
