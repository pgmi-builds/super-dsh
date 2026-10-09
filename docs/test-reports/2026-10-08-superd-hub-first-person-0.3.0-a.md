# superd-hub First-Person Test Report — 0.3.0-a (dev3 → PC)

- Date: 2026-10-08 (UTC)
- Tester: dev3-deepseek-default, first-person, via the `superd-hub` MCP tool surface from a DSH web session (dev3 GUI 127.0.0.1:3080)
- Trigger: user installed `super-dsh` through the dev3 DSH WebUI plugin manager and asked for a first-person pass of the super-d facilities; this is the first round against the merged Better Dash + Super Dash monorepo line
- Nodes: local `bfwu` = dev3, peer `skc8` = PC (`homepc`)
- Machine-id rotation since 0.1.7-g: PC was `79he` on 2026-09-29, is `skc8` now. Old addresses/conversation ids from earlier reports no longer route; the address format is unchanged (`<m4>-<a6>`).

## 1. Versions under test

| Node | Host | Runtime |
|------|------|---------|
| bfwu (dev3) | srv1637772 | harness `@deepseek-ai/dsh` **0.2.0-rc.2**; profile `~/.dsh/profiles/web` has `super-dsh` **0.3.0-a** + `better-dsh` **0.3.0-a** (better-dsh pinned to a bundle-artifact tgz, sha-suffixed; both listed as bundle rows in the profile `package.json`) — the WebUI plugin-manager install |
| skc8 (PC) | homepc | hub lanes: three `bin.js --profile superd-pub --no-open` processes — two from Oct 07 and the active one PID 1537916 with `--port 4999 --trusted-host test.pc.internal.test`; PC's own web profile still runs super-dsh **0.1.12-a** / better-dsh **0.2.5-e**; PC repo master @ `d0fb356` ("Document verified 0.3.0-a publication and dev3 production removal"), in sync with origin; in-repo harness `upstream/deepseek-harness` at 0.2.0-rc.2 |

Release context (from `docs/test-reports/2026-10-08-030-a-release.md`): 0.3.0-a publishes both npm packages from the merged workspace; suites 27 / 709 / 572 / 1,205 passed; native installs verified on PC4999 and dev3's isolated-4998 line with "seven ready worlds".

## 2. Surface exercised

`agents` roster · `agent_status` (both machines) · `exec` oneshot (local + cross-machine: happy path, timeout, signal, truncation, two-layer validation, concurrency) · `exec` PTY (local + cross-machine + persistence-across-calls) · `a2a` (open, resume, read sweep, two error legs) · better-dsh `dvc://ast_grep` device (schema face + live execution) · raw-wire 401 fence on the PC front door · code-level inspection of the installed dist.

## 3. Roster and status

- `agents`: 2 machines × 7 agents, all `ready:true, failed:false`. Local: DSH 0kdzjk (me), Claude 9xpbi4, Codex 92tgxg, Hermes dqsdy4, OMP 0yijnn, Pi ea3yvg, Antigravity yuaisr. PC: DSH ihs6bm, Antigravity a3k1ps, Claude dh2fh2, Codex w6tlxh, Hermes ebxnp0, OMP vcwk5l, Pi ha1ati.
- `agent_status skc8-ihs6bm` (PC DSH): 5-row window, alive-first, `agentAvailable:true` on its session rows, `collectedAt` on the 5-minute sweep — same shape as 0.1.7-g plus the `agentAvailable` field.
- `agent_status bfwu-9xpbi4` (local Claude): 5 rows, `agentAvailable:false` while idle, and an older A2A thread still visible as a `conversationId` row (`djio81`) — conversation rows persist in windows.

## 4. exec — oneshot

### 4.1 Happy paths
- Local (default machine): `exit:0`, streams separated, default cwd `/home/u1/.dsh`.
- Cross (`skc8`): identity leg `exit:0` in ~110 ms; default cwd is now `/home/u1/.dsh` on PC too (the 79he-era default of the mesh-p1 worktree is gone with the rotated lane).
- Machine label is not an exec target: `machine:"pc"` → `[E_EXEC_FAILED] unknown machine "pc" — call agents for the roster`. Roster ids only (`skc8`).

### 4.2 Timeout and signal
- `sleep 5` with `timeoutSec:1` → `exit:null, timedOut:true, outcome:"timeout"`, killed at **1019 ms** — the SIGTERM→SIGKILL ladder holds.
- `echo before; kill -KILL $$` → `exit:null, outcome:"signaled"` with the pre-kill line in stdout — the 0.1.7-g `signaled` distinction survives the major bump.

### 4.3 Truncation (30 000-byte boundary, exact)
- 5 000 `H` + 30 001 `T` (35 001 bytes) → `truncated:true`, returned payload is exactly the trailing 30 000 `T` bytes — head-drop tail semantics confirmed on 0.3.0-a.

### 4.4 Validation — two layers intact
| Input | Layer | Message |
|---|---|---|
| `timeoutSec: 1.5` | harness schema | `invalid arguments: "timeoutSec" must be an integer` |
| `cmd: ""` | hub parse | `[E_BAD_EXEC] exec: cmd must be a non-empty string` |
| `cwd: "relative/nope"` | hub parse | `[E_BAD_EXEC] exec: cwd must be an absolute path` |
| `timeoutSec: 0` | hub parse | `[E_BAD_EXEC] exec: timeoutSec must be an integer in [1, 600]` |
| ~4 400-char cmd | hub parse | `[E_BAD_EXEC] exec: cmd exceeds 4096 characters` |
| `machine: "pc"` | hub routing | `[E_EXEC_FAILED] unknown machine "pc"` |
| unknown address `zzzzzz-000000` (a2a) | hub parse | `[E_BAD_ADDRESS] agent must be a "<m4>-<a6>" address … call the agents action` |
| `stop` conversationId `zzzzzz` | a2a registry | `a2a: conversation "zzzzzz" is not in the registry` |

### 4.5 Concurrency
- Two same-block execs (each ~1.05 s) ran strictly sequentially — the second started ~50 ms after the first ended. Harness-side sequencing persists, same as 0.1.7-d/g.
- Hub-side wire concurrency was proven over raw HTTP in 0.1.7-g §4.6 and was not re-probed this round (cookie legs skipped).

### 4.6 Raw-wire fence
- Unauthenticated GET and POST to `https://test.pc.internal.test/api/superd/exec` → **401 `unauthorized`** in ~140 ms; Caddy front door healthy.

## 5. exec — PTY

- Cross-machine PTY on `skc8`: created with `cd /home/u1/workspaces/superd` + `SUPERD_PTY_PROBE=030a` (221 ms), then **reused** in a second call — `cwd` and the env var survived, `reconnected:false` (52 ms). Persistence is keyed per (session, machine), no label/spawn dance needed on this surface.
- Local PTY: `/dev/pts/1`, default cwd `/home/u1/.dsh`, 70 ms.
- 0.1.7-g defects **D1/D2 not reproduced**: PTY rode the MCP tool surface cleanly this round (the harness 0.2.0-rc.2 pair declares `mode`), so the schema-rejection → leaked-PTY chain has no opportunity; no orphan processes observed.

## 6. a2a

- Open leg: `send` to `skc8-ihs6bm` → `delivered`, conversation **z433pb**, `created:true`, receipt carries messageId/conversationId/sessionId (PC session e122456a).
- Resume leg: `send` with `conversationId:z433pb` and **agent omitted** → `delivered`, `created:false` — route derived from the conversation id as documented.
- `read` sweep: `count:0` (clean; replies auto-deliver at the peer's turn end and are not polled).
- Error legs: unknown address and unknown-conversation stop both rejected cleanly (table §4.4).
- Reply-path leg **completed post-push, both turns**: the peer's `SUPERD-TEST-20261008-ACK` (message a2a-cfc41628) and then `SUPERD-TEST-20261008-B-ACK` (message a2a-5654dc46) auto-delivered into this conversation through the hub relay (`form=relay`) — open → peer-turn → relayed-reply verified end-to-end for **both** injected turns, closing the reply-path re-probe left optional since 0.1.7-g. (The two replies arrived in two separate relay deliveries rather than one merged peer turn.) One nuance: asked for its super-dsh package version, the peer quoted its **harness** version (0.2.0-rc.2, `@deepseek-ai/dsh`) — PC's web profile runs super-dsh 0.1.12-a, so the answer reflects the DSH anchor, not the hub plugin.

## 7. better-dsh merge (new in 0.3.0-a)

- One plugin-manager install now carries both lines: `super-dsh@0.3.0-a` and `better-dsh@0.3.0-a` land in the same profile, both registered as bundle rows.
- `dvc://` device registry is live: `dvc://ast_grep` answers its schema face — `{patterns, path?, offset?, limit?, includeMeta?}`.
- Live execution: pattern `execEnabled` over the hub dist searched 118 files and returned structured JSON (`matches/totalMatches/filesSearched/limitReached`). Zero hits is correct semantics, not a failure — ast-grep matches AST patterns (a bare identifier pattern does not match property reads), so results differ from substring grep by design.
- `execEnabled` gate still present in the installed dist (`a2a-row.js`, `hub-tool.js`, `machines.js`, `mesh-rpc.js`); the live flip test from 0.1.7-d was not repeated.

## 8. Session notes (harness-side, not hub defects)

- Scripting pad cannot call hyphen-named tools programmatically (`tool["superd-hub"]` → `_DashrBindingHolder` not subscriptable); all hub legs therefore ran as direct tool calls.
- `cordis_inspect_query` `Tool.listTools` rejects `input:{}` — the field must be omitted entirely. Usage quirk only.
- ssh dev3→pc is healthy again (2026-09-29 known_hosts blocker cleared); this report went over scp instead of chunked exec.

## 9. Verdict

All probed legs green on `super-dsh 0.3.0-a` + harness `0.2.0-rc.2`: roster/status, oneshot exec (including timeout/signal/truncation/validation), cross-machine PTY with persistence, a2a open/resume/**relayed reply** with clean error legs, better-dsh device execution, and the unauth fence. Prior-round defect class D1/D2 did not reproduce. The only operational surprise is the PC machine-id rotation (`79he` → `skc8`), which silently invalidates old addresses and cross-references — worth remembering when reading older reports.

## 10. Delivery

- Local copy: `dev3:/home/u1/workspaces/superd/docs/test-reports/2026-10-08-superd-hub-first-person-0.3.0-a.md`
- Delivered: `pc:/home/u1/workspaces/superd/docs/test-reports/2026-10-08-superd-hub-first-person-0.3.0-a.md` via `scp` over the dev3→pc ssh alias; md5 verified identical on both sides.
- Addendum: §6 reply-path completion folded in after the first push; both copies re-synced by scp with the updated md5 re-verified.
- Addendum 2: §11 four-tool deep probe (CTX / LSP / AST / Browser) appended after the first two pushes; re-synced again with md5 re-verified.

## 11. Addendum — better-dsh four-tool deep probe (CTX / LSP / AST / Browser)

First-person pass over the four better-dsh tools flagged as most important. All read faces answer schema docs on `read dvc://<device>`; execution is `write dvc://<device>` with a JSON args object.

### 11.1 CTX (`ctx://session/<face>`) — session-log surface

- `ctx://session/transcript:N-M` — colon-form line window over the raw session log; returned the exact log entries (including `USER-INJECTED (user-approval)` policy-change lines) around this round's opening prompt.
- `ctx://session/transcript?q=B-ACK` — `?q=` is a plain full-log line filter; returned every line containing the token (tool-call payloads, relayed replies, my own turns, memory writes).
- `ctx://session/user_prompts` — compact prompt listing with `seq=` + entry ids; correctly showed the three prompts of this session.
- `ctx://session/compactions` — empty-state answer `(no compactions recorded)` on a session that has not compacted.
- Same-machinery faces not individually probed this round: `thinking`, `system`, `user_prompts[n]`, `tool_calls[n]`, `agent_responses[n]`.

### 11.2 LSP (`dvc://lsp`) — worked, with two onboarding gotchas

- `read dvc://lsp/status`: registry shows `typescript-language-server` available for ts/js; pyright / rust-analyzer / gopls unavailable on this host; `liveServers:[]`, gate `unasked`.
- `write {"action":"on"}` turns the per-session gate on ("servers warm-start per language on first file contact; no repo artifacts are written").
- Queries verified against a scratch TS project: **definition** (usage at line 5 → declaration line 1, exact columns), **references** (both sites incl. declaration), **hover** (markdown `function greet(name: string): string`), **diagnostics** with `all:1` (clean). Response shape: `{ok, server, file, root, position, locations|text|diagnostics}`; positions are 1-based line/character.
- Gotcha 1 — init-failure backoff: a failed server init is memoized per `${command}:${root}` for **180 s** (`INIT_FAILURE_BACKOFF_MS`), and the memo survives `off`→`on` and file-scoped `reload`; error text is `failed to initialize recently: …`. Change the root or wait out the window to retry.
- Gotcha 2 — TypeScript 7 is not usable: npm's current `typescript@7.0.2` is the native (Go) compiler and ships **no `tsserver.js`**; `typescript-language-server` rejects it (`provides no tsserver.js`). Workspace needs `typescript@5` (5.9.3 verified). Practically: install TS5 into the workspace **before** first LSP contact to avoid burning the backoff window.
- Escape hatches in args: `server` selects a `defaults.json` registry entry by name; `command`+`args` override the server line entirely. Device can also auto-provision servers into a `.vendor` root.

### 11.3 AST (`dvc://ast_grep` + `dvc://ast_edit`)

- `ast_grep` (search) already exercised in §7 — structured matches over 118 files, AST-pattern semantics.
- `ast_edit` (structural rewrite): `{ops:[{pat,out}], paths, dryRun?}` — **dryRun defaults to true**. Preview returned per-change records with `before/after`, `byteStart/byteEnd`, `startLine/startColumn/endLine/endColumn`, `applied:false`, plus `totalReplacements/filesTouched/filesSearched`.
- Real write (`dryRun:false`) → `applied:true`; file verified on disk: both `oldFn($A)` call expressions rewritten to `newFn($A)`, the unmatched `keepMe();` line untouched.
- Per its face text, ast_edit performs **no workspace boundary check** — it writes whatever paths it is given (the approval/policy layer is the boundary). Treat as trusted-surface tool.

### 11.4 Browser Use (`dvc://browser`) — headless Chrome via puppeteer-core, single tab

- `open`: `{"action":"open","url":"https://example.com"}` → `{ok:true, url, title:"Example Domain"}`.
- `run`: code is evaluated as an **expression** (a `return` statement fails with `Unexpected token 'return'`). Verified: `document.URL + …` → correct URL/title; `Array.from(document.querySelectorAll('a')).map(a => a.href).join(' , ')` → the page's iana.org link. One transient: the first expression evaluating `querySelector('h1')` returned null before later expressions saw the DOM — likely an early evaluate against the not-yet-settled page; a wait/retry is the workaround.
- `close`: `{"action":"close"}` → `{ok:true}`. Tab lifecycle is one tab per process (explicit subset of omp's multi-tab browser).

### 11.5 Addendum verdict

All four tools functional first-person on 0.3.0-a. CTX is the standout for long-session work (raw log windows + full-text filter + prompt index). LSP is production-capable once the two onboarding gotchas are respected (TS5-not-7 in the workspace; 180 s init-failure backoff that ignores off/on). ast_edit's dryRun-by-default and byte/line spans make structural rewrite safe to drive blind; browser is a lean but honest single-tab evaluate surface. No defects filed; gotchas recorded as usage constraints, not bugs.
