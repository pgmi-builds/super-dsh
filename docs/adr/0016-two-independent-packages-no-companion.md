# ADR 0016 — Two fully independent packages: no companion install, remote tools only in Better Dash

Status: accepted (2026-11-02 user decision).

## Context

ADR 0015 made the packages npm-independent but kept two coupling legs: the native
Plugin Manager companion coordinator that installed Better Dash from inside Super
Dash (exact → latest → bare name, durable first-use receipts, plus a Hub Settings
recovery row), and the `superd-remote` composite row that mounted a generated copy
of Better's remote tools inside Super so that either package alone could provide
the `remote`/`remote_transfer` tools. The user retired both legs as unnecessary
complexity: whoever wants the remote tools installs Better Dash.

## Decision

- Super Dash ships no companion coordinator and no manual install entry. The Hub
  Settings tab whose only content was the Better Dash install status is removed
  along with the `superd-bundle-setup` row and the `superdCompanions` service.
  Users install each package themselves (`dsh plugin add super-dsh` /
  `dsh plugin add better-dsh`); neither package installs, promotes, upgrades or
  reinstalls the other at any time.
- The model-facing `remote`/`remote_transfer` tools ship ONLY in Better Dash.
  Super's `superd-remote` composite row and the public `super-dsh/remote` export
  are deleted; `verify-package-pair.mjs` rejects both.
- The generated `super-dsh/remote/` closure itself REMAINS, narrowed to a PRIVATE
  hub-internal dependency: the hub's own exec/PTY/task/file lanes
  (`exec.ts`, `remote-provider.ts`, `remote-job-rpc.ts`, `remote-job-client.ts`,
  `remote-file-rpc.ts`, `hub-tool.ts`) import their canonical process primitives
  (`PtySession`, oneshot/binary process, rings, argv builders, helper assets)
  from it. It carries no composite row, no public export, and no tool
  registration; `build-remote.mjs` and the provenance/leaf-hash verification are
  unchanged.
- `better-dsh/src/remote/` remains the sole editable remote source, unchanged.
  Its Super Dash hub integration is explicitly PRESERVED: when both packages are
  installed, Better's remote driver still picks up the hub-provided
  `superdRemoteTransport` service, so `hub:<m4>` stays a remote target and the
  hub PTY/oneshot lanes keep working. The hub-side executor code belongs to the
  hub body, not to the remote tool.
- DSH upstream compatibility is one unified range across both packages and every
  sub-manifest: `>=0.2.0-0 <1.0.0-0` for all `@deepseek-ai/dsh*` peers.

## Consequences and verification

- `verify-package-pair.mjs` rejects a `./remote` export, a `./setup` export, a
  `super-dsh/remote` row in Super's composite patch, and any Better dependency
  or physical payload; the shipped `remote/` closure must still pass the full
  provenance verification. Synchronized versions, the dual-tarball pack line,
  the pair registry test infrastructure and the publish order (Better before
  Super) are unchanged.
- No receipt migration is performed: companion receipts under
  `$DSH_HOME/superd/companions/` are simply no longer read. Leftover files are
  inert and can be deleted by hand; the old legacy `companion-registration`
  migration is gone with its reader.
- Consumer acceptance: a Super-only profile must boot without any Better install
  attempt and show no Settings tab in the Hub UI; a profile with both packages
  must still list `hub:<m4>` targets through Better's remote tool.

Supersedes the companion-install and Super-remote-row legs of ADR 0015
(2026-10-10); ADR 0014 remains historical evidence.
