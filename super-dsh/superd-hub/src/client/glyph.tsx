import * as React from 'react'

/**
 * The Hub mark: the Agent Teams icon — four quadrant blocks meeting at the
 * center (one per agent, converging into a team), matching the artwork the
 * native Plugins page shows for the Agent Teams official bundle. Redrawn
 * in-bundle because the client bundle's purity gate forbids value imports
 * outside CLIENT_EXTERNALS. The gradient id is unique per instance so repeated
 * marks in one document keep distinct `url(#…)` references.
 *
 * @module superd-hub/client/glyph
 */

/** Sanitized useId: raw React ids contain colons, kept out of url(#…) refs. */
function useGlyphId(): string {
  return `superd_hub_glyph_${React.useId().replaceAll(':', '')}`
}

/**
 * Render the Hub mark.
 *
 * @param props - `size`: square edge in pixels.
 * @returns the inline SVG mark.
 */
export function HubGlyph({ size }: { size: number }): React.JSX.Element {
  const uid = useGlyphId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="8.63 8.17 18.84 18.84"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ display: 'block', flex: 'none' }}
    >
      <path
        d="M13.3027 17.1077H9.03125V12.8372H13.3027V17.1077ZM17.5742 12.8372C17.574 15.1958 15.6623 17.1075 13.3037 17.1077V8.56567H17.5742V12.8372Z"
        fill={`url(#${uid}a)`}
      />
      <path
        d="M18.5229 12.8372V8.56567H22.7944V12.8372H27.0659V17.1077H22.7944C20.4357 17.1077 18.5232 15.1959 18.5229 12.8372Z"
        fill="#F2AF63"
      />
      <path
        d="M17.5742 26.6072H13.3037V18.0642C15.6625 18.0644 17.5742 19.9769 17.5742 22.3357V26.6072ZM13.3027 22.3357H9.03125V18.0642H13.3027V22.3357Z"
        fill="#7CB7FF"
      />
      <path
        d="M22.7944 26.6072H18.5229V22.3357C18.5229 19.9768 20.4355 18.0642 22.7944 18.0642H27.0659V22.3357H22.7944V26.6072Z"
        fill="#45D9E7"
      />
      <defs>
        <linearGradient id={`${uid}a`} x1="16.1247" y1="6.6613" x2="9.03125" y2="19.2206" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7CB7FF" />
          <stop offset="1" stopColor="#145AF3" />
        </linearGradient>
      </defs>
    </svg>
  )
}
