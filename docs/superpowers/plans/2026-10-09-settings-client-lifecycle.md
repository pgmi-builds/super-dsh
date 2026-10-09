# Settings client lifecycle and public URL plan

Spec: `docs/specs/settings-client-lifecycle/spec.md`.

- [x] Inspect actual PC/dev3 component inventory, served namespaces and visible UI; trace package client loading and native install provenance.
- [x] Inspect official settings lifecycle through real TypeScript LSP/AST and compare upstream consumer examples.
- [x] Add PC/dev3 production public-url flags with backups and restart; retain trust flags and transparent Caddy.
- [x] Reproduce lifecycle failures with real native ConfigForms and the package contribution, then apply its official whileServed lifecycle to failover and compaction.
- [x] Run targeted lifecycle and Host behavior tests, both typecheck lanes, and build the synchronized next-letter tarball pair.
- [x] Launch4999 first; verify domain public-url, cold disabled settings visibility, live component on/off/on, valid enabled settings persistence and unchanged credential seed.
- [x] Deliver the same pair and launcher to dev3's isolated test line, verify the same lifecycle and preserve its existing review path. Keep production packages unchanged until acceptance.
- [x] Write the evidence report and explain native bundle/package/source distinctions; leave4999 running for user review. No publish/commit/push.

Evidence: `docs/test-reports/2026-10-09-settings-client-lifecycle.md`. Production plugin package replacement and publication are outside the applied changes;4999 and the isolated dev3 line remain available for acceptance.
