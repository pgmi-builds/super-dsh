# Independent bundle switches Implementation Plan

> **For agentic workers:** Use executing-plans to implement task-by-task; mandatory independent requesting-code-review before completion. Steps use checkbox syntax.

**Goal:** One Super pack installs independently switchable native Super and Better bundle rows.
**Architecture:** Locally built Better archive and digest ship with Super; a shared Better-owned delivery coordinator calls native installed CLI after readiness. Native profile selection owns switches; no Better YAML is loaded by Super.
**Tech Stack:** TypeScript, Cordis, official DSH CLI/pnpm, npm tarballs, Node test runner.
**Spec:** docs/specs/independent-bundles/spec.md

## Global Constraints
- Preserve standalone Better, separate WebMCP, exact pins, same-source artifacts and test data.
- No upstream edits, production home/ports/Caddy writes, publication or GitHub finalization.
- Existing-package replacement requires native restart; both-disabled sync waits for activation.

### Task 1: Independent native registration and retained selections
**Files:** better-dsh/src/bundle-delivery.ts, better-dsh/tsdown.config.ts, better-dsh/package.json, better-dsh/cordis.patch.yml; test/bundle-delivery.test.mjs; super-dsh/superd-hub/src/bundle-setup.ts, super-dsh/package.json, super-dsh/cordis.patch.yml.
**Interfaces:** `reconcileBundledDelivery(profile, signal?)` discovers descriptors, caches exact artifacts and runs native CLI; `apply(ctx)` registers readiness/change listeners with abortable cleanup.
- [x] Write real CLI fixture test: first install gives two bundles; update retains disabled Better; repeat causes no changes; same-artifact removal stays removed; tampered archive is rejected.
- [x] Run `node --test test/bundle-delivery.test.mjs`; observe absent production export failure.
- [x] Implement discovery/caching/CLI coordination and optional host peers; share implementation through Super subpath.
- [x] Build Better and Super host, rerun real CLI tests and host/client types.

### Task 2: Verified self-contained pack
**Files:** super-dsh/scripts/build-better.mjs, super-dsh/scripts/verify-bundled.mjs, scripts/read-pack-pair.mjs, test/read-pack-pair.test.mjs; README.md, package docs and launcher comments.
**Interfaces:** Existing pack/readPair verify independent Better bytes, archived Better bytes/digest and independent Super patch declaration.
- [x] Update real npm fixture test to require independent layer declaration and exact embedded archive; observe current verifier failure.
- [x] Stage independent Better tarball and descriptor from the same local build; verify digest and archive bytes in full pack.
- [x] Run root delivery guards and fusion regression; build candidate 0.3.0-d using normal paired pack pipeline.

### Task 3: Consumer behavior and independent review
**Files:** docs/test-reports/2026-10-08-independent-bundles.md; docs/dev-test-environment-notes.md if access details change.
- [x] Start PC4999 through current launcher, verify only Super was supplied, native coordinator registers Better and original WebMCP row remains.
- [x] Exercise native switches, cold restart and tool behavior with actual sessions; retain test line access for user.
- [x] Install same pair onto dev3 via existing launcher and repeat independent switch/tool behavior. No production edits.
- [x] Request independent code review, fix material findings and rerun affected delivery checks.
- [x] Record evidence and report URLs, exact artifact versions and restart limits. Leave all changes uncommitted for user acceptance.

### Acceptance-discovered lifecycle repairs
- [x] Guard native HMR transaction scope across hot listener replacement, preserving Agent attribution and native queue/watch/disposal.
- [x] Give foreign world rows scoped roster/mount/target/fetch ownership with awaited teardown and pending-boot cancellation.
- [x] Run regression tests against native Cordis/HMR and repeated delivered-bundle toggles.
- [x] Rebuild both local archives as 0.3.0-e, then f/g after acceptance fixes and repeat real consumers.
