# Parked — `agy --hub` backend transport

**Status: PARKED 2026-10-03. Not wired, not shipped, not imported by anything.**
The shipping `agent-agy` adapter is pure CLI headless
(`agy --input-format=stream-json`); the SDK variant lives in its own package
and is `disabled: true` by default.

This directory is the *take-it-out-later* record: working code, the measured
wire contract, the ground truth we captured, and exactly why we stopped.

---

## 1. What this is

The same `/home/u1/.local/bin/agy` binary (1.2.15) has **three faces**:

| Face | Invocation | Status |
|---|---|---|
| interactive TUI | `agy` | the user's daily driver |
| headless | `agy --input-format=stream-json` | **what we ship** |
| hub server | `agy --hub --hub-port=N` | this directory |

`--hub` serves the whole agent over HTTP, on the Connect service
`exa.language_server_pb.LanguageServerService` (237 methods). That is the
surface Google's own clients use — the official VS Code extension
(`Google.google-antigravity`) downloads this same binary to `~/.gemini/bin/agy`
and spawns exactly:

```bash
AGY_ENABLE_HUB=1 ANTIGRAVITY_VSCODE_HOST=1 ANTIGRAVITY_AUTH_SUCCESS_APP=vscode \
  agy --hub --hub-port=<p> --app_data_dir=antigravity --csrf_token=<uuid>
```

`--hub` is **undocumented** (absent from `agy --help`) and absent from every
other binary in the family: the Antigravity 2.0 app's bundled `language_server`
and the Antigravity IDE's both reject it (`flags provided but not defined:
-hub -hub-port`) and are driven with
`--https_server_port/--csrf_token/--app_data_dir/--cloud_code_endpoint` instead.
Treat hub availability as **probed, never assumed** — hence the supervisor's
failure taxonomy.

---

## 2. Why parked — tool execution is blocked

A hub turn **cannot execute a tool** in this environment, while the CLI
headless path can:

```
hub:          RUN_COMMAND → CORTEX_STEP_STATUS_ERROR
              {"shortError":"connecting to sandbox server: read unix @->@: recvmsg: connection reset by peer"}
CLI headless: run `uname -s` → "Linux"   (zero sandbox complaints)
```

Root cause, isolated: **execution policy is resolved server-side from
project/user settings and a client cannot override it.**

- Sending `cascadeConfig.plannerConfig.toolConfig.runCommand.autoCommandConfig
  .autoExecutionPolicy = AUTO_EXECUTION_POLICY_NOT_ENFORCED` is **stripped** —
  the engine echoes `autoCommandConfig: {}` back in `userInput.userConfig`.
- So the hub honours the project/user policy, sandboxes the command, and the
  sandbox server is unreachable.
- The CLI headless path works only because `--dangerously-skip-permissions`
  bypasses that whole path.

Changing the policy from the API is not currently reachable:
`GetUserSettings` → `unimplemented`, `GetProjects` → `404 page not found` on
this build. The practical routes are the desktop app's settings UI, or finding
the correct method name.

**Assessment:** the hub's advantage is the *state/API* surface (cascades,
trajectories, turn diffs, model catalog, artifacts, sidecars). Its disadvantage
is exactly the thing an agent adapter cannot live without — running tools.
CLI headless wins for turns today.

Auth is *not* a blocker and needs no extra work: the hub inherits the same
ladder. Measured `GetAuthStatus` → `hasValidAuth: true`,
`projectId: "crafty-run-501613-m0"`, and `GetGrantedScopes` → 8 scopes including
`cloud-platform` (Agent Platform OAuth + system keyring).

---

## 3. Files

| File | What it is |
|---|---|
| `agy-hub-client.ts` | typed `LanguageServerService` client: endpoint, CSRF, error normalisation, request builders, step helpers, live model catalog resolution |
| `agy-hub-supervisor.ts` | owns one `agy --hub` lifetime: argv/env contract, free-port pick, `/healthz` wait, banner parsing, teardown, failure taxonomy |
| `agy-hub-client.test.mjs` | 16 tests — pins the three gotchas, error mapping, step helpers, catalog |
| `agy-hub-supervisor.test.mjs` | 10 tests — spawn contract (asserted from the child's own env), taxonomy, teardown/reaping |
| `mock_agy_hub.mjs` | test double with modes `ok` / `no-flag` / `tty` / `hang` / `silent` |
| `mock_agy_hub_bin.sh` | shell wrapper so the double can stand in as `agyBin` |

Test totals when parked: `agent-agy` **100/100** (74 pre-existing + 26 here).

---

## 4. The measured wire contract

### 4.1 Error shape (Connect)

| Case | HTTP | Body |
|---|---|---|
| unknown method | 404 | plain text `404 page not found` |
| bad argument | 400 | `{"code":"invalid_argument","message":"…"}` |
| missing/wrong CSRF | 401 | `{"code":"unauthenticated","message":"missing CSRF token"}` |

`/healthz` is the only unauthenticated route:
`{"instanceId":"…","status":"ok"}`.

### 4.2 Three gotchas that fail SILENTLY

1. **`items` takes only `[{text}]`.** protojson discards unknown fields, so
   `{userMessage:{text}}` / `{prompt}` / `{cascadeInput:{…}}` all return HTTP
   200 `{}` and leave a `USER_INPUT` step whose items are `[{}]`. The failure
   surfaces two steps later as a bogus *"plan model not specified"*, because
   the message never arrived. Build the body only via `userInputItems()`.
2. **`plannerConfig.planModel` (enum) and `modelName` (catalog key) must both
   be present.** Either alone → `plan model not specified; you must specify a
   valid model`. The enum does **not** track display names — the live catalog
   returned `gemini-3.8-flash-medium → MODEL_PLACEHOLDER_M319` while
   `gemini-2.5-flash → MODEL_GOOGLE_GEMINI_2_5_FLASH` displays as
   "Gemini 3.5 Flash Lite". Always resolve from `GetAvailableModels`.
3. **Non-blocking sends return `{}` unconditionally** — success and garbage are
   indistinguishable. `blocking: true` is what makes the engine validate.

### 4.3 Startup banner (the only place the engine names its version)

```
  Antigravity server is running.

  Server version:  2.19.1
  CLI version:  1.2.15

  ➜  Open in your browser:  http://localhost:5395
```

Two spaces after each colon. `--hub` does **not** write a discovery file; that
only happens in `-persistent_mode` (LS daemon), so in hub mode the banner is the
version source and `readHubDiscovery()` stays best-effort.

### 4.4 Verified round trip

```
StartCascade {source: CORTEX_TRAJECTORY_SOURCE_AGENT_API,
              trajectoryType: TRAJECTORY_TYPE_CASCADE,
              workspaceUris: ["file:///abs/path"]}          → {cascadeId}
SendUserCascadeMessage {cascadeId, items:[{text}], cascadeConfig:{plannerConfig}, blocking} → {}
GetCascadeTrajectorySteps {cascadeId}                     → {steps:[…]}
```

---

## 5. Ground truth: step → DSH event mapping

Captured from a real turn (`/tmp/agy-hub-steps-tool.json` at the time).

**Tool calls are not their own step** — they ride on the planner response:

```json
CORTEX_STEP_TYPE_PLANNER_RESPONSE   keys=[type,status,metadata,plannerResponse]
  plannerResponse: {
    messageId, stopReason: "STOP_REASON_STOP_PATTERN",
    toolCalls: [{ id: "call_851", name: "run_command",
                  argumentsJson: "{\"CommandLine\":\"uname -s\",\"Cwd\":\"…\"}",
                  thinkingSignature: "…" }]
  }
```

The execution step pairs back through `metadata.toolCall`:

```json
CORTEX_STEP_TYPE_RUN_COMMAND  keys=[type,status,metadata,error,runCommand]
  metadata: { startedAt, completedAt,
              toolCall: { id: "call_851", name: "run_command", argumentsJson: "…" } }
  error:    { shortError: "connecting to sandbox server: …" }        // on failure
  runCommand: { … }                                                 // on success
```

Mapping therefore is:

| step | emit |
|---|---|
| `plannerResponse.modifiedResponse ?? .response` | text chunk |
| `plannerResponse.toolCalls[]` | `onToolEvent({event:"tool_call", id, name, args: argumentsJson})` |
| execution step, status DONE | `tool_result` from its payload |
| execution step, status ERROR | `tool_result` with `is_error`, text = payload.error.shortError |
| `errorMessage` | error event, turn over |
| planner `stopReason: STOP_REASON_STOP_PATTERN` | turn boundary |

### Known defect to fix on resurrection

`stepKind()` (in `agy-hub-client.ts`) returns the first non-meta key, which is
**wrong for tool steps**: `RUN_COMMAND` carries both `error` and `runCommand`,
and it reports `error`. Replace it with a payload key derived from the type —
`CORTEX_STEP_TYPE_RUN_COMMAND` → `runCommand` — and keep `stepKind` only for the
single-payload steps it was written for (`userInput`, `plannerResponse`,
`errorMessage`).

---

## 6. How to take it back out

```bash
cd /home/u1/workspaces/superd
cp docs/parked/agy-hub/agy-hub-{client,supervisor}.ts super-dsh/agent-agy/src/
cp docs/parked/agy-hub/agy-hub-*.test.mjs        super-dsh/agent-agy/test/
cp docs/parked/agy-hub/mock_agy_hub.mjs docs/parked/agy-hub/mock_agy_hub_bin.sh \
   super-dsh/agent-agy/fixtures/
chmod +x super-dsh/agent-agy/fixtures/mock_agy_hub_bin.sh
cd super-dsh/agent-agy && npm run build && node --test test/agy-hub-*.test.mjs
```

The tests import from `dist/`, so build first. Then the wiring that was **never
done** (this is the actual remaining work):

1. Add `src/agy-hub-transport.ts` implementing `LiveAgyClient`
   (`agent.ts:46`, a `Pick<AgyCliClient, "conversationId" | "lastUsage" |
   "onThinkingDelta" | "onToolEvent" | "setApprovalHandler" | "turn" | "close">`
   plus optional `setSystemMessageHandler`) on top of `AgyHubClient`.
2. Add a factory that probes hub first and falls back to `AgyCliClient` when
   `AgyHubUnavailableError.permanent` — and, given §2, **also** when the hub
   cannot execute tools.
3. Write the routing tests, red-check them, then run the 4999/4996 pack line.

---

## 7. Evidence log (2026-10-03)

- `agy` 1.2.15, hub banner `Server version: 2.19.1 / CLI version: 1.2.15`
- hub HTTP: `/healthz` ok, `GetAllPlugins` `{}`, 401 without token
- live catalog: 18 models, quota 1, `API_PROVIDER_GOOGLE_VERTEX`
- driven turns: `say OK` → `PLANNER_RESPONSE "OK"` (9.3 s warm, 32.6 s cold)
- parked after: `connecting to sandbox server` on every tool step, with the
  policy-stripping proof in `userInput.userConfig`
- Antigravity 2.0 desktop app updated 2.0.1 → **2.19.1** during the same
  investigation (`storage.googleapis.com/antigravity-public/antigravity-hub/
  <version>-<build>/<platform>/Antigravity.tar.gz`); backup at
  `/opt/Antigravity-x64.2.0.1.bak`
