# Final 0.3.1 release bytes — dev3 installed acceptance

Date: 2026-10-12 HKT. Result: **PASS** for final immutable `0.3.1` candidate bytes. This is the requested final installed-consumer gate: exact dual artifacts, native installation, new model session with checkpoint and native read, then actual TEST-host restart and same-session cold recovery. The accepted s full matrix and t filesystem-failure delta remain prior evidence; no fault matrix or dying cell was replayed here. Publishing and Git finalization are parent-owned steps, not actions asserted by this report.

## Delivery and native installation

- Target `dev3`; retained home `/home/u1/workspaces/superd/.tests/foreign-substrate`; profile `superd-pub`; test port `4998`.
- Independent host anchor `/home/u1/workspaces/superd/.tests/dsh-0.2.1-alpha.1-install/node_modules/@deepseek-ai/dsh/package.json`, version `0.2.1-alpha.1`.
- Exact `pair.json`, `better-dsh-0.3.1.tgz`, `super-dsh-0.3.1.tgz` transferred to target `.scratch/release-0.3.1/pair`. Received SHA256 matched:
  - Better `6bb78bd2cd54ddf6df92ebc3c25ee32de333e7cb62d621f95c1b8d98a9e9af89`.
  - Super `832103fe729c286cd9e3e06f6d9ab5dae8bce701b48a4494aaf546c4aa8fd935`.
- Existing canonical launcher consumed that supplied pair, retained home, independent anchor, prebuilt dev WebMCP, and `.scratch/socat`. No target product build or pip install.
- Launcher upgraded Super t→0.3.1 and retained independent Better t. Native `pluginManager/installBundle` explicitly requested `better-dsh@0.3.1` with registry `http://127.0.0.1:14998/`, request ID `release-031-dev3-native-upgrade`. Actual result: changed true, application restart-required, package exit 0, installed version 0.3.1.
- TEST unit restarted for loaded-code refresh. Physical installed versions of both packages are 0.3.1, within retained profile node_modules; no source link.
- Authenticated shell returned200 with official transport and Super fusion markers. Seven local plus seven retained paired runtime entries all ready/failedfalse. Pairing/home/session data preserved. Log world-failed count0.

## Actual native model calls and restart

New release session `session-73e7e3f8-41d2-49d9-95a9-8579f65e15e7`. Live model catalog selected `deepseek-official / deepseek-flash`.

| Stage | Actual call/result sequences | Observed result |
| --- | --- | --- |
| Create | 18/19 | `release_031_value=73`; `RELEASE-031-CREATED 73`; typed73; isErrorfalse |
| Native callback and continuity | 24/27 | actual `await tool.read({"file_path":"/home/u1/workspaces/superd/.tests/foreign-substrate/profiles/superd-pub/package.json","limit":3})`; native hashline string; `RELEASE-031-STATE 73`; typed73; isErrorfalse |
| After TEST-host restart | 44/45 | assertion `release_031_value==73` passed without reconstruction; `RELEASE-031-COLD-RESTORED 73`; `[dashr] namespace restored from the turn-2 snapshot`; typed73; isErrorfalse |

Both actual model turns ended completed. Between them, the existing TEST unit was restarted with `systemctl --user restart superd-4998-test`; no registry/production restart or source rebuild. The first immediate modelCatalog probe preceded sessionController readiness and returned `gateway/service-unavailable` with `active Service "sessionController" is unavailable`. That probe submitted no prompt or cell. The normal ready retry submitted the single same-session restore prompt and passed. The startup transient is recorded instead of being hidden or reported as a failed Python cell.

Before restart the real manifest was turn2 and its payload SHA256 `f0909eeb41f0bfaad20853ee3c9c2562f3479c60fad400e46ecd974bc6f9d244`, verified against payload bytes. After restore/check the manifest advanced to turn3 with the same namespace payload hash. Names `r`, `release_031_value`, no omissions. Directory0700, manifest/payload0600. Bindings `tool` and `ToolCallError` are recorded as bindings, excluded from serialized names.

Manifest environment: snapshot format2, protocol4, dill0.4.1, CPython3.11.15, interpreter `/home/u1/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu/bin/python3.11`, environment hash `8a417c9ae4f50103ac6881f7a238df3a4d62ed780214b3eb7aaf53c9ba1fefed`. This target used its existing compatible managed interpreter, not an unverified new system interpreter installation.

## Actual model-visible Surface and resource provenance

Actual fresh-turn `request/header` eval descriptor is byte-identical to installed `better-dsh/eval-description.md`. Description SHA256 `7966bacfc69e7e82c2a378812ca3f560ebcef4a66bc25191668dec4e878297dc`. Full extracted descriptor includes OMP, interpreter prerequisite, best-effort checkpoint/omission/no-replay guidance, plus reset schema deleting saved checkpoints. It is archived independently of unrelated request context.

Installed resource hashes:

- Unmodified upstream runner `e0e660ca44193735a2de467254b050109bb23028aca71af01b9365b9ab88e974`.
- better_support.py `57c283f15e83fc3d600612dc81cb33e0f349883176399fb89a07f0d4229d23c2`.
- better_snapshot.py `c2b9ff92211e9940f7c4cf7bd3415c202528e5db6cdf39a313e215d02a154c42`.
- OMP MIT license `16c45f9d667442781f03fa198914cc39abcaa48ec5ed8f644643e554ca2fbf63`.
- Dill license `f669d63bebf765baaa0b20d8b0c1193296a7e0ea0c22c50a308b74d76ab3939c`.

The complete unchanged dill/source resource map is archived in `dev3-resource-hashes.json`.

## Evidence and running target

Local compact evidence `/home/u1/workspaces/superd/.scratch/release-0.3.1/dev3-evidence/`; archive `/home/u1/workspaces/superd/.scratch/release-0.3.1/dev3-evidence.tar.gz`. It contains native installation result, actual session IDs/call arguments/results/end reasons, model descriptor, version/roster smoke, manifests before/after restart, resource hashes and final status. Compact event files include actual tool/call, tool/result and turn/end only. Cookies, env secrets and unrelated request context were not copied back. Full original native histories remain in target retained test home.

Final target units active and left running: `superd-4998-test`, `superd-4998-pair-registry`, `superd-lan-4998-relay`. Native service `http://127.0.0.1:4998/`; the parent's existing review forward reaches this same service at `http://192.0.2.130:4996/`. No production home/port, Caddy/firewall/global SSH, upstream source, product source/docs, Git commit/tag/push or npm publish action by this worker.
