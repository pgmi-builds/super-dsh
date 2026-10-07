import * as React from 'react'
import { RUNTIME_ICON_ASSETS } from './icon-assets.gen.js'
import { runtimeIdOf } from '../roster.js'

/**
 * Per-runtime marks for the Agent Runtimes roster, keyed by the unified
 * runtime identifier (spec `docs/specs/hub-roster-identity/spec.md`): the
 * adapter package name (`agent-omp`, `agent-omp-sdk`, …) on every LOCAL and
 * FEDERATED row alike, `native` for DSH. The marks come from the icon asset
 * pack (`assets/icons/` → `icon-assets.gen.ts`); a runtime whose id maps to
 * no asset — a remote peer running an adapter this build has never seen —
 * falls back to the subagent artwork (two stacked rounded squares — the
 * native Plugins page's stand-in for subagents) as the default foreign-agent
 * mark.
 *
 * @module superd-hub/client/runtime-icons
 */

/** Sanitized useId: raw React ids contain colons, kept out of url(#…) refs. */
function useGlyphId(): string {
  return `superd_subagent_${React.useId().replaceAll(':', '')}`
}

/**
 * The subagent mark: two stacked rounded squares (the Plugins page's
 * subagent artwork, redrawn in-bundle) — the default foreign-agent icon for
 * a runtimeId with no pack asset.
 *
 * @param props - `size`: square edge in pixels.
 * @returns the subagent mark.
 */
export function SubagentGlyph({ size }: { size: number }): React.JSX.Element {
  const uid = useGlyphId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="8.47 8.67 19.16 19.16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ display: 'block', flex: 'none' }}
    >
      <rect x="14.99" y="15.19" width="12.24" height="12.24" rx="2.4" fill={`url(#${uid}a)`} fillOpacity="0.85" />
      <rect x="8.87" y="9.07" width="12.24" height="12.24" rx="2.4" fill={`url(#${uid}b)`} fillOpacity="0.85" />
      <defs>
        <linearGradient id={`${uid}a`} x1="21.11" y1="15.19" x2="21.11" y2="27.42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#45E7A4" />
          <stop offset="1" stopColor="#05909D" />
        </linearGradient>
        <linearGradient id={`${uid}b`} x1="14.99" y1="9.07" x2="14.99" y2="21.31" gradientUnits="userSpaceOnUse">
          <stop stopColor="#69B9FF" />
          <stop offset="1" stopColor="#324DE2" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/** One embedded square image mark at the requested edge. */
function imgMark(uri: string, size: number): React.JSX.Element {
  return (
    <img
      src={uri}
      alt=""
      width={size}
      height={size}
      style={{ display: 'block', flex: 'none', objectFit: 'contain' }}
    />
  )
}

/**
 * Render one runtime's mark: the asset the runtime identifier maps to in the
 * icon pack, the subagent mark when nothing maps (unknown remote adapter).
 * `runtimeId` is the wire field; `agentKey` is the compatibility leg for
 * callers that only hold a roster key (baked globals, the selector's active
 * key) — both resolve through `runtimeIdOf`, so an SDK half and its main
 * line carry the same mark exactly as the manifest says.
 *
 * @param props - `runtimeId`: the roster row's unified id; `agentKey`: the
 *   roster key when no id is at hand; `size`: square edge in pixels.
 * @returns the runtime mark.
 */
export function RuntimeMark({ runtimeId, agentKey, size }: { runtimeId?: string; agentKey?: string; size: number }): React.JSX.Element {
  const resolved = runtimeId ?? (agentKey !== undefined ? runtimeIdOf(agentKey) : undefined)
  const asset = resolved === undefined ? undefined : RUNTIME_ICON_ASSETS[resolved]
  if (asset === undefined) return <SubagentGlyph size={size} />
  // The DSH fish is the one non-square mark: height keeps its intrinsic ratio.
  const height = asset.ratio === 1 ? size : Math.round((size / asset.ratio) * 100) / 100
  if (asset.tile === undefined) {
    return (
      <img
        src={asset.uri}
        alt=""
        width={size}
        height={height}
        style={{ display: 'block', flex: 'none', objectFit: 'contain' }}
      />
    )
  }
  // Marks whose own ink would vanish on a dark frame carry an opaque tile:
  // Codex's black glyph on white, Pi's white glyph on black.
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: Math.max(3, Math.round(size * 0.2)),
        background: asset.tile,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {imgMark(asset.uri, Math.round(size * 0.74))}
    </span>
  )
}
