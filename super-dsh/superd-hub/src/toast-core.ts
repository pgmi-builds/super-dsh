/**
 * Toast feedback core (C1 task 4) — the pure, host-half half of the
 * official-primitive toast: the props seam and the module store. The React
 * wrapper (the always-mounted host component + element factory) lives in
 * `src/client/toast.ts`; this split mirrors switch-core (pure logic where
 * tsc emits and node tests import; the DOM/React face is injected by the
 * client lane).
 *
 * The toast copy rides the platform's `Toast` primitive — top-center
 * banner, dark surface in both themes, warn-orange icon seat, green
 * `tone="success"` — rendered by the HOST's React tree through the
 * primitive's own body portal. Failure notices hold ~6 s: the primitive's
 * docblock prescribes longer holds for failures that name what broke.
 *
 * @module superd-hub/toast-core
 */

/** Options: the toast tone and hold window. */
export interface SuperdToastOptions {
  /** `'success'` renders the primitive's green check glyph. */
  tone?: 'success'
  /** Full-opacity hold before the fade; defaults to {@link TOAST_DEFAULT_HOLD_MS}. */
  holdMs?: number
}

/** Failures that name what broke need a longer read than a one-liner. */
export const TOAST_DEFAULT_HOLD_MS = 6_000

/** One pending toast: a monotonic sequence plus its resolved copy. */
export interface PendingSuperdToast {
  readonly seq: number
  readonly text: string
  readonly options: SuperdToastOptions
}

/** The exact props the official primitive receives (pure — the unit seam). */
export function toastProps(text: string, options: SuperdToastOptions = {}): {
  text: string
  tone?: 'success'
  holdMs: number
} {
  const props: { text: string; tone?: 'success'; holdMs: number } = {
    text,
    holdMs: options.holdMs ?? TOAST_DEFAULT_HOLD_MS,
  }
  if (options.tone !== undefined) props.tone = options.tone
  return props
}

// ---- the module store (last-wins; transient notices never queue) ----------

let seq = 0
let current: PendingSuperdToast | undefined
const listeners = new Set<(toast: PendingSuperdToast | undefined) => void>()

function emit(): void {
  for (const fn of [...listeners]) {
    try { fn(current) } catch { /* a broken listener never breaks the store */ }
  }
}

/** Fire one toast (best-effort: without a mounted owner nothing renders). */
export function showSuperdToast(text: string, options: SuperdToastOptions = {}): void {
  current = { seq: ++seq, text, options }
  emit()
}

/** Clear a shown toast (the fade's `onDone`); stale sequences are no-ops. */
export function clearSuperdToast(done: number): void {
  if (current === undefined || current.seq !== done) return
  current = undefined
  emit()
}

/** Subscribe to the store (the host's effect face); returns unsubscribe. */
export function onSuperdToast(fn: (toast: PendingSuperdToast | undefined) => void): () => void {
  listeners.add(fn)
  // Initial push: an owner mounting after a toast fired still shows it
  // (the host's effect subscribes post-mount).
  try { fn(current) } catch { /* a broken listener never breaks the store */ }
  return () => { listeners.delete(fn) }
}
