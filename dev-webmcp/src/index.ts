/**
 * dashr-dev-webmcp — the dev/test WebMCP injection bundle.
 *
 * WHAT: one host-side component that pushes page-mcp's single-file IIFE
 * (devtools tools on `document.modelContext`: dev_snapshot / dev_click /
 * dev_fill / dev_console / dev_network / dev_eval / …) into every index.html
 * the line serves, through the webserver's public `webserver/index-inject`
 * event — the same sanctioned seam `dashr-web-trust` rides. No client half,
 * no route, no config.
 *
 * WHY SERVER-SIDE: the tool's premise is "any agent that can reach the page
 * can discover and call the tools". That only holds when the script arrives
 * WITH the page. A tab-local injection (agent evaluates an inject snippet
 * after load) works for exactly one already-open tab and is the multi-step
 * dance this component exists to delete: after composition, opening the
 * line's URL in ANY browser — the operator's Chrome, a coding agent's
 * browser-use, a fresh headless tab — IS the whole get-ready procedure.
 *
 * DEV/TEST ONLY: the component hosts arbitrary in-page debugging tools
 * (`dev_eval` is arbitrary JS in the user's session). The package never
 * ships: it is absent from the super-dsh pack (`files` whitelist + pack.mjs)
 * and only the dev/test bootstrap (`test/start-4999.sh`) installs it into
 * the profile. Off = restate the row `disabled: true` at the profile layer
 * or drop it from `dsh.profile.bundles` (plugin-presence IS the switch; no
 * env knob, per the 2026-09-27 ruling).
 *
 * Known boundary: `document.modelContext` is [SecureContext] — https:// and
 * loopback qualify; plain-HTTP LAN access does not (the Caddy domain and
 * loopback URLs, which the agent rigs use, are unaffected).
 *
 * @module @pgmi-builds/better-dsh-dev-webmcp
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `webserver/index-inject` Events merge and the
// IndexInjection shape from the host webserver's Context declaration.
import type { } from '@deepseek-ai/dsh-host-webserver'
import { pageMcpScriptText } from './script.js'

/** Cordis plugin name. */
export const name = 'dashr-dev-webmcp'

/** No static injects: `webServer` is composed conditionally inside
 * {@link apply}, so the row loads (dormant) in compositions without one. */
export const inject: string[] = []

/**
 * Mount the injection: one `webserver/index-inject` listener pushing the
 * page-mcp script row on every index render. The event re-emits per render
 * and the text is cached after first read, so config reloads and restarts
 * need no listener re-wiring.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['webServer'], () => {
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script', placement: 'head', text: pageMcpScriptText() })
    })
  })
}

export default { name, inject, apply }
