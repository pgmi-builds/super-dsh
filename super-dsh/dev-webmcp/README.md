# superd-dev-webmcp

Dev/test-only DSH bundle: injects [page-mcp](https://github.com/pgmi-builds/page-mcp)
(WebMCP devtools tools on `document.modelContext`) into every index.html the
line serves, via the webserver's public `webserver/index-inject` event — the
same sanctioned seam `superd-web-trust` rides.

Server-side injection is the whole point: after this bundle is composed, ANY
browser that opens the line's URL — the operator's Chrome, a coding agent's
browser-use, a fresh headless tab — gets the tools on page load with zero
manual steps. A tab-local injection proves nothing and reaches no one else.

**Never shipped.** The package is absent from the `super-dsh` pack (`files`
whitelist and `pack.mjs`); only dev/test profiles compose it
(`test/start-4999.sh` adds it to `dsh.profile.bundles` and installs it
`file:`). Off switch: restate the row `disabled: true` at the profile layer
or drop it from the bundle list — plugin-presence IS the switch.

Boundaries: `dev_eval` is arbitrary JS in the page's session (hence
dev/test only); `document.modelContext` is `[SecureContext]` — https:// and
loopback qualify, plain-HTTP LAN access does not.
