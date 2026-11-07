/**
 * The touch-first mount gate + the rc.1 gesture dispatch (2026-11-08
 * revival): recognition design unchanged from the tested form; the wiring
 * now addresses rc.1's native drawer surfaces, and the NEW drawer-mask
 * double-toggle guard gets its own case.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { JSDOM } from '../../upstream/deepseek-harness/node_modules/jsdom/lib/api.js'
import { setupMobileLayout } from '../src/mobile/client/index.ts'

// ---- the controllable browser faces ----------------------------------------

/** A MediaQueryList pair the test flips and fires at will. */
class FakeMql {
  matches: boolean
  readonly listeners: Array<() => void> = []
  constructor(matches: boolean) { this.matches = matches }
  addEventListener(_kind: 'change', fn: () => void): void { this.listeners.push(fn) }
  removeEventListener(_kind: 'change', fn: () => void): void {
    const at = this.listeners.indexOf(fn)
    if (at !== -1) this.listeners.splice(at, 1)
  }
  set(matches: boolean): void {
    this.matches = matches
    for (const fn of [...this.listeners]) fn()
  }
}

interface Harness {
  readonly coarse: FakeMql | undefined
  readonly hover: FakeMql | undefined
  readonly disposers: Array<() => void>
  readonly added: Array<{ type: string; capture: boolean }>
  readonly removed: Array<{ type: string; capture: boolean }>
  readonly document: Document
  readonly MouseEvent: typeof MouseEvent
  readonly toggles: { count: number }
  readonly clicks: { expand: number; toggle: number }
}

function harness(options: { coarse?: boolean; hover?: boolean; enabled?: boolean; matchMedia?: boolean; maxTouchPoints?: number; velocityOff?: boolean } = {}): Harness {
  // A non-opaque origin: JSDOM's about:blank default makes the click
  // dispatch path throw on `localStorage` access.
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://dashr-mobile.test/' })
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('window', dom.window)
  let coarseRef: FakeMql | undefined
  let hoverRef: FakeMql | undefined
  if (options.matchMedia !== false) {
    const coarse = new FakeMql(options.coarse === true)
    const hover = new FakeMql(options.hover === true)
    coarseRef = coarse
    hoverRef = hover
    vi.stubGlobal('matchMedia', (query: string): MediaQueryList => (query.includes('coarse') ? coarse : hover) as unknown as MediaQueryList)
  }
  vi.stubGlobal('navigator', { maxTouchPoints: options.maxTouchPoints ?? 0 })
  ;(globalThis as { __DASHR_MOBILE__?: unknown }).__DASHR_MOBILE__
    = options.enabled === false ? undefined : { enabled: true, ...(options.velocityOff === true ? { swipeVelocityPxPerMs: 0 } : {}) }

  // Registration tracking OVER the real listeners, so the same harness can
  // both assert mount/unmount and actually dispatch pointer events.
  const added: Array<{ type: string; capture: boolean }> = []
  const removed: Array<{ type: string; capture: boolean }> = []
  const doc = dom.window.document
  const realAdd = doc.addEventListener.bind(doc)
  const realRemove = doc.removeEventListener.bind(doc)
  const captureOf = (opts?: boolean | AddEventListenerOptions): boolean =>
    typeof opts === 'object' ? opts?.capture === true : opts === true
  doc.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
    added.push({ type, capture: captureOf(opts) })
    return realAdd(type, listener, opts)
  }) as typeof doc.addEventListener
  doc.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
    removed.push({ type, capture: captureOf(opts) })
    return realRemove(type, listener, opts)
  }) as typeof doc.removeEventListener

  const disposers: Array<() => void> = []
  const toggles = { count: 0 }
  const clicks = { expand: 0, toggle: 0 }
  // The stub ctx: effect factories run at mount (cordis semantics); inject
  // fires immediately with a layout face (the conditional peer present) and
  // returns the {dispose} face the surface's cleanup calls.
  const ctx = {
    effect(fn: () => () => void, _label?: string) { disposers.push(fn()); return () => { } },
    inject(_deps: string[], cb: (c: unknown) => (() => void) | void) {
      const off = cb({ get: () => ({ toggleSidebar() { toggles.count += 1 } }) })
      // cordis treats the callback's return as the injection's cleanup.
      return { dispose() { off?.() } }
    },
  }
  setupMobileLayout(ctx as never)
  return {
    get coarse() { return coarseRef },
    get hover() { return hoverRef },
    disposers, added, removed, toggles, clicks,
    document: doc,
    MouseEvent: dom.window.MouseEvent,
  }
}

// ---- the official rc.1 state fixtures ---------------------------------------

interface PanelFixture {
  /** Drawer/sidebar closed (`[data-sidebar-collapsed]` present). */
  leftCollapsed?: boolean
  /** Right panel presentation; omitted = no attributes (open-by-track). */
  right?: 'closed' | 'fullscreen' | 'track'
  /** A current session (the header slot anchor). */
  session?: boolean
  /** rc.1's drawer mask. */
  mask?: boolean
  /** The official right-panel controls. */
  expandButton?: boolean
  toggleButton?: boolean
}

/** Paint the official rc.1 state attributes the client half reads. */
function paint(h: Harness, fixture: PanelFixture): void {
  h.document.body.innerHTML = ''
  const add = (attrs: Record<string, string>): HTMLElement => {
    const el = h.document.createElement('div')
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    h.document.body.append(el)
    return el
  }
  if (fixture.leftCollapsed === true) add({ 'data-sidebar-collapsed': '' })
  if (fixture.right === 'closed') add({ 'data-rightbar-collapsed': '' })
  if (fixture.right === 'fullscreen') add({ 'data-rightbar-fullscreen': '' })
  if (fixture.session === true) add({ 'data-slot': 'conversation.session.header' })
  if (fixture.mask === true) add({ 'data-sidebar-mask': '' })
  if (fixture.expandButton === true) {
    const b = h.document.createElement('button')
    b.setAttribute('data-sidebar-right-expand', '')
    b.addEventListener('click', () => { h.clicks.expand += 1 })
    h.document.body.append(b)
  }
  if (fixture.toggleButton === true) {
    const b = h.document.createElement('button')
    b.setAttribute('data-sidebar-right-toggle', '')
    b.addEventListener('click', () => { h.clicks.toggle += 1 })
    h.document.body.append(b)
  }
}

/** One full pointer drag against the document (JSDOM viewport = 1024). */
function swipe(h: Harness, from: { x: number; y: number }, to: { x: number; y: number }): void {
  h.document.dispatchEvent(new h.MouseEvent('pointerdown', { clientX: from.x, clientY: from.y }))
  h.document.dispatchEvent(new h.MouseEvent('pointermove', { clientX: to.x, clientY: to.y }))
  h.document.dispatchEvent(new h.MouseEvent('pointerup', {}))
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { __DASHR_MOBILE__?: unknown }).__DASHR_MOBILE__
  vi.restoreAllMocks()
})

describe('the touch-first mount gate', () => {
  it('a phone-class device mounts the swipe listeners (no CSS leg any more)', () => {
    const h = harness({ coarse: true, hover: true })
    expect(h.added.map((e) => e.type)).toEqual(expect.arrayContaining(['pointerdown', 'pointermove', 'pointerup', 'pointercancel']))
    expect(h.added.every((e) => e.capture)).toBe(true)
    expect(h.document.querySelector('[data-plugin-css]')).toBeNull()
  })

  it('a desktop-class device (fine pointer, hoverable) mounts NOTHING', () => {
    const h = harness({ coarse: false, hover: false })
    expect(h.added).toEqual([])
  })

  it('a touchscreen laptop (fine primary pointer) stays desktop even with many touch points', () => {
    const h = harness({ coarse: false, hover: false, maxTouchPoints: 10 })
    expect(h.added).toEqual([])
  })

  it('a capability flip re-evaluates: desktop → phone mounts, phone → desktop unmounts', () => {
    const h = harness({ coarse: false, hover: false })
    expect(h.added).toEqual([])
    // The tablet's pointer hardware changes: both queries flip and fire.
    h.hover!.set(true)
    h.coarse!.set(true)
    expect(h.added.length).toBe(4)
    // Back to desktop: the surface is gone again (listeners removed).
    h.hover!.set(false)
    h.coarse!.set(false)
    expect(h.removed.map((e) => e.type)).toEqual(expect.arrayContaining(['pointerdown', 'pointermove', 'pointerup', 'pointercancel']))
  })

  it('a disabled host config stays inert on a phone-class device too', () => {
    const h = harness({ coarse: true, hover: true, enabled: false })
    expect(h.added).toEqual([])
  })

  it('no matchMedia at all degrades to the touch-points probe', () => {
    const touch = harness({ matchMedia: false, maxTouchPoints: 5 })
    expect(touch.added.length).toBe(4)
    const desktop = harness({ matchMedia: false, maxTouchPoints: 0 })
    expect(desktop.added).toEqual([])
  })

  it('unloading the effect removes the surface', () => {
    const h = harness({ coarse: true, hover: true })
    expect(h.added.length).toBeGreaterThanOrEqual(4)
    for (const dispose of h.disposers) dispose()
    expect(h.removed.length).toBeGreaterThanOrEqual(4)
  })
})

describe('gesture dispatch over the rc.1 wiring (velocity gate disarmed for same-tick events)', () => {
  it('right-swipe from the left band opens the drawer through the layout service', () => {
    const h = harness({ coarse: true, hover: true, velocityOff: true })
    paint(h, { leftCollapsed: true, right: 'closed', session: true })
    swipe(h, { x: 50, y: 400 }, { x: 150, y: 400 })
    expect(h.toggles.count).toBe(1)
    expect(h.clicks).toEqual({ expand: 0, toggle: 0 })
  })

  it('left-swipe closes an open drawer AND swallows the mask click born of the swipe', () => {
    const h = harness({ coarse: true, hover: true, velocityOff: true })
    const seen: Element[] = []
    h.document.addEventListener('click', (event) => { seen.push(event.target as Element) })
    paint(h, { right: 'closed', mask: true }) // drawer open: no [data-sidebar-collapsed]
    swipe(h, { x: 600, y: 400 }, { x: 500, y: 400 })
    expect(h.toggles.count).toBe(1)
    // rc.1's mask would toggle right back — the guard eats exactly this click.
    const mask = h.document.querySelector('[data-sidebar-mask]')!
    mask.dispatchEvent(new h.MouseEvent('click', { bubbles: true }))
    expect(seen).toEqual([])
    // The guard is spent: a later, non-mask click passes untouched.
    h.document.body.dispatchEvent(new h.MouseEvent('click', { bubbles: true }))
    expect(seen).toEqual([h.document.body])
  })

  it('left-swipe with everything closed and a session clicks the official expand button', () => {
    const h = harness({ coarse: true, hover: true, velocityOff: true })
    paint(h, { leftCollapsed: true, right: 'closed', session: true, expandButton: true })
    swipe(h, { x: 500, y: 400 }, { x: 400, y: 400 }) // right zone start (≥ viewport/4)
    expect(h.clicks.expand).toBe(1)
    expect(h.toggles.count).toBe(0)
  })

  it('right-swipe over a fullscreen right panel clicks the official toggle button', () => {
    const h = harness({ coarse: true, hover: true, velocityOff: true })
    paint(h, { leftCollapsed: true, right: 'fullscreen', toggleButton: true })
    swipe(h, { x: 600, y: 400 }, { x: 700, y: 400 }) // panel open: any origin admits
    expect(h.clicks.toggle).toBe(1)
    expect(h.toggles.count).toBe(0)
  })

  it('the center band stays inert in both directions (content swipes never misfire)', () => {
    const h = harness({ coarse: true, hover: true, velocityOff: true })
    paint(h, { leftCollapsed: true, right: 'closed', session: true, expandButton: true })
    swipe(h, { x: 200, y: 400 }, { x: 300, y: 400 }) // 120 < 200 < 256 (viewport/4)
    swipe(h, { x: 200, y: 400 }, { x: 100, y: 400 })
    expect(h.toggles.count).toBe(0)
    expect(h.clicks).toEqual({ expand: 0, toggle: 0 })
  })

  it('a vertical-dominant drag never fires (scroll intent wins)', () => {
    const h = harness({ coarse: true, hover: true, velocityOff: true })
    paint(h, { leftCollapsed: true, right: 'closed', session: true })
    swipe(h, { x: 50, y: 100 }, { x: 150, y: 500 })
    expect(h.toggles.count).toBe(0)
  })

  it('one drag is one shot: further moves in the same drag do nothing', () => {
    const h = harness({ coarse: true, hover: true, velocityOff: true })
    paint(h, { leftCollapsed: true, right: 'closed', session: true })
    h.document.dispatchEvent(new h.MouseEvent('pointerdown', { clientX: 50, clientY: 400 }))
    h.document.dispatchEvent(new h.MouseEvent('pointermove', { clientX: 150, clientY: 400 }))
    h.document.dispatchEvent(new h.MouseEvent('pointermove', { clientX: 250, clientY: 400 }))
    h.document.dispatchEvent(new h.MouseEvent('pointerup', {}))
    expect(h.toggles.count).toBe(1)
  })

  it('a below-threshold drag does not fire', () => {
    const h = harness({ coarse: true, hover: true, velocityOff: true })
    paint(h, { leftCollapsed: true, right: 'closed', session: true })
    swipe(h, { x: 50, y: 400 }, { x: 80, y: 400 }) // 30px < 40px
    expect(h.toggles.count).toBe(0)
  })
})
