/**
 * Pill geometry for the Hub sidebar row's agent selector (2026-10-18): the
 * pure math behind anchoring the selector to its row. Split out of
 * HubPanelIcon so node tests can pin it from `dist/client/` — the
 * mesh-groups precedent (pure logic beside the components, no DOM, no
 * React, no @deepseek-ai imports).
 *
 * Why absolute-in-flow and not `position: fixed` + re-measure: the native
 * sidebar scrolls (many workspaces; iOS Safari drags the whole page), and a
 * fixed pill tracks the VIEWPORT, not the content — without a scroll
 * listener it stayed at its mount-time viewport spot while the row moved
 * (the reported mis-alignment). Anchoring the pill to its positioned
 * ancestor (the `Menu` wrapper span — upstream `.root` is
 * `position: relative`, in-flow inside the row) makes the composite ride ANY
 * scroll natively: zero JS per scrolled frame, exact by construction, and
 * the open menu keeps following through its own capture-phase scroll
 * placement (`getAnchorRect` reads the pill live).
 *
 * @module superd-hub/client/pill-geometry
 */

/**
 * The measured boxes one anchoring reads. All viewport px, straight from
 * `getBoundingClientRect()` — same-frame reads, so any scroll moves both
 * boxes equally and the derived offsets are scroll-invariant by
 * construction.
 */
export interface PillMeasureInput {
  /** The row button's box (the `.panelRow` the glyph sits in). */
  row: { readonly top: number; readonly bottom: number; readonly right: number }
  /** The pill's positioned ancestor box (the `Menu` wrapper span). */
  wrap: { readonly left: number; readonly top: number }
}

/** Wrapper-relative offsets the pill is placed from. */
export interface PillBox {
  /** Wrapper left edge → row right edge (px; both ride the same flow). */
  readonly dx: number
  /** Wrapper top edge → row vertical center (px). */
  readonly cy: number
}

/**
 * Derive the scroll-invariant offsets from one same-frame measurement.
 * Measuring the DELTAS (not absolute coordinates) is the whole point: they
 * survive any scroll of any ancestor, so nothing needs to re-run while the
 * sidebar scrolls.
 */
export function measurePillBox(input: PillMeasureInput): PillBox {
  return {
    dx: input.row.right - input.wrap.left,
    cy: (input.row.top + input.row.bottom) / 2 - input.wrap.top,
  }
}

/** The row's own horizontal padding (native `.panelRow`): the selector's inset. */
export const PILL_ROW_INSET = 8

/** Structural CSS style the render side spreads into the pill span. */
export interface PillStyle {
  readonly position: 'absolute'
  readonly left: number
  readonly top: number
  readonly transform: string
}

/**
 * The pill's placement, wrapper-relative: its right edge sits `inset` px
 * inside the row's right edge, vertically centered on the row
 * (`translateY(-50%)`). `selectorWidth` is the render-time pill width (the
 * mark is present only while an agent is active), so it stays a render
 * concern; the measured box is not.
 */
export function pillStyle(box: PillBox, selectorWidth: number, inset: number = PILL_ROW_INSET): PillStyle {
  return {
    position: 'absolute',
    left: box.dx - inset - selectorWidth,
    top: box.cy,
    transform: 'translateY(-50%)',
  }
}
