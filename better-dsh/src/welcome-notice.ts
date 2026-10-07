/** Host policy for the native versioned welcome notice. No browser copy or fixed version. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-app-boot'

export const name = 'dashr-welcome-notice'
export const inject = ['loader', 'profileContext']
const NAMESPACE = 'ui-settings-general'
const FIELD = 'welcomeNoticeVersion'

/** The private upstream constant has no Host export; reject changed layouts rather than guess. */
export function parseWelcomeVersion(client: string): string {
  const values = [...client.matchAll(/\b(?:const|let|var)\s+WELCOME_NOTICE_VERSION\s*=\s*(['"])([^'"\\\r\n]+)\1\s*[;,]/g)]
  if (values.length !== 1) throw new Error('dashr-welcome-notice: expected one WELCOME_NOTICE_VERSION in the installed Models client; check the upstream bundle layout or disable this entry')
  return values[0]![2]!
}

/** Resolve from the owning DSH installation, never from this plugin's build dependencies. */
export function readHostWelcomeVersion(installAnchor: string): string {
  const web = createRequire(installAnchor).resolve('@deepseek-ai/dsh-web-app/package.json')
  const client = createRequire(web).resolve('@deepseek-ai/dsh-client-ui-settings-models/client')
  return parseWelcomeVersion(readFileSync(client, 'utf8'))
}

/** Keep the original settings namespace and native UI; project policy before startup settles. */
export async function apply(ctx: Context): Promise<(() => Promise<void>) | undefined> {
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === NAMESPACE)
  if (entry === undefined || entry.disabled) return
  const version = readHostWelcomeVersion(ctx.profileContext.installAnchor)
  const original = { ...(entry.options.config ?? {}) } as Record<string, unknown>
  const unhook = ctx.on('internal/config', function (this: Fiber, _raw, next) {
    const config = next()
    return this.entry?.options.id === NAMESPACE ? { ...config, [FIELD]: version } : config
  }, { global: true })
  try {
    if (entry.fiber === undefined) await entry.init()
    await entry.fiber?.await()
    await entry.update({ config: { ...original, [FIELD]: version } })
  } catch (error) {
    unhook()
    throw error
  }
  return async () => {
    unhook()
    if (entry.fiber === undefined || entry.disabled) return
    const config = { ...(entry.options.config ?? {}) } as Record<string, unknown>
    if (Object.hasOwn(original, FIELD)) config[FIELD] = original[FIELD]
    else delete config[FIELD]
    await entry.update({ config })
  }
}

export default { name, inject, apply }
