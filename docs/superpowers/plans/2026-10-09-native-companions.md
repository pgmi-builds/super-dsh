# Native Companions Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development and dispatching-parallel-agents for the independent implementation scopes; perform a whole-change review before acceptance. No commits until user acceptance, per repository rules.

**Goal:** Install Better through native DSH management, expose explicit reinstall in Hub Settings, and keep the native listener stable during plugin changes.

**Architecture:** Super owns a companion service wrapping the native Plugin Manager, with profile-specific user intent under its existing persistence namespace. The browser Settings component calls that service in ctx0. Better's client contributes an onboarding skip component using the official slot instead of a replacement server.

**Tech Stack:** TypeScript, Cordis services/events, DSH Plugin Manager, React slots, Node test runner, paired npm tarballs, existing 4999 launcher and test registry.

**Spec:** `docs/specs/native-companions/spec.md`

## Global Constraints

- No upstream source edits or production package/service/Caddy mutations.
- Both local tarballs begin at `0.3.0-f` and advance synchronized letters per iteration; no publication, commit, tag or push.
- Native manager chooses registry/package operations; exact installed Super version first, latest then bare `better-dsh` after preceding failures.
- Existing Better disable/removal choices survive restart and Super upgrades.
- Companion data lives under `$DSH_HOME/superd/companions/`.
- Real browser and tarball acceptance on 4999, plus DEV3 pairing; preserve test data and leave the rig running.

## Task 1: Companion host service

**Files:** `super-dsh/superd-hub/src/bundle-setup.ts`, companion service/contract files beside it, obsolete `scripts/register-companion.mjs`, `super-dsh/cordis.patch.yml`, related tests.

**Interfaces:** Provide native ctx0 namespace `superdCompanions`, unary methods `getBetterDash(): Promise<BetterDashStatus>` and `installBetterDash(): Promise<BetterDashStatus>`. Shared browser-safe status: `{ installed: boolean; version?: string; enabled?: boolean; installing: boolean; error?: string; requestedVersion: string }`. Settings calls `/api/superdCompanions/getBetterDash` and `/api/superdCompanions/installBetterDash` using native unary envelopes.

- [x] Navigate native `installBundle`, management events and HMR boundaries with actual LSP/AST.
- [x] Add failing behavior tests: exact succeeds without latest; exact failure calls latest; latest failure calls bare name; both fail remain retryable; concurrent requests use one install; disabled existing Better remains disabled; migrated receipt plus missing Better does not install; removal remains honored after restart/version change.
- [x] Implement using `manager.installBundle('better-dsh@' + installedSuperVersion)` then `manager.installBundle('better-dsh@latest')`, then `manager.installBundle('better-dsh')` after each preceding native failure. Check the final native outcome and installed state; retain useful errors.
- [x] Implement readiness/event scheduling without nested HMR, native change observation, intent persistence and explicit retry. Remove the child pnpm/offline-promotion mechanism.
- [x] Run meaningful host tests and typecheck; report commands and affected files. Do not commit.

## Task 2: Better client welcome policy

**Files:** Better welcome/webserver sources and exports, `cordis.patch.yml`, existing client plugin entry, related tests.

- [x] Use LSP/AST to verify the official `welcome-notice` entry, priority winner and owner `complete()` behavior.
- [x] Add a failing component/lifecycle test showing each onboarding mount invokes `complete`, unrelated entries survive, and disposal restores native fallback.
- [x] Register `settings.onboarding`, id `welcome-notice`, priority `-1`, order `-100`; invoke `complete()` once per mount through React effect and render null. Gate lifetime on the actual corresponding enabled Better host component, following existing served-namespace patterns.
- [x] Remove server welcome acknowledgement and WebServer replacement/provider rows/exports. Retain native public WebTrust/mobile events.
- [x] Build Better and run relevant tests; report commands and files. Do not commit.

## Task 3: Hub Settings and delivery/launcher

**Files:** Hub `src/client/HubPage.tsx`, new focused Settings/API modules, release/build/pair verification scripts and tests, `super-dsh/package.json`, test launcher/registry, current delivery docs and AGENTS.

- [x] Navigate existing Hub fetch/envelope conventions and AST scope before edits.
- [x] Add request/result behavior tests for the companion client API and update packaging contract tests to reject all Better dependency edges/payload.
- [x] Add first Settings row with status/version/enablement, loading/error and explicit Install control; handle native change notifications or periodic mounted refresh without changing foreign-world selection.
- [x] Remove Better dependency from the Super manifest and version helper; derive synchronized build validation from the packages' own versions. Remove Better staging from Super's compilation/pack pipeline. Keep host optional peers unchanged.
- [x] Change launcher default to loopback and existing relay. Keep its registry alive for runtime native install and serve `latest` metadata from this round's Better tarball, never an old public Better fallback. Preserve native profile state rather than preinstall/promote Better.
- [x] Set `0.3.0-f`, build both actual tarballs, run relevant tests and update current contract docs without rewriting historical reports.

## Task 4: Review and real acceptance

- [x] Review the complete working diff for contract, HMR and persistence mistakes; repair findings before consumer acceptance.
- [x] Start 4999 with the canonical launcher and preserved home/credentials; test fresh Super-only runtime installation and restart-preserved choices.
- [x] In the browser verify Settings uninstall/reinstall, native independent switches/removal with no Better override toast, first visit and new chat without preview modal.
- [x] Pair with the existing DEV3 endpoint using existing authorized pairing credentials, checking roster/connection behavior; no DEV3 deploy/restart.
- [x] Save actual evidence and remaining limits in `docs/test-reports/2026-10-09-native-companions-4999.md`; leave 4999 running and return its URL, branch/worktree and results.

## Acceptance-discovered lifecycle correction

Removing Better's replacement listener exposed outer-owned Hub route/sweep/PTY effects surviving a native Connection reload. The dedicated pairing route then vanished after child setup collided with the stale Hub route. Bind those effects to the existing Connection injection scope, including asynchronous PTY cleanup. Actual Native WebServer/Connection tests reproduce the failure before the correction and verify repeated reloads afterwards. Final consumer iteration is `0.3.0-i`; F/G established initial installation and preserved uninstall/upgrade behavior, H was built during review, and I includes triple fallback and the route lifecycle correction.
