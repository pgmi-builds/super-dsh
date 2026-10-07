/**
 * Official-primitive toast wrapper (C1 task 4) — the React half over
 * {@link ../toast-core.js}'s pure store. The always-mounted Hub sidebar row
 * carries the {@link SuperdToastHost} owner; the platform `Toast` primitive
 * renders through its own body portal (top-center banner, dark surface in
 * both themes, warn-orange icon seat, green `tone="success"`), so the host's
 * React tree owns the renderer — this module never imports react-dom.
 *
 * @module superd-hub/client/toast
 */
import * as React from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  clearSuperdToast,
  onSuperdToast,
  toastProps,
  type PendingSuperdToast,
} from '../toast-core.js'

export {
  TOAST_DEFAULT_HOLD_MS,
  toastProps,
  showSuperdToast,
  clearSuperdToast,
  onSuperdToast,
  type SuperdToastOptions,
  type PendingSuperdToast,
} from '../toast-core.js'

/**
 * The element for one pending toast: keyed by sequence so a newer toast
 * remounts the primitive and restarts its slide-in cycle (the primitive's
 * own re-show contract).
 */
export function superdToastElement(toast: PendingSuperdToast): React.ReactElement {
  return React.createElement(Toast, {
    key: toast.seq,
    ...toastProps(toast.text, toast.options),
    onDone: () => { clearSuperdToast(toast.seq) },
  })
}

/**
 * The always-mounted owner: subscribes to the store and renders the current
 * toast (nothing while the store is empty). Mounted inside the Hub sidebar
 * row — the primitive's body portal places the banner top-center regardless
 * of where the owner sits.
 */
export function SuperdToastHost(): React.ReactElement | null {
  const [toast, setToast] = React.useState<PendingSuperdToast | undefined>(undefined)
  React.useEffect(() => onSuperdToast(setToast), [])
  return toast === undefined ? null : superdToastElement(toast)
}
