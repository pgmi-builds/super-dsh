# Task 3 — dev3 installed consumer acceptance

Date: 2026-10-12 HKT. Result: the planned dev3 installed-consumer cases passed on the immutable `0.3.0-s` pair. Evidence is actual native `tool/call`, `tool/result` and `turn/end` records, plus installed package hashes and checkpoint manifests. This report does not claim root/source-suite checks passed; the parent records those separately.

## Delivery and isolation

- SSH alias `dev3`; repository `/home/u1/workspaces/superd`; retained home `/home/u1/workspaces/superd/.tests/foreign-substrate`; profile `profiles/superd-pub`.
- Independent host anchor `/home/u1/workspaces/superd/.tests/dsh-0.2.1-alpha.1-install/node_modules/@deepseek-ai/dsh/package.json`, installed version `0.2.1-alpha.1`. Node `24.15.0`; system `python3` reports `3.14.4`.
- Exact received pair directory `.scratch/omp-python-s-pair`; launcher consumed supplied pair with `SUPERD_TEST_PACK_DIR`, `SUPERD_PORT=4998`, retained home, independent anchor, `SUPERD_TEST_DEV_WEBMCP_PREBUILT=1`, and `.scratch/socat`. No target product build.
- `better-dsh-0.3.0-s.tgz` SHA256 `73dfb82d1b259438225770144937f7f3fa0b8a7656b01deec59df197e8714071`.
- `super-dsh-0.3.0-s.tgz` SHA256 `1626e2a52f4936ccd3492cb34b12272bde0fe16b0ef9d81344115368a0808fd2`.
- Launcher preserved independent Better `0.3.0-o`. Native `pluginManager/installBundle` explicitly requested `{spec:"better-dsh@0.3.0-s",options:{requestId:"omp-dev3-s-native-upgrade",registry:"http://127.0.0.1:14998/"}}`. Result: `changed:true`, `application:"restart-required"`, package exit `0`, bundle version `0.3.0-s`. Only the test host was restarted for loaded code refresh.
- Authenticated whole app shell returned `200` with official transport and Super fusion markers. Both installed package versions are `0.3.0-s`, physically within the profile node_modules tree. All seven local runtimes (`native`, `agy`, `claude`, `codex`, `hermes`, `omp`, `pi`) ready, failed false. Preserved pairing adds seven remote entries, making 14 total; all ready, failed false. No pairing data removed. `.scratch/superd-4998.log` contains zero `[super-dsh] ... world failed:` records.
- Existing `.env` remained present and mode `0600`; launcher used retained test credentials. No credential values/cookies were printed or copied back. No production home, production port, Caddy, firewall, global SSH configuration, publish, Git finalization, or upstream source action.

## Actual model wire Surface

The actual live catalog selected `deepseek-official / deepseek-flash`. This is the catalog's provider ID, rather than a hard-coded historical provider name.

`request/header` in the basic session carries the actual model-wire `eval` descriptor. Its 3029-byte description is byte-identical to the installed `better-dsh/eval-description.md`, SHA256 `7966bacfc69e7e82c2a378812ca3f560ebcef4a66bc25191668dec4e878297dc`. It includes OMP, interpreter prerequisites, best-effort checkpoints, omitted resources, and no automatic replay. Actual reset schema says it resets to EMPTY and deletes saved checkpoints. The extracted descriptor is `dev3-model-surface.json` in the evidence directory.

## Sessions and observed results

Event sequences below identify each native tool call/result. Full compact records retain the exact arguments, output, error flag and completion reason.

| Case | Session ID | Actual evidence |
| --- | --- | --- |
| Basics, read, cold restore, death | `session-ac39f460-2d53-4e84-be77-b01f497c4f13` | See detailed rows below |
| Partial checkpoint | `session-5cc1f998-d523-4fc7-a85b-b09956f652a0` | create `18/19`; cold resume `36/37` |
| Timeout, input, reset | `session-5e6b7ad0-e8c1-4e67-a7ab-13f268382370` | timeout `24/25`; recovery `30/31`; `%reset`/input `36/37`; reset:true `92/95` |
| Actual host cancellation | `session-4c4b8c7d-326a-459b-b16d-1da92eed5425` | start `18/19`; next cell `29/30` |
| Corrupt manifest, isolated new session | `session-62006113-d9b6-431c-b1ac-dd21d85dd2bf` | create `18/19`; degraded resume `36/37` |

Basic session:

- `18/19`: definitions and alias/function check returned `OMP-STATE-CREATED 5 True`.
- `24/29`: preserved state check and top-level `await asyncio.sleep(0,42)` produced captured `OMP-AWAIT 42`; native `tool.glob` succeeded. The supplied relative `package.json` read failed honestly with native `ToolCallError: [E_NOT_FOUND]`, because this target checkout has no root `package.json`. `46/47` confirmed the preceding successful glob result remained a Python dict.
- `34/35`: expected `ValueError: OMP-EXPECTED-ERROR` after assigning `omp_before_error=73`.
- `40/41`: `OMP-ERROR-STATE-RETAINED 73`, followed by typed dict completion `{ "marker":"OMP-TYPED-COMPLETION", "answer":42 }`.
- `61/64`: successful native `tool.read` of the actual installed profile's absolute `package.json`; result type `str` with native hashline content. Output `OMP-NATIVE-READ-SUCCESS ...` and `OMP-STATE-STILL-OK 5 True 73`. The first relative-path failure is retained, not suppressed.
- After actual test host stop and canonical launcher restart, `81/82`: `OMP-COLD-RESTORED 5 True 73`; notice `[dashr] namespace restored from the turn-6 snapshot`; typed `{ "restored":true, "answer":42 }`.
- Marker path `.scratch/omp-python-repl/side-effect-marker.txt` was absent before admission. `98/99` is the only death cell, writing the marker and `os._exit(23)`. Actual worker-exit result: `the kernel for this session died; its namespace was restored from the turn-7 snapshot. Changes after that checkpoint may be lost. This cell may have executed partially, including external side effects; inspect their state before choosing any retry. No user code was replayed.` No retry of the dying cell was made.
- Next call `113/114` only inspected restored state and read the marker: `OMP-STATE-AFTER-DEATH 5 True 73` and `OMP-NO-REPLAY 1`. Closing the read file left a `stream` variable whose resource was honestly omitted from turn-8 checkpoint. Independent final inspection confirmed marker count exactly one, SHA256 `587968966c0a1cd69f00c0cf15825f210b470b6d383f787c406d8e7d058f697a`.

Partial checkpoint session:

- Create returned `OMP-PARTIAL-CREATED True` and `turn-1 checkpoint saved; partial coverage` with `omp_bad (RuntimeError: OMP-INTENTIONAL-NONSERIALIZABLE)`, `omp_nested_file (UnsupportedResource: unsupported live resource TextIOWrapper)`, `omp_nested_lock (UnsupportedResource: unsupported live resource lock)`.
- Actual host restart, then `36/37` returned `OMP-PARTIAL-RESTORED [17] True`, restoring the turn-1 snapshot with the same omission notice. Actual assertions verified all three omitted variables absent and the good list's alias identity preserved. Bindings were reconstructed by normal runtime startup.

Timeout, reset and input session:

- Native `%pwd` and `!echo` worked; initial assignment printed `SET 91`.
- Actual timeout argument `1` produced `Python cell exceeded 1000ms`; next cell returned `OMP-AFTER-TIMEOUT 42`.
- `%reset` followed by input immediately returned `Interactive stdin is unsupported in Better Python REPL; pass input as a variable or tool argument`.
- Subsequent calls verified `omp_reset_target` absent, and native read bindings worked after reset. The model first repeated the nonexistent root path, then assumed a dict result incorrectly; both native errors are preserved. It recovered to a correct string read and `OMP-RESET-BINDING-OK` (`66/69`).
- Final actual `reset:true` call `92/95` asserted previous `g`, `r`, and `omp_reset_target` absent, performed absolute profile-manifest `tool.read`, and returned `OMP-EXPLICIT-RESET-BINDING-OK 42 <class 'str'>` and expression `42`. Its new manifest is turn-1 with only new `r`, no previous payload.

Cancellation session:

- Native `session/cancel` was invoked after actual eval started. Tool result captured `OMP-CANCEL-STARTED` and `Error: code run failed (abort): [object Object]`; this exact rough abort text is recorded. `turn/end` was `aborted`, reason `user`.
- Next native model turn returned `OMP-AFTER-ACTUAL-CANCEL 42`, completed normally. It did not replay the sleep.

Corruption session:

- A new acceptance-only session created a real turn-1 partial checkpoint. The test unit was stopped first, all pending model proofs already ended, and its original manifest was copied to an owned evidence file.
- Only that session manifest was replaced with intentionally invalid JSON. Restart used the same canonical launcher, supplied immutable pair and retained home, preventing a pending save from repairing the fixture before cold load.
- `36/37` asserted old `omp_good` absent and returned `OMP-CORRUPT-EMPTY 42`, `[dashr] snapshot not replayable (JSONDecodeError: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)); started from an EMPTY namespace — re-create any state you need`, expression `42`.

## Installed checkpoints and provenance

Normal shipped default persistence was active without a test profile snapshot override:

`/home/u1/workspaces/superd/.tests/foreign-substrate/better-dsh/python-repl/3d4c7eb4f48fe687e640f2d9cb29e75df7050e160d7d7631c2a89f71bfffc593/<sessionId>/`.

Observed manifest: snapshot format `2`, protocol `4`, vendored dill `0.4.1`, CPython `3.11.15`, interpreter `/home/u1/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu/bin/python3.11`, venv path within installed Better `.venv-kernel`; environment hash `8a417c9ae4f50103ac6881f7a238df3a4d62ed780214b3eb7aaf53c9ba1fefed`. Thus this consumer exercised the existing compatible managed interpreter, not the system Python 3.14.4 binary. No pip installation or product build was performed in this acceptance round. This report does not infer fresh 3.14 compatibility from the system version inventory.

Before restart the basic turn-6 payload SHA256 was `5ccba2a4427bf588a06c48b3152be4b1f3b7077db9c46028e05f44b620941059`; partial turn-1 payload was `ea760f3349542bba416056c11d9313773c53192aa827df637b6d17b41149021e`. Each selected payload hash was checked against its manifest before restart and at the final capture. Snapshot directories were mode `0700`, manifests and payloads `0600`. Manifest `bindingNames` lists `tool`/`ToolCallError`; serialized names exclude them. Full environment, names, omissions, generations, hashes and modes are in before/final manifest evidence.

Installed resource SHA256:

- Unmodified upstream runner: `e0e660ca44193735a2de467254b050109bb23028aca71af01b9365b9ab88e974`.
- `better_support.py`: `57c283f15e83fc3d600612dc81cb33e0f349883176399fb89a07f0d4229d23c2`.
- `better_snapshot.py`: `c2b9ff92211e9940f7c4cf7bd3415c202528e5db6cdf39a313e215d02a154c42`.
- OMP MIT license: `16c45f9d667442781f03fa198914cc39abcaa48ec5ed8f644643e554ca2fbf63`.
- Dill license: `f669d63bebf765baaa0b20d8b0c1193296a7e0ea0c22c50a308b74d76ab3939c`.

All installed Python resource hashes, including unchanged dill sources, are in `dev3-resource-hashes.json`.

## Evidence and running review

PC evidence directory: `/home/u1/workspaces/superd/.scratch/omp-python-repl/dev3-evidence/`; compressed transfer `/home/u1/workspaces/superd/.scratch/omp-python-repl/dev3-evidence.tar.gz`. Each proof directory includes `session.json`, `summary.json` and `events.compact.json` containing native tool/call, tool/result, and turn/end only. This avoids copying unrelated model request context or cookies. The cancellation proof has `cancellation.json` and actual compact events. Installed surface, native operation, smoke result, final service status, before/final checkpoints and original corrupt fixture manifest are included. Full original native histories remain under the retained target test home.

Final dev3 units are active and left running: `superd-4998-test`, `superd-4998-pair-registry` (14998), `superd-lan-4998-relay`. Native endpoint `http://127.0.0.1:4998/`, target relay `http://187.127.111.29:4998/`; historical public firewall restriction is unchanged. Authenticated request using proposed PC review Host `192.0.2.130:4996` returned `200` with the app, so a parent-owned SSH forward needs no target restart/config change. The parent owns final PC-facing review URL and report integration.
