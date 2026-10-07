# dashr-dev-webmcp

Dev/test-only DSH bundle: injects [page-mcp](https://github.com/pgmi-builds/page-mcp)
(WebMCP devtools tools on `document.modelContext`) into every index.html the
line serves, via the webserver's public `webserver/index-inject` event — the
same sanctioned seam `dashr-web-trust` rides.

Server-side injection is the whole point: after this bundle is composed, ANY
browser that opens the line's URL — the operator's Chrome, a coding agent's
browser-use, a fresh headless tab — gets the tools on page load with zero
manual steps. A tab-local injection proves nothing and reaches no one else.

**Never shipped.** This directory belongs to the Better Dash repository and
is excluded from both Better Dash and Super Dash release tarballs. Only dev/test
profiles compose it; the sibling Super Dash launcher
`../superd/super-dsh/test/start-4999.sh` builds it and installs it as a `file:`
dependency. `scripts/sync-host-peers.mjs <install-anchor>` supplies real host
types from that launcher’s installation before compilation. Off switch: restate the row `disabled: true` at the profile layer
or drop it from the bundle list — plugin-presence IS the switch.

Boundaries: `dev_eval` is arbitrary JS in the page's session (hence
dev/test only); `document.modelContext` is `[SecureContext]` — https:// and
loopback qualify, plain-HTTP LAN access does not.
