# superd-hub First-Person Test Report — 0.1.8-a (surface pass)

- Date: 2026-10-02 ~05:48–06:05 UTC (13:48–14:05 HKT)
- Tester: native DSH agent running **inside** the 4999 pack line on **PC** (`homepc`), calling the
  `superd-hub` model tool first-person — the P3 acceptance shape (spec §13 / plan 5b). No in-rig
  stand-in, no raw-RPC-only substitute: every leg below is a real call this session made.
- Nodes: local `79he` = PC (`homepc`); peer `bfwu` = dev3 (`srv1637772`).
- Direction: **PC → dev3** (cross-machine) **plus PC-local** same-version legs (native self-loop and
  a real foreign-runtime spawn), chosen because the two ends are **not on the same pack** this round
  (see §1 / §9 F1).
- Report written at `pc:/home/u1/workspaces/superd/docs/test-reports/2026-10-02-superd-hub-first-person-0.1.8-a.md`
  (identical copy committed to the dev line at
  `.worktrees/mesh-p1/docs/test-reports/2026-10-02-superd-hub-first-person-0.1.8-a.md`).

## 1. Versions under test

| Node | Host | Runtime |
|------|------|---------|
| `79he` (PC) | homepc, Linux 7.0.0-34-generic | unit `superd-4999-test.service`, PID 147363, started **2026-10-02 13:43:58 HKT**. Launcher `/usr/bin/node …/.worktrees/mesh-p1/upstream/deepseek-harness/apps/cli/lib/bin.js --profile superd-pub --no-open --trusted-host 192.0.2.130 --trusted-host test.pc.internal.test`; harness **`0.1.7-rc.1`**; pack **`super-dsh@0.1.8-a`** (tarball `file:` install, `.scratch/superd-pack/super-dsh-0.1.8-a.tgz`); `DSH_HOME=.worktrees/mesh-p1/.tests/superd`; worktree HEAD `3bb768c` |
| `bfwu` (dev3) | srv1637772, Linux 7.0.0-27-generic | hub lane PID 2513109 `~/.local/bin/dsh web --trusted-host dsh.dev3.internal.test`, pack **`super-dsh@0.1.7-n`** at `~/.dsh/profiles/web/node_modules/super-dsh` |

**The two ends are one revision apart.** The `0.1.7-m` round deliberately re-tested on a matched pair;
this round could not, because only the PC line was rebuilt/booted for `0.1.8-a` while dev3 still serves
`0.1.7-n`. That skew is not a footnote — it produced the round's largest finding (§9 **F1**), and it is why
the same-version A2A legs were run **locally** (native self-loop + a real Claude spawn) instead of across
the mesh.

## 2. Facility inventory — "hub tools, facilities, if any"

Inventory read from source (`superd-hub/src/hub-tool.ts`) and confirmed live against the installed dist:

| # | Surface | Entry point | This round |
|---|---------|-------------|-----------|
| 1 | Model tool **`superd-hub`**, one tool / call-shape dispatch, **6 actions**: `agents`, `send`, `read`, `stop`, `agent_status`, `exec` | ctx0 `tools` service, row `superd-hub` → `super-dsh/a2a` (`a2a-row.ts`, tool built by `hub-tool.ts`) | ✅ present, mounted, live |
| 2 | `exec` oneshot executor (local run + cross-machine post) | `exec.ts`, `mesh-rpc.ts` | ✅ |
| 3 | `exec` **persistent PTY** (one shell per `(initiator session, machine)`) | `exec-pty-*.ts` | ✅ local + cross-machine |
| 4 | A2A conversation service (open/resume, receipt, completion capture, stop) | `a2a-service.ts` | ✅ |
| 5 | A2A reply delivery face (relay / **transcript** / notice / bounded buffer) | `a2a-delivery.ts`, `a2a-ingest.ts` | ✅ relay + transcript + notice; buffer leg not live-reachable |
| 6 | Mesh federation (`/hub` family, `/api/superd/*`, WS mux, 5-min reprobe sweep) | `hub-route.ts`, `mesh-link.ts`, `gateway.ts` | ✅ HTTP + WS probed |
| 7 | Registries `machines.json` / `agent-ids.json` / `a2a-conversations.json` / `agent-status.json` under `<home>/superd/` | `machines.ts`, `agent-ids.ts`, `agent-status.ts` | ✅ |
| 8 | Agent-status sweep cache (alive-first, ≤5 rows) + D30 `lastOutput` | `agent-status.ts`, `hub-tool.ts:shapeAgentStatusWindow` | ✅ (D30 gap: §9 F3) |

**Action count is 6, not 7.** `new_conversation` was deleted outright by **D24** (no alias); it is absent
from the installed tool schema and the harness rejects it at the argument layer (§7.2). The tool's own
family framing is now `facility/status` (`agents`, `agent_status`) · `messaging` (`send`, `read`, `stop`) ·
`shell` (`exec`), with the lifecycle line "OPEN once (send with no conversationId) → then only `send` with
its conversationId".

## 3. Roster and machine status

- `{}` (empty args) and `{action:"agents"}` both return the thin roster — machine → agents, no session
  state. 2 machines × 7 agents = **14 rows, all `ready:true, failed:false`**:
  - `79he` (`local`): DSH `8ah589`, Claude `2wmzvq`, OMP `0d6xzz`, Codex `c6uxel`, Pi `xwes79`,
    Hermes `zdn2wp`, Antigravity `74tu6w`.
  - `bfwu` (`DEV3`): Antigravity `yuaisr`, Claude `9xpbi4`, Codex `92tgxg`, DSH `0kdzjk`, Hermes `dqsdy4`,
    OMP `0yijnn`, Pi `ea3yvg` — labels carry the `· dev3` suffix (new vs the `0.1.7-m` snapshot; good
    disambiguation for an operator staring at 14 rows).
- **Post-boot window (observation O1).** The line restarted at 13:43:58 to pick up the pack. At 13:48–13:49
  the roster read `bfwu: agents: []` and `GET /api/superd/machines` reported
  `{"id":"bfwu", …, "status":"pending"}` with **no `lastProbeAt`** — i.e. the peer is paired, enabled and
  reachable (cross-machine `exec` to it answered in 241 ms), yet the roster is empty until the first
  reprobe sweep runs (interval default 300 s; the **first** tick lands one full period after boot). At
  13:49:07 the sweep ran, status flipped to `reachable` (`lastProbeAt 1790920147177`) and all 7 DEV3 rows
  appeared. The `agents` listing carries **no machine status**, so a caller during that window cannot tell
  "peer down" from "peer not probed yet". See §9 O1.
- `agent_status` accepts a bare `a6` (`{agent:"8ah589", machine:"79he"}`) or a full address; cross-machine
  `agent_status bfwu-0kdzjk` returned a normal 5-row window.

## 4. `agent_status`

| Leg | Result |
|-----|--------|
| Local `79he-8ah589` | 5-row alive-first window; my own live session `4fd0e6` first (`busy`), companion sessions next — full UUIDs stay in the cache, display truncates to the uuid head |
| Peer `bfwu-0kdzjk` | 5-row window, works cross-machine |
| **F2 from `0.1.7-m` (the `[undefined]` title)** | **FIXED** — row `lunx18` now renders `(untitled) [hub A2A]`, not `[undefined] [hub A2A]` |
| Registry-joined rows | `conversationId` rides the row (`lunx18`, later `q3hghw`/`v5120n`/`1f7xzb`), title = `{title} [hub A2A]` |
| **Cache staleness** | `collectedAt` is the 5-minute sweep timestamp; after opening `q3hghw` at 13:50 the conversation was absent from the window until the 13:54:07 sweep. Matches the documented "not being in it implies nothing"; no defect |
| **D30 `lastOutput` (positive leg)** | At 13:54:07 `agent_status 79he-2wmzvq` returned `{conversationId:"1f7xzb", sessionId:"384857", title:"FP hub 0.1.8-a claude spawn leg [hub A2A]", status:"idle", lastOutput:"PONG-018A-STEER", lastOutputAt:1790920370960}` — the ownership gate passed because this session is the conversation's initiator |

The D30 **negative** leg (a non-initiator must not see `lastOutput`) is not reachable from a single
session and stays unit-covered. The D30 **coverage gap** is real and live-reproduced — see §9 F3.

## 5. `exec` — oneshot

| Leg | Call | Result |
|-----|------|--------|
| Local happy | `host/user/pwd/math/kernel` probe | `exit:0`, 90 ms, `cwd` = instance worktree root, `machine:"79he"` |
| Nonzero exit | `echo out; echo err >&2; exit 7` | `exit:7`, streams separated (`out-stream` / `err-stream`) |
| Timeout | `echo pre-timeout; sleep 5; …` + `timeoutSec:1` | `exit:null, timedOut:true, outcome:"timeout"`, killed at **1009 ms** |
| Signal death | `echo pre-kill; kill -KILL $$` | `exit:null, outcome:"signaled"`, `pre-kill` preserved |
| **Cross-machine** | same identity probe on `bfwu` | `exit:0`, **241 ms**, `host=srv1637772`, default cwd `/home/u1/.dsh` |
| `cwd` (oneshot) | `pwd` with `cwd:"/etc"` | `/etc` — honored |
| Concurrency (raw HTTP) | 4 × `sleep 1.5` in parallel | **wall 1621 ms**, per-call 1584–1586 ms — genuinely concurrent |

### 5.1 Validation — two layers, both intact

| Input | Layer | Message |
|---|---|---|
| `cmd: ""` | hub parse | `[E_BAD_EXEC] superd-hub: exec: cmd must be a non-empty string` |
| `cwd: "relative/nope"` | hub parse | `[E_BAD_EXEC] superd-hub: exec: cwd must be an absolute path` |
| `machine: "nonexistent-machine-zzz"` | hub routing | `[E_EXEC_FAILED] superd-hub: unknown machine "…" — call agents for the roster` |
| `timeoutSec: 1.5` | harness schema | `invalid arguments: "timeoutSec" must be an integer` |
| `timeoutSec: 0` / `601` (raw HTTP) | mesh API | `mesh-api: exec: timeoutSec must be an integer in [1, 600]` |
| 4 096-char `cmd` / 4 097-char `cmd` | mesh API | succeeds / `mesh-api: exec: cmd exceeds 4096 characters` |
| `machine` field on raw `/api/superd/exec` | mesh API | `unknown field "machine"` — the raw endpoint is local-only |
| malformed body | mesh API | `exec body is not valid JSON — …` |

### 5.2 Truncation boundary (exact)

| stdout size | `truncated` | returned payload |
|---|---|---|
| 30 000 B | `false` | 30 000 B |
| 30 001 B | `true` | **30 000 B — the tail** (head dropped) |

## 6. `exec` — persistent PTY

| Dispatch | Machine | Command | Result |
|---|---|---|---|
| 1 | `79he` | `cd /tmp && export PTY_PROBE=pc-018a && echo armed…` | `exit:0, cwd:"/tmp"`, 42 ms |
| 2 | `79he` | `echo dispatch2 pwd=$(pwd) probe=$PTY_PROBE` | **`/tmp` + `pc-018a` survive**; 1 ms (warm shell) |
| 3 | `79he` | `sleep 30; echo AFTER-TIMEOUT` + `timeoutSec:2` | `exit:130`, `timedOut:true`, 2002 ms |
| 4 | `79he` | `echo post-timeout-alive pwd=$(pwd) probe=$PTY_PROBE` | shell **alive**, cwd+env intact — timeout interrupts the command, not the session |
| 5 | `bfwu` | `cd /var/tmp && export XPTY_PROBE=dev3-018a && echo xarmed…` | `exit:0, cwd:"/var/tmp"`, 302 ms |
| 6 | `bfwu` | `echo xdispatch2 host=$(hostname) pwd=$(pwd) probe=$XPTY_PROBE` | `srv1637772`, `/var/tmp`, `dev3-018a` — persistence across the wire, 49 ms |

- **F1 from `0.1.7-m` (`cwd` silently ignored on PTY) — FIXED.** Both the local and the remote PTY leg now
  refuse it explicitly:
  `[E_BAD_EXEC] superd-hub: exec: cwd is not supported with mode "pty" — the persistent shell keeps its own cwd; use ``cd <dir> && …`` inside the command`.
- **No orphans / no leaks.** After all dispatches exactly **one** executor per host, correctly parented:
  local `script -qfec bash /dev/null` PID 150189 (ppid 147363 = this hub, own pgid); remote PID 2792802
  (ppid 2513109 = the dev3 hub). Every dispatch returned `reconnected:false`.

## 7. A2A — same-version legs (PC-local, 0.1.8-a ↔ 0.1.8-a)

Run locally precisely because the mesh is mixed-version (§9 F1).

### 7.1 Deterministic round trip — native self-loop

| Step | Call | Receipt |
|---|---|---|
| Open | `send` to `79he-8ah589`, title `FP hub 0.1.8-a local self-loop`, message asks for token `PONG-018A-LOCAL` | `outcome:"delivered"`, `conversationId:"q3hghw"`, `sessionId:"session-8a22f286-…"`, `created:true`, plus the D29 note *"reply auto-delivers as a new message in this conversation — never poll; read only sweeps buffered leftovers"* |
| Reply | responder session used the hub tool | `a2a.send.channel conversation=q3hghw from=79he-8ah589 latch=true` → `a2a.deliver.writeback via=self-route` → delivered into **this** session as `[superd-hub:a2a] kind=reply form=relay …` with the exact payload `PONG-018A-LOCAL` |

`read` swept `{"count":0,"messages":[]}` before, during and after — consistent with the documented
"replies ride as new messages, `read` only sweeps leftovers".

### 7.2 Resume leg, `agent` omitted (D24 route derivation)

| Leg | Receipt |
|---|---|
| Non-self (`1f7xzb`, Claude `2wmzvq`) | `outcome:"delivered"`, `conversationId:"1f7xzb"`, `sessionId:"session-38485746-…"` (**the responder's session**), `created:false` — the hub derived the route, injected into the responder session (`a2a.send.route-derived → completion.armed → ingest.done kind=message outcome=delivered`) |
| Self (`q3hghw`) | `outcome:"delivered"`, `sessionId:"session-4fd0e64e-…"` — **this session, not the responder's**; see §9 **F2** |

### 7.3 Foreign-runtime spawn (real Claude world)

`send` to `79he-2wmzvq` (Claude) returned `outcome:"delivered"` in the 10 s sync window with
`conversationId:"1f7xzb"`, `sessionId:"session-38485746-…"`, `created:true`; a real
`claude --output-format stream-json … --session-id=38485746-…` process appeared, parented to this hub.
Three turns were driven (open, resume, `delivery:"steer"`); every turn replied by **plain text**, so the
D20 **transcript** fallback carried it back:

```
[superd-hub:a2a] kind=reply form=transcript conversation=1f7xzb from=79he-2wmzvq message=a2a-relay-… note="the peer …"
PONG-018A-CLAUDE           (open)
PONG-018A-CLAUDE-RESUME    (resume, agent omitted)
PONG-018A-STEER            (delivery:"steer")
```

`delivery:"steer"` was accepted (`outcome:"delivered"`, same conversation/session) and produced its own
reply — no rejection, no duplicate.

### 7.4 Delivery inventory in the initiator session (8 artifacts, 0 duplicates)

| # | Conversation | Form | Payload |
|---|---|---|---|
| 1 | `q3hghw` | relay reply | `PONG-018A-LOCAL` |
| 2 | `q3hghw` | relay "reply" | **my own continuation text echoed back** — F2 |
| 3 | `v5120n` | relay reply | `STOP-PROBE-ACK` |
| 4 | `v5120n` | notice (`reason=stopped-by-initiator`) | "turn stopped by initiator request" |
| 5 | `1f7xzb` | transcript reply | `PONG-018A-CLAUDE` |
| 6 | `1f7xzb` | transcript reply | `PONG-018A-CLAUDE-RESUME` |
| 7 | `v5120n` | relay "reply" | **second continuation echoed back** — F2 |
| 8 | `1f7xzb` | transcript reply | `PONG-018A-STEER` |

No notice for the transcript turns (the channel produced an artifact, so the watch stayed quiet) — the
"at most one artifact per turn" invariant held everywhere except the stop race (§9 F4).

### 7.5 `stop`

| Leg | Result |
|---|---|
| Live-but-busy (`v5120n`, immediately after the open) | `{"stopped":true,"scope":"turn"}` — the hard-stop path works; the responder had already sent its channel reply (see F4) |
| Same conversation, now idle | `{"stopped":false,"scope":"turn","note":"no turn was active"}` |
| `scope:"session"` | `{"stopped":false,"scope":"turn-only","reason":"no session-close endpoint upstream","note":"no turn was active"}` — documented degradation honored |
| Registry-unknown id | `a2a: conversation "zznonexistent" is not in the registry` |

## 8. A2A — cross-version leg (PC 0.1.8-a → dev3 0.1.7-n)

One `send` open to `bfwu-0kdzjk` was enough to expose the skew:

```json
{"action":"send","outcome":"failed","messageId":"a2a-2c67a9c6-…","sessionId":"","created":true,
 "error":{"code":"gateway/uncaught","message":"a2a-wire: ingest receipt from https://dsh.dev3.internal.test
 is not a v1 receipt shape — {\"outcome\":\"injected\",\"messageId\":\"a2a-2c67a9c6-…\",
 \"conversationId\":\"d9i951\",\"sessionId\":\"session-88e2188d-be05-4e14-acbd-3b5bfb734203\"}"}}
```

The peer's own journal proves the envelope **did** arrive and **did** inject:

```
superd-hub: a2a.conversation.adopt conversation=d9i951 session=session-88e2188d-… peer=79he-8ah589 hostAgent=0kdzjk
superd-hub: a2a.completion.armed conversation=d9i951 session=session-88e2188d-… watermark=0
superd-hub: a2a.ingest.done kind=new-conversation outcome=injected message=a2a-2c67a9c6-…
```

…so the `failed` receipt is a **false negative**, and it has a second-order cost on this side:

```
superd-hub: a2a.send.fail      code=gateway/uncaught messageId=a2a-2c67a9c6-…
superd-hub: a2a.ingest.fail    code=a2a/conversation-not-found message=a2a-2652a725-…   ← the peer's reply
superd-hub: a2a.ingest.done    kind=message outcome=failed message=a2a-2652a725-… conversation=d9i951
superd-hub: a2a.deliver.local  conversation=d9i951 kind=notice outcome=followup from=bfwu-0kdzjk
```

Because the create receipt never parsed, the initiator row for `d9i951` was never recorded, so **the
peer's reply was dropped** (`mirrorRowOf` → `undefined` → `conversation-not-found`). Only the peer's
"send-failed" **notice** reached this session (notices route by address, no row needed). The reverse
direction is equally broken: dev3's own log shows it rejecting *our* receipt —

```
superd-hub: a2a.send.notice-fail conversation=d9i951 error="a2a-wire: ingest receipt from
 https://test.pc.internal.test is not a v1 receipt shape —
 {\"outcome\":\"delivered\",\"messageId\":\"a2a-notice-…\",\"conversationId\":\"d9i951\",\"sessionId\":\"session-4fd0e64e-…\"}"
```

Full analysis in §9 **F1**.

## 9. Findings

### F1 — MAJOR: mixed-version mesh breaks A2A in **both** directions (receipt vocabulary rename without tolerance)

- **Mechanism.** `a2a-wire.ts:355-358` validates a receipt as exactly
  `{outcome, messageId, sessionId}` (+ optional `conversationId`/`error`) with
  `outcome ∈ {'delivered','failed'}`. The D28 rename (`injected` → `delivered`) landed in `0.1.8-a`, so a
  peer on `0.1.7-n` — whose receipt is `{"outcome":"injected", …}` — fails the guard, which **throws**
  (`a2a-wire.ts:427`) instead of degrading. `A2A_WIRE_VERSION` stays `1` (it frames the *envelope*, not the
  receipt), so nothing in the exchange can detect or negotiate the skew.
- **Consequences observed (not inferred):**
  1. `send` returns `failed` / `gateway/uncaught` for a message that was delivered and injected.
  2. The initiator row is never recorded — the success path (`a2a-service.ts:1079`) and the D1
     failed-receipt hardening (`:1124`) both require a *parsed* answer, so the hardening is bypassed.
  3. The peer's subsequent channel reply hits `a2a-ingest.ts:432` `a2a/conversation-not-found` and is
     **silently lost**; the operator sees only a peer "send-failed" notice.
  4. The reverse leg fails the same way on the peer's side (their guard rejects our `delivered`), so the
     peer's "notice not delivered" state is also wrong.
- **Framing.** Half of this is environmental (dev3 not upgraded), but the *shape* is a robustness defect:
  a same-v1 peer's unknown-but-legible outcome should not be a hard protocol error, and a rejected receipt
  that carries `conversationId`+`sessionId` should still yield an addressable row so the reply leg survives.
- **Recommendation.** Accept `injected` as a legacy alias of `delivered` (tolerate-then-warn), and/or gate
  on a peer-advertised pack/protocol version; and record the initiator row from any receipt that carries
  ids, even when the outcome is rejected. Until then, **the mesh must be upgraded in lockstep** — which
  this round could not do (dev3 was left untouched, per the no-unrequested-restart discipline).

### F2 — MAJOR: continuations on a **self-addressed** conversation loop back to the initiator

- **Reproduction (2/2).** Open `q3hghw` to `79he-8ah589` (my own agent address): the *first* message works
  and the responder replies `PONG-018A-LOCAL`. Then any continuation —
  `send {conversationId:"q3hghw", message:…}` with `agent` omitted — returned
  `outcome:"delivered"` with `sessionId:"session-4fd0e64e-…"` (**this** session, not the responder's
  `8a22f286`) and the log shows `a2a.send.channel` → `a2a.deliver.writeback … via=self-route` instead of an
  injection. The initiator's own text then lands in its inbox as a `kind=reply form=relay` message
  attributed to the peer. Same for `v5120n` (second occurrence). The responder sessions
  (`8a22f286`, `68faa107`) contain **none** of the follow-up text.
- **Mechanism.** The self-route discriminator is
  `row.hostAgent !== undefined && env.from.machine === selfId() && env.from.agent === row.hostAgent`
  (`a2a-ingest.ts`, self-route write-back branch). When the conversation's target **is** the caller's own
  address, `from.agent === row.hostAgent` is true for the initiator's outbound continuation too, so it is
  classified as the peer's write-back. `kind:"new-conversation"` takes a different branch, which is why
  only the first message works. The spec (`docs/specs/machine-mesh-a2a/spec.md`) has no ruling for the
  same-address case.
- **Impact.** Silent; the failure mode is context-poisoning — an agent reads its own message back as a
  peer reply — and the "peer" never sees the follow-up, so the conversation is quietly one-way after the
  open. The roster advertises the local agent's own address with no caveat.
- **Recommendation.** Discriminate by session (`env.from.sessionId`), not address; or refuse a
  self-addressed conversation at `send` time with an explicit error and document it; or mark outbound
  sends so the ingest knows the direction.

### F3 — MAJOR (D30 coverage): `lastOutput` is never written for **channel** replies — only for transcripts

- **Live contrast on the same pack, same session:**

  | Conversation | Peer reply path | row `lastOutput` |
  |---|---|---|
  | `q3hghw` (native self-loop) | channel write-back (`kind=message`, `via=self-route`) | `null` |
  | `v5120n` (native self-loop) | channel write-back | `null` |
  | `1f7xzb` (Claude) | transcript fallback (`kind=reply`, `transcribed:true`) | `"PONG-018A-STEER"` ✅ |

- **Mechanism.** `recordLastOutput` (`a2a-ingest.ts:255-262`) has exactly one caller:
  `deliverLocal`'s reply branch (`:283`). Both write-back branches — self-route and peer — call
  `deliverReply` directly and return a receipt without touching it. So D30 only fires when the peer
  answers with **plain text** (transcript); the taught, primary path (the peer uses the hub tool) never
  populates it.
- **Impact.** `agent_status`'s `lastOutput` is effectively dead for channel-using peers — which is exactly
  the population D29 was written for ("`agent_status` is the status query"). The ownership gate itself
  verified positively (§4), so this is purely a missing writer.
- **Recommendation.** Call `recordLastOutput(row.shortId, env.message)` in both write-back branches, or
  persist `completion.text` at the turn boundary regardless of which artifact carried it.

### F4 — MINOR: stop-after-reply race yields contradictory artifacts

`v5120n` was opened and stopped immediately. The responder's channel reply landed first
(`a2a.send.ok … message=a2a-337a6b20`), then the stop was accepted (`a2a.stop … stopped=true scope=turn`),
and the completion watch then emitted a **`stopped-by-initiator` notice** — so the initiator received
**both** the answer and "turn stopped by initiator request", i.e. two artifacts for one turn. Cause: the
`stoppedAt > armedSentAt` branch (`a2a-ingest.ts:368`) is evaluated **before** the
`lastSentAt > armedSentAt` quiet branch (`:374`), so a stop stamped after the peer already sent its reply
overrides the "channel-send-in-window" rule. Low severity (both facts are individually true), but it
breaks the documented "a turn end yields at most ONE artifact" invariant. **Recommend** checking the
channel latch first, or suppressing the stop notice when the turn already produced a channel artifact.

### Observations

- **O1 — boot-time roster blind spot.** After a hub restart the remote roster is empty and
  `/api/superd/machines` says `status:"pending"` until the first reprobe sweep (default 300 s; first tick
  is one full period after boot), while `exec` to that same peer already works. `agents` exposes no machine
  status, so a model calling `agents` in that window sees a paired machine with zero agents and no reason.
  **Recommend** an explicit pending/unreachable marker on machine rows, or a boot-time probe.
- **O2 — `created:true` on failed opens.** `created` is computed syntactically
  (`hub-tool.ts:489`: `args.conversationId === undefined`), so `send` to an unknown agent/machine returns
  `outcome:"failed"` **with `created:true`** even though nothing was created. The field reads as a world
  fact; it is a request-shape flag. **Recommend** rename (`attemptedOpen`) or force false on failure.
- **O3 — error-code name drift.** A wrong `agent` on a continuation on the **same** machine returns
  `code:"a2a/conversation-machine-mismatch"` with the precise message
  `conversation "0dwf02" belongs to bfwu-0kdzjk, not bfwu-9xpbi4`. Only the label is off (it is an agent
  mismatch); the message itself is excellent. **Recommend** rename to `conversation-agent-mismatch`.
- **O4 — surface facts recorded as designed.** All world mounts (`/claude/`, `/omp/`, `/agy/`, `/codex/`,
  `/pi/`, `/hermes/`) return **404** (native-ui-only since 0.1.5); `/hub` returns 404
  `{"error":"foreign-only","message":"the /hub family serves ?agent=<label> foreign traffic only; native
  belongs to /api"}`; `/hub/api/remote.mux` is the WS entry. No defect — recorded so the next round does
  not re-litigate it.

### Fixed since `0.1.7-m`

- **F1 (PTY `cwd` silently ignored)** — fixed; explicit refusal on both local and remote legs.
- **F2 (`[undefined]` title in the UI)** — fixed; renders `(untitled)`.
- **Unknown-agent error wording** — still precise
  (`a2a: unknown-agent bfwu-zzzzzz (no such agent on machine bfwu)`).

## 10. Residual / not exercised

- `read`'s unread-buffer branch is still not live-reachable (needs the initiator torn down mid-flight);
  every call returned `{"count":0}`.
- **D28's `accepted` path was never triggered.** Every leg settled inside the 10 s sync window — local
  native (in-process), local foreign spawn (Claude), and cross-machine dev3 (its ingest is fast). The
  `accepted` receipt + background-settle notice therefore remains unit-covered only, as does
  `undelivered`. (The cross-version leg returns `failed`, which is a different branch.)
- `reconnected:true` (PTY transport-death recovery) not triggered; every dispatch returned `false`.
- The `execEnabled` disable gate was not flipped on the live mesh.
- D30's ownership gate **negative** leg is not observable from one session.
- A **dev3-initiated** conversation (dev3 → PC) was not run as a full conversation; the reverse direction
  is evidenced only through the peer's reply/notice legs and its own receipt-rejection log.
- The **client/Web UI hub face** was not exercised (no browser surface in this first-person session); the
  tool + HTTP/WS facility surface is the P3 acceptance shape.
- Cross-version behaviour of `agent_status`'s `lastOutput`/ownership gate not probed (no cross-version
  conversation could be established — F1).

## 11. Verdict

**Not green — green locally, broken as a mesh.** The six-action surface itself is coherent and well
guarded: 14-row roster, 5-row status windows with the `[undefined]` fix, oneshot exec with a correct
exit/stderr/timeout/signal taxonomy, exact 30 000-byte tail truncation, true concurrency, persistent PTY
with cwd+env survival, one clean executor per host, the `0.1.7-m` PTY-`cwd` fix, a same-version local round
trip with token-exact payloads, a real Claude spawn whose transcript replies auto-delivered, honest
`stop` semantics, and an intact 401 fence on both the HTTP and the WS front.

Against that, three findings block a green verdict: **F1** — the current mixed-version mesh cannot complete
A2A in either direction (false `failed`, dropped reply, no row) and the failure is a hard protocol throw
rather than a degradation; **F2** — a self-addressed conversation silently becomes one-way after the open,
with the initiator's own text echoed back as a peer reply; **F3** — D30's `lastOutput` never populates on
the channel path, so the new status field is effectively dead for the peers D29 targets. **F4** adds a
minor invariant break on the stop race, and O1–O3 are surface polish.

F1 is partly a deployment fact (dev3 still on `0.1.7-n`) and can be removed by upgrading dev3 to `0.1.8-a`
and re-running §8 — but the tolerance gap it exposes should be fixed regardless, because the mesh will
always have mixed-version windows during a rollout.

## 12. Test artifacts left behind (for the record)

- Conversations created live, left as inert registry rows (35 rows total, 3 added, no junk from the failed
  sends): `q3hghw` (native self-loop), `v5120n` (stop-busy probe), `1f7xzb` (Claude spawn leg). The peer
  carries a **desynced** mirror row `d9i951` with no local counterpart — a direct artifact of F1; it also
  holds a buffered reply for this session on the dev3 side.
- One persistent PTY shell per host, scoped to this session (PID 150189 on PC, 2792802 on dev3); reaped on
  session close. One live Claude process (PID 152069) for `1f7xzb`, parented to this hub — the expected
  idle foreign-runtime world, not an orphan.
- No process was killed, no service restarted, **dev3 was left running `0.1.7-n` untouched**, and no prod
  home (`~/.dsh` of the 3080/3081 instances, `~/.superd`) was touched. The 4999 line was left running and
  verified healthy (`GET /` with cookie → 200, unit `active`).

## 13. Addendum — live arrival in the model's own context

The eight artifacts inventoried in §7.4 from the session store surfaced as live conversational turns
immediately after the test turn ended, in order, one per turn, no duplicates — the loop is closed from the
*model's* side, not only at the store. They also carry the full D20 provenance wording, which is worth
quoting because it pins the two delivery forms to their sources:

```
[superd-hub:a2a] kind=reply form=relay conversation=q3hghw  from=79he-8ah589   → PONG-018A-LOCAL
[superd-hub:a2a] kind=reply form=relay conversation=q3hghw  from=79he-8ah589   → <my own continuation text>   (F2)
[superd-hub:a2a] kind=reply form=relay conversation=v5120n  from=79he-8ah589   → STOP-PROBE-ACK
[superd-hub:a2a] kind=notice          conversation=v5120n  reason=stopped-by-initiator
[superd-hub:a2a] kind=reply form=transcript conversation=1f7xzb from=79he-2wmzvq → PONG-018A-CLAUDE
[superd-hub:a2a] kind=reply form=transcript conversation=1f7xzb from=79he-2wmzvq → PONG-018A-CLAUDE-RESUME
[superd-hub:a2a] kind=reply form=relay conversation=v5120n  from=79he-8ah589   → <second continuation text>  (F2)
[superd-hub:a2a] kind=reply form=transcript conversation=1f7xzb from=79he-2wmzvq → PONG-018A-STEER
```

The transcript form carries `note="the peer never sent through the channel — this is the runtime delivering
the peer's last output at turn end"`. That sentence is, verbatim, the behaviour **F3** shows is *not*
persisted to the conversation row: the runtime grabs the last output at turn end for the transcript form
only, and the channel form — where the peer reaches the hub through its own tool — records nothing.
