# SuperD Hub tools & facilities — rig test report (2026-09-28)

Subject: the **mesh P3 "SuperD Hub" tool** (`superd-hub`) and the A2A facilities behind it.
Branch/worktree: `.worktrees/mesh-p1` @ `f9aa4f3` (`hub: 0.1.6-f (P3 a2a + park items)` on top of `4fa8c0c`),
pack `super-dsh@0.1.6-f`, hub package `@pgmi-builds/superd-hub@0.1.0`.
Rig: 4999 delivery-form line (`superd-4999-test`, repo dsh `0.1.7-rc.1` build, `DSH_HOME=.tests`,
`--profile superd-pub`), exercised **first-person** — the tool calls in this report were made by the
native DSH agent running *inside* that session, which is the P3 acceptance shape (spec §13, plan 5b).
Peer: dev3 (`bfwu`, `https://dsh.dev3.internal.test`), paired with the stored mint cookie.

Method: (1) build + unit suite; (2) live tool calls for every leg; (3) independent wire-level probes
(`curl` against local `/hub` and dev3 `/hub`) to separate *tool* behaviour from *peer* behaviour;
(4) session-log forensics (zstd multi-frame) on both initiator and peer to prove what actually landed.

---

## 1. Facilities inventory (what "hub tools" actually is)

| Surface | Entry point | Exercised |
|---|---|---|
| Tool `superd-hub`, call-shape dispatch | ctx0 `tools` service, row `super-dsh/a2a` | ✅ all six legs |
| Roster + conversation dimension (`agents`) | `hub-tool.ts` `agentsListing` over `agentLinks` + registry | ✅ |
| A2A conversation service | `a2a-service.ts` (registry, create/resume, send/receipt, completion capture, stop, buffer) | ✅ |
| Reply delivery face | `a2a-delivery.ts` (`a2a-relay` / `a2a-notice`, followup routing, bounded buffer) | ✅ relay; ⚠️ buffer not live-reachable |
| `/hub` route family (foreign demux, envelope forward, WS mux) | `hub-route.ts` | ✅ via curl + implicit in every cross-machine call |
| Mesh federation wire (`/hub/api?agent=`) | `mesh-gateway.ts` / `mesh-federate.ts` | ✅ (cross-machine call to dev3) |
| Registries | `machines.json`, `agent-ids.json`, `a2a-conversations.json` under `<home>/superd/` | ✅ |
| `exec` leg | placeholder by ruling (P4) | ✅ placeholder returned |

Not in scope / not reachable: `wireCompletionToDelivery`'s **unread-buffer** branch (needs the initiator
to be torn down mid-flight — unit-covered only, see D8).

---

## 2. Build & unit suite

| Check | Result |
|---|---|
| `npx tsc -p .` (superd-hub) | clean, exit 0 |
| `node --test --test-force-exit test/*.test.mjs` (superd-hub) | **355 tests / 354 pass / 1 fail** |
| The 1 failure | `test/spawn-world.test.mjs` — `Error: source profile missing: .tests/profiles/ctx1-min`. **Pre-existing environmental gap**, identical to the C1 report (fixture removed in the 2026-09-26 farm sweep). Not a P3 regression. |
| P3-specific files | `hub-tool`, `a2a-service`, `a2a-delivery`, `wire-endpoints`, `machines` — 59/59 pass on the focused run |

---

## 3. Live leg-by-leg results

| # | Leg / call | Result | Evidence |
|---|---|---|---|
| 1 | `{}` / `agents` | ✅ | 2 machines × 7 agents = 14 rows, all `ready:true`; dev3 a6s adopted verbatim (`bfwu-ea3yvg`, …) |
| 2 | `{action:'exec'}` | ✅ | `{"note":"not yet implemented: exec (P4)"}` |
| 3 | `{action:'read'}` | ✅ (empty) | `{"count":0,"messages":[]}` — correct, nothing buffered |
| 4 | `new_conversation` bad address `"bogus"` | ✅ error | `[E_BAD_ADDRESS] …` |
| 5 | `new_conversation` unknown a6 `79he-zzzzzz` | ⚠️ misleading | `a2a: no gateway for 79he-zzzzzz — machine unreachable or not paired` (see D7) |
| 6 | `send` empty message | ✅ error | `[E_MISSING_MESSAGE]` |
| 7 | `stop` without conversationId | ✅ error | `[E_MISSING_CONVERSATION]` |
| 8 | unknown action | ✅ schema-level reject | `"action" must be one of [...]` |
| 9 | `new_conversation` **native** + title | ✅ | `conversationId session-3`, title persisted, verified in ctx0 `session/list` |
| 10 | `new_conversation` **local world** (Pi) + title | ❌ **fails** | `failed to rename session "session-c1dd2f81…": … is not live in this store` (**D1**) |
| 11 | `new_conversation` **local world** (Codex) + title | ❌ fails | same `not live in this store` (**D1**) |
| 12 | `new_conversation` **dev3 Pi** + title (cross-machine) | ❌ fails | same `not live in this store` (**D1**, reproduced on the peer's older pack) |
| 13 | `new_conversation` **dev3 Codex** (cross-machine) | ❌ fails differently | `typert gateway: session/create: active Service "sessionController" is unavailable` (**D4**) |
| 14 | `send` untitled → local Pi | ✅ `injected` | messageId `a2a-a9d98257…`, conversationId `session-4` |
| 15 | **auto-reply relay** (peer `PONG-P3`) | ✅ | my session log `agent/inbox/spliced` seq 275, `source.kind='a2a-relay'`, text `Agent 79he-xwes79 replied (conversation "(untitled)"):\n\nPONG-P3` |
| 16 | second turn relay (`PONG-P3-II`) | ✅ | seq 380, same shape |
| 17 | `stop` scope `turn` (peer running `sleep 45`) | ✅ | peer `turn/end {"turn":3,"reason":{"kind":"aborted","reason":{"kind":"user"}}}`; `sleep 45` never completed; tool returned `{stopped:true,scope:"turn"}` |
| 18 | `stop` scope `session` | ✅ degrades by design | `{stopped:true, scope:"turn-only", reason:"no session-close endpoint upstream"}` |
| 19 | resume after stop (`RESUMED-OK`) | ✅ | relay #4 in my session; peer turn 4 completed |
| 20 | **cross-machine** `send` dev3 Pi | ✅ `injected` | messageId `a2a-caabf8a2…`; peer session `session-532252a2…` created on dev3 |
| 21 | **cross-machine** completion watch | ✅ fires | relay from `bfwu-ea3yvg` delivered into my session (6th splice, empty — that turn was aborted) |
| 21b | **cross-machine reply text** | ✅ | dev3 peer turn 2 completed `response:"CROSS-OK"`; relay 7 in my session: `Agent bfwu-ea3yvg replied (conversation "(untitled)"):\n\nCROSS-OK` |
| 22 | **cross-machine** `stop` | ✅ | dev3 peer `running:false` after the call |
| 23 | `/hub/api?agent=pi` session plane (curl) | ✅ | `session/list` and `session/create` both `ok:true` — the local demux *does* reach a live world session plane |

**Wire-level note for #23/#13:** the local `/hub` demux and dev3's are the same code path; the local
worlds answer `session/list`/`session/create` fine, and dev3 does too for **claude / omp / pi / hermes / agy**.
Only **dev3's `codex` world** fails — its own inventory shows
`include:session-controller | @deepseek-ai/dsh-api-session-controller | enabled:true | fiberPhase:"pending"`.
That is peer-side, not a defect in this branch's routing.

---

## 4. Defects found

### D1 — Title rename fails in **every world context** → `new_conversation` and `send`+`title` are broken for all non-native targets (BLOCKER for that leg)

The A2A create path is `session/create` → `session/rename`, per spec §7.2 (title is a first-class
argument of `new_conversation` and of `send`). The rename step fails inside any **world** ctx:

```
POST /hub/api?agent=pi   {"method":"session/rename","payload":{"args":{"request":
  {"sessionId":"session-4ce3e180-…","title":"Rename probe A"}}}}
→ {"ok":false,"error":{"code":"gateway/internal",
   "message":"failed to rename session \"session-4ce3e180-…\": Error: session \"session-4ce3e180-…\" is not live in this store"}}
```

Reproduced at wire level, independently of the tool:

| Probe | Target | Session state | Result |
|---|---|---|---|
| A | local `/hub/api?agent=pi` | session that already ran 3 turns | ❌ not live in this store |
| B | local `/hub/api?agent=pi` | never-run session | ❌ not live in this store |
| E | local `/hub/api?agent=codex` | never-run session (its `session-controller` is `active`) | ❌ not live in this store |
| C | ctx0 `/api/session/rename` (**control**) | native session | ✅ `{title:"Rename probe C", seq:4}` |
| — | dev3 `/hub/api?agent=pi` (via the tool) | fresh session | ❌ same error on the peer's *older* pack |

Reading of the evidence: the failure is not a race with a not-yet-live session (B is a cold session; A is a
session that demonstrably ran and persisted), and not a broken world (E's world has an active
`session-controller`). It is systematic for world contexts and absent at ctx0. Upstream anchor:
`packages/session/session-title/src/index.ts:404` throws when
`this.ctx.sessions.get(session.id) !== session` inside `rename()`, reached from
`packages/api/session-controller/src/commands.ts:193` after `resolveAgent()`. So in a world ctx the
agent's `session` is not the object the title service sees as live; at ctx0 it is. Root cause is therefore
in how world contexts attach/resume sessions for the title service — to be pinned by the owner of that
path (this report establishes the boundary: **ctx0 ✅ / every world ❌, local and remote, both packs**).

Consequences, all observed live:

* `new_conversation` **throws after creating the session**. The registry row is inserted *before* the
  rename (deliberate, per the code comment), so the caller is told the call failed while an untitled
  conversation now exists and is addressable (`session-` for Pi, `session-c` for Codex, `session-5` for
  dev3 Pi in the registry). The `new_conversation` leg has no receipt shape (spec §7.2 returns a value;
  §2's receipt discipline applies to `send` only), so there is nothing structured to recover from.
* `send` **with** `title` fails the same way (it shares the create+rename path, wrapped into a
  `failed` receipt); `send` **without** `title` works.
* Spec §7.2 recommends giving a title ("建议给（LM 语义辨识）") and the tool's own description advertises
  `title?` on both legs — so the *recommended* usage is the broken one.
* Workaround for P3 acceptance: omit `title`. Verified working end-to-end (rows 14–22).

### D2 — Conversation short IDs are degenerate (`session-` + one char)

`shortIdFor` (`a2a-service.ts:147`) mints `sessionId.slice(0, 8)`, but every DSH session id is
`session-<uuid>`, so the first 8 characters are the constant `session-`. Collisions then lengthen by
**one** character. Live registry after ~10 operations:

```
"session-", "session-3", "session-4", "session-5", "session-c"
```

The tool description tells the model these are usable aliases ("conversationId (短 ID)"), and the A2A
envelope teaches the **peer** to reply with `conversationId session-4` — a 9-character id whose first
8 characters carry zero information. Two further mismatches:

* spec §11 prescribes lengthening `8→10→12…`; the implementation lengthens `8→9→10…`.
* spec §2/§7.2's premise ("短 ID = 截首 8 位") silently assumes the session id has no fixed prefix.

Suggested fix direction: mint from the **UUID portion** (e.g. first 4–6 hex of the uuid, or a base36
truncation), which also makes the envelope's reply token actually discriminating.

### D3 — An aborted turn fires an **empty** relay

`subscribeCompletion`'s `fire()` uses `state.lastText.get(turn)?.text ?? ''` and `turn/end` fires on any
live turn end, including `aborted`. Observed twice:

* local, after `stop` → relay text `Agent 79he-xwes79 replied (conversation "(untitled)"):\n\n` (empty)
* cross-machine, after `stop` → relay from `bfwu-ea3yvg` with the same empty body (the very next turn on
  that same conversation relayed `CROSS-OK` correctly, which isolates the emptiness to the abort)

Spec §7.3 scopes relaying to "对端完成 turn **产出最终回复**时". An aborted turn produced no reply, so the
initiator receives a content-free user message — noise in the initiating conversation, and (because it
is a `followup`) it can wake an idle agent for nothing. Suggested: suppress `fire` when the turn ended
non-`completed` and no assistant text was captured, or emit a bounded `a2a-notice` instead.

Related roughness: for `stop` the hub emits **no** notice at all even though `A2aNoticeReason` already
carries `'stop'`.

### D4 — dev3's `codex` world cannot serve the session plane (peer-side, older pack)

Cross-machine A2A to `bfwu-92tgxg` (Codex · dev3) fails at the very first RPC:

```
typert gateway: session/create: active Service "sessionController" is unavailable
typert gateway: session/list:   active Service "sessionController" is unavailable
```

dev3's own world inventory explains it: `session-controller` is `enabled:true` but
`fiberPhase:"pending"` — the row never activated (the same class as the C2 `modules` finding).
The other five dev3 worlds are `active` and serve session RPCs fine. **Action:** dev3-side; not fixable
from this branch. Until then, "dev3-codex" (the target named in plan 5b) is not addressable, and the
tool's `ready:true` for that row is optimistic — roster `ready` does not imply a working session plane.

Additionally, dev3's plugin inventory shows **no `include:superd-a2a` row** (the local instance has one),
i.e. dev3 runs a pre-P3 pack. Cross-machine A2A *to* dev3 still works without it (the reply comes back
over our completion watch), but dev3 cannot *initiate*.

### D5 — `stop` reports `stopped:true` when no turn was active

`stop` scope `turn` was called twice: once while the peer was genuinely running `sleep 45` (row 17), and
once on scope `session` at a moment when **no** turn was in flight (row 18, right after the turn-scope stop
had already aborted turn 3). Both returned `{"stopped":true}`. `a2a-service.ts` returns `cancelled:true`
unconditionally once `session/turnCancel` resolves, so the field means "the cancel RPC was accepted",
not "a turn was cancelled". The tool description promises a hard stop of the **active** turn; a
`cancelled:false` (or an `idle` note) when nothing was running would be honest.

### D6 — The I2 version-mismatch warning can never fire

`versionWarningFor` compares the peer's `hub.version` with this hub package's own version, and
`hub.version` is read from `@pgmi-builds/superd-hub/package.json` — a constant **`0.1.0`** that does not
move with the pack. Both ends report `"version":"0.1.0"` while the packs are `0.1.6-f` (local) and
pre-P3 (dev3). The warning is therefore dead exactly in the case it exists for — and D4 is a concrete
instance (dev3's stale pack was only visible via `pluginInventory`, not via the version probe).
Suggested: source `hub.version` from the **pack** version (or the profile bundle manifest), which is
what `dsh plugin add` actually versions.

### D7 — Unknown *local* a6 gets a machine-level error

```
{action:'new_conversation', agent:'79he-zzzzzz'}
→ a2a: no gateway for 79he-zzzzzz — machine unreachable or not paired
```

`79he` is **this** machine; the address is simply unknown. Spec §11 wants an `unknown-agent` error
"带地址", and the message sends the model chasing a pairing problem that does not exist. The same string
is used for a genuinely unreachable machine, so the two cases are indistinguishable.

### D8 — Unread buffer not live-exercisable (coverage note, not a defect)

`read` returned `{count:0}` in every live probe, correctly: the buffer only fills when the **initiator**
is not live (`route()` → `agents.get` undefined). Reaching it live requires tearing the calling session
down mid-flight, which this rig cannot do from inside itself. The branch is unit-covered
(`a2a-delivery.test.mjs`) but has **no** end-to-end evidence in this report — flagged so it is not
mistaken for verified.

---

## 5. Rig state & side effects

* 4999 line and dev3 were **not** restarted; prod 3080/3081 untouched.
* Session artifacts created (test home `.tests/superd/`):
  * initiator: this session `session-aa6e195a…` — the six `a2a-relay` splices queued on `next-turn`
    (4 local + 2 from dev3) were **all observed firing as real user turns** in the initiating
    conversation, in order: `PONG-P3`, `PONG-P3-II`, *(empty)*, `RESUMED-OK`, *(empty)*, `CROSS-OK`.
    The two empty turns are the D3 aborted-turn relays seen from the receiving side, and the last one is
    the cross-machine `CROSS-OK` — so the splice→turn transition, the aborted-turn→empty-body
    consequence (D3) and the cross-machine path are all confirmed at turn level, not merely at inbox
    level. This is the delivery mechanism working as designed; the artifacts are the test's own traces,
    not leakage.
  * local: native probe `session-3138ea83…` (titled), Pi `session-4ce3e180…` (4 turns:
    PONG-P3 / PONG-P3-II / aborted / RESUMED-OK), Pi `session-c1dd2f81…` and `session-f2527f27…` and
    Codex `session-c8c50130…` (empty shells from the D1 failures and the curl probe).
  * peer dev3: `session-532252a2…` (Pi, 2 turns: 1 aborted by the cross-machine `stop`, 1 completed
    `CROSS-OK`).
* Registry `a2a-conversations.json` holds 5 rows, all `0600`, including the D1 orphan rows.

## 6. Acceptance state

| Spec §14 P3 acceptance criterion | Verdict |
|---|---|
| Tool call `agents` → roster with conversation dimension | ✅ pass |
| `new_conversation` → returns `{conversationId, sessionId, agent, machine}` | ❌ **fail for every non-native target** (D1); ✅ native only |
| `send` → receipt + answer **auto-relayed** back | ✅ pass for local targets (text relayed, 3×) **and cross-machine** (dev3 Pi `CROSS-OK` relayed to the initiator) — **but only when `title` is omitted** |
| `stop` effective and conversation stays resumable | ✅ pass (turn aborted; resume + relay verified), with D3/D5 roughness |

**P3's headline mechanism works** — the receipt, the completion watch, the auto-relayed reply and the
hard stop all function, including across the machine mesh. **P3 is not deliverable as specified**,
because the *title* argument — advertised on both mutating legs and recommended by the spec — is broken
for every foreign target (D1), the addressing aliases handed to the peer are degenerate (D2), and one
named peer target (dev3 codex) is unreachable for peer-side reasons (D4).

Suggested order: D2 (cheap, improves every id the peer must echo) → D1 (the blocker; needs the
world-session attach/title-liveness root cause) → D3/D5 (fidelity) → D6 (restores the diagnostic that
would have surfaced D4).

Awaiting user first-person acceptance before any version bump or publish; no publish performed.

> Independent verification addendum (second observer, dev3): [2026-09-28-hub-tools-rig-test-addendum-independent.md](./2026-09-28-hub-tools-rig-test-addendum-independent.md)
