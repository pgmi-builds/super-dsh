/**
 * Browser ownership and opt-in authentication-only server admission.
 * trustAllHosts skips Host/Origin restrictions while retaining native cookie
 * authentication. Existing transports and declared-authority mode are preserved.
 * Mounted on ctx0, whose connection also gates the /hub routes.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installAuthenticationOnlyAdmission } from './connection-trust.js'
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
 * @param trustAllHosts - enable browser ownership for every hostname.
 * @returns script text, or undefined for an empty declared-authority list.
 */
export function buildTrustScript(trustedPageAuthorities: readonly string[] | undefined, trustAllHosts = false): string | undefined {
  if (trustAllHosts) return frame(['if(!window.__DSH_TRANSPORT__)window.__DSH_TRANSPORT__={ownsHost:true};'])
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
  /** Skip address fences on server and browser; native authentication remains. */
  trustAllHosts?: boolean
  /** Hostnames this operator declares their own devices' pages run on. */
  trustedPageAuthorities?: readonly string[]
}

/** The trusted-hosts single source: upstream spelling first, this line's second. */
function trustedHostsEnv(): string | undefined {
  return process.env.DSH_TRUSTED_HOSTS ?? process.env.SUPERD_TRUSTED_HOSTS
}

/** Row config schema (schema-level default derives from the trusted-hosts env). */
export const Config = z.object({
  trustAllHosts: z.boolean().default(false),
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
 * Mount browser ownership and, when opted in, native authentication-only admission.
 * @param ctx - host plugin context.
 * @param config - the row config.
 */
export function apply(ctx: Context, config: TrustConfig | undefined): void {
  if (config?.trustAllHosts) {
    ctx.inject(['connection'], owner => {
      owner.effect(() => installAuthenticationOnlyAdmission(owner.connection),
        'superd-web-trust: authentication-only admission')
    })
  }
  const authorities = config?.trustedPageAuthorities
  ctx.inject(['webServer'], () => {
    ctx.on('webserver/index-inject', (table) => {
      const text = buildTrustScript(authorities, config?.trustAllHosts)
      if (text !== undefined) table.push({ kind: 'script', placement: 'head', text })
    })
  })
}

export default { name, inject, Config, apply }
