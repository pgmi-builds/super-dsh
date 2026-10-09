# Registry companion dependency delivery implementation plan

> Execute inline, task by task, using Superpowers TDD and verification. Existing authorized work remains in this checkout; no commit, tag, push or public npm publish before this release's approval.

**Goal:** One user installation resolves synchronized Super/Better registry packages, with no physical Better payload in Super.
**Architecture:** Exact dependency plus native offline promotion for independent DSH bundle identities. A read-only local test registry serves the unmodified pair to package managers.
**Tech Stack:** npm/pnpm, Node HTTP, Cordis/DSH official package operations.
**Spec:** docs/specs/registry-companion-delivery/spec.md

- [x] Trace official native operations using actual LSP definition/references/call hierarchy and TypeScript AST; inspect npm dependency contract.
- [x] Replace embedding tests with dependency/no-payload contracts; observe red with old pack.
- [x] Remove Better bundling/archive descriptor, retain same-repository dual build and development type/runtime source consistency; verify pair and client exports.
- [x] Change companion coordinator to exact offline native registration; test initial install, no-op, disablement, uninstall, updates, lock races, cancellation and installed-version mismatch.
- [x] Add launcher-owned test registry and package-specific npm configuration; preserve test homes/seed and prior settings; no Better override/pre-promotion.
- [x] Synchronize iteration 0.3.0-f; full pack and necessary unit/type/package checks.
- [x] Verify one-install npm and native manager paths, 4999 delivery UI/session behavior first; same pair dev3 next; restore pre-test switches. Both delivery/UI paths and five foreign runtimes passed. Record dev3 native history-recall failure and Antigravity billing QUOTA explicitly; full runtime release acceptance remains incomplete.
- [x] Update current docs/AGENTS/ADR to supersede embedding contract, record report, leave review services running. Public registry final acceptance follows explicit publish approval and outstanding runtime acceptance resolution.
