// Pill geometry (2026-10-18): the pure math anchoring the Hub sidebar row's
// agent selector to its row — wrapper-relative `position: absolute` instead
// of the `position: fixed` + re-measure predecessor that mis-aligned on
// iOS Safari (the sidebar scrolls; the fixed pill tracked the viewport).
//
// The property under test: the derived offsets are INVARIANT under any
// translation of both boxes (that is what makes the pill ride any scroll
// natively — nothing re-runs while the sidebar scrolls). The render style is
// pinned so the pill's right edge sits one row-inset inside the row's right
// edge, vertically centered.
import test from 'node:test'
import assert from 'node:assert/strict'

const { PILL_ROW_INSET, measurePillBox, pillStyle } = await import('../dist/client/pill-geometry.js')

const ROW = { top: 640, bottom: 676, right: 264 }
const WRAP = { left: 36, top: 650 }

test('measurePillBox derives wrapper-relative offsets from one same-frame read', () => {
  const box = measurePillBox({ row: ROW, wrap: WRAP })
  assert.equal(box.dx, ROW.right - WRAP.left, 'dx: row right edge minus wrapper left edge')
  assert.equal(box.cy, (ROW.top + ROW.bottom) / 2 - WRAP.top, 'cy: row vertical center minus wrapper top')
})

test('the offsets are scroll-invariant: translating BOTH boxes changes nothing', () => {
  const before = measurePillBox({ row: ROW, wrap: WRAP })
  // The sidebar scrolled by -180px (content moved down): both boxes ride it.
  const scrolled = measurePillBox({
    row: { top: ROW.top - 180, bottom: ROW.bottom - 180, right: ROW.right },
    wrap: { left: WRAP.left, top: WRAP.top - 180 },
  })
  assert.deepEqual(scrolled, before, 'a scroll of any ancestor cancels out of the deltas')
})

test('pillStyle: right edge one row-inset inside the row, vertically centered', () => {
  const box = measurePillBox({ row: ROW, wrap: WRAP })
  const width = 50
  const style = pillStyle(box, width)
  assert.equal(style.position, 'absolute')
  // left = dx - inset - width  →  pill right edge = row.right - inset.
  assert.equal(style.left, box.dx - PILL_ROW_INSET - width)
  assert.equal(style.left + width, box.dx - PILL_ROW_INSET)
  assert.equal(style.top, box.cy)
  assert.equal(style.transform, 'translateY(-50%)')
})

test('pillStyle: the default inset is the native panelRow horizontal padding (8px)', () => {
  assert.equal(PILL_ROW_INSET, 8)
  const style = pillStyle({ dx: 100, cy: 12 }, 30)
  assert.equal(style.left, 100 - 8 - 30)
})
