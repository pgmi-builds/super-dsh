# Desktop transport and reciprocal pairing implementation plan

> Execute in this session using executing-plans; request an independent reviewer after implementation. User has approved the design and revised pairing policy. Repository release/production rules override skill commit/worktree defaults.

**Goal:** Support desktop transport and persist failed reciprocal connections by Hub UID.

**Architecture:** Keep `/hub` routing and upstream authentication; unify frontend URL rewriting over the document and declared stream carrier. Extend reciprocal offers with UID and retain failed inbound rows in the existing pairing table/probe lifecycle.

**Tech Stack:** TypeScript, Cordis, Node test runner, upstream TypeScript LSP/AST.

**Spec:** `docs/specs/desktop-transport-and-pairing/spec.md`.

## Global constraints

DSH `0.2.1-alpha.1`; test iteration `0.3.0-k`; two exact-version packages; no upstream edits, fake types, production access or publication. Preserve current UI layout and test homes.

Subsequent user instruction explicitly authorizes push/publish as `0.3.0-e`, after checking public latest `0.3.0-d`. That release uses the same executable payload, with synchronized manifests, repeated final-artifact PC/dev3 checks and a separate release report.

## Tasks

- [x] Trace `pairMachine`, `reprobeMachine`, `handlePost` with LSP and AST; inspect official carrier hooks.
- [x] Add failing transport and UID/inbound-pairing regressions; run against the baseline build.
- [x] Implement dynamic document/stream URL rewriting in `fusion-transport.ts` and verify focused tests.
- [x] Implement UID reciprocal handling, durable incoming rows and recovery in `mesh-link.ts`, `machines.ts`, `mesh-rpc.ts`; extend client origin payload and honest success feedback with minimal UI changes.
- [x] Run Hub and delivery tests/typechecks, request independent review and resolve findings.
- [x] Build synchronized local tarballs and launch PC4999; verify actual switch/create/prompt/resume and pairing behavior; keep review URL running.
- [x] Transfer unchanged pair to dev3, use its existing isolated launcher/home and verify behavior. Document actual Electron coverage and any remaining acceptance gap.
- [x] Write `docs/test-reports/2026-10-09-desktop-transport-and-pairing.md`; report results and retained URLs. No Git/npm finalization.
- [ ] Complete actual Electron acceptance on an available desktop host. Current Mac host cannot be reached; carrier proof is explicitly not Electron GUI acceptance. Antigravity successful prompt/resume also remains blocked by external QUOTA.

## Delivery findings included in the implementation

The Better root password gate intercepted native token exchange, affecting reciprocal pairing and Electron bootstrap. Super now delegates a dedicated exact token route to native Connection; Better preserves the root exchange for the official desktop profile. No upstream changes or independent auth implementation. The optional profile fact uses official Cordis `get`, tested against a real Context, so non-profile Web compositions remain supported.

## Verification record

Final candidate is the unchanged 0.3.0-k dual tarball pair. Hub 593/593, affected Better auth/Connection 24/24, final optional-service review 21/21; Better full-suite fixture failure and successful browser rerun are recorded honestly in the report. PC/dev3 behavior covers loopback mutual pairing, public reverse connection, gray retention/recovery, authenticated federation and real create/prompt/cold-resume (Antigravity QUOTA excluded). Review URL remains https://test.pc.internal.test/.
