# Host component and settings UI lifecycle

2026-10-09: PC and dev3 Plugin Manager reports `dashr-failover` disabled with no live Fiber or served settings namespace, while General still displays its editable selectors. Better's package-level client is mounted by the active root component, so each independently toggleable Host component must own its settings contribution through the official Host namespace mirror.

- Register failover and compaction General rows with native `configForms.whileServed`, scoped through `ctx.effect`.
- A missing Host owner shows no settings row. Enabling, disabling and reenabling the owner adds, removes and restores only its contribution without reloading the package client.
- Preserve the independent server component controls and native configuration writes. Do not auto-enable a component because its UI was visible.
- Delivery follows the subsequent 2026-10-09 registry-companion decision: ordinary exact Better dependency, no embedded Better payload, native offline registration and truthful registry Code source. A native `file:` source remains valid for deliberately local consumers; do not fabricate provenance.
- Add public-url to PC/dev3 production CLI and the port4999 domain rig. Additional test canonical URLs can be explicitly supplied with `SUPERD_TEST_PUBLIC_URL`; do not infer a serving URL from arbitrary extra trusted authorities.
- Verify the fix first through the complete versioned4999 tarball line and then dev3's isolated delivered test line. Production runtime packages remain on the user-installed release until the new iteration is accepted; only the requested production CLI flags/restarts are applied now.
