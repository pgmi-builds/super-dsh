# superd-hub first-person test — super-dsh 0.1.7-d (dev3 → pc)

- **Date:** 2026-09-29, ~13:06–13:12 CST
- **Tester:** `dev3-deepseek-default`, session `session-9b6dcc3a-1661-48f6-8006-33b810cfe13f`, hub address **`bfwu-0kdzjk`**
- **Local:** dev3 / machine `bfwu` / `srv1637772`, Linux 7.0.0-27-generic, DSH `0.1.7-rc.2`, **super-dsh `0.1.7-d`** (profile dep `/tmp/super-dsh-0.1.7-d.tgz`)
- **Peer:** PC / machine `79he` / `homepc`, Linux 7.0.0-30-generic, origin `https://test.pc.internal.test`, peer hub cwd `/home/u1/workspaces/superd/.worktrees/mesh-p1`
- **Report destination:** `/home/u1/workspaces/superd/docs/test-reports/`
- **Method:** first-person. Every claim below was produced either by calling the live `superd-hub` tool from this session or by hitting the local hub's HTTP surface at `http://127.0.0.1:3080` with a cookie minted from the startup token URL. No code was modified; `~/.dsh/superd/machines.json` was temporarily edited once and restored byte-identical (§6).

Prior art at the destination: newest hub first-person report before this one is
`2026-09-28-superd-hub-first-person-0.1.6-k.md`; the directory holds 20 files and no
first-person report for the 0.1.7 line. This is the first 0.1.7-d pass.

---

## 0. TL;DR

| Area | Result |
|---|---|
| Tool surface (`superd-hub`, 7 legs) | **All legs answered**; roster, status, conversation, send, read, stop, exec |
| a2a local (`bfwu` → Pi `ea3yvg`) | **Green** — new conversation, follow-up, replies delivered as spliced **waking turns** (shell shows turn-trigger cards, not operator prompts — §2.6.1) |
| a2a cross-machine (`bfwu` → PC `79he-8ah589`) | **Green** — new conversation + follow-up, both replies relayed back (~3 s) |
| remote exec local + `79he` | **Green** — exit codes, stderr, cwd, unicode, truncation, timeout, concurrency |
| Timeout / group kill | **Green** — `SIGTERM`→`SIGKILL` to the process group; no orphan survived |
| 30 000-byte tail window | **Exact** — 30 000 → `truncated:false`; 30 001 → `truncated:true`, 30 000-byte tail |
| Auth fence | **Green** — every unauthenticated `/api/*` path, including a bogus one, is 401 |
| `execEnabled=false` gating | **Green** — remote refused, local unaffected, registry restored |
| Defects found | 1 real (silent bad-`cwd` failure), plus 4 observations/doc nits — §5 |

---

## 1. Facility inventory

The whole feature is **one model-facing tool**, `superd-hub`, dispatched by call shape.
It is registered by `superd-hub/dist/hub-tool.js` (`createSuperdHubTool`) and wired in
`a2a-row.js`; the executing side of exec is `superd-hub/dist/exec.js`.

| Leg | Call | What it does |
|---|---|---|
| roster | `{}` / `{action:"agents"}` | machines → agents, thin rows (`id`, `label`, `address`, `ready`, `failed`) |
| status | `{action:"agent_status", agent}` | that agent's session window from the 5-minute sweep cache |
| open | `{action:"new_conversation", agent, title?, message?}` | open a conversation; `message` is the first turn |
| send | `{action:"send", agent, conversationId?, message, delivery?}` | inject one user turn; follow-up when `conversationId` given |
| sweep | `{action:"read"}` | only messages buffered while this session was not live |
| stop | `{action:"stop", agent, conversationId, scope?}` | cancel the peer's active turn |
| exec | `{action:"exec", cmd, machine?, cwd?, timeoutSec?, mode?}` | one-shot `bash -lc <cmd>` locally or on a paired machine |

Shared HTTP surface (same `/api` fence, cookie auth):

| Route | Method | Result observed |
|---|---|---|
| `/api/superd/exec` | POST | one-shot exec; returns `{exit,stdout,stderr,durationMs,truncated,timedOut}` |
| `/api/superd/a2a` | POST | a2a wire ingest (v1 envelope) |
| `/api/superd/a2a/outbox?machine=<m4>` | GET | claim & clear buffered envelopes (declarative claim) |
| `/api/superd/machines` | GET | pairing view: `status:"reachable"`, `lastProbeAt` |

Operational journal (console → `journalctl --user -u dsh.service`), one line per event:
`a2a.conversation.new`, `a2a.send.ok`, `a2a.ingest.done`, `a2a.completion.armed`,
`a2a.completion.notice`, `a2a.deliver.local`, `a2a.deliver.writeback`, `a2a.route.deliver`,
`a2a.stop`, `a2a.exec.run`, `a2a.exec.remote`.

---

## 2. a2a — simple pass

### 2.1 Roster

`superd-hub` → 2 machines, 14 agents: `bfwu` (local) `DSH 0kdzjk, Claude 9xpbi4,
OMP 0yijnn, Codex 92tgxg, Pi ea3yvg, Hermes dqsdy4, Antigravity yuaisr`;
`79he` (PC) the same seven runtimes. All rows `ready:true`.

### 2.2 agent_status (cache read)

`bfwu-ea3yvg` and `79he-8ah589` both returned a 5-row window with `collectedAt`
≈ `1790658226555`/`…628`, alive-first. The PC DSH lane `8ah589` had
`agentAvailable:true` on three sessions; the local foreign-runtime lanes were all
`agentAvailable:false` (they activate on demand). Unknown agent id → empty window plus
the honest note *"no collected status for this agent yet … call agents for the roster"*.

### 2.3 new conversation (local)

```
new_conversation {agent:"bfwu-ea3yvg", title:"A2A simple test 0.1.7-d",
                  message:"… Reply with exactly … A2A-NEW-OK-7d4e"}
→ {conversationId:"k8h2e8",
   sessionId:"session-1eb3b25c-6c48-49d3-89bf-a3e8a752eb97",
   agent:"ea3yvg", machine:"bfwu"}
```

Journal: `a2a.conversation.new` → `a2a.completion.transcript bytes=15` →
`a2a.deliver.local conversation=k8h2e8 kind=reply outcome=followup from=bfwu-ea3yvg`.
First person, it arrived in **this** session (see §2.6).

### 2.4 follow-up

```
send {agent:"bfwu-ea3yvg", conversationId:"k8h2e8", message:"…A2A-FOLLOW-OK-9c1f"}
→ {outcome:"injected", messageId:"a2a-5260513d-cb2a-4c47-a3a1-a42c181e10d1",
   conversationId:"k8h2e8", sessionId:"session-1eb3b25c-…",
   note:"reply auto-delivers as a new message in this conversation — never poll;
         read only sweeps buffered leftovers"}
```

### 2.5 read / stop

| Call | Result |
|---|---|
| `read` | `{count:0, messages:[]}` — nothing buffered, replies auto-deliver (contract holds) |
| `stop` right after the follow-up (peer busy) | `{stopped:true, scope:"turn"}` |
| `stop` once the peer was idle | `{stopped:false, scope:"turn", note:"no turn was active"}` (D5) |
| `stop` with `scope:"session"` | `{stopped:false, scope:"turn-only", reason:"no session-close endpoint upstream", note:"no turn was active"}` |

The abort in the third row produced the no-reply notice in §2.6, and the journal line
`a2a.stop conversation=k8h2e8 stopped=true scope=turn` plus
`a2a.ingest.done kind=stop outcome=injected`.

### 2.6 Delivery record — first person

Decompressing my own session log
(`…/sessions/--home-u1-workspaces-base--/session-9b6dcc3a-…/session.v4.jsonl.zstd`)
shows the a2a turns landing as `agent/inbox/spliced` events with `"target":"next-turn"`:

| seq | source kind | text |
|---|---|---|
| 131 | `a2a-relay` (bfwu-ea3yvg) | `Agent bfwu-ea3yvg — last output at turn end (conversation "A2A simple test 0.1.7-d"):  A2A-NEW-OK-7d4e` |
| 161 | `a2a-notice` | `conversation "k8h2e8": turn ended, no reply`  (`reason:"peer"`) |
| 188 | `a2a-relay` (79he-8ah589) | `Agent 79he-8ah589 replied (conversation "A2A cross-machine simple test 0.1.7-d"):  A2A-XM-OK-b3a7` |
| 275 | `a2a-relay` (79he-8ah589) | `Agent 79he-8ah589 replied (conversation "A2A cross-machine simple test 0.1.7-d"):  A2A-XM-FOLLOW-OK-5e2d` |

Two shapes are visible and they are honest about their origin: a foreign runtime that
never used the channel contributes its **last output at turn end**, while a DSH peer
that answered through the channel is phrased as **replied**. The aborted turn yields
only the notice — no cause taxonomy (§5, F2).
### 2.6.1 What the shell renders — model turn ≠ operator prompt

The relay is delivered as an `agent/inbox/spliced` event (`target:"next-turn"`,
`inserted:[{role:"user", source:{kind:"a2a-relay"}}]`); at the next turn boundary the
harness promotes it to a real `user/message` event — seq **374** (a2a-relay), **383**
(a2a-notice), **392**, **401** — each with `surfaceOp:"append"`. **The model therefore sees
an ordinary user-role message**, which is why the earlier prose called it a turn.

The Web UI does not. `dsh-client-ui-chat`'s `messageDefinition` classifies a `user/message`
by `source.kind`: only `"user"` becomes an operator prompt (`kind:"user"`); every other
kind becomes a `kind:"context"` message, and when it **woke** the turn (`waking:true`, i.e.
claimed out of `inbox-next-turn`) `buildViewNode` re-kinds it **`turn-trigger`**.
`TurnTriggerNodeView` draws a collapsible card: title from `turnTriggerDetails(source)`,
body = the message text, sub-line `message.trigger.explanation`. `turnTriggerDetails` only
knows `goal`, `agent-message`, `team-message`, `subagent-settled`, `webhook`, `schedule`,
`tool-jobs`, `cordis-host-runner`; `a2a-relay` and `a2a-notice` fall through to the default
`message.trigger.request` — so the operator sees **"Execution requested"**, not a prompt:

```
Execution requested                                             13:12
This notification triggered this response.
Agent bfwu-ea3yvg — last output at turn end (conversation "A2A simple test 0.1.7-d"):
A2A-NEW-OK-7d4e
```

Machine-readable confirmation: `ctx://session/user_prompts` holds exactly the two operator
prompts (seq 17, seq 412). The four a2a deliveries, the approval-policy change (seq 16) and
the corti-memory / agent-instructions / runtime-context / skill-catalog injections
(seq 18–21) are all non-`user` sources and never appear there. So "the reply arrives as a
new message in this conversation" is exact at the model layer and inexact at the UI layer:
the delivery is a **waking turn**, surfaced as a turn-trigger card.

### 2.7 Cross-machine

```
new_conversation {agent:"79he-8ah589", title:"A2A cross-machine simple test 0.1.7-d", …}
→ {conversationId:"hec4zo", sessionId:"session-341098cd-88c1-4d9e-87d7-eec1521e29a7",
   agent:"8ah589", machine:"79he"}
```

Journal 13:07:59 `a2a.conversation.new … peer=79he-8ah589 initiator=bfwu-0kdzjk`, then at
13:08:02 `a2a.deliver.writeback conversation=hec4zo from=79he-8ah589 via=peer
outcome=followup` — a **3 s** round trip. A follow-up `send` on `hec4zo` was injected and
the reply splice arrived as seq=275.

### 2.8 Error legs

| Call | Error |
|---|---|
| `send` no agent | `[E_MISSING_AGENT] superd-hub: send requires agent ("<m4>-<a6>")` |
| `send` agent, no message | `[E_MISSING_MESSAGE] superd-hub: send requires a non-empty message` |
| `send` agent `notanaddress` | `[E_BAD_ADDRESS] superd-hub: agent must be a "<m4>-<a6>" address …` |
| `new_conversation` no agent | `[E_MISSING_AGENT] superd-hub: new_conversation requires agent ("<m4>-<a6>")` |
| `stop` no conversationId | `[E_MISSING_CONVERSATION] superd-hub: stop requires conversationId` |

Agent-before-message ordering still holds (0.1.6-k behaviour preserved).

---

## 3. remote exec — detailed pass

### 3.1 Happy path (tool), local and cross-machine

| # | machine | cmd | result |
|---|---|---|---|
| 1 | (omitted → `bfwu`) | `echo "exec-local-ok host=$(uname -n) epoch=…"` | `exit:0`, stdout verbatim, `stderr:""`, `durationMs:67`, `truncated:false`, `timedOut:false` |
| 2 | `bfwu` + `cwd:/home/u1` | `pwd; id -un; echo "shell=$0"` | `exit:0`, `/home/u1\nu1\nshell=bash\n` — `cwd` honoured, `bash -lc` |
| 3 | `bfwu` | `echo to-stdout; echo to-stderr >&2; exit 7` | `exit:7`, stdout `to-stdout`, stderr `to-stderr` — streams separate, exit code preserved |
| 4 | `79he` | `hostname; whoami; pwd; uname -sr` | `exit:0`, `homepc\nu1\n/home/u1/workspaces/superd/.worktrees/mesh-p1\nLinux 7.0.0-30-generic\n`, `durationMs:94` |
| 5 | `79he` + `cwd:/home/u1/workspaces/superd` | `pwd; ls docs/test-reports \| wc -l` | `exit:0`, `/home/u1/workspaces/superd\n20\n` |
| 6 | `bfwu` | `printf 'héllo\nλ-line\n'; printf 'diag-line\n' >&2; exit 3` | `exit:3`, UTF-8 intact both streams |
| 7 | `bfwu` explicit + `mode:"oneshot"` + `timeoutSec:600` | `echo explicit-self; hostname` | `exit:0` — explicit self id and max timeout accepted |
| 8 | `79he` after §3.7 restore | `echo post-restore-remote-ok; hostname` | `exit:0`, `homepc` |

**Default cwd** is the *hub process* cwd, inherited per side: local `bfwu` → `/home/u1/.dsh`;
peer `79he` → `/home/u1/workspaces/superd/.worktrees/mesh-p1`. `HOME=/home/u1`, `SHLVL=1`,
`$0=bash`.

Cross-machine latency for trivial commands was **90–113 ms** (`a2a.exec.remote` →
`a2a.exec.run`), i.e. the pairing origin adds no perceptible overhead here.

### 3.2 Timeout and group kill

| cmd | `timeoutSec` | result |
|---|---|---|
| `sleep 30; echo never-should-print` | 2 | `{exit:null, timedOut:true, durationMs:2015}` |
| `sleep 300 & echo "bg-pid=$!"; wait` | 1 | `{exit:null, timedOut:true, durationMs:1013, stdout:"bg-pid=2343839\n"}` |
| `sleep 120; echo done120` | 1 | `{exit:null, timedOut:true, durationMs:1016}` |
| `sleep 30; echo never-should-print-remote` (`79he`) | 2 | `{exit:null, timedOut:true, durationMs:2012}` |

`durationMs` tracks the budget within ~16 ms, so the timer fires on time.

**Orphan check.** After the `sleep 120` leg, `pgrep -x sleep -a` showed exactly one
`sleep 30`, whose parent is `/bin/bash /scripts/init-without-ocr.sh` (pid `3699748`, started
Sep 10) — an unrelated host monitor, not a test descendant, and it cycles its pid. No
timed-out command survived, including the backgrounded `wait` child. Group kill is clean.

### 3.3 Output window and truncation

Local tool runs and the HTTP endpoint agree exactly:

| total stream bytes | returned `stdout` length | `truncated` |
|---|---|---|
| 29 999 | 29 999 | `false` |
| 30 000 | 30 000 | `false` |
| 30 001 | 30 000 | `true` |
| 32 768 | 30 000 | `true` |
| `seq 1 20000` (≈108 KB) | 30 000, first line `15001` | `true` |

The window is a **tail**: the last 30 000 bytes, not the first. The same holds for stderr
(`seq 1 20000 1>&2` → `stderr` 30 000 bytes, stdout empty, `truncated:true`).

### 3.4 Exit-code semantics

| cmd | `exit` | `timedOut` | reading |
|---|---|---|---|
| `exit 7` | `7` | `false` | normal non-zero |
| `kill -KILL $$` | `null` | `false` | died by signal |
| `sleep 30` + `timeoutSec:2` | `null` | `true` | timed out |
| `cwd:/nonexistent-xyz-777` | `null` | `false` | **spawn failed silently** (F1) |

### 3.5 Validation matrix

The rules live in one place, `parseOneShotExecBody`, and are shared verbatim by the tool
and the endpoint; only the error prefix differs (`[E_BAD_EXEC] superd-hub:` vs
`mesh-api:`).

| Input | Tool surface | HTTP endpoint |
|---|---|---|
| unknown `machine:"zzzz"` | `[E_EXEC_FAILED] … unknown machine "zzzz" — call agents for the roster` | n/a (initiator-side) |
| `cwd:"relative/dir"` | `[E_BAD_EXEC] … exec: cwd must be an absolute path` | `400 {"error":"mesh-api: exec: cwd must be an absolute path"}` |
| `timeoutSec:0` | `[E_BAD_EXEC] … exec: timeoutSec must be an integer in [1, 600]` | same rule (600/601 tested: 601 → `400`) |
| `timeoutSec:1.5` | `invalid arguments: "timeoutSec" must be an integer` — **harness schema**, before execute (F4) | n/a |
| `cmd:""` / blank | (schema-level, same as HTTP) | `400 … cmd must be a non-empty string` |
| `cmd` > 4096 chars | not reachable via a sane call | `400 … cmd exceeds 4096 characters` |
| unknown field in body | not reachable via tool schema | `400 … exec: unknown field "nope"` |
| body `[]` | not reachable | `400 … request body must be a JSON object` |
| malformed JSON | not reachable | `400 {"error":"mesh-api: exec body is not valid JSON — Expected property name or '}' …"}` |
| `GET /api/superd/exec` | n/a | `405 … method GET is not supported on /api/superd/exec (use POST)` |
| `mode:"pty"` | `{action:"exec", note:"exec mode \"pty\" (persistent terminal over WS) is not implemented yet …"}` | n/a |

### 3.6 Concurrency

Four parallel `POST /api/superd/exec` requests (`sleep 2` each) from one shell:

```
s1=1790658531.813947912  e1=1790658533.830900064  durationMs=2076
s2=1790658531.839616640  e2=1790658533.855789516  durationMs=2085
s3=1790658531.859504187  e3=1790658533.867936870  durationMs=2077
s4=1790658531.869063223  e4=1790658533.877909769  durationMs=2068
```

All four start inside **55 ms** and finish together — the hub does not serialise execs.
(Note: three *tool* calls issued in one assistant message are ordered by the harness
itself, so they are not evidence either way; the HTTP batch is the valid probe.)

### 3.7 Per-machine gating (`execEnabled`)

Backed up `~/.dsh/superd/machines.json`, set `remotes[0].execEnabled=false` for `79he`:

- `exec {machine:"79he", cmd:"echo SHOULD-NOT-RUN-ON-PC"}` →
  `[E_EXEC_FAILED] superd-hub: exec is disabled for machine "79he" on this registry row (execEnabled=false)`
- `exec {cmd:"echo local-unaffected"}` → `exit:0` (the knob is per-machine, initiator-side)
- restored from backup; `diff` against the pre-test copy → **IDENTICAL**; remote exec re-verified in §3.1 row 8.

The gate throws before any bytes leave, exactly as the tool description says.

### 3.8 Journal observability

- Executing side logs the result:
  `superd-hub: a2a.exec.run cmd="seq 1 20000" exit=0 durationMs=48 truncated=true`
  (`exit=none`, `timedOut=true`, `truncated=true` markers appear only when true).
- Initiator side logs the **request only** for remote legs:
  `superd-hub: a2a.exec.remote machine=79he cmd="…" timeoutSec=120`. There is no matching
  completion line on the initiator, so a remote result lives only in the tool response —
  see F6.

---

## 4. HTTP facility

- **Fence:** unauthenticated requests to `/api/superd/exec`, `/api/superd/a2a`,
  `/api/superd/machines`, `/api/superd/outbox` **and** a deliberately bogus `/api/nope`
  all return `401 unauthorized` — deny-by-default, the fence does not leak route existence.
- **Cookie:** the startup log line `dsh web: http://127.0.0.1:3080/?token=…` (current pid
  `2342394`, token `sHG5…sBDs`) responds `303 See Other` + `Set-Cookie:
  dsh-auth-…=v1.…; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`. That jar then
  authorises every route above.
- `/api/superd/machines` (authed) → `{"self":{"id":"bfwu","label":"local"},
  "machines":[{"id":"79he", …, "status":"reachable","lastProbeAt":1790658226700}]}`.
- `/api/superd/a2a` POST validation: `{}` → `400 a2a-wire: unsupported frame version
  undefined (protocol v1)`; `[]` → `400 a2a-wire: frame must be a JSON object`.
- `/api/superd/a2a/outbox` without `?machine=` → `400 … requires a non-empty ?machine=
  query parameter`; with `machine=zzzz` → `200 {"v":1,"envelopes":[]}`.
- `/api/superd/outbox` (authed, no `/a2a`) → `404 not found` (F3).

---

## 5. Findings

**F1 — real defect (minor): a bad `cwd` fails silently.**
`exec {cwd:"/nonexistent-xyz-777", cmd:"pwd"}` →
`{"exit":null,"stdout":"","stderr":"","durationMs":10,"truncated":false,"timedOut":false}`.
`runOneShotExec` does `child.once('error', () => resolve(null))`, so the spawn error is
discarded: no message, no exit code, no flag. A typo'd or unprovisioned directory is
indistinguishable from a process that died on a signal. *Impact:* a misconfigured cwd looks
like a silent no-op instead of a failure. *Suggestion:* put the error text into `stderr`
(or a new `error`/`outcome` field) and/or set a distinguishable flag.

**F2 — observation: `exit:null` is one sentinel for three outcomes.** Timeout is
disambiguated by `timedOut:true`; a signal death (`kill -KILL $$`) and a spawn failure both
return `exit:null, timedOut:false`. An `outcome` enum (`exited|signaled|timeout|spawn-error`)
would remove the ambiguity. Related: the no-reply a2a notice carries no cause taxonomy
(§2.6, seq 161), so an operator cannot tell an aborted turn from a runtime failure.

**F3 — doc nit: the outbox route is one path segment deeper than the prose implies.** The
code comments and README say "GET outbox"; the real route is
`GET /api/superd/a2a/outbox` (`A2A_OUTBOX_PATH` in `a2a-wire.js`). An authenticated
`GET /api/superd/outbox` returns `404 not found`.

**F4 — layering note: `timeoutSec` non-integers never reach the parser via the tool.**
The tool declares `timeoutSec` as `integer`, so `1.5` is rejected by the harness input
schema (`invalid arguments`) before `execute` runs; the parse-level branch is only
reachable over HTTP (verified `400`). Not a defect — but tool-level tests for that branch
must be written against the endpoint, not the tool.

**F5 — good placeholder discipline.** `mode:"pty"` returns a note and spawns nothing; no
error, no half-built streaming surface.

**F6 — observability nit: remote exec has no initiator-side completion line.** Local runs
log `a2a.exec.run` with `exit`/`durationMs`/`truncated`/`timedOut`; remote runs log only
`a2a.exec.remote … cmd=… timeoutSec=…`. The peer logs the run, but from the initiator's
journal you cannot see whether the command succeeded. A `a2a.exec.remote.done` line would
close the loop.

**F7 — UX: a2a turns render with a generic title.** `a2a-relay` / `a2a-notice` are not among
the source kinds `turnTriggerDetails` knows, so both fall to the `default` branch: title
`message.trigger.request` = **"Execution requested"**, explanation "This notification
triggered this response." A recognized kind would read better — `agent-message` maps to
"Task message received" — or upstream could declare an a2a kind. Cosmetic; delivery,
ordering and exactly-once are unaffected.


Everything else matched the documentation and the spec comments: address validation, the
`[E_*]` taxonomy and ordering, the tail window, the group kill, the `execEnabled` knob,
and the never-poll delivery contract.

---

## 6. Hygiene / restoration

- `~/.dsh/superd/machines.json` was backed up (`/tmp/machines.json.bak`), mutated only for
  §3.7, and restored; `diff` reports **IDENTICAL**. Nothing else on disk was modified on
  either machine.
- No orphaned processes: every timed-out command's group was reaped (`pgrep -x sleep`
  showed only the unrelated `/scripts/init-without-ocr.sh` child).
- Test residue: `/tmp/c1..c4.json`, `/tmp/long.json`, `/tmp/cj.txt`, `/tmp/machines.json.bak`,
  `/tmp/hub-report-0.1.7-d.b64` (removed on PC after decoding). The two a2a conversations
  `k8h2e8` (Pi, local) and `hec4zo` (DSH, PC) remain as normal history, by design.
- The `bfwu` auth cookie minted for §4 expires in 30 days; it lives only in `/tmp`.

---

## 7. Verdict

super-dsh **0.1.7-d** behaves as specified in every leg this pass could reach. The P4
one-shot remote exec is the headline and it holds up: correct exit/stderr/cwd semantics,
an exact 30 000-byte tail window with an honest `truncated`, a two-stage group kill with no
orphans, real concurrency, and an initiator-side per-machine `execEnabled` gate that throws
before any bytes leave. The a2a channel is simple and honest: replies auto-deliver as
spliced waking turns (never poll), `read` sweeps only leftovers, `stop` distinguishes an
active turn from an idle one, and cross-machine send/follow-up round-trips in ~3 s.

The only real defect is F1 — a bad `cwd` failing with an empty, `null`-exit shape and no
diagnostic — which is a small, self-contained fix in `exec.js`'s `error` handler.

---

## Appendix A — representative journal lines

```
superd-hub: a2a.conversation.new conversation=hec4zo session=session-341098cd-… peer=79he-8ah589 initiator=bfwu-0kdzjk
superd-hub: a2a.deliver.writeback conversation=hec4zo from=79he-8ah589 via=peer outcome=followup
superd-hub: a2a.deliver.local conversation=k8h2e8 kind=reply outcome=followup from=bfwu-ea3yvg
superd-hub: a2a.completion.notice conversation=k8h2e8
superd-hub: a2a.stop conversation=k8h2e8 stopped=true scope=turn
superd-hub: a2a.exec.run cmd="sleep 47; echo orphan-47-done" exit=none durationMs=1014 timedOut=true
superd-hub: a2a.exec.run cmd="python3 -c \"…('a'*30001)\"" exit=0 durationMs=50 truncated=true
superd-hub: a2a.exec.remote machine=79he cmd="pwd; ls docs/test-reports | wc -l" timeoutSec=120
```

## Appendix B — how this report was delivered

Written locally on dev3 (`/tmp/hub-report-0.1.7-d.md`), then written to PC over the `pc`
ssh host (`ssh pc 'cat > …docs/test-reports/2026-09-29-superd-hub-first-person-0.1.7-d.md'`
with the local file on stdin) and integrity-checked with `md5sum` on both ends. The
delivered file was then read back through the facility under test —
`superd-hub {action:"exec", machine:"79he", cmd:"md5sum …; wc -l -c …"}` — plus `ls -l`
and `head` for a content spot-check. A chunked base64-over-exec delivery would also work
(the exec `cmd` cap is 4096 characters), but this report is ~22 KB, so ssh carries it in
one round trip; the exec leg is what verified it on the far side.
