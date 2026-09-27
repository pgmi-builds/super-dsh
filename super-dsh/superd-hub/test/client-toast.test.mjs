// Official-primitive toast core (C1 task 4): the props seam and the module
// store (last-wins, stale-clear no-op). The React wrapper's rendering is
// verified on the pack line (the host owns the renderer).
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TOAST_DEFAULT_HOLD_MS,
  toastProps,
  showSuperdToast,
  clearSuperdToast,
  onSuperdToast,
} from '../dist/toast-core.js'

test('toastProps: defaults hold 6s; tone only when success; explicit hold honored', () => {
  assert.deepEqual(toastProps('hello'), { text: 'hello', holdMs: TOAST_DEFAULT_HOLD_MS })
  assert.deepEqual(toastProps('ok', { tone: 'success' }), { text: 'ok', tone: 'success', holdMs: 6000 })
  assert.deepEqual(toastProps('x', { holdMs: 1200 }), { text: 'x', holdMs: 1200 })
  assert.equal('tone' in toastProps('plain'), false)
})

test('toast store: show notifies, last wins, stale clear is a no-op, fresh clear empties', () => {
  const seen = []
  const off = onSuperdToast((t) => seen.push(t === undefined ? 'none' : `${t.seq}:${t.text}`))
  showSuperdToast('first')
  showSuperdToast('second')
  assert.equal(seen.at(-1), '2:second', 'last-wins: the newest toast replaces the prior')
  clearSuperdToast(1)
  assert.notEqual(seen.at(-1), 'none', 'stale seq clear changes nothing')
  clearSuperdToast(2)
  assert.equal(seen.at(-1), 'none', 'fresh clear empties the store')
  off()
})

test('toast store: a listener throwing never breaks the store', () => {
  const off = onSuperdToast(() => { throw new Error('broken listener') })
  showSuperdToast('resilient')
  const seen = []
  const off2 = onSuperdToast((t) => seen.push(t?.text))
  assert.equal(seen.at(-1), 'resilient')
  off(); off2()
})
