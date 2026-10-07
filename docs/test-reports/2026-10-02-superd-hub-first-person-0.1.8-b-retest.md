# superd-hub First-Person Test Report — 0.1.8-b retest (fix verification)

- Date: 2026-10-02 ~06:07–06:20 UTC (14:07–14:20 HKT)
- Tester: the same native DSH agent as the `0.1.8-a` round, running **inside** the 4999 pack line on
  **PC** (`homepc`) and calling the `superd-hub` model tool first-person.
- Scope: re-test the four findings (**F1–F4**) and the observation **O2** filed in
  [`2026-10-02-superd-hub-first-person-0.1.8-a.md`](./2026-10-02-superd-hub-first-person-0.1.8-a.md),
  against pack **`0.1.8-b`** (fix commit `64b3cad`, "fix(a2a): 0.1.8-b — first-person findings … 480/480"),
  **with both ends on the same pack this time**.
- Report written at `pc:/home/u1/workspaces/superd/docs/test-reports/2026-10-02-superd-hub-first-person-0.1.8-b-retest.md`
  (identical copy in the dev line at `.worktrees/mesh-p1/docs/test-reports/`).

## 1. Versions under test

| Node | Host | Runtime |
|------|------|---------|
| `79he` (PC) | homepc | unit `superd-4999-test.service`, PID 159959, restarted **14:07:30 HKT**; pack **`super-dsh@0.1.8-b`** in `.tests/superd/profiles/superd-pub` |
| `bfwu` (dev3) | srv1637772 | hub PID 2794890, restarted **14:08:19 HKT**; pack **`super-dsh@0.1.8-b`** (dist mtime 14:08:03) |

The version skew of the previous round is gone: **both ends are `0.1.8-b`**, and the mesh is reachable
(`status:"reachable"`, fresh `lastProbeAt`). Worktree HEAD = `64b3cad`; the round therefore tests the
delivered tarball (`.scratch/superd-pack/super-dsh-0.1.8-b.tgz`), not a source tree.

## 2. Verdict table

| Finding (0.1.8-a) | Status on 0.1.8-b | Evidence |
|---|---|---|
| **F1** mixed-version receipt (`injected`) throws; reply lost | **FIXED — verified live, both halves** | §3 |
| **F2** self-addressed continuations loop back to the initiator | **NOT FIXED — reproduces identically** | §4 |
| **F3** `lastOutput` never written on the channel path (D30 dead) | **FIXED** | §5.1 |
| **F4** stop-after-reply yields two artifacts | **FIXED** | §5.2 |
| **O2** `created:true` on a failed open | **FIXED** | §5.3 |
| O1 (boot-time roster `pending` window), O3 (error-code name) | unchanged / not addressed by `64b3cad` | §6 |

## 3. F1 — legacy `injected` receipt is tolerated (live, not just read)

Because dev3 was upgraded in lockstep, the mixed-version leg can no longer be produced by the real mesh —
so I stood up a **legacy-peer fixture** (`.worktrees/mesh-p1/.scratch/legacy-peer.mjs`, scratch-only): a
local HTTP server that mints a cookie, advertises one agent, and answers `POST /api/superd/a2a` with the
**old 0.1.7-n vocabulary** `{"outcome":"injected", …}`. It was paired as machine `q1q1`
(`POST /api/superd/machines`) and unpaired afterwards (`DELETE … ?id=q1q1` → `{"removed":true}`).

| Leg | Result on 0.1.8-b |
|---|---|
| Roster over the fixture | `q1q1` / `LEGACY 0.1.7-n` → agent `q1q1-aaaaaa`, `ready:true` |
| `send` to `q1q1-aaaaaa` (peer answers **`injected`**) | `{"action":"send","outcome":"delivered","messageId":"a2a-2f761c35-…","conversationId":"3qf92a","sessionId":"session-legacy-3qf92a","created":true,…}` — **on 0.1.8-a this exact leg returned `failed` / `gateway/uncaught`** |
| Initiator row recorded **from the tolerated receipt** | registry row `3qf92a`: `{machine:"q1q1", agent:"aaaaaa", sessionId:"session-legacy-3qf92a", initiatorSession:"session-4fd0e64e-…", hostAgent:absent}` |
| Peer write-back reply resolves and delivers | `POST` of a v1 `message` envelope from `q1q1-aaaaaa` → `{"outcome":"delivered", …}`; log `a2a.deliver.writeback conversation=3qf92a from=q1q1-aaaaaa via=peer outcome=followup`; payload `LEGACY-PEER-REPLY-018B` landed in this session as `kind=reply form=relay` |
| D30 on that reply | row `lastOutput: "LEGACY-PEER-REPLY-018B"` |

This is the exact chain that lost the reply on 0.1.8-a (`a2a/conversation-not-found` → dropped); it now
completes. The tolerance is visible in the installed dist (`isReceiptOutcome` accepts `injected` and
`normalizeReceiptOutcome` rewrites it to `delivered` before the boundary returns).

**Real mesh (F1's user-visible symptom):** `send` open to `bfwu-0kdzjk` → `outcome:"delivered"`,
`conversationId:"ymhzgf"`, `sessionId:"session-4467d9e8-…"` (the peer's session), and the dev3 agent's
channel reply `PONG-018B-OPEN` auto-delivered into this session (log:
`a2a.send.ok → a2a.deliver.writeback conversation=ymhzgf from=bfwu-0kdzjk via=peer → a2a.ingest.done
kind=message outcome=delivered`). **The cross-machine round trip is green.**

## 4. F2 — self-addressed continuations **still loop back** (reproduced 1/1, same shape)

| Step | Observation |
|---|---|
| Open `omsgil` to `79he-8ah589` (my own agent address) | `outcome:"delivered"`, `sessionId:"session-4f27f1f9-…"` (the responder's session) — correct |
| Responder's first reply | `PONG-018B-SELF` delivered to this session — correct |
| **Continuation** `send {conversationId:"omsgil"}` | `outcome:"delivered"` but **`sessionId:"session-4fd0e64e-…"` — this session, not the responder's**; log: `a2a.send.route-derived → a2a.send.channel … latch=true → a2a.deliver.writeback … via=self-route → a2a.ingest.done` for my own messageId `a2a-ec4e1bc4-…` |
| Where the text went | It landed back in **my** inbox as `kind=reply form=relay conversation=omsgil … self-addressed continuation (F2 retest…)` |
| Where it did **not** go | The responder session `session-4f27f1f9-…` contains **0** messages referencing `omsgil`/`018B` |

**Root cause is now one layer up from where the fix landed.** `0.1.8-b` changed the *ingest* discriminator
to `env.from.sessionId === row.sessionId` (correct in itself), but the *service* still decides `writeBack`
by address (`a2a-service.ts:991-992`):

```ts
const expected = row.hostAgent !== undefined ? {machine: selfM4(), id: row.hostAgent} : {machine: row.machine, id: row.agent}
writeBack = row.hostAgent !== undefined && to.machine === row.machine && to.id === row.agent
```

For a self-addressed conversation `row.agent === row.hostAgent`, so after the (session-correct) route
derivation at `:968` sets `to = {self, row.hostAgent}`, the address test still yields `writeBack = true`.
That marks the channel latch, and `:1037-1046` stamps the outbound envelope with
`from = {self, row.hostAgent, sessionId: row.sessionId}` — which then *satisfies* the new ingest-side
session check, so the message is classified as the hosted peer's write-back and delivered to
`row.initiatorSession` (the initiator). The initiator's own continuation never reaches the responder.

**Recommended fix (one decision, not a new mechanism):** derive `writeBack` from the caller's session, not
from address equality — e.g. `writeBack = row.hostAgent !== undefined && initiator.sessionId === row.sessionId`
(the same predicate the route derivation at `:963` already uses) — or propagate the route-derivation branch
("the opener continues") instead of re-deriving it from addresses at `:991`. Addressing the *initiator* of a
mirror row should remain the write-back signal; it just cannot be distinguished from "the host is also the
initiator" by address.

**Secondary consequence:** because the misrouted text is delivered as a `kind=reply` through the write-back
branch, the F3 writer dutifully records it — `omsgil`'s row now reads
`lastOutput: "self-addressed continuation (F2 retest, must reach the responder)…"`, i.e. the initiator's own
words presented as the peer's last output. F3 is fixed; F2 makes it record the wrong thing in this one case.

## 5. The other fixes

### 5.1 F3 — `lastOutput` now populated on the channel path — **FIXED**

| Conversation | Reply path | `lastOutput` |
|---|---|---|
| `ymhzgf` (`bfwu-0kdzjk`, cross-machine) | channel write-back (`via=peer`) | `"PONG-018B-OPEN"` ✅ |
| `3qf92a` (legacy fixture) | channel write-back (`via=peer`) | `"LEGACY-PEER-REPLY-018B"` ✅ |
| `omsgil` (self-addressed) | write-back (misrouted by F2) | the initiator's own text — F2, not F3 |

And it survives the cache round trip: after the 14:17:39 sweep,

```
agent_status bfwu-0kdzjk → {conversationId:"ymhzgf", sessionId:"4467d9",
  title:"FP 0.1.8-b cross-machine open [hub A2A]", status:"idle", agentAvailable:true,
  lastOutput:"PONG-018B-OPEN", lastOutputAt:1790921695288}
```

— the D30 ownership gate passing for the initiator, **cross-machine**. D30 is now live for exactly the
population D29 targets (peers that answer through the channel).

### 5.2 F4 — one artifact per turn on the stop race — **FIXED**

Same shape as the 0.1.8-a reproduction: open `iydfrm` to `79he-8ah589`, then `stop` immediately.

- The responder's channel reply arrived (`PONG-018B-STOPRACE` in this session);
- the completion watch then logged **`a2a.completion.quiet conversation=iydfrm reason=channel-send-in-window`**
  — on 0.1.8-a the same sequence emitted `a2a.completion.stopped` + a `stopped-by-initiator` notice;
- this session's inbox for `iydfrm` holds the reply **only** — no second artifact. The
  "a turn end yields at most ONE artifact" invariant holds.
- Nuance (unchanged, and upstream-shaped): `stop` still answered `{"stopped":true,"scope":"turn"}` for a
  turn that had already produced its reply — the RPC was accepted, the *artifact* side is what was fixed.
  Worth a ruling if `stopped:true` should be suppressed when the turn already completed.

### 5.3 O2 — `created` is now a world fact — **FIXED**

```
send agent=bfwu-zzzzzz → {"outcome":"failed", …, "created":false, "error":{"code":"a2a/unknown-agent", …}}
send agent=zzzz-123456 → {"outcome":"failed", …, "created":false, "error":{"code":"a2a/unknown-machine", …}}
```

(0.1.8-a reported `created:true` on both.) No junk registry rows resulted: 35 rows before the round →
**39** after, the 4 additions being exactly the 4 conversations this round created
(`3qf92a`, `ymhzgf`, `omsgil`, `iydfrm`).

## 6. Regression pass (surface that was green stays green)

| Check | Result |
|---|---|
| `agents` roster | 2 machines × 7 agents; the legacy fixture appeared and disappeared with pairing (`removed:true`) |
| `agent_status` | local + cross-machine windows; `(untitled)` still renders (0.1.7-m F2 fix intact) |
| `read` | `{"count":0,"messages":[]}` |
| `stop` idle / unknown id | `stopped:false` + note / registry-not-found error (unchanged) |
| `exec` oneshot local | `exit:7`, stdout/stderr separated (84 ms) |
| `exec` oneshot cross-machine | `srv1637772` in 55 ms |
| `exec` PTY local | `cd /tmp` + exported `PTY_018B` survive to the next dispatch (45 ms) |
| `exec` PTY cross-machine | `cd /var/tmp` + `XPTY_018B` survive (`/var/tmp`, `dev3b`, 49 ms) |
| `exec` PTY `cwd` | still explicitly refused (`[E_BAD_EXEC] … cwd is not supported with mode "pty"`) |
| HTTP fences | `GET /` no cookie **401**; `POST /api/superd/exec` no cookie **401**; PTY WS upgrade no cookie **401**; with cookie `GET /` **200** |
| `/hub`, world mounts | `/hub` **404** foreign-only; `/claude/`, `/omp/` **404** (native-ui-only) |
| Processes | exactly one PTY executor per host (local PID 163637, ppid 159959 = the new hub); the fixture process was stopped |

## 7. Residual / not exercised

- The legacy-tolerance leg was driven by a **fixture**, not a real old hub (no 0.1.7-n node remains in the
  mesh). The reverse half of F1 — an old peer rejecting *our* `delivered` receipt — is inherently
  unfixable from this side and was not re-run.
- D28's `accepted` path (10 s sync window → background settle → `delivered`/`undelivered` notice) still
  never triggered: every leg on 0.1.8-b settled inside the window, as on 0.1.8-a.
- `read`'s unread-buffer branch, `reconnected:true`, the `execEnabled` disable, and D30's gate **negative**
  leg remain unreachable/unit-covered (unchanged from the previous report).
- O1 (post-boot `pending` roster window) and O3 (`conversation-machine-mismatch` naming) were not part of
  `64b3cad` and were not re-filed.

## 8. Verdict

**Four of five items fixed and verified live; F2 is not fixed.**

- **F1** — fixed, and verified against a real legacy-shape peer rather than by reading the guard: the
  `injected` receipt is tolerated and normalized, the row is recorded from it, and the reply leg that was
  dropped on 0.1.8-a now delivers. The real cross-machine round trip (PC → dev3, channel reply, exact
  payload) is green.
- **F3** — fixed; `lastOutput` is written on both write-back branches and surfaces through `agent_status`
  cross-machine, which is what D29 needed.
- **F4** — fixed; the channel-send window now precedes the stop notice, restoring one artifact per turn.
- **O2** — fixed; `created` no longer lies on a failed send.
- **F2** — **still broken on 0.1.8-b.** The ingest-side discriminator was corrected, but the service-side
  `writeBack` decision (`a2a-service.ts:991`) is still address-based, and for a self-addressed conversation
  the initiator's address *is* the host's address — so the continuation is still classified as the hosted
  peer's write-back, still latches the channel, and still echoes into the initiator's own session while the
  responder receives nothing. It is one predicate wide (`initiator.sessionId === row.sessionId`), and it is
  the only remaining blocker to a green verdict on this surface.

## 9. Test artifacts left behind (for the record)

- Conversations created live, left as inert registry rows: `3qf92a` (points at the unpaired fixture machine
  `q1q1`), `ymhzgf` (dev3, healthy), `omsgil` (self, F2), `iydfrm` (stop-race). Registry 35 → 39 rows.
- The fixture was fully removed: `DELETE /api/superd/machines?id=q1q1` → `{"removed":true}`, process stopped;
  `GET /api/superd/machines` lists only `bfwu` again. The scratch script
  `.worktrees/mesh-p1/.scratch/legacy-peer.mjs` is left on disk (gitignored) and re-runnable.
- One PTY shell per host, scoped to this session; reaped on session close. The Claude world from the
  previous round is gone (the line restarted).
- No prod home touched, **dev3 left running `0.1.8-b`** (its restart was the operators', not mine), 4999
  left running and healthy.

## 10. Addendum — live arrival in the model's own context

The write-back driven through the tolerated legacy receipt (§3) surfaced in this session as a live
conversational turn after the test turn ended, carrying the exact payload:

```
[superd-hub:a2a] kind=reply form=relay conversation=3qf92a from=q1q1-aaaaaa message=a2a-legacy-reply-01

LEGACY-PEER-REPLY-018B
```

So the fixed chain is confirmed at all three boundaries, not just in the registry: the legacy `injected`
receipt was tolerated at the wire (`send` → `delivered`), the initiator row was recorded from it, and the
peer's later channel write-back was delivered into the initiator's **context** — the exact leg that
0.1.8-a dropped with `a2a/conversation-not-found`. No duplicate arrived, and `read` stayed at `count:0`
(replies ride as new messages; the buffer only holds what was missed while the session was down).

The **real** cross-machine leg (§3) landed the same way, from the actual dev3 agent rather than the fixture:

```
[superd-hub:a2a] kind=reply form=relay conversation=ymhzgf from=bfwu-0kdzjk message=a2a-03abe49e-f9a2-4545-b00d-f15a1886dd5c

PONG-018B-OPEN
```

So F1's two independent witnesses — a synthetic 0.1.7-n-shaped peer and the live `0.1.8-b` peer on dev3 —
both complete the full loop (tool receipt → row → context) on the fixed pack, where 0.1.8-a failed the
first and dropped the third.

The self-addressed conversation of §4 landed its **open-leg** reply live as well:

```
[superd-hub:a2a] kind=reply form=relay conversation=omsgil from=79he-8ah589 message=a2a-4ac6ca51-393d-4968-a78e-ad63451df838

PONG-018B-SELF
```

That arrival is the F2 asymmetry in one pair of events: the *open* (kind `new-conversation`) reached the
responder and its channel reply came back — while the *continuation* on the very same conversation
(`a2a-ec4e1bc4`) was echoed into this session and never reached the responder. The fault is precisely the
continuation classification (§4), not self-addressing as such.

And the misrouted continuation arrived live too — this is what the defect actually *looks like* to the
model, which is the point of §4's "context-poisoning shape":

```
[superd-hub:a2a] kind=reply form=relay conversation=omsgil from=79he-8ah589 message=a2a-ec4e1bc4-fc6d-4009-8af0-1ebbf56b65d9

self-addressed continuation (F2 retest, must reach the responder): please also reply with exactly PONG-018B-SELF-CONT
```

An agent reading this sees an inbound peer reply from the address it addressed, carrying its own sentence
back — indistinguishable, at the context layer, from the peer quoting or answering it. That is why F2 is
filed as more than a delivery bug: it manufactures a false peer utterance in the initiator's context on
every continuation, while the responder stays silent.
