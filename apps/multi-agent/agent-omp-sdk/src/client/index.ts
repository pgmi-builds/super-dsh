/**
 * Mobile responsiveness — client half entry (the first client surface of this
 * plugin). Mounts {@link setupMobileLayout}: CSS breakpoint override + the
 * document-level CAPTURE swipe gesture, both config-gated by the host half's
 * injected page global (`window.__OMP_WEB_MOBILE__`). The client half of a
 * dual-half plugin carries no loader config, so the page global IS the config
 * channel.
 *
 * The plugin shape mirrors the cordis client-plugin contract: an `inject`
 * declaration of required services plus an `apply(ctx)` that mounts the
 * feature. Only the `layout` service (the cross-plugin panel-action contract
 * provided by `@deepseek-ai/dsh-client-ui-layout`) is required — the feature
 * degrades to CSS-only when that peer is absent from the composition.
 *
 * @module omp-web-sdk/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { setupMobileLayout } from '../mobile/client/index.js'

/** Required services (cordis fiber inject): the panel-action face only. */
export const inject = ['layout']

/**
 * Mount the mobile feature. Inert unless the host's boot script opted the
 * page in via `window.__OMP_WEB_MOBILE__`.
 *
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Operator diagnostic (2026-09-09 iOS investigation): `?mdebug` in the page
  // URL mounts a self-reporting banner so ONE screenshot from a real device
  // localizes where the mobile feature breaks (global? style? listeners?
  // layout service? viewport?). Default path is untouched.
  if (typeof location !== 'undefined'
    && (location.search.includes('mdebug') || location.hash.includes('mdebug'))) {
    const report = (): void => {
      const facts: string[] = [
        `bundle=OK`,
        `global=${String((globalThis as { __OMP_WEB_MOBILE__?: unknown }).__OMP_WEB_MOBILE__ !== undefined)}`,
        `vw=${String(window.innerWidth)}`,
        `collapsed=${String(document.querySelector('[data-sidebar-collapsed]') !== null)}`,
        `rightOpen=${String(document.body.hasAttribute('data-dsh-sidebar-collapsed'))}`,
      ]
      const tag = document.createElement('div')
      tag.textContent = `[mdebug] ${facts.join(' ')}`
      tag.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b00;color:#fff;font:12px monospace;padding:4px 8px;pointer-events:none;'
      document.documentElement.append(tag)
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(report, 4000))
    else setTimeout(report, 4000)
  }
  setupMobileLayout(ctx)
}
