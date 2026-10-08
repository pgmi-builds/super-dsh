# DSH 0.2.1-alpha.1 Alignment Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to execute this alignment; read-only domain audits use dispatching-parallel-agents. Root AGENTS overrides skill commit/approval defaults.

**Goal:** Align the merged Better/Super delivery against DSH 0.2.1-alpha.1 source and registry consumers.

**Architecture:** Preserve independent YAML layers and exact embedded Better artifact. Use native host APIs and existing tarball launcher; dev3 gets a separate registry installation anchor to protect production.

**Tech Stack:** TypeScript, Cordis, pnpm, npm tarballs, real DSH Web sessions.

**Spec:** docs/specs/dsh-021-alignment/spec.md

## Global Constraints

No production home/ports/shared install mutations, no registry publication or Git finalization. Existing upstream build patches only; real types, single host module instances, no fake stubs. Keep test homes and their session data.

### Task 1: Verify and switch upstream

- [x] Query npm version/dist-tags/timestamps and GitHub release tag; backup dirty upstream patches under ignored scratch.
- [x] Fetch explicit tag from official GitHub, inspect patch carrier changes, checkout 5badb150, replay sanctioned patches.
- [x] Clean upstream ignored generated files; install its pinned pnpm and run complete build, recording exit codes.

### Task 2: Audit merged compatibility and adapt

- [x] Read-only Better and Hub audits: explicit old/new git diff, LSP definition/references and TypeScript AST evidence.
- [x] Check all imported host packages/exports, replacement YAML rows and client slot IDs against new source.
- [x] Fix only demonstrated incompatibilities with meaningful regression verification; regenerate farms and use synchronized next letter version via npm run version:release.

### Task 3: Verify dual delivery

- [x] Build npm run pack (Better first, Super embedded) and run root/Better/Hub/adapter suites appropriate to changes.
- [x] Launch 4999 Super and 4997 Better consumers using current launcher and exact pair.
- [x] Verify password/auth, native app/client uniqueness, metadata, General welcome, roster/hub routes, model eval Surface and old-session resume.
- [x] Validate parallel plugin toggles against actual native manager; affected runtime create/prompt/resume.

### Task 4: Registry target and review

- [x] Install @deepseek-ai/dsh@0.2.1-alpha.1 in independent dev3 .tests install tree; transfer same pair and launcher support; start test 4998 against its real anchor.
- [x] Verify same artifact/behavior and model Surface on dev3; preserve production service and installation untouched.
- [x] Write docs/test-reports/2026-10-08-dsh-021-alpha-alignment.md, update current dev reference notes, leave test URLs available and report exact limitations.

验收边界：Antigravity 实际 prompt 被外部 billing QUOTA 阻断；其余默认 runtime 两机 create/prompt/冷 resume 通过。可选 SDK 仅 suite。详见本轮报告。
