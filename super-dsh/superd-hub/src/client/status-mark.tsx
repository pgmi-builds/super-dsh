import * as React from 'react'
import type { MeshMachineStatus } from './mesh-api.js'

/**
 * The machine row's connection mark: a Wi-Fi-style signal glyph (drawn
 * in-bundle — the official primitives catalog has no antenna/wifi icon, and
 * the pack precedent for missing official artwork is an in-bundle redraw)
 * standing in for the retired status word chip (2026-10-07 user ruling, spec
 * hub-roster-identity §4). The four health states keep their text semantics
 * on the `title` and differ by color; the two failure states add the strike.
 *
 * @module superd-hub/client/status-mark
 */

/** The color of one machine health state (the dot palette the chips used). */
function statusColor(status: MeshMachineStatus): string {
  if (status === 'reachable') return 'var(--dsw-alias-state-success-primary)'
  if (status === 'auth-expired') return 'var(--dsw-alias-state-error-primary)'
  if (status === 'unreachable') return 'var(--dsw-alias-label-caption)'
  return 'var(--dsw-alias-label-caption)'
}

/** The word the icon replaces — tooltip and accessibility text. */
const STATUS_TEXT: Readonly<Record<MeshMachineStatus, string>> = {
  reachable: 'reachable',
  pending: 'pending',
  unreachable: 'unreachable',
  'auth-expired': 'auth expired',
}

/**
 * The signal mark for one machine health state.
 *
 * @param props - `status`: the machine's health; `size`: square edge in pixels.
 * @returns the status mark.
 */
export function StatusMark({ status, size }: { status: MeshMachineStatus; size: number }): React.JSX.Element {
  const failed = status === 'unreachable' || status === 'auth-expired'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      role="img"
      aria-label={STATUS_TEXT[status]}
      style={{ display: 'block', flex: 'none', color: statusColor(status) }}
    >
      <circle cx="8" cy="12.6" r="1.5" fill="currentColor" />
      <path d="M5.1 9.9a4.4 4.4 0 0 1 5.8 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M2.9 7.5a7.6 7.6 0 0 1 10.2 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M0.9 5.2a10.6 10.6 0 0 1 14.2 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity={status === 'pending' ? 0.45 : 1} />
      {failed && <path d="M2 14.2 14 2.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
  )
}
