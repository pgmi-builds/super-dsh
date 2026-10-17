/** The touch-first mount gate (2026-10-18 user ruling) over a real DOM. */
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
  readonly coarse: FakeMql
  readonly hover: FakeMql
  readonly disposers: Array<() => void>
  readonly added: Array<{ type: string; capture: boolean }>
  readonly removed: Array<{ type: string; capture: boolean }>
  tag(): HTMLElement | null
}

function harness(options: { coarse?: boolean; hover?: boolean; enabled?: boolean; matchMedia?: boolean; maxTouchPoints?: number } = {}): Harness {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  vi.stubGlobal('document', dom.window.document)
  if (options.matchMedia !== false) {
    const coarse = new FakeMql(options.coarse === true)
    const hover = new FakeMql(options.hover === true)
    vi.stubGlobal('matchMedia', (query: string) => (query.includes('coarse') ? coarse : hover))
    var coarseRef = coarse
    var hoverRef = hover
  }
  vi.stubGlobal('navigator', { maxTouchPoints: options.maxTouchPoints ?? 0 })
    ; (globalThis as { __DASHR_MOBILE__?: unknown }).__DASHR_MOBILE__ = options.enabled === false ? undefined : { enabled: true }

  const added: Array<{ type: string; capture: boolean }> = []
  const removed: Array<{ type: string; capture: boolean }> = []
  const doc = dom.window.document
  const track = (record: Array<{ type: string; capture: boolean }>) => (type: string, _fn: () => void, capture?: boolean): void => {
    record.push({ type, capture: capture === true })
  }
  doc.addEventListener = track(added) as typeof doc.addEventListener
  doc.removeEventListener = track(removed) as typeof doc.removeEventListener

  const disposers: Array<() => void> = []
  // The stub ctx: effect factories run at mount (cordis semantics); inject
  // fires immediately with a layout face (the conditional peer present) and
  // returns the {dispose} face the surface's cleanup calls.
  const ctx = {
    effect(fn: () => () => void, _label?: string) { disposers.push(fn()); return () => { } },
    inject(_deps: string[], cb: (c: unknown) => (() => void) | void) {
      const off = cb({ get: () => ({ toggleSidebar() { } }) })
      // cordis treats the callback's return as the injection's cleanup.
      return { dispose() { off?.() } }
    },
  }
  setupMobileLayout(ctx as never)
  return {
    get coarse() { return (typeof coarseRef !== 'undefined' ? coarseRef : undefined) as FakeMql },
    get hover() { return (typeof hoverRef !== 'undefined' ? hoverRef : undefined) as FakeMql },
    disposers,
    added,
    removed,
    tag: () => doc.querySelector('[data-plugin-css="better-dsh/mobile"]'),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { __DASHR_MOBILE__?: unknown }).__DASHR_MOBILE__
  vi.restoreAllMocks()
})

describe('the touch-first mount gate', () => {
  it('a phone-class device mounts the zero-width rule and the swipe listeners', () => {
    const h = harness({ coarse: true, hover: true })
    expect(h.tag()).not.toBeNull()
    expect(h.tag()?.textContent).toContain('data-sidebar-collapsed')
    expect(h.added.map((e) => e.type)).toEqual(expect.arrayContaining(['pointerdown', 'pointermove', 'pointerup', 'pointercancel']))
    expect(h.added.every((e) => e.capture)).toBe(true)
  })

  it('a desktop-class device (fine pointer, hoverable) mounts NOTHING — no zero-width, no mouse swipes', () => {
    const h = harness({ coarse: false, hover: false })
    expect(h.tag()).toBeNull()
    expect(h.added).toEqual([])
  })

  it('a touchscreen laptop (fine primary pointer) stays desktop even with many touch points', () => {
    const h = harness({ coarse: false, hover: false, maxTouchPoints: 10 })
    expect(h.tag()).toBeNull()
    expect(h.added).toEqual([])
  })

  it('a capability flip re-evaluates: desktop → phone mounts, phone → desktop unmounts', () => {
    const h = harness({ coarse: false, hover: false })
    expect(h.tag()).toBeNull()
    // The tablet's pointer hardware changes: both queries flip and fire.
    h.hover!.set(true)
    h.coarse!.set(true)
    expect(h.tag()).not.toBeNull()
    expect(h.added.length).toBe(4)
    // Back to desktop: the surface is gone again (tag removed, listeners removed).
    h.hover!.set(false)
    h.coarse!.set(false)
    expect(h.tag()).toBeNull()
    expect(h.removed.map((e) => e.type)).toEqual(expect.arrayContaining(['pointerdown', 'pointermove', 'pointerup', 'pointercancel']))
  })

  it('a disabled host config stays inert on a phone-class device too', () => {
    const h = harness({ coarse: true, hover: true, enabled: false })
    expect(h.tag()).toBeNull()
    expect(h.added).toEqual([])
  })

  it('no matchMedia at all degrades to the touch-points probe', () => {
    const touch = harness({ matchMedia: false, maxTouchPoints: 5 })
    expect(touch.tag()).not.toBeNull()
    const desktop = harness({ matchMedia: false, maxTouchPoints: 0 })
    expect(desktop.tag()).toBeNull()
  })

  it('unloading the effect removes the surface', () => {
    const h = harness({ coarse: true, hover: true })
    expect(h.tag()).not.toBeNull()
    for (const dispose of h.disposers) dispose()
    expect(h.tag()).toBeNull()
    expect(h.removed.length).toBeGreaterThanOrEqual(4)
  })
})
