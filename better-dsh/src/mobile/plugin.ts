/**
 * `dashr-mobile`: the mobile row (host half) — swipe-gesture page config
 * plus the iOS zoom-guard.
 *
 * 2026-11-08 revival — upstream dsh 0.2.2-rc.1's native mobile adaptation
 * turned out to be UI-only (SIDEBAR_DRAWER_BREAKPOINT=768 overlay drawers,
 * always-mounted opener, right-panel autoFullscreen; NO touch gestures), so
 * the field-tested swipe gestures are BACK, re-wired onto the native drawer
 * (client half `src/mobile/client/`, config channel `window.__DASHR_MOBILE__`).
 * What stays retired is the zero-rail CSS leg: rc.1's own drawer owns layout
 * now, and our `[data-sidebar-collapsed]` grid override would fight the
 * native right-panel track in the 768–1024 band. The recognition design is
 * unchanged from the tested form (source `1706b81`: start admission
 * X120-left-band / right three quarters, ≥40px travel, ×1.3 horizontal
 * dominance, 0.15 px/ms average velocity, one shot mid-drag). The gesture
 * leg is delivered as before: this row renders the page global through ONE
 * `webserver/index-inject` listener (the MOBILE LEG); the trusted-page
 * authorities leg lives on the sibling `dashr-web-trust` row; the event is
 * a list, so the two rows compose and toggle independently.
 *
 * @module dashr/mobile
 */

import { Context } from '@deepseek-ai/cordis'
import z from '#schemastery'
// Type-only: pulls the `webserver/index-inject` Events merge into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { buildMobileScript, type MobileConfig } from '../web-trust.ts'

/** Cordis plugin name. */
export const name = 'dashr-mobile'

/**
 * No static injects: `webServer` is composed conditionally inside
 * {@link apply}, so the row loads (dormant) in compositions without one.
 */
export const inject: string[] = []

/**
 * Row config schema — the gesture knobs plus the zoomGuard escape hatch.
 */
const MOBILE_CONFIG: z<Required<MobileConfig>> = z.object({
  enabled: z.boolean().default(true),
  // The swipe-gesture leg (2026-11-08 revival): 'on' plants the page
  // global for the client half; 'off' is the per-leg escape hatch.
  gesture: z.union(['on', 'off']).default('on'),
  // Recognition thresholds — the tested `1706b81` defaults (see
  // src/mobile/gesture.ts); the same tuning surface as before the
  // retirement.
  swipeDistancePx: z.natural().min(8).default(40),
  dominanceRatio: z.number().min(1).default(1.3),
  leftEdgeBandPx: z.natural().min(8).default(120),
  rightZoneRatio: z.number().min(0.05).max(0.9).default(0.25),
  swipeVelocityPxPerMs: z.number().min(0).default(0.15),
  // iOS focus auto-zoom suppression (change 2026-09-03-ios-focus-zoom-
  // suppression): 'meta' rewrites the viewport meta early on iOS-class
  // narrow viewports; 'off' is the escape hatch. 'font' (solution A, the
  // 16px floor) is a RESERVED future value — deliberately NOT accepted yet:
  // an unimplemented enum member would fail silent (no-op) at runtime, while
  // an unknown value here fails LOUD at config load.
  zoomGuard: z.union(['meta', 'off']).default('meta'),
})

export const Config = MOBILE_CONFIG

/**
 * Mount the mobile-leg injection: one `webserver/index-inject` listener
 * pushing the rendered row.
 * @param ctx - host plugin context.
 * @param config - the row config.
 */
export function apply(ctx: Context, config: MobileConfig | undefined): void {
  const mobile = config
  ctx.inject(['webServer'], () => {
    ctx.on('webserver/index-inject', (table) => {
      const text = buildMobileScript(mobile)
      if (text !== undefined) table.push({ kind: 'script', placement: 'head', text })
    })
  })
}

export default { name, inject, Config, apply }
