/**
 * Mobile swipe gestures (client half) — the 2026-11-08 revival, re-wired
 * onto upstream rc.1's NATIVE mobile drawer. The recognition design is
 * restored unchanged from the tested form (source `1706b81` + the velocity
 * gate; see `../gesture.ts` for the semantics): start admission X120 left
 * band / right three quarters, ≥40px travel, ×1.3 horizontal dominance,
 * 0.15 px/ms average velocity, one shot mid-drag.
 *
 * rc.1 wiring map (every address is an OFFICIAL upstream surface, verified
 * against the rc.1 checkout):
 * - left sidebar/drawer — state: AppFrame's `[data-sidebar-collapsed]`
 *   (present = collapsed; in drawer mode the drawer is open exactly while
 *   this is absent); action: `ctx.layout.toggleSidebar()` (ui-layout's
 *   cross-plugin panel-action face — the same call rc.1's own drawer mask
 *   and opener button make).
 * - right panel — state: `[data-rightbar-collapsed]` (trackless) plus
 *   `[data-rightbar-fullscreen]` (the rc.1 autoFullscreen presentation
 *   below 768); actions: the official controls, `[data-sidebar-right-expand]`
 *   (open) and `[data-sidebar-right-toggle]` (close).
 * - session liveness — the `conversation.session.header` slot anchor.
 *
 * NEW with rc.1 (the only behavioral addition over the tested design): the
 * drawer MASK. AppFrame now renders `[data-sidebar-mask]` with an onClick
 * that calls `toggleSidebar()` itself — a swipe that fires our toggle
 * mid-drag may still end as a browser `click` on that mask, which would
 * toggle the drawer a SECOND time (right back). `armMaskClickSwallow`
 * swallows exactly one mask-targeted click within 600ms of a left-panel
 * action; every other click passes untouched.
 *
 * What is NOT restored: the zero-rail CSS leg. rc.1's own drawer owns
 * narrow-viewport layout (the user field-verified the native UI); the
 * `[data-sidebar-collapsed]` grid override is retired for good — this
 * module mounts gesture listeners only, no style tag.
 *
 * Gating, unchanged from the tested form: config comes from the host
 * half's injected boot script (`window.__DASHR_MOBILE__` — the client half
 * of a dual-half plugin carries no loader config, so the page global IS
 * the config channel) and the device must be touch-first
 * (`isTouchFirstDevice`, 2026-10-18 user ruling).
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

/** Left sidebar/drawer state, live off AppFrame's semantic attribute. */
function readLeftCollapsed(): boolean {
  return document.querySelector('[data-sidebar-collapsed]') !== null
}

/**
 * The OFFICIAL right sidebar's state, read from AppFrame's TWO presentation
 * facets, synchronously (a cached mirror lags the panel's own DOM write by
 * a render, and a close-swipe issued right after an open-swipe would
 * misroute):
 *
 * - `[data-rightbar-collapsed]` — the reserved GRID TRACK facet (present =
 *   zero-width right column). Below 768 rc.1 presents the panel FULLSCREEN
 *   WITHOUT a track (`autoFullscreen`), so this attribute alone misreads a
 *   panel covering the whole frame as "closed" — the 2026-09-11 field bug:
 *   every close-swipe misrouted to open-left.
 * - `[data-rightbar-fullscreen]` — the overlay facet (present = fullscreen
 *   presentation active, open by definition; rc.1 emits it below 768).
 *
 * Open = track reserved OR fullscreen overlay.
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
 * Drive the OFFICIAL right sidebar through its own controls: opening clicks
 * `[data-sidebar-right-expand]` (the conversation header corner button,
 * rendered exactly while collapsed with a session); closing clicks
 * `[data-sidebar-right-toggle]` (the dock chrome toggle). The store action
 * behind them is slot-store-internal — cross-plugin imports are the hard
 * boundary, so the native buttons ARE the sanctioned entry. Absent button
 * (no session, or already in the target state): a no-op, never a crash.
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
 * The rc.1 drawer-mask double-toggle guard: swallow exactly ONE click that
 * lands on `[data-sidebar-mask]` shortly after our own left-panel toggle.
 * rc.1's mask has `onClick={toggleSidebar}` of its own — without this
 * guard, the browser `click` born of the swipe's pointerup could undo the
 * very toggle the swipe just made. Scoped hard: a click landing anywhere
 * else passes through untouched (and disarms the guard), and the guard
 * self-expires.
 */
function armMaskClickSwallow(): void {
  const swallow = (event: Event): void => {
    cleanup()
    const target = event.target
    // Duck-typed (`closest` presence) rather than `instanceof Element`:
    // the module also runs in node-based unit tests where the bare `Element`
    // global does not exist. Text/document targets simply have no closest.
    const el = target as Element | null
    if (el !== null && typeof el.closest === 'function' && el.closest('[data-sidebar-mask]') !== null) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const cleanup = (): void => {
    clearTimeout(timer)
    document.removeEventListener('click', swallow, true)
  }
  const timer = setTimeout(cleanup, 600)
  document.addEventListener('click', swallow, true)
}

/**
 * Mount the swipe-gesture surface. Inert unless the host's boot script
 * opted the page in AND the device is touch-first (2026-10-18 user ruling).
 * Capability flips (a tablet's primary pointer hardware changing)
 * re-evaluate and mount/unmount the surface live.
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
  }, 'dashr: mobile gestures')

  /** The swipe listeners, mounted and disposed as one surface (no CSS —
   * rc.1's native drawer owns narrow-viewport layout now). */
  function mountTouchSurface(): () => void {
    // The layout service is a conditional peer: a composition without
    // ui-layout gets no gesture surface at all (there is no second leg).
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
        if (action === 'open-left' || action === 'close-left') {
          armMaskClickSwallow()
          layout.toggleSidebar()
        }
        else if (action === 'open-right') openRightPanel()
        else closeRightPanel()
      }
      const onPointerEnd = (): void => {
        start = undefined
      }
      // CAPTURE on `document`: an open overlay panel (rc.1's fullscreen
      // drawer or right panel, dialogs) is a fixed layer over the frame;
      // bubbling listeners on the frame would never see its closing swipe.
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
      offLayout.dispose()
    }
  }
}
