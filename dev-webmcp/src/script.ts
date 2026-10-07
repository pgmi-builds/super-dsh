/**
 * The injected script text: page-mcp's single-file IIFE, read from this
 * package's own exact-pinned `page-mcp` dependency at first use and cached.
 *
 * Why inline (`{kind:'script', text}`) and not `{kind:'script-src', src}`:
 * inline needs no static route, no auth surface and no network — the row is
 * rendered straight into the served index.html on every index render, for
 * every browser, on every access path (loopback, LAN, Caddy domain).
 *
 * The renderer (`webserver/index-inject` `script` rows) does NOT escape
 * `text`, so this module refuses any text that would close the element early
 * (`</script` inside code can only appear within string/regex literals, and
 * `<\/script` is byte-equivalent there — escape instead of shipping broken
 * HTML). page-mcp@0.0.1 contains zero such sequences; the assertion keeps a
 * future version from silently breaking the served page.
 *
 * @module dist/script.js
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

/** A script text that would terminate its own `<script>` element early. */
const ELEMENT_CLOSING = '</script'

let cached: string | undefined

/**
 * The page-mcp dist text, ready for a `script` index-injection row.
 * Reads `page-mcp/dist/page-mcp.js` from THIS package's dependency tree
 * (exact-pinned in package.json) on first call; cached afterwards.
 * @throws when the text would break out of its `<script>` element.
 */
export function pageMcpScriptText(): string {
  cached ??= readScript()
  return cached
}

function readScript(): string {
  const file = createRequire(import.meta.url).resolve('page-mcp/dist/page-mcp.js')
  const text = readFileSync(file, 'utf8')
  assertInjectableScript(text)
  return text
}

/**
 * Assert one text is safe to splice into an inline `<script>` row.
 * Pure; exported for the unit test, which pins it against the REAL
 * dependency's dist (the test imports this module from `dist/` per the
 * build-then-test convention).
 * @param text - candidate script text.
 * @throws when the text contains an element-closing sequence.
 */
export function assertInjectableScript(text: string): void {
  if (text.includes(ELEMENT_CLOSING)) {
    throw new Error(
      `dashr-dev-webmcp: page-mcp script contains ${JSON.stringify(ELEMENT_CLOSING)} `
      + '— it would close its own <script> element early when inlined into the index; '
      + 'escape it as <\\/script before injecting',
    )
  }
}
