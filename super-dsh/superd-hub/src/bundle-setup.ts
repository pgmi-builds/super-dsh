/** Better Dash is installed by the current profile's native Plugin Manager. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { BetterDashCompanion } from './companions.js'
import type { BetterDashStatus } from './companion-contract.js'
import { PACK_VERSION } from './pack-version.js'
export { BetterDashCompanion } from './companions.js'
export type { BetterDashStatus } from './companion-contract.js'

export const name = 'superd-bundle-setup'
export const inject = ['profileContext', 'appReady']
declare module '@deepseek-ai/cordis' {
  interface Context { superdCompanions: SuperdCompanions }
}
export class SuperdCompanions extends TypertRemoteService {
  constructor(ctx: Context, private readonly companion: BetterDashCompanion) { super(ctx, 'superdCompanions') }
  @Remote
  getBetterDash(): Promise<BetterDashStatus> { return this.companion.getBetterDash() }
  @Remote
  installBetterDash(): Promise<BetterDashStatus> { return this.companion.installBetterDash() }
}

export function apply(ctx: Context): void {
  const companion = new BetterDashCompanion(ctx.profileContext, PACK_VERSION, () => ctx.get('pluginManager'))
  new SuperdCompanions(ctx, companion)
  ctx.effect(() => {
    let ready = false, registering = true
    const start = () => {
      void companion.ensureAutomatic().then(status => {
        if (status.error !== undefined) ctx.logger.warn(status.error)
      }).catch(error => ctx.logger.warn('Better Dash companion status failed', error))
    }
    const offReady = ctx.appReady!.onReady(() => {
      ready = true
      // Cold readiness occurs after boot, outside HMR. A live mount gets an
      // immediate callback while its parent HMR transaction is still active:
      // wait for the native changed notification below instead.
      if (!registering) start()
    })
    registering = false
    const offChange = ctx.on('plugin-manager/changed', () => {
      // Native configure/HMR has finished here, but the parent's profile lock
      // is still held. Return immediately; child install queues that lock.
      if (ready) start()
    })
    return () => { offReady(); offChange(); companion.dispose() }
  }, 'bundle-delivery: native companions')
}
export default { name, inject, apply }
