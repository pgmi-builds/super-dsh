# superd-hub First-Person Test Report — 0.1.8-d retest (F2 closed, O1 landed)

- Date: 2026-10-02 ~06:39–06:46 UTC (14:39–14:46 HKT)
- Tester: the same native DSH agent as the previous rounds, running **inside** the 4999 pack line on
  **PC** (`homepc`) and calling the `superd-hub` model tool first-person.
- Scope: re-test the one open finding (**F2**, self-addressed continuations) plus the new **O1** item, and
  regression-check the fixes verified on 0.1.8-b (F1/F3/F4/O2), against pack **`0.1.8-d`** with **both
  ends on the same revision**.
- Report written at `pc:/home/u1/workspaces/superd/docs/test-reports/2026-10-02-superd-hub-first-person-0.1.8-d-retest.md`
  (identical copy in the dev line at `.worktrees/mesh-p1/docs/test-reports/`).

## 1. Versions under test

| Node | Host | Runtime |
|------|------|---------|
| `79he` (PC) | homepc | unit `superd-4999-test.service`, PID 175638, restarted **14:39:39 HKT**; pack **`super-dsh@0.1.8-d`** |
| `bfwu` (dev3) | srv1637772 | hub PID 2798882, restarted **14:40:09 HKT**; pack **`super-dsh@0.1.8-d`** |

Worktree HEAD = `cfd9186`; the two commits under test are `3a990fb` (**0.1.8-c**: F2 completed — the
service-side `writeBack` decision is a session fact) and `cfd9186` (**0.1.8-d**: O1 boot-time reprobe +
spelled-out stop semantics). Tested through the installed tarball
(`.scratch/superd-pack/super-dsh-0.1.8-d.tgz`).

## 2. Verdict table

| Item | Status on 0.1.8-d | Evidence |
|---|---|---|
| **F2** self-addressed continuations loop back to the initiator | **FIXED — verified at receipt, log, session store and D30** | §3 |
| **O1** post-boot `pending` roster / machine status | **FIXED** (machines + roster) | §4.1 |
| **O1b** *new*: the boot tick caches an **empty local `agent_status` window** for ~5 min | **NEW FINDING** (low/medium) | §4.2 |
| **Stop** semantics: live vs natural end | verified: `true` for a live cancel, `false` for a natural end; cancellation notice intact | §5 |
| **F1 / F3 / F4 / O2** (fixed on 0.1.8-b) | **still green on 0.1.8-d**, F1 re-run live | §6 |

## 3. F2 — self-addressed continuations now reach the responder (the round's headline)

Reproduced the exact shape that failed on **both** 0.1.8-a and 0.1.8-b: open a conversation to my own
agent address, then continue it.

| Step | 0.1.8-a / 0.1.8-b | **0.1.8-d** |
|---|---|---|
| Open `hvxoni` → `79he-8ah589` | `delivered`, responder session `6adbd64a` | same (`delivered`, `session-6adbd64a-…`) |
| **Continuation** `send {conversationId:"hvxoni"}` | `delivered` but `sessionId = session-4fd0e64e-…` (**the initiator's own**), log `deliver.writeback … via=self-route` | `delivered`, **`sessionId:"session-6adbd64a-8ab2-4492-92be-30a60710c974"` — the responder's session** |
| Where the text went | echoed into **my** session as `kind=reply form=relay`, attributed to the peer | log `a2a.ingest.done kind=message outcome=delivered message=a2a-3e9de3b2-…` (an **injection**); no write-back line for that messageId |
| Self-echo | present | **0** inbox entries for `a2a-3e9de3b2-…` |
| Did the responder get it? | no (responder session: 0 related messages) | **yes** — it answered, and `PONG-018D-SELF-CONT` auto-delivered into this session (`a2a-2c066a3a-…`) |
| D30 row after the exchange | `omsgil.lastOutput` = **my own continuation text** (poisoned) | `hvxoni.lastOutput = "PONG-018D-SELF-CONT"` — the responder's reply |

The fix is exactly the predicate recommended in the 0.1.8-b report (`a2a-service.ts`):

```ts
const callerIsHost = hosted && initiator.sessionId === row.sessionId
writeBack = callerIsHost
```

— the address test (`to.id === row.agent`) is gone, so "the opener continues" and "the host replies" are
distinguished by session, which is the only thing that differs in the self-addressed case.

**Before/after in one `agent_status` window** (both rows still in the registry, so the contrast is live):

```
{conversationId:"hvxoni", sessionId:"6adbd6", title:"FP 0.1.8-d self-addressed F2 [hub A2A]",
 status:"idle", agentAvailable:true, lastOutput:"PONG-018D-SELF-CONT"}          ← 0.1.8-d: correct
{conversationId:"omsgil", sessionId:"4f27f1", title:"FP 0.1.8-b self-addressed F2 [hub A2A]",
 status:"idle", agentAvailable:false, lastOutput:"self-addressed continuation (F2 retest, must reach
 the responder): please also reply with exactly PONG-018B-SELF-CONT"}            ← 0.1.8-b: poisoned
```

## 4. O1 — boot-time reprobe

### 4.1 Fixed: machine status and roster are populated at boot

The line booted at **14:39:39**. At **14:41:06** (87 s later — far inside the 300 s interval, where
0.1.8-b was still `pending` with an empty remote roster):

```
GET /api/superd/machines →
{"id":"bfwu","name":"dev3",…,"status":"reachable","lastProbeAt":1790923188895}   ← ≈14:39:48, i.e. boot+9 s
agents → 2 machines × 7 agents (14 rows), all ready:true
```

`startReprobeSweep({ …, immediate: true })` fires one tick at startup (`mesh-link.ts`, O1 comment), so the
roster and status are live within seconds of a restart instead of one full period later. Confirmed for the
machine row and for the tool roster.

### 4.2 NEW (O1b): the same boot tick caches an **empty** local `agent_status` window for ~5 minutes

The boot tick runs the R5 collectors as well as the probes, and the *local* collection runs before the
native runtime is ready. What the cache recorded at 14:39:53 for `79he`:

```
{a6:"8ah589", rows:[], error:'typert gateway: session/list: active Service "sessionController" is unavailable'}
{a6:"0d6xzz", rows:[], error:'a2a: no gateway for 79he-0d6xzz — machine unreachable or not paired'}
… (all 7 local agents rows:[] with an error)
```

Consequence, observed live: `agent_status 79he-8ah589` returned **`{"collectedAt":1790923188162,"sessions":[]}`**
— an empty window — even though this session was running and several other sessions existed. It stayed
empty until the next sweep at **14:44:48**, which collected normally:

```
79he collectedAt ≈14:44:48 → 8ah589 rows: 32 (no error), 0d6xzz rows: 8, c6uxel rows: 5, …
agent_status 79he-8ah589 → 5-row window again (conversations hvxoni / afxx49 / iydfrm / omsgil + this session)
```

So the O1 fix is correct for the mesh-facing half but, by running the *whole* sweep early, it samples the
local session plane during startup and caches the failure for a full interval. On 0.1.8-b the first tick
was late enough that this never happened (at the cost of the 5-minute pending window O1 set out to fix).
**Recommend** one of: run only the remote probe on the boot tick and let the local collector wait for the
first interval; retry a failed local collection after a short backoff (e.g. 15–30 s) rather than caching
the error; or have `agent_status` treat a `sessionController unavailable` cache as "not collected yet"
instead of an empty window. Note the same early-tick hazard applies to the foreign-runtime
(`no gateway`) entries.

## 5. Stop semantics (0.1.8-d surface wording)

The `cfd9186` change here is **description-only** (`hub-tool.ts`); the behaviour is the underlying stop
RPC, exercised on one conversation (`afxx49`, self-addressed):

| Call | `stopped` | Situation |
|---|---|---|
| stop #1 | `false`, `scope:"turn"`, `"no turn was active"` | the first turn had already ended naturally (its channel reply `PONG-018D-STOP` was sent in-window; log `completion.quiet reason=channel-send-in-window`) — the case that wrongly answered `true` on 0.1.8-b |
| stop #2 | `true` | the continuation's turn was genuinely live (the responder had been asked to `sleep 40` first) |
| stop #3 / #4 | `true` | …and still live/unwinding ~10–30 s later |
| settlement | `a2a.completion.stopped conversation=afxx49` + `kind=notice reason=stopped-by-initiator` delivered at 14:44 | the cancelled turn's outcome notice, and the only artifact for that turn |

So: live → `true`, natural end → `false`, and the cancelled turn still produces exactly one
`stopped-by-initiator` notice (the F4 taxonomy is intact). One observation worth a ruling: **repeated
`stop` calls each answer `stopped:true`** while the first cancellation is still unwinding, even though the
description reads per-call ("`stopped:true` means **this call** cancelled a live turn"). Low severity;
consider answering "a cancellation is already in flight" for a repeat.

## 6. Regression on 0.1.8-d (F1/F3/F4/O2 and the surface)

| Check | Result |
|---|---|
| **F1** legacy `injected` receipt (re-run live with the fixture peer `q1q1`) | `send` → **`delivered`**, `conversationId 8iwj7n`, `created:true`; initiator row recorded; simulated peer write-back POST → `{"outcome":"delivered",…}`; row `lastOutput:"LEGACY-PEER-REPLY-018D"` |
| **F3** `lastOutput` on the channel path | `hvxoni` = responder's reply, `afxx49` = `PONG-018D-STOP`, `2e8mbj` = `PONG-018D-DEV3` — all correct, all surfaced through `agent_status` |
| **F4** one artifact per turn | `omsgil`/`iydfrm`/`hvxoni`/`afxx49` each logged `completion.quiet reason=channel-send-in-window` for channel-answered turns; no spurious stop notice |
| **O2** `created` on failure | (unchanged since 0.1.8-b) no junk rows: registry 39 → **43** = exactly the 4 conversations this round created (`hvxoni`, `afxx49`, `2e8mbj`, `8iwj7n`) |
| Cross-machine round trip (PC → dev3) | open `2e8mbj` → `delivered`; reply `PONG-018D-DEV3` auto-delivered (`deliver.writeback … via=peer`) |
| `exec` oneshot cross-machine | `srv1637772` in **47 ms** |
| `read` | `{"count":0,"messages":[]}` |
| HTTP fences | `GET /` no cookie **401**; `POST /api/superd/exec` no cookie **401** |
| Roster / status | 14 agents, `(untitled)` title fix intact, windows alive-first |

## 7. Residual / not exercised

- D28's `accepted` path still never triggers (every leg settles inside the 10 s sync window) — unit-covered
  only, unchanged across a/b/d.
- `read`'s unread-buffer branch, `reconnected:true`, the `execEnabled` disable, and D30's ownership-gate
  **negative** leg remain unreachable from a single session.
- The legacy-tolerance leg uses the fixture peer (no real 0.1.7-n node remains); its reverse half (an old
  peer rejecting our receipt) is inherently unfixable from this side.
- `agent_status`'s local window was only re-checked after the 14:44:48 sweep; the O1b finding is
  established from the cache contents and one observed empty window, not from a second restart.
- No fresh PTY legs were run this round (the `exec`/PTY code is untouched by `3a990fb`/`cfd9186`); the
  cross-machine oneshot above and the 0.1.8-b PTY matrix stand.

## 8. Verdict

**Green for the findings under test.** F2 is fixed and verified at every layer that failed before —
receipt identity, routing log, absence of self-echo, responder participation, and the D30 field — using the
exact predicate the previous report recommended. O1's user-visible symptom (post-boot `pending` roster)
is fixed, verified 87 s after a restart. The stop surface now matches its wording on both sides
(live cancel vs natural end), and the cancelled turn still yields its single notice. F1/F3/F4/O2 remain
green on the new pack, with F1 re-run against a live legacy-shape peer rather than argued from an
unchanged diff.

One new item is filed: **O1b** — the boot tick also samples the local session plane before the runtime is
up, caching an empty `agent_status` window (with `sessionController unavailable` / `no gateway` errors) for
a full interval. It is the mirror image of O1: fixing "the roster waits 5 minutes" introduced "the local
status is empty for 5 minutes". Small and self-contained, but it is the difference between a restart being
transparent and `agent_status` lying about local sessions for the first five minutes.

## 9. Test artifacts left behind (for the record)

- Conversations created live, left as inert registry rows: `hvxoni` (F2), `afxx49` (stop), `2e8mbj`
  (dev3 regression), `8iwj7n` (points at the unpaired fixture machine `q1q1`). Registry 39 → 43 rows.
- The fixture was fully removed again (`DELETE … ?id=q1q1` → `{"removed":true}`, process stopped, port 4977
  free); `GET /api/superd/machines` lists only `bfwu`. `.scratch/legacy-peer.mjs` stays on disk (gitignored).
- One PTY shell left from the 0.1.8-b round on each host (reaped on session close); no new PTY this round.
- No prod home touched; **dev3 left running `0.1.8-d`**; 4999 left running and active.
