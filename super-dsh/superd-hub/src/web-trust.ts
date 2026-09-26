/**
 * Web page trust component — the browser-side twin of the connection row's
 * server-side `trustedHosts` fence (ported from better-dsh `web-trust.ts`,
 * authorities leg only).
 *
 * Why: when the Web UI is served on an operator-declared non-loopback
 * authority (Caddy domain, LAN IP), the server side accepts the Host through
 * `trustedHosts`, but the BROWSER-side connection client computes
 * `ctx.connection.isLoopback` from `location.hostname` — non-loopback → the
 * page degrades into the describe-mirror shape (Host settings persistence
 * reports terminal `memory` unavailability). This component injects one
 * inline `<head>` script through the webserver's public
 * `webserver/index-inject` event (every index render re-emits; row data is
 * read fresh at emit time, so a config reload needs no listener re-wiring):
 * when the page's hostname is one the operator declared their own, it sets
 * `window.__DSH_TRANSPORT__ = { ownsHost: true }` BEFORE any application
 * bundle materializes — the connection client's only whole-repo consumer —
 * restoring the upstream-documented shape for trusted authorities.
 *
 * The object deliberately carries NO fetch/openStream: the connection
 * client's optional chaining then builds the default HTTP/WS transport, so
 * the flag's only effect is the loopback verdict. An existing
 * `__DSH_TRANSPORT__` (a worker shell that owns a real transport) is never
 * overwritten.
 *
 * On/off (two independent levels, both standard):
 *   - row level: a profile layer with `- id: superd-web-trust / disabled: true`
 *     removes the component entirely;
 *   - config level: `trustedPageAuthorities: []` keeps the row mounted but
 *     injects nothing (fully inert).
 *
 * Composed on ctx0 only (since path-separation T-D): the `super-dsh/web-trust`
 * row in the composite bundle's insert list. The per-world row retired with
 * the world pages themselves (T-D disabled the world webui rows — no world
 * page renders, so no world-local injection exists); `/hub` is the sole
 * foreign entry and it serves ctx0's index, which this ctx0 row covers.
 *
 * @module @pgmi-builds/superd-hub/web-trust
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the `webserver/index-inject` Events merge and the
// IndexInjection shape from the host webserver's Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'

/**
 * The schema-level default for `trustedPageAuthorities` (better-dsh v0.2.2a
 * shape): derive from the trusted-hosts environment — the SAME single source
 * the server-side fence legs read (`SUPERD_TRUSTED_HOSTS` on this line, upstream
 * spelling `DSH_TRUSTED_HOSTS` honored first) — so ONE declaration (e.g. one
 * `Environment=` line in the service unit) drives the server fence and the
 * page leg with zero per-instance plugin config. Bare hostnames only:
 * `location.hostname` carries no port, and {@link assertBareHostname} would
 * reject a portful entry at boot, so portful/schematic entries are dropped
 * here instead of thrown. Declared in the Config SCHEMA rather than the
 * bundle patch row because a profile/home layer row with the same id
 * whole-row-overrides the row's config object, while schema defaults fill
 * per-key at plugin load and survive every overlay layer. An explicit
 * configured value always wins.
 *
 * @param env - the raw trusted-hosts value (whitespace/comma separated).
 * @returns the bare-hostname authorities to trust by default.
 */
export function deriveDefaultPageAuthorities(env: string | undefined): string[] {
  return (env ?? '').split(/[\s,]+/).filter(h => h.length > 0 && !/[:/@?#]/.test(h))
}

/** The `webserver/index-inject` row shape this component pushes. */
export interface BootScriptRow {
  kind: 'script'
  placement: 'head'
  text: string
}

/** Assert one configured authority is a bare hostname (no port/path/scheme). */
function assertBareHostname(entry: string): void {
  if (entry.length === 0 || /[:/@?#]/.test(entry)) {
    throw new Error(
      `superd-web-trust: trustedPageAuthorities entry ${JSON.stringify(entry)} is not a bare hostname `
      + '(location.hostname carries no port; an entry with port/path would never match)',
    )
  }
}

/** The IIFE framing (a throwing leg stays invisible on the page). */
function frame(body: string[]): string {
  return ['(function(){try{', ...body, '}catch(e){}})();'].join('')
}

/**
 * Build the authorities-leg script. Pure: same config in, same script out —
 * the unit tests pin the shape (authority match, no-overwrite guard,
 * inert-when-empty, hostile-string escaping).
 *
 * @param trustedPageAuthorities - the operator-declared hostnames.
 * @returns the script text, or `undefined` when the list is empty (inject
 *   nothing — the component is fully inert).
 */
export function buildTrustScript(trustedPageAuthorities: readonly string[] | undefined): string | undefined {
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

/** Row config schema. */
export interface TrustConfig {
  /** Hostnames this operator declares their own devices' pages run on. */
  trustedPageAuthorities?: readonly string[]
}

/** The trusted-hosts single source: upstream spelling first, this line's second. */
function trustedHostsEnv(): string | undefined {
  return process.env.DSH_TRUSTED_HOSTS ?? process.env.SUPERD_TRUSTED_HOSTS
}

/** Row config schema (schema-level default derives from the trusted-hosts env). */
export const Config = z.object({
  trustedPageAuthorities: z.array(String).default(deriveDefaultPageAuthorities(trustedHostsEnv())),
})

/** Cordis plugin name. */
export const name = 'superd-web-trust'

/**
 * No static injects: `webServer` is composed conditionally inside
 * {@link apply}, so the row loads (dormant) in compositions without one.
 */
export const inject: string[] = []

/**
 * Mount the authorities-leg injection: one `webserver/index-inject` listener
 * pushing the rendered row.
 * @param ctx - host plugin context.
 * @param config - the row config.
 */
export function apply(ctx: Context, config: TrustConfig | undefined): void {
  const authorities = config?.trustedPageAuthorities
  ctx.inject(['webServer'], () => {
    ctx.on('webserver/index-inject', (table) => {
      const text = buildTrustScript(authorities)
      if (text !== undefined) table.push({ kind: 'script', placement: 'head', text })
    })
  })
}

export default { name, inject, Config, apply }
