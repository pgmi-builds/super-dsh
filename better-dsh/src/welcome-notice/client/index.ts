/** Skip the preview notice through the settings shell's public completion path. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef } from 'react'

/** Complete each newly selected notice without persisting native acknowledgement state. */
export function SkipWelcomeNotice({ complete }: PropsRuntime<'settings.onboarding'>): null {
  const completed = useRef(false)
  useEffect(() => {
    if (completed.current) return
    completed.current = true
    complete()
  }, [complete])
  return null
}

/** A package client can outlive this independently toggleable Host component. */
export function setupWelcomeNotice(ctx: Context): void {
  ctx.effect(() => ctx.configForms.whileServed(['dashr-welcome-notice'], () => ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'welcome-notice',
    priority: -1,
    order: -100,
  }, SkipWelcomeNotice))), 'welcome notice: served skip policy')
}
