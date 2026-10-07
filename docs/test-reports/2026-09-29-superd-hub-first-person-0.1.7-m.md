# superd-hub First-Person Test Report — 0.1.7-m (PC → dev3)

> **Terminology correction (appended by the pc-deepseek-default owner, 2026-09-29 night).**
> Same correction as the 0.1.7-g round: "MCP tool surface/leg" below means the **DSH-native
> tool** `superd-hub` (registered by our plugin row via `@deepseek-ai/dsh-tools`), not the MCP
> protocol. superd has no MCP client or server.


- Date: 2026-09-29 ~12:2x UTC (20:2x HKT)
- Tester: native DSH agent running **inside** the 4999 test line on **PC** (`homepc`), calling the
  `superd-hub` model tool first-person — the exact P3 acceptance shape (spec §13 / plan 5b).
  No in-rig stand-in, no raw-RPC-only substitute: every tool leg below is a real call this session made.
- Nodes: local `79he` = PC (`homepc`); peer `bfwu` = dev3 (`srv1637772`).
- Direction: **PC → dev3**. The two preceding first-person rounds (`0.1.7-d`, `0.1.7-g`) were driven from
  dev3 against PC, so this round is also a direction flip / independent replication.
- Report written locally on PC at
  `pc:/home/u1/workspaces/superd/docs/test-reports/2026-09-29-superd-hub-first-person-0.1.7-m.md`.

## 1. Versions under test

| Node | Host | Runtime |
|------|------|---------|
| `79he` (PC) | homepc, Linux 7.0.0-34-generic | unit `superd-4999-test.service`, PID 62889, started 19:56:54 HKT. Launcher = in-tree worktree build `…/.worktrees/mesh-p1/upstream/deepseek-harness/apps/cli/lib/bin.js --profile superd-pub`; harness **`0.1.7-rc.1`**; pack **`super-dsh@0.1.7-m`** (tarball `file:` install, `.scratch/superd-pack/super-dsh-0.1.7-m.tgz`); `DSH_HOME=.worktrees/mesh-p1/.tests/superd`; worktree HEAD `9f72dd4` |
| `bfwu` (dev3) | srv1637772, Linux 7.0.0-27-generic | hub lane PID 2392606 `node /home/u1/.local/bin/dsh web --trusted-host dsh.dev3.internal.test`, started ~19:58 HKT — i.e. **after** the 19:57:11 HKT pack install, so it loaded pack **`0.1.7-m`** at `~/.dsh/profiles/web/node_modules/super-dsh` (both ends on the same pack this round) |

Both ends therefore run **0.1.7-m**, i.e. the revision that carries the `0.1.7-h..m` fixes for the
D1/D2 defects filed by the `0.1.7-g` round. Re-testing those two defects was a primary goal.

## 2. Facility inventory — "hub tools, facilities, if any"

The question the brief asks first is *what exists*. Inventory read from source
(`superd-hub/src/`) and confirmed live:

| # | Surface | Entry point | This round |
|---|---------|-------------|-----------|
| 1 | Model tool **`superd-hub`**, one tool / call-shape dispatch, **7 actions**: `agents`, `agent_status`, `new_conversation`, `send`, `read`, `stop`, `exec` | ctx0 `tools` service, row `superd-hub` → `super-dsh/a2a` (`a2a-row.ts`, tool built by `hub-tool.ts`) | ✅ present, mounted, live |
| 2 | `exec` oneshot executor (local run + cross-machine post) | `exec.ts`, `mesh-rpc.ts` | ✅ |
| 3 | `exec` **persistent PTY** (one shell per `(initiator session, machine)`) | `exec-pty-session.ts` / `-channel.ts` / `-framing.ts` / `-rpc.ts` | ✅ **live over the tool surface** (was blocked in 0.1.7-g) |
| 4 | A2A conversation service (registry, create/resume, receipt, completion capture, stop) | `a2a-service.ts` | ✅ |
| 5 | A2A reply delivery face (`relay` / `notice`, follow-up routing, bounded buffer) | `a2a-delivery.ts` | ✅ relay leg; buffer leg still not live-reachable |
| 6 | A2A wire + ingest (hub↔hub envelopes, mirror-row adoption) | `a2a-wire.ts`, `a2a-ingest.ts` | ✅ |
| 7 | Mesh federation (`/hub` family, `/api/superd/*`, WS mux) | `hub-route.ts`, `mesh-gateway.ts`, `mesh-federate.ts`, `gateway.ts` | ✅ (HTTP + WS probed) |
| 8 | Registries `machines.json` / `agent-ids.json` / `a2a-conversations.json` / `agent-status.json` under `<home>/superd/` | `machines.ts`, `agent-ids.ts`, `agent-status.ts` | ✅ |
| 9 | Agent-status sweep (5-minute cache) | `agent-status.ts` + `mesh-link.ts` sweep collectors | ✅ |

Everything in the brief's "tools, facilities" resolves to surfaces 1–9; there is no tenth thing.
Action count is **7**; `agent_status` was the 7th (the 2026-09-28 canonical inventory listed 6, and
`0.1.7-g` already carried `agent_status`), so this round adds no new action but confirms all 7.

## 3. Roster and status

- `agents`: 2 machines × 7 agents = **14 rows, all `ready:true, failed:false`**. Local `79he`:
  DSH `8ah589`, Claude `2wmzvq`, OMP `0d6xzz`, Codex `c6uxel`, Pi `xwes79`, Hermes `zdn2wp`,
  Antigravity `74tu6w`. Peer `bfwu`: Antigravity `yuaisr`, Claude `9xpbi4`, Codex `92tgxg`,
  DSH `0kdzjk`, Hermes `dqsdy4`, OMP `0yijnn`, Pi `ea3yvg`.
- `agent_status 79he-8ah589`: 5-row alive-first window; includes A2A rows carrying
  `conversationId` with `agentAvailable:false` (`lunx18`, `6icqiz`).
- `agent_status bfwu-0kdzjk`: works cross-machine; window returned.
- **Cache semantics observed**: `collectedAt` did not advance across the ~20-minute round
  (`1790684523354` / `…324346`), so the three conversations opened mid-round never appeared in the
  window. This matches the documented "absence from the window implies nothing" caveat — no defect.

## 4. `exec` — oneshot

| Leg | Call | Result |
|-----|------|--------|
| Local happy | `echo host/user/pwd; echo math=$((6*7))` | `exit:0`, 83 ms, `outcome:"exited"`, cwd = instance worktree root |
| Nonzero exit | `echo out; echo err >&2; exit 7` | `exit:7`, stdout `out`, stderr `err` — streams separated |
| **Cross-machine** | same shell identity probe on `bfwu` | `exit:0`, **43 ms**, `host=srv1637772`, default cwd `/home/u1/.dsh` |
| Timeout | `sleep 5` + `timeoutSec:1` | `exit:null, timedOut:true, outcome:"timeout"`, killed at **1010 ms** |
| Signal death | `echo pre-kill; kill -KILL $$` | `exit:null`, `outcome:"signaled"`, `pre-kill` preserved — taxonomy holds |
| Truncation boundary | exactly 30 000 B stdout | `truncated:false` |
| Truncation boundary | 30 001 B stdout (+6 B count line) | `truncated:true`; returned payload is the **tail** (head dropped) |

### 4.1 Validation — two layers, both intact

| Input | Layer | Message |
|---|---|---|
| `timeoutSec: 1.5` | harness schema | `invalid arguments: "timeoutSec" must be an integer` |
| `cmd: ""` | hub parse | `[E_BAD_EXEC] superd-hub: exec: cmd must be a non-empty string` |
| `cwd: "relative/nope"` | hub parse | `[E_BAD_EXEC] superd-hub: exec: cwd must be an absolute path` |
| `machine: "nonexistent-machine-zzz"` | hub routing | `[E_EXEC_FAILED] superd-hub: unknown machine "…" — call agents for the roster` |
| `timeoutSec: 0` / `601` (raw HTTP) | mesh API | `mesh-api: exec: timeoutSec must be an integer in [1, 600]` |
| **4 097-char `cmd`** (raw HTTP) | mesh API | `mesh-api: exec: cmd exceeds 4096 characters` (4 096 chars **succeeds**) |
| `machine` field on raw `/api/superd/exec` | mesh API | `mesh-api: exec: unknown field "machine"` — the raw endpoint is **local-only**; cross-machine is reached by calling the peer's endpoint |

### 4.2 Concurrency

- Four parallel raw-HTTP execs (`sleep 1.5` each) → **wall 1.64 s**, per-call durations 1586–1590 ms.
  The hub genuinely executes concurrently. (One-block MCP tool calls remain harness-sequenced, as
  previously documented — unchanged, and not a hub property.)

## 5. `exec` — persistent PTY (D1/D2 retest)

**7 successful PTY dispatches** over the MCP tool surface (5 local, 2 cross-machine), plus 2
validation rejections.

### 5.1 D1 (0.1.7-g: PTY rejected by harness output schema) — **FIXED**

`exec` with `mode:"pty"` now returns a valid tool result. Response shape:
`{action, mode:"pty", machine, output, exit, cwd, timedOut, reconnected, durationMs}` — `mode` is
declared in the tool's output schema in the installed dist (`hub-tool.js` carries the explicit
lockstep comment naming D1). **PTY is usable through the MCP surface.**

Local legs:

| Dispatch | Command | Result |
|---|---|---|
| 1 | `cd /tmp && export PTY_PROBE=pc-017m && echo armed…` | `exit:0, cwd:"/tmp"`, 44 ms |
| 2 | `echo dispatch2 pwd=$(pwd) probe=$PTY_PROBE` | **`pwd=/tmp`, `probe=pc-017m`** — cwd **and** env survive; 1 ms (warm shell) |
| 3 | `sleep 30` + `timeoutSec:2` | `exit:130` (SIGINT), `timedOut:true`, 2002 ms |
| 4 | `echo post-timeout-alive pwd=$(pwd) probe=$PTY_PROBE` | shell **alive** at `/tmp`, env intact — timeout interrupts the command, not the session |
| 5 | `pwd` with `cwd:"/etc"` passed | `cwd:"/tmp"` — see **F1** |

Cross-machine legs (`bfwu`):

| Dispatch | Command | Result |
|---|---|---|
| 1 | `cd /var/tmp && export XPTY_PROBE=dev3-017m && echo xarmed…` | `exit:0, cwd:"/var/tmp"`, 593 ms |
| 2 | `echo xdispatch2 host=$(hostname) pwd=$(pwd) probe=$XPTY_PROBE` | `host=srv1637772, pwd=/var/tmp, probe=dev3-017m` — persistence across the wire; 51 ms |

Guard legs on the PTY branch: `cmd:""` → `[E_BAD_EXEC]`; `machine:"nope-zzz"` →
`[E_EXEC_FAILED] unknown machine`.

### 5.2 D2 (0.1.7-g: orphaned PTY executor + leaked WS) — **not reproduced**

- After all 7 dispatches, **exactly one** executor exists per host — local
  `script -qfec bash /dev/null` PID 72060 (ppid 62889 = this hub, pgid own) and peer PID 2395641
  (ppid 2392606 = dev3 hub). Both are the expected **live** persistent shells for *this* session,
  which reap on session close. No orphans on either host.
- Note on coverage honesty: D2's original trigger was the harness *rejecting the tool result*, which
  discarded the caller's handle without closing the channel. With D1 fixed that path is no longer
  reachable through normal use, so D2 was not re-triggered end-to-end; what is proven is that the
  normal lifecycle (including a timeout/interrupt) leaves no orphan. The abandonment path remains
  covered by unit tests only.

## 6. A2A

### 6.1 Full deterministic round-trip — **GREEN** (first time; `0.1.7-g` was inconclusive)

The `0.1.7-g` round could not complete the reply leg because the PC host went down mid-round. This
round completes it, PC → dev3:

| Step | Call | Receipt |
|---|---|---|
| Open | `new_conversation` → `bfwu-0kdzjk`, title `FP hub 0.1.7-m tools round trip`, message = token request | `conversationId "0dwf02"`, `sessionId session-02ea4278-134f-4112-9d9d-3ad58aac2680` |
| Follow-up | `send` with `conversationId:"0dwf02"` | `outcome:"injected"`, `messageId a2a-be02ceda-…`, same conversation/session |
| Open-new via send | `send` **without** `conversationId`, with `title` | opened fresh `conversationId "vdbzor"`, `sessionId session-92039269-…` |
| Open, no message | `new_conversation` without `message` | `conversationId "2jmi9f"`, `sessionId session-f7c47fb3-…` — accepted, but **not a silent open**: R4 still injects a waking turn (see below / **O4**) |
| `read` | ×3 during the round | `{"count":0,"messages":[]}` every time |

**Reply arrival — proven, not inferred.** Four replies came back, exactly one per injected turn, and
each landed in *this* session as a `next-turn` message whose `source.kind` is `a2a-relay`:

```
[superd-hub:a2a] kind=reply form=relay conversation=0dwf02   from=bfwu-0kdzjk message=a2a-62c78aba-…  → PONG-017M-FROM-DEV3
[superd-hub:a2a] kind=reply form=relay conversation=0dwf02   from=bfwu-0kdzjk message=a2a-83133e32-…  → PONG-FOLLOWUP-017M
[superd-hub:a2a] kind=reply form=relay conversation=vdbzor   from=bfwu-0kdzjk message=a2a-d0afe254-…  → PONG-SENDOPEN-017M
[superd-hub:a2a] kind=reply form=relay conversation=2jmi9f   from=bfwu-0kdzjk message=a2a-6add48b9-…  → reply to the R4 opener
```

Evidence chain (three independent witnesses agree):
1. **Peer registry** (`bfwu:~/.dsh/superd/a2a-conversations.json`) carries mirror rows with
   `machine "79he", agent "8ah589", hostAgent "0kdzjk"` and **`channelUsed:true` + `lastSentAt`** —
   the peer did send.
2. **Initiator log**: `a2a.deliver.writeback … via=peer outcome=followup` → `a2a.ingest.done
   kind=message outcome=injected` for each reply.
3. **Initiator session store**: the reply payloads are present verbatim in
   `.tests/superd/storages/session_projcache/sessions/session-d34d6d67-….json` under `next-turn`.

Payload fidelity is exact (token-for-token), no duplicates, one reply per turn. As documented, the
replies ride as **new messages**, not the `read` buffer — consistent with `read` staying at `count:0`.

### 6.2 Error legs

| Input | Result |
|---|---|
| `new_conversation` agent `"bogus"` | `[E_BAD_ADDRESS] superd-hub: agent must be a "<m4>-<a6>" address …` |
| `new_conversation` agent `"bfwu-zzzzzz"` | `a2a: unknown-agent bfwu-zzzzzz (no such agent on machine bfwu)` — **improved** vs 0.1.7-g's misleading unpaired-machine text |
| `new_conversation` agent `"zzzz-123456"` | `a2a: unknown-machine "zzzz" — address "…" is not a paired machine` |
| `send` empty message | `[E_MISSING_MESSAGE] superd-hub: send requires a non-empty message` |
| `stop` without `conversationId` | `[E_MISSING_CONVERSATION] superd-hub: stop requires conversationId` |
| `stop` on registry-unknown id | `a2a: conversation "zznonexistent" is not in the registry` |
| unknown action `frobnicate` | harness schema reject: `"action" must be one of ["agents","new_conversation","send","read","stop","agent_status","exec"]` |
| `stop` on a live-but-idle conversation | `{stopped:false, scope:"turn", note:"no turn was active"}` (D5 honest idle) |
| `stop` with `scope:"session"` | `{stopped:false, scope:"turn-only", reason:"no session-close endpoint upstream", note:"no turn was active"}` — documented degradation honored |

Peer-side corroboration: `a2a.stop.refused conversation=6icqiz scope=turn reason="session … not found
(not attached)"` → `a2a.ingest.done kind=stop outcome=injected` → the soft `stopped:false` answer.

## 7. HTTP / WS surface

Minted a cookie from the instance's launch token (`curl -c jar -L '…?token=…'`); seed persistence
meant no other ceremony.

| Probe | Result |
|---|---|
| `GET /` without cookie | **401** `dsh web authentication required` |
| `POST /api/superd/exec` without cookie | **401** |
| `GET /` · `/api/superd/machines` · `/api/superd/a2a/outbox?machine=79he` with cookie | 200 / 200 / 200 |
| `GET /api/superd/machines` body | self `79he`; `bfwu` `status:"reachable"`, `lastProbeAt` fresh; **no `execEnabled` field ⇒ exec enabled** |
| outbox | `{"v":1,"envelopes":[]}` |
| `GET /api/superd/exec/pty` WS upgrade **without cookie** | **401** — the upgrade is not weaker than the HTTP fence |
| `POST /api/superd/exec` valid | `{"exit":0,"stdout":"raw-http-ok\nu1\n",…,"outcome":"exited"}` |

## 8. Findings

### Fixed / closed since 0.1.7-g
- **D1 (PTY blocked by output schema)** — fixed; `mode` is declared in the output schema and PTY
  works through the MCP tool. 7/7 dispatches valid.
- **D2 (PTY orphan + leaked WS on result rejection)** — no orphans in the normal lifecycle, on either
  host. The original rejection trigger is now unreachable, so this is "cannot reproduce by its old
  path", not "re-proven fixed under fault injection".
- **Misleading unknown-agent error** — now precise (`unknown-agent … (no such agent on machine …)`).
- **Reply leg** — moved from *inconclusive (outage)* to **green** with exact payload verification.

### F1 — NEW, minor: `cwd` is silently ignored on the PTY leg
`cwd` is a declared, documented property of `exec`, and oneshot honors it (`pwd` with `cwd:"/etc"` →
`/etc`). The PTY branch in `hub-tool.ts` never reads `args.cwd`, so a PTY call carrying `cwd` returns
success while the command runs in the session's existing directory (`cwd:"/tmp"` in the probe). Silent
parameter no-ops are the worst of the three options. **Recommend** either honoring `cwd` as a one-shot
`cd` before the command, or rejecting it explicitly on `mode:"pty"`
(`[E_BAD_EXEC] superd-hub: exec: cwd is not supported with mode "pty"`), and saying so in the tool
description.

### F2 — NEW, cosmetic/by-design: the `[undefined]` title placeholder reaches the UI
`A2A_TITLE_PLACEHOLDER = '[undefined]'` (D17) is deliberate at the wire/registry layer for "operator
gave no title", and mirror rows adopt it verbatim by design. The user-visible consequence is a peer
session titled literally **`[undefined] [hub A2A]`** — visible in `agent_status` (`lunx18`) and in two
pre-existing `a2a-conversations.json` rows (`g19v2b`, `lunx18`). This is not a regression, but the
string is hostile to a human reading the session list. **Recommend** a friendlier placeholder
(e.g. `(untitled)`) or suppressing the marker for untitled conversations — at minimum a ruling that
`[undefined]` is accepted UX.

### O3 — Observation: `stop`/`send` `agent` is an *owner address*, and its value depends on row kind
For **mirror** rows (`hostAgent` set) the address must be **self** (`79he-8ah589`); for **initiator**
rows (no `hostAgent`) it must be the **peer**. Both were exercised:
`stop agent=79he-8ah589 conversationId=6icqiz` → honest idle answer; the same call addressed to the peer
was refused with a precise, self-correcting message
(`… belongs to 79he-8ah589, not bfwu-0kdzjk`). The tool description says `agent` is the peer / "the
peer's active turn", which is wrong for mirror rows. **Recommend** documenting `agent` as *the
conversation's owner address* (call `agent_status`/the refusal message tells you which). Worth a
ruling on whether the two row kinds should present one uniform address to the caller.

### O4 — Observation/friction: a message-less `new_conversation` is **never silent** (R4)
The wire envelope requires a message, so a message-less create substitutes the fixed opener
`A2A_OPENING_MESSAGE = '(conversation opened)'` (`a2a-service.ts`, R4) and still injects **one waking
turn** on the peer. Proven live: opening `2jmi9f` with only a title woke dev3's agent, whose injected
turn read

```
A2A message from 79he-8ah589 (conversation "FP hub 0.1.7-m open-no-message"):

(conversation opened)

This conversation is initiated through superd-hub by the sender. …
```

and which duly replied. This is by design, but the model-facing description — "`message?` … when
given, IS the first turn" — reads as though omitting it opens *without* a turn, and the R4 comment
itself records that peers "burned steps investigating" the bare-opening turn (D21 removed it for
message-bearing creates only). **Recommend** the `new_conversation` description state explicitly that
a message-less open still costs the peer one turn carrying `(conversation opened)` — callers who do not
want that should simply pass a message, which D21 folds into a single turn.

### Residual / not exercised
- `read`'s unread-buffer branch remains not live-reachable (needs the initiator torn down mid-flight) —
  same status as the `0.1.7-g` round; unit-covered only.
- `reconnected:true` (PTY transport-death recovery) was not triggered; every dispatch returned
  `reconnected:false`.
- `execEnabled` disable was not flipped on the live mesh (would disrupt the peer); the code-level gate
  is present, and the machines API currently omits the field (⇒ enabled).

## 9. Verdict

**Green.** The `superd-hub` tool and its facilities are fully reachable first-person from a native DSH
session on PC and work end-to-end against dev3: 7 actions, 14-agent roster, oneshot exec
local+remote with correct exit/stderr/timeout/signal taxonomy and exact 30 000-byte tail truncation,
true hub-side concurrency, persistent PTY with cwd+env survival and no leaks, a complete deterministic
A2A round-trip with payload fidelity, and an intact 401 fence on both the HTTP and WS fronts.

Both defects carried in from `0.1.7-g` are closed for the paths that can reach them. Two new items are
filed — **F1** (silent `cwd` no-op on PTY, minor, worth a small fix) and **F2** (the `[undefined]` UI
placeholder, cosmetic, worth a ruling) — plus two documentation gaps: **O3** (`stop`/`send` addressing)
and **O4** (a message-less open is never silent). Neither O3 nor O4 is a behavioural defect; both are
places where the model-facing contract under-describes what the wire actually does.

## 10. Test artifacts left behind (for the record)

- Conversations created live: `0dwf02`, `vdbzor`, `2jmi9f` (plus their mirror rows on dev3), all idle,
  left in the registries as inert rows rather than deleting only the local half and desyncing the peer.
- One persistent PTY shell per host, scoped to this session (`72060` on PC, `2395641` on dev3);
  reaped on session close.
- No process was killed, no service restarted, no prod home (`~/.dsh` of the *PC prod* instance on
  3080, `~/.superd`) was touched. The 4999 line was left running.

## 11. Addendum — live reply arrival (observed after writing §6.1)

The four replies verified in §6.1 were queued as `next-turn` while the test turn was still running.
The first surfaced as a **live conversational turn** immediately after it ended — a user-role message
in this session carrying the full relay envelope and the exact requested payload:

```
[superd-hub:a2a] kind=reply form=relay conversation=0dwf02 from=bfwu-0kdzjk message=a2a-62c78aba-8b7e-4b24-896e-39b37d7031b2

PONG-017M-FROM-DEV3
```

This closes the loop from the *model's* side: the reply is not merely present in the session store, it
is delivered into the agent's context as a turn. **All four landed, 4/4, in order and one per turn:**

| Conversation | Leg | messageId | Payload delivered |
|---|---|---|---|
| `0dwf02` | `new_conversation` | `a2a-62c78aba-…` | `PONG-017M-FROM-DEV3` |
| `0dwf02` | follow-up `send` | `a2a-83133e32-…` | `PONG-FOLLOWUP-017M` |
| `vdbzor` | `send`, no conversationId | `a2a-d0afe254-…` | `PONG-SENDOPEN-017M` |
| `2jmi9f` | **message-less** open | `a2a-6add48b9-…` | reply to the R4 `(conversation opened)` turn |

No duplicates, no spurious notices, no reordering — each reply carries the exact token requested for
that turn. The fourth arrival is what exposed **O4**: a "no message" open is not a no-op, and the peer
answered the R4 opener exactly as it answers an explicit message. The reply leg is confirmed
end-to-end at the delivery boundary, not only at the store.

No duplicates, no spurious notices, no reordering — each reply carries the exact token requested for
that turn. The reply leg is confirmed end-to-end at the delivery boundary, not only at the store.
