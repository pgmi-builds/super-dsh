# Task 3 — dev3 0.3.0-t delta acceptance

Date: 2026-10-12 HKT. Result: **PASS** for the t delivery and targeted filesystem-save-failure delta. The complete s behavior matrix and its original evidence remain preserved in [original s report](dev3.md) and `.scratch/omp-python-repl/dev3-evidence/`; this report does not claim that whole matrix was repeated on t.

## Exact delivered consumer

- Target SSH `dev3`; retained test home `/home/u1/workspaces/superd/.tests/foreign-substrate`; native profile `superd-pub`; port `4998`.
- Independent host anchor `.tests/dsh-0.2.1-alpha.1-install/node_modules/@deepseek-ai/dsh/package.json`, version `0.2.1-alpha.1`.
- Copied the exact `pair.json` and two tarballs to target `.scratch/omp-python-t-pair`. Received Better SHA256 `a9b908e75c1292b066d912fd01b2098906df3adfc2c1fea90da66cd75b28064d`; Super SHA256 `95ed98db2f32311df121b02c4d281ccc4d3967807eccfd4d2f2b3c52d4d2cadf`.
- Canonical launcher used supplied pair, retained home, independent anchor, dev WebMCP prebuilt flag and explicit `.scratch/socat`. No target product build.
- Launcher upgraded Super s→t and retained independent Better s. Actual native `pluginManager/installBundle` then requested exact `better-dsh@0.3.0-t` with registry `http://127.0.0.1:14998/`, request ID `omp-dev3-t-native-upgrade`. Result `changed:true`, `restart-required`, package exit `0`, installed version `0.3.0-t`. Only TEST host restarted to refresh loaded code.
- First immediate postrestart smoke request arrived before root route mount and returned `404`; no model prompt was submitted. Normal readiness retry and final smoke returned authenticated app `200`. Both physical package versions t; seven local and seven retained paired agents all ready/failed false; log world-failed count `0`.

## Actual model filesystem delta

Fresh session: `session-f1a7ffd9-6b2d-4975-92c8-4315c9d8dda7`. The live catalog selected `deepseek-official / deepseek-flash`. Each stage made exactly one actual eval call and ended completed. Native call/result event sequences:

| Stage | Call / result | Actual output and state |
| --- | --- | --- |
| Create | 18 / 19 | `OMP-FS-CREATED 73`, typed expression `73`, isError false; real turn-1 checkpoint saved |
| Blocked save | 33 / 34 | `OMP-FS-SAVE-NONFATAL 74`, failed-checkpoint notice, typed expression `74`, **isError false** |
| Recovered directory | 48 / 49 | assertion `important_value == 74` passed; `OMP-FS-CONTINUED 74`, typed `74`, no checkpoint failure |
| Native read + continuity | 63 / 66 | successful `await tool.read({"file_path":"/home/u1/workspaces/superd/.tests/foreign-substrate/profiles/superd-pub/package.json","limit":3})` returned native hashline string; `OMP-T-STATE-CONTINUED 74`, typed `74` |

The blocked call executed `important_value += 1` only once. Exact checkpoint notice:

> [dashr] namespace snapshot failed: EEXIST: file already exists, mkdir '/home/u1/workspaces/superd/.tests/foreign-substrate/better-dsh/python-repl/3d4c7eb4f48fe687e640f2d9cb29e75df7050e160d7d7631c2a89f71bfffc593/session-f1a7ffd9-6b2d-4975-92c8-4315c9d8dda7'; latest successful checkpoint is turn-1

The successful Python stdout and expression result survived the host-side mkdir failure. No retry of the increment, reset, variable redefinition, dying cell or full s fault matrix occurred.

## Fixture integrity and checkpoint evidence

The owned fixture first read this new session's saved manifest and moved only its checkpoint directory into proof-owned `original-checkpoints`. It created an exclusive mode-0600 regular marker file at the former directory while the existing Python child remained alive. The parent registry/profile/session collection and other checkpoints were untouched.

Recovery verified the exact owned marker bytes, removed that marker and moved the original checkpoint directory back. Final target checkpoint path is again a directory and `original-checkpoints` backup no longer exists: **fixture fully restored**.

- Original turn-1 payload SHA256 `f65ce94bfc30403119137400884317b24c0c2e772b0d93e2ce85b9538af2c867`, verified against original manifest.
- Final turn-4 payload SHA256 `c9fe1ea66b10bdb36e48add9aa8112a18b4f6ed2ce28bfc228caa471981e4eb0`, verified against final manifest. Names `important_value`, `r`; no omissions. Prior retained turn-3 recovered payload SHA256 `9b891d40aa5934cdd2d1b1f31a127d266b34407c09933a6f3f35cbdde3a5a697` also exists, confirming checkpoint saves resumed after fixture recovery.
- Directory `0700`, manifest and payload `0600`; snapshot format `2`, protocol `4`, dill `0.4.1`, CPython `3.11.15` at `/home/u1/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu/bin/python3.11`. Environment hash `8a417c9ae4f50103ac6881f7a238df3a4d62ed780214b3eb7aaf53c9ba1fefed`. This target uses its existing managed compatible interpreter; no pip install was performed.

## Actual model Surface and installed resources

Actual `request/header` eval descriptor extracted from the fresh native model turn is byte-identical to installed `better-dsh/eval-description.md`; description SHA256 `7966bacfc69e7e82c2a378812ca3f560ebcef4a66bc25191668dec4e878297dc`. The descriptor includes the OMP/best-effort/no-replay guidance and reset schema that deletes saved checkpoints. Complete descriptor is saved separately without unrelated model request context.

Installed resource SHA256:

- runner.py: `e0e660ca44193735a2de467254b050109bb23028aca71af01b9365b9ab88e974` (expected unchanged upstream runner).
- better_support.py: `57c283f15e83fc3d600612dc81cb33e0f349883176399fb89a07f0d4229d23c2`.
- better_snapshot.py: `c2b9ff92211e9940f7c4cf7bd3415c202528e5db6cdf39a313e215d02a154c42`.
- OMP license: `16c45f9d667442781f03fa198914cc39abcaa48ec5ed8f644643e554ca2fbf63`.
- Dill license: `f669d63bebf765baaa0b20d8b0c1193296a7e0ea0c22c50a308b74d76ab3939c`.

The complete installed resource hash map, native install result, model descriptor, before/recovered checkpoints, fixture metadata and exact tool records are in the evidence directory.

## Evidence and running state

Local compact evidence: `/home/u1/workspaces/superd/.scratch/omp-python-repl/dev3-t-evidence/`; archive sibling `dev3-t-evidence.tar.gz`. Each stage keeps `session.json`, `summary.json`, and `events.compact.json` containing actual tool/call, tool/result and turn/end. No cookie, env secret or unrelated model request context was copied back. Target full original histories remain in retained test home.

Final `superd-4998-test`, `superd-4998-pair-registry` and `superd-lan-4998-relay` are active and left running. Native target loopback `http://127.0.0.1:4998/`; parent-owned PC review transport `http://192.0.2.130:4996/` reaches this same target service. Parent verified review HTTP200. Final local app shell200, seven local plus seven paired agents ready, world-failed0. No production home/port, Caddy/firewall/global SSH, upstream source, publish, Git finalization or product source/documentation change was made by this worker.
