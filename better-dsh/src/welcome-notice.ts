/** Lifecycle owner of the client-only native welcome skip policy. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '#schemastery'

export const name = 'dashr-welcome-notice'
export const inject: string[] = []

// Settings projects only volatile schemas. This empty live namespace exposes
// component presence without editing any native settings or acknowledging a version.
export const Config = z.object({}).volatile()

export function apply(ctx: Context): void {
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}

export default { name, inject, Config, apply }
