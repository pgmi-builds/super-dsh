# Pi Bundled Delivery Implementation Plan

> Execute inline; preserve existing uncommitted work and production isolation.

**Goal:** Deliver a complete Super Dash tarball that installs through dev3's native Plugin Manager without script approvals.

**Architecture:** Extend the current pack orchestrator with a frozen Pi SDK tree. Copy the SDK and its transitive dependencies into a real bundled dependency, retaining upstream files verbatim and the existing Pi adapter. Continue building and bundling local Better Dash first.

**Tech Stack:** Node.js, npm ci/pack, pnpm 12, native DSH Plugin Manager.

**Spec:** `docs/specs/pi-bundled-delivery/spec.md`.

## Constraints

- Pi exact pin 0.84.2; local pair version 0.3.0-h.
- Build-only npm ci: ignore scripts, omit dev and optional; no consumer policy override.
- No upstream edits, production restart/install, npm publish, commit, tag or push.

## Task 1: Frozen physical Pi bundle

Files: `super-dsh/scripts/build-pi.mjs`, `super-dsh/agent-pi/runtime/{package.json,package-lock.json}`, `super-dsh/package.json`, `super-dsh/scripts/pack.mjs`, `super-dsh/test/pi-bundle.test.mjs`, `super-dsh/test/pack-contract.test.mjs`.

- [x] Add failing contract: `assert.ok(manifest.bundledDependencies.includes('@earendil-works/pi-coding-agent'))`.
- [x] Add fixture with SDK's hoisted leaf declaring `postinstall: node hook.js`; embed and pack; extract leaf runtime and hook verbatim, verify SDK resolves its nested leaf.
- [x] Implement `embedPiDependencyTree(line, tree)` and `buildPiBundle(line, repo)`; reject pin mismatch and host dependencies. Use copied frozen manifests with `npm ci --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund`.
- [x] Add Pi to bundledDependencies; call buildPiBundle before npm pack; run targeted tests.

## Task 2: Complete consumer artifact and URL acceptance

- [x] `npm run version:release -- 0.3.0-h`; `npm run pack`; validate local Better bytes and physically bundled Pi tree.
- [x] Copy exact Super tarball into `/home/u1/view-dir`, verify SHA256 and dev3 HTTPS download.
- [x] Keep 4999 running through existing launcher; verify native rows and Pi behavior.
- [x] Use dev3 isolated complete-pack test service and native `pluginManager/inspect` + `pluginManager/installBundle` with HTTPS URL and strictDepBuilds true, no approvedBuilds. Verify Better independent registration, Pi behavior and report.
- [x] Write report and provide exact URL for user's production UI installation; do not publish before explicit release approval.

## Approved release follow-up

User production UI acceptance and `0.3.0-a` release approval are recorded in
`docs/test-reports/2026-10-08-030-a-release.md`. Final artifact verification,
fresh full tests and PC/dev3 consumer behavior passed before submission.
