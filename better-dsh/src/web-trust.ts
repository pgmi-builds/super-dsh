/**
 * Web trust + mobile page-config boot scripts (host half of the P2/P3 web
 * features).
 *
 * Two INDEPENDENT Plugins-page component rows deliver page config through
 * the webserver's public `webserver/index-inject` event (every index render
 * re-emits; row data is read fresh at emit time, so a config reload needs no
 * listener re-wiring). The event is a LIST: each row pushes its own inline
 * `<head>` script, so toggling one row never touches the other (spec
 * docs/specs/plugins-page-components/spec.md).
 *
 * `dashr-web-trust` — trusted page authorities (the browser-side twin of the
 * connection row's server-side `trustedHosts`): when the page's hostname is
 * one the operator declared their own, the script sets
 * `window.__DSH_TRANSPORT__ = { ownsHost: true }` BEFORE any application
 * bundle materializes. The connection client half computes
 * `ctx.connection.isLoopback` from that flag (its only whole-repo
 * consumer), which restores the upstream-documented shape for trusted
 * authorities — the page works AND keeps Host settings persistence —
 * instead of the describe mirror's terminal `memory` unavailability.
 * The object deliberately carries NO fetch/openStream: the connection
 * client's optional chaining then builds the default HTTP/WS transport,
 * so the flag's only effect is the loopback verdict. An existing
 * `__DSH_TRANSPORT__` (a worker shell that owns a real transport) is
 * never overwritten.
 *
 * `trustAllHosts: true` is the authentication-only deployment mode: a
 * reversible Connection admission delegate removes Host/Origin fencing while
 * keeping the native cookie verifier, and the page owns the Host regardless
 * of its hostname. The default remains the declared-authorities mode.
 *
 * `dashr-mobile` — swipe-gesture page config + iOS focus auto-zoom
 * suppression (2026-11-08 revival of the gesture leg onto upstream rc.1's
 * native mobile drawers, which ship the UI adaptation but no touch
 * gestures): a `window.__DASHR_MOBILE__` global for the client half, plus
 * a self-contained static zoomGuard section.
 *
 * Each leg injects nothing at all when its own config disables it; the
 * mobile leg ships default-ON (design D1), so a bare config still carries
 * the zoomGuard section. The scripts are strict IIFEs over JSON-embedded
 * literals — no config string is ever spliced into code unescaped.
 *
 * @module dashr/web-trust
 */

import { Context } from '@deepseek-ai/cordis'
import z from '#schemastery'
// Type-only: pulls the `webserver/index-inject` Events merge and the
// IndexInjection shape from the host webserver's Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { buildZoomGuardSection } from './mobile/zoom-guard.ts'
import { installAuthenticationOnlyAdmission } from './connection-trust.ts'
/**
 * The schema-level default for `trustedPageAuthorities` (v0.2.2a): derive
 * from the DSH_TRUSTED_HOSTS environment — the SAME single source the
 * fence leg's patch expression reads first — so ONE declaration (e.g. one
 * `Environment=` line in the service unit) drives both legs with zero
 * per-instance plugin config. Bare hostnames only: `location.hostname`
 * carries no port, and `assertBareHostname` would reject a portful entry at
 * boot, so portful/schematic entries are dropped here instead of thrown.
 * Declared in the Config SCHEMA rather than the bundle patch row because a
 * profile/home layer row with the same id whole-row-overrides the row's
 * config object, while schema defaults fill per-key at plugin load and
 * survive every overlay layer. An explicit configured value always wins.
 *
 * @param env - the raw DSH_TRUSTED_HOSTS value (whitespace-separated).
 * @returns the bare-hostname authorities to trust by default.
 */
export function deriveDefaultPageAuthorities(env: string | undefined): string[] {
  return (env ?? '').split(/\s+/).filter(h => h.length > 0 && !/[:/@?#]/.test(h))
}

/** Mobile page-config knobs (the `dashr-mobile` row's config shape).
 *
 * 2026-11-08 revival: the gesture knobs are back. Upstream rc.1's native
 * mobile adaptation is UI-only (no touch gestures), so the field-tested
 * swipe feature rides again — this row config resolves here and ships to
 * the client half through the `window.__DASHR_MOBILE__` page global. The
 * zero-rail CSS leg stays retired (rc.1's own drawer owns layout). */
export interface MobileConfig {
  enabled?: boolean
  /** The swipe-gesture leg's escape hatch: `'off'` plants no page global. */
  gesture?: 'on' | 'off'
  swipeDistancePx?: number
  dominanceRatio?: number
  leftEdgeBandPx?: number
  rightZoneRatio?: number
  swipeVelocityPxPerMs?: number
  /**
   * iOS focus auto-zoom suppression mode (change
   * `2026-09-03-ios-focus-zoom-suppression`): `'meta'` (default) rewrites
   * the viewport meta on iOS-class narrow viewports; `'off'` is the escape
   * hatch. `'font'` (16px floor, solution A) is a RESERVED value slot,
   * deliberately not in the schema enum — unimplemented values fail loud
   * at config load rather than no-op silently.
   */
  zoomGuard?: 'meta' | 'off'
}

/** The `webserver/index-inject` row shape these features push. */
export interface BootScriptRow {
  kind: 'script'
  placement: 'head'
  text: string
}

/** Assert one configured authority is a bare hostname (no port/path/scheme). */
function assertBareHostname(entry: string): void {
  if (entry.length === 0 || /[:/@?#]/.test(entry)) {
    throw new Error(
      `dashr-web-trust: trustedPageAuthorities entry ${JSON.stringify(entry)} is not a bare hostname `
      + '(location.hostname carries no port; an entry with port/path would never match)',
    )
  }
}

/** The IIFE framing shared by both legs (a throwing leg stays invisible). */
function frame(body: string[]): string {
  return ['(function(){try{', ...body, '}catch(e){}})();'].join('')
}

/**
 * Build the authorities-leg script. Pure: same config in, same script out —
 * the unit tests pin the shape (authority match, no-overwrite guard,
 * inert-when-empty).
 *
 * @param trustedPageAuthorities - the operator-declared hostnames.
 * @param trustAllHosts - delegate admission to native authentication without an address fence.
 * @returns the script text, or `undefined` when declared-authorities mode
 *   has an empty list (no page injection).
 */
export function buildTrustScript(trustedPageAuthorities: readonly string[] | undefined, trustAllHosts = false): string | undefined {
  if (trustAllHosts) {
    return frame(['if(!window.__DSH_TRANSPORT__)window.__DSH_TRANSPORT__={ownsHost:true};'])
  }
  const authorities = [...(trustedPageAuthorities ?? [])]
  if (authorities.length === 0) return undefined
  for (const entry of authorities) assertBareHostname(entry)
  return frame([
    'if(!window.__DSH_TRANSPORT__){',
    `var h=location.hostname,a=${JSON.stringify(authorities)};`,
    'for(var i=0;i<a.length;i++)if(a[i]===h){window.__DSH_TRANSPORT__={ownsHost:true};break}',
    '}',
  ])
}

/**
 * Build the mobile-leg script. Pure: same config in, same script out — the
 * unit tests pin the shape (page global + zoomGuard section by default,
 * per-leg escape hatches, injects nothing when both are off).
 *
 * @param mobile - the resolved mobile config.
 * @returns the script text, or `undefined` when the row is explicitly
 *   disabled or BOTH legs are off (inject nothing).
 */
export function buildMobileScript(mobile: MobileConfig | undefined): string | undefined {
  // Ship default ON (design D1): absent config or absent flag both mean
  // enabled; only an explicit `enabled: false` opts the page out.
  const mobileEnabled = mobile?.enabled !== false
  if (!mobileEnabled) return undefined
  // Two independent legs (2026-11-08 revival): the gesture config global
  // for the client half, and the self-contained zoomGuard section. Each leg
  // rides unless it is explicitly turned off — the same default-on posture
  // as the row itself; both off injects nothing at all.
  const gestureOn = mobile?.gesture !== 'off'
  const zoomOn = mobile?.zoomGuard !== 'off'
  if (!gestureOn && !zoomOn) return undefined
  const body: string[] = []
  if (gestureOn) {
    const payload = {
      enabled: true,
      ...(mobile?.swipeDistancePx !== undefined ? { swipeDistancePx: mobile.swipeDistancePx } : {}),
      ...(mobile?.dominanceRatio !== undefined ? { dominanceRatio: mobile.dominanceRatio } : {}),
      ...(mobile?.leftEdgeBandPx !== undefined ? { leftEdgeBandPx: mobile.leftEdgeBandPx } : {}),
      ...(mobile?.rightZoneRatio !== undefined ? { rightZoneRatio: mobile.rightZoneRatio } : {}),
      ...(mobile?.swipeVelocityPxPerMs !== undefined ? { swipeVelocityPxPerMs: mobile.swipeVelocityPxPerMs } : {}),
    }
    body.push(`window.__DASHR_MOBILE__=${JSON.stringify(payload)};`)
  }
  if (zoomOn) body.push(buildZoomGuardSection())
  return frame(body)
}

/**
 * `dashr-web-trust` row config schema. Only the authorities leg lives here —
 * the mobile knobs are the `dashr-mobile` row's own config.
 */
export interface TrustConfig {
  /** Accept every serving address after native cookie authentication, including in the browser UI. */
  trustAllHosts?: boolean
  /** Hostnames this operator declares their own devices' pages run on. */
  trustedPageAuthorities?: readonly string[]
}

/** Row config schema (schema-level default derives from `DSH_TRUSTED_HOSTS`). */
export const Config = z.object({
  trustAllHosts: z.boolean().default(false),
  trustedPageAuthorities: z.array(String).default(deriveDefaultPageAuthorities(process.env.DSH_TRUSTED_HOSTS)),
})

/** Cordis plugin name. */
export const name = 'dashr-web-trust'

/**
 * No static injects: `webServer` is composed conditionally inside
 * {@link apply}, so the row loads (dormant) in compositions without one.
 */
export const inject: string[] = []

/**
 * Mount page capabilities and, when enabled, an authentication-only admission
 * delegate. Both registrations are owned by this plugin fiber.
 * @param ctx - host plugin context.
 * @param config - the row config.
 */
export function apply(ctx: Context, config: TrustConfig | undefined): void {
  const authorities = config?.trustedPageAuthorities
  if (config?.trustAllHosts) {
    ctx.inject(['connection'], (owner) => {
      owner.effect(() => installAuthenticationOnlyAdmission(owner.connection), 'dashr-web-trust: authentication-only admission')
    })
  }
  ctx.inject(['webServer'], () => {
    ctx.on('webserver/index-inject', (table) => {
      const text = buildTrustScript(authorities, config?.trustAllHosts)
      // Ownership must precede application scripts even when modules mount asynchronously.
      if (text !== undefined) table.unshift({ kind: 'script', placement: 'head', text })
    })
  })
}

export default { name, inject, Config, apply }
