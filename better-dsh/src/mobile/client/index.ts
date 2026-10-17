/**
 * Mobile responsiveness (client half) — an EXACT port of the operator's
 * ui-layout swipe patch (`z_dsh-alpha` commit `1706b81`) into plugin form
 * (see `../gesture.ts` for the semantics and their source anchors), plus
 * the one addition: the average-velocity gate.
 *
 * Two coordinated pieces, both config-gated by the host half's injected
 * boot script (`window.__DASHR_MOBILE__` — the client half of a dual-half
 * plugin carries no loader config, so the page global IS the config
 * channel) and DEVICE-gated on a touch-first primary input (2026-10-18
 * user ruling — `isTouchFirstDevice` in `../gesture.ts`): phones and
 * tablets mount both pieces; a desktop host mounts NEITHER, ever. The
 * superseded behavior compressed upstream's collapsed rail to zero width
 * on ANY pointer, so a desktop window below upstream's own auto-collapse
 * threshold (1024, measured on the frame's own box — which a right-panel
 * call-out helps squeeze) lost its sidebar AND the toggle inside it, with
 * mouse-drag swipes as the only — undiscoverable — way back. Desktop
 * narrow is now upstream's own rail with a visible toggle; swipes stay
 * where they are native (fingers).
 * channel):
 *
 * - **CSS** (the upstream-paradigm route — static rules, zero JS
 *   geometry): keyed PURELY on AppFrame's semantic
 *   `[data-sidebar-collapsed]` attribute — whenever upstream's layout
 *   collapses the sidebar (their auto-collapse threshold, 1024 today,
 *   theirs to move freely), our rule further compresses the 56px rail to
 *   a zero-width track. No pixel cut-off of our own (2026-09-11 mobile
 *   wave ruling). Degradation is benign: if upstream renames the
 *   attribute, the rule stops matching and the native rail simply
 *   renders.
 *
 * - **Gesture** (additive — upstream ships no swipe code): document-level
 *   CAPTURE listeners (an open overlay panel covers the frame — a
 *   frame-level listener would never see the closing swipe). The drag is
 *   decided on `pointermove` the moment the thresholds are met (one
 *   shot), never at pointerup. Left panel actions go through the layout
 *   service (`ctx.layout.toggleSidebar()`); right panel actions go
 *   through the OFFICIAL 0.1.5 controls (`[data-sidebar-right-expand]`
 *   to open, `[data-sidebar-right-toggle]` to close) with the open state
 *   read off AppFrame's `[data-rightbar-collapsed]`. Both reads address
 *   official surfaces only — third-party plugin DOM is never a state
 *   input. Absent right panel (pre-0.1.5 hosts, no session): right
 *   actions no-op silently; LEFT gestures keep working regardless.
 *
 * @module dashr/mobile/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  admitsSwipeStart, classifySwipeProgress, isTouchFirstDevice, resolveMobileConfig,
  type MobilePageConfig, type PanelState,
} from '../gesture.ts'

/**
 * One media query, or `undefined` when the environment has none (old
 * webviews throw or omit `matchMedia`) — the probe then rides the
 * touch-points fallback in {@link isTouchFirstDevice}.
 */
function safeMatchMedia(query: string): MediaQueryList | undefined {
  try {
    return globalThis.matchMedia?.(query) ?? undefined
  } catch {
    return undefined
  }
}
/** Structural layout face (`ctx.layout`): exactly what this feature calls. */
interface LayoutPanelFace {
  toggleSidebar(): void
}

/** Left sidebar state, live off AppFrame's semantic attribute. */
function readLeftCollapsed(): boolean {
  return document.querySelector('[data-sidebar-collapsed]') !== null
}

/**
 * The OFFICIAL right sidebar's state (0.1.5 ui-sidebar-right), read from
 * AppFrame's TWO presentation facets, synchronously (a cached mirror lags
 * the panel's own DOM write by a render, and a close-swipe issued right
 * after an open-swipe would misroute):
 *
 * - `[data-rightbar-collapsed]` — the reserved GRID TRACK facet (present =
 *   zero-width right column). On phones (<768) the panel presents FULLSCREEN
 *   WITHOUT a track (`autoFullscreen` in SidebarRight), so this attribute
 *   alone misreads a panel that covers the whole frame as "closed" — the
 *   2026-09-11 field bug: every close-swipe misrouted to open-left.
 * - `[data-rightbar-fullscreen]` — the overlay facet (present = fullscreen
 *   presentation active, open by definition).
 *
 * Open = track reserved OR fullscreen overlay. On hosts before 0.1.5 both
 * attributes never appear: closed, permanently — left gestures unaffected.
 */
function readRightOpen(): boolean {
  const fullscreen = document.querySelector('[data-rightbar-fullscreen]') !== null
  const trackless = document.querySelector('[data-rightbar-collapsed]') !== null
  return fullscreen || !trackless
}

/**
 * Whether a session is current — the plugin-side stand-in for the source's
 * `detailsSession !== undefined` guard (the right panel is a
 * session-scoped surface; without a session its expand button is not
 * rendered, so opening would be a no-op anyway).
 */
function readSessionLive(): boolean {
  return document.querySelector('[data-slot="conversation.session.header"]') !== null
}

/** Panel state snapshot, both sources live. */
function readPanelState(): PanelState {
  return { leftCollapsed: readLeftCollapsed(), rightOpen: readRightOpen() }
}

/**
 * Drive the OFFICIAL right sidebar through its own controls (0.1.5
 * ui-sidebar-right): opening clicks `[data-sidebar-right-expand]` (the
 * conversation header corner button — the panel's own documented "way
 * into a hidden panel", rendered exactly while collapsed with a session);
 * closing clicks `[data-sidebar-right-toggle]` (the dock chrome toggle).
 * The store action behind them (`setExpanded`/`toggleExpanded`) is
 * slot-store-internal — cross-plugin imports are the hard boundary, so
 * the native buttons ARE the sanctioned entry. Absent button (pre-0.1.5
 * host, no session, or already in the target state): a no-op, never a
 * crash.
 */
function openRightPanel(): void {
  document.querySelector<HTMLButtonElement>('[data-sidebar-right-expand]')?.click()
}

function closeRightPanel(): void {
  document.querySelector<HTMLButtonElement>('[data-sidebar-right-toggle]')?.click()
}

/** Page global left by the host half's boot script (see `src/web-trust.ts`). */
interface DashrMobileGlobal {
  __DASHR_MOBILE__?: MobilePageConfig
}

/**
 * The responsive CSS: zero-width sidebar track whenever upstream's layout
 * has collapsed the sidebar, keyed PURELY to AppFrame's semantic
 * attribute (survives class-hash churn). No width media query of our own
 * (2026-09-11 ruling): upstream owns the auto-collapse threshold (1024
 * today), and this rule simply takes the 56px rail they leave behind to
 * zero. If upstream renames the attribute the rule stops matching and
 * their native rail renders (benign degradation). The tag carries the
 * plugin-owned dataset so the loader's style-claim machinery removes it
 * on unload, like module CSS.
 */
function mobileCss(): string {
  return [
    `[data-sidebar-collapsed] {`,
    `  grid-template-columns: 0px minmax(0, 1fr) 0px !important;`,
    `}`,
  ].join('\n')
}

/**
 * Mount the mobile feature: style injection plus the swipe listeners.
 * Inert unless the host's boot script opted the page in AND the device is
 * touch-first (2026-10-18 user ruling). Capability flips (a tablet's
 * primary pointer hardware changing) re-evaluate and mount/unmount the
 * surface live; the media queries answer on every browser since ~2015 and
 * a webview without `matchMedia` degrades to the touch-points probe.
 *
 * @param ctx - client root context.
 */
export function setupMobileLayout(ctx: ClientContext): void {
  const pageConfig = (globalThis as DashrMobileGlobal).__DASHR_MOBILE__
  const config = resolveMobileConfig(pageConfig)
  if (!config.enabled) return

  const coarseQuery = safeMatchMedia('(pointer: coarse)')
  const hoverQuery = safeMatchMedia('(hover: none)')

  ctx.effect(() => {
    let disposeSurface: (() => void) | undefined
    const apply = (): void => {
      const touchFirst = isTouchFirstDevice({
        hoverNone: hoverQuery?.matches,
        pointerCoarse: coarseQuery?.matches,
        maxTouchPoints: (navigator as { maxTouchPoints?: number }).maxTouchPoints,
      })
      if (touchFirst && disposeSurface === undefined) disposeSurface = mountTouchSurface()
      else if (!touchFirst && disposeSurface !== undefined) {
        disposeSurface()
        disposeSurface = undefined
      }
    }
    coarseQuery?.addEventListener('change', apply)
    hoverQuery?.addEventListener('change', apply)
    apply()
    return () => {
      coarseQuery?.removeEventListener('change', apply)
      hoverQuery?.removeEventListener('change', apply)
      disposeSurface?.()
    }
  }, 'dashr: mobile layout')

  /** The style tag + gesture listeners, mounted and disposed as one surface. */
  function mountTouchSurface(): () => void {
    const styleTagId = 'better-dsh/mobile'
    const tag = document.createElement('style')
    tag.dataset.plugin = 'better-dsh'
    tag.dataset.pluginCss = styleTagId
    tag.textContent = mobileCss()
    document.head.append(tag)

    // The layout service is a conditional peer: a composition without
    // ui-layout keeps the CSS (pure cosmetics) and skips the left-panel
    // half of the gesture.
    const offLayout = ctx.inject(['layout'], (layoutCtx: ClientContext) => {
      const layout = layoutCtx.get('layout') as LayoutPanelFace | undefined
      if (layout === undefined) return
      let start: { x: number; y: number; t: number } | undefined
      const onPointerDown = (event: PointerEvent): void => {
        start = undefined
        const viewport = window.innerWidth
        // Everything past the mount gate runs on touch-first devices only —
        // the 2026-10-18 ruling replaced the per-event pointer-kind check.
        // Start admission (source pointerdown gate: X120 left band / right
        // three quarters while both panels are closed, anywhere once one
        // is open).
        const panels = readPanelState()
        if (!admitsSwipeStart(event.clientX, viewport, panels, config)) return
        start = { x: event.clientX, y: event.clientY, t: event.timeStamp }
      }
      const onPointerMove = (event: PointerEvent): void => {
        const origin = start
        if (origin === undefined) return
        const action = classifySwipeProgress(
          {
            dx: event.clientX - origin.x,
            dy: event.clientY - origin.y,
            dtMs: event.timeStamp - origin.t,
          },
          readPanelState(),
          readSessionLive(),
          config,
        )
        if (action === null) return
        // One shot: the drag is spent the moment it fires (source
        // semantics — the ref is nulled inside the move handler).
        start = undefined
        if (action === 'open-left' || action === 'close-left') layout.toggleSidebar()
        else if (action === 'open-right') openRightPanel()
        else closeRightPanel()
      }
      const onPointerEnd = (): void => {
        start = undefined
      }
      // CAPTURE on `document`: an open overlay panel (fullscreen right
      // sidebar, dialogs) is a fixed layer over the frame; bubbling
      // listeners on the frame would never see its closing swipe.
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('pointermove', onPointerMove, true)
      document.addEventListener('pointerup', onPointerEnd, true)
      document.addEventListener('pointercancel', onPointerEnd, true)
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('pointermove', onPointerMove, true)
        document.removeEventListener('pointerup', onPointerEnd, true)
        document.removeEventListener('pointercancel', onPointerEnd, true)
      }
    })

    return () => {
      tag.remove()
      void Promise.resolve(offLayout.dispose())
    }
  }
}
