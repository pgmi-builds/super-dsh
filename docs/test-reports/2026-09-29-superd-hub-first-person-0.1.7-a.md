# SuperD Hub — first-person `superd-hub` tool & facilities pass (`super-dsh@0.1.7-a`)

**Subject**: the **`superd-hub` model tool** and the **facilities behind it** — the A2A conversation
service, the envelope v1 / ingest plane with its idempotent seen-set, the postoffice outbox, the
m4/a6 roster + machine pairing, the `/api/superd/*` mesh API, `/api/agent-runtime` (incl. `?mesh=1`),
the `/hub` foreign demux + WS mux, the auth fence, and the 5-minute information-status sweep.
Hub surface only: no `cordis_a2a` MCP, no browser UI pass.

**First-person** means literally: every §2–§4 tool result was produced by *this* DSH session calling
its own `superd-hub` tool inside the **live** dev3 instance — no external driver, no curl stand-in
for a tool leg, no reuse of a previous run's transcript. §5 facility probes are curl / raw sockets
against the *same* process, plus direct reads of the on-disk registries it writes.

- **Date/time**: 2026-09-29, ~05:16–05:22 CST (+08:00) = 2026-09-28 21:16–21:22 UTC.
- **Tester session**: `session-0e9183b2-21c3-447d-8d6d-cd65983a0ede` (ctx0 native lane), hub address
  **`bfwu-0kdzjk`**, machine **`bfwu`** = dev3 (187.127.111.29).
- **Runtime**: `dsh.service` (live Dash Agent Web UI), `127.0.0.1:3080`, PID 2290730, started
  2026-09-29 04:53:57 CST; `ExecStart=dsh web --trusted-host dsh.dev3.internal.test`;
  `DSH_HOME=/home/u1/.dsh`, profile `web`.
- **Pack under test**: `super-dsh@0.1.7-a` (dev3 profile tree, installed from
  `file:/tmp/super-dsh-0.1.7-a.tgz`); served `hub.version` = `0.1.7-a`.
- **Peer**: machine **`79he`** = PC/homepc, origin `https://test.pc.internal.test` → the rig at
  `superd-4999-test.service`, `DSH_HOME=.worktrees/mesh-p1/.tests/superd`, profile `superd-pub`,
  pack also **`0.1.7-a`** (worktree `super-dsh`). **Both ends are `0.1.7-a`** — no mixed-version skew.
- **Source revision**: mesh-p1 HEAD `4ee6b82` (acceptance doc), feature commit `7b5f61e`
  *"feat(a2a): reply semantics v3 (D20-D22) — channel-first replies with monotonic latch +
  transcript fallback, 0.1.7-a"*.
- **Prior passes**: `2026-09-28-superd-hub-first-person-0.1.6-j.md` (user's own),
  `2026-09-28-superd-hub-first-person-0.1.6-k.md`, `2026-09-28-hub-tools-rig-test.md` (+ independent
  addendum). This pass is the **first on `0.1.7-a`** and the first to re-check D1/D2/D3/D5 live.

**Delta since the last pass**: dev3 moved `0.1.6-k` → **`0.1.7-a`**, whose headline is *reply
semantics v3* — channel-first write-back with a monotonic latch, transcript fallback for no-tool
peers, a one-turn opening (D21), and a `'pending'` taxonomy reserve (D22). This pass exercises all of
it live, plus a regression sweep over the older defect list.

---

## 1. The tool: seven legs, one call shape

`superd-hub` is a single dispatch tool — one optional `action` plus per-leg params. The complete
surface as exercised; `agent` is `<m4>-<a6>`, `conversationId` a 6-char shortId.

| Leg | Params | Meaning |
|---|---|---|
| *(omitted)* / `agents` | — | roster: machines → agents (`id`, `label`, `address`, `ready`, `failed`) |
| `agent_status` | `agent` | one agent's alive-first ≤5-row session window from the 5-min cache |
| `new_conversation` | `agent`, `title?`, `message?` | mint a conversation + session on the peer; `message` merges the opening into ONE turn |
| `send` | `agent`, `conversationId?`/`title?`, `message`, `delivery?` | inject one user turn; mints a conversation if none given; `delivery` = `queue`(default) / `steer` |
| `read` | — | sweep messages buffered for *this* session while it was not live |
| `stop` | `agent`, `conversationId`, `scope?` | cancel the peer's active turn; `scope` `turn`(default)/`session` |
| `exec` | — | P4 placeholder: `"not yet implemented: exec (P4)"` |

**Facilities behind it** (enumerated from the installed `superd-hub/dist`, then probed in §5):
`a2a-service` (registry / mint / send / stop / unread buffer) · `a2a-wire` + `a2a-ingest` (envelope
v1, send-receipt guard, **idempotent seen-set**) · `a2a-delivery` (live-agent routing) · postoffice
outbox (durable parking) · `agent-roster` + `roster` + `agent-ids` (a6 mint) + `machines` (m4 mint,
pairing) · `mesh-link` + `mesh-federate` + `agent-status` (5-min sweep + window shaper) ·
`mesh-rpc` (`/api/superd/machines`) · `rpc` (`/api/agent-runtime`) · `hub-route` (`/hub` foreign
demux + WS mux) · `web-trust` (auth fence) · `pack-version` (served `hub.version`) · on-disk
registries under `<home>/superd/`.

---

## 2. First-person read-only legs (verbatim receipts)

**Roster (legs 1–2)** returned **2 machines × 7 agents = 14 rows, all `ready:true`, `failed:false`**,
identical for `{}` and `agents`, and **unchanged after all write activity** (no duplicate/phantom
rows, no peer re-broadcast — self-description discipline holds):

```
bfwu (local): 0kdzjk DSH · 9xpbi4 Claude · 0yijnn OMP · 92tgxg Codex · ea3yvg Pi · dqsdy4 Hermes · yuaisr Antigravity
79he (PC):    74tu6w Antigravity · 2wmzvq Claude · c6uxel Codex · 8ah589 DSH · zdn2wp Hermes · 0d6xzz OMP · xwes79 Pi
```

| # | Call | Result |
|---|---|---|
| 1 | `{}` | roster, identical shape to `agents` |
| 2 | `agents` | 14 rows, addresses `<m4>-<a6>` |
| 3 | `exec` | `{"action":"exec","note":"not yet implemented: exec (P4)"}` |
| 4 | `read` (start) | `{"action":"read","count":0,"messages":[]}` |
| 5 | `read` (after 6 reply deliveries) | still `count:0` — **replies are spliced live into the calling session, never buffered** (see §4) |
| 6 | `agent_status bfwu-0kdzjk` (**self**) | 5 rows; my own session `0e9183` shows `status:"idle"`, `agentAvailable:true` — **the cache is a ~2.6-min-old snapshot taken before this turn** (`collectedAt` 1790630055907 = 05:14:15) |
| 7 | `agent_status 79he-8ah589` | 5 idle rows (`d34d6d`,`a12a47`,`33b5df`,`a3ba70`,`aa6e19`) — no `[hub A2A]` rows in the remote window today |
| 8 | `agent_status bfwu-ea3yvg` (local Pi) | fresh row **`a1cc9d` titled `FP-A local transcript (0.1.7-a) [hub A2A]` carrying `conversationId:"2wnhv3"`** — the shaper surfaces the registry title + marker |
| 9 | `agent_status 79he-zzzzzz` | honest empty: `{"sessions":[],"note":"no collected status for this agent yet …"}` |

> **Observation A (cache latency).** Self `status` reads `idle` while the tester is mid-turn, because
> the window is served from the 5-minute sweep cache and `collectedAt` is ~2.6 min behind the query.
> The previous (0.1.6-k) pass happened to catch a fresher cache and saw `busy`. This is by design,
> but a caller must read `collectedAt` — the field is the honesty mechanism.

---

## 3. Error / rejection legs (verbatim)

| # | Call | Result |
|---|---|---|
| 10 | `send` (no agent) | `Error: [E_MISSING_AGENT] superd-hub: send requires agent ("<m4>-<a6>")` |
| 11 | `send agent=bfwu-ea3yvg` (no message) | `Error: [E_MISSING_MESSAGE] superd-hub: send requires a non-empty message` |
| 12 | `send agent="notanaddress"` | `Error: [E_BAD_ADDRESS] superd-hub: agent must be a "<m4>-<a6>" address — call the agents action to list valid ids (got "notanaddress")` |
| 13 | `new_conversation` (no agent) | `Error: [E_MISSING_AGENT] superd-hub: new_conversation requires agent ("<m4>-<a6>")` |
| 14 | `stop` (no agent) | `Error: [E_MISSING_AGENT] superd-hub: stop requires agent ("<m4>-<a6>")` |
| 15 | `stop agent=bfwu-ea3yvg` (no conversationId) | `Error: [E_MISSING_CONVERSATION] superd-hub: stop requires conversationId` |
| 16 | `agent_status agent="bad"` | `Error: [E_BAD_ADDRESS] superd-hub: agent must be a "<m4>-<a6>" address …` |
| 17 | `stop agent=79he-8ah589 conversationId="zzzzzz"` | `Error: a2a: conversation "zzzzzz" is not in the registry` |
| 18 | `stop agent=79he-zzzzzz conversationId="ovgbuk"` | `Error: a2a: conversation "ovgbuk" belongs to 79he-8ah589, not 79he-zzzzzz` |
| 19 | `action:"bogus_action"` | `Error: invalid arguments: "action" must be one of ["agents","new_conversation","send","read","stop","agent_status","exec"]` |

Validation order (unchanged from the k pass): **agent → message → address** for `send`;
**agent → conversationId → registry/ownership** for `stop`. Legs 17–18 are new, richer ownership
errors not seen in earlier passes.

> **Observation B (dead branch).** `hub-tool.js:351` still carries an `E_BAD_ACTION` throw, but leg 19
> is rejected earlier by the JSON-schema `enum` at the tool boundary, so that branch is unreachable
> from a model call. Harmless defence-in-depth; noted for completeness.

---

## 4. Live write legs — and where the replies landed (the headline)

Six write legs were run. All receipts are verbatim.

| Leg | Call | Receipt |
|---|---|---|
| **FP-A** local transcript | `new_conversation agent=bfwu-ea3yvg title="FP-A local transcript (0.1.7-a)" message="Reply with exactly PONG-FP-A and nothing else."` | `{"conversationId":"2wnhv3","sessionId":"session-a1cc9d0b-…","agent":"ea3yvg","machine":"bfwu"}` |
| **FP-B** cross-machine channel | `new_conversation agent=79he-8ah589 title="FP-B cross-machine channel (0.1.7-a)" message="Reply with exactly PONG-FP-B. If you have the superd-hub tool, reply through the channel with it."` | `{"conversationId":"ovgbuk","sessionId":"session-c9d750b7-…","agent":"8ah589","machine":"79he"}` |
| **FP-C** abort | `new_conversation agent=bfwu-ea3yvg title="FP-C stop/abort (0.1.7-a)" message="Use the bash tool to run: sleep 30 . Wait for it to finish, then reply with exactly PONG-FP-C."` → then `stop` | `{"conversationId":"rj2u8i","sessionId":"session-e0c300f2-…"}` / stop `{"stopped":true,"scope":"turn"}` |
| **FP-D** continuation | `send agent=bfwu-ea3yvg conversationId="2wnhv3" message="Reply with exactly PONG-FP-D and nothing else."` | `{"outcome":"injected","messageId":"a2a-ca4aec9a-…","conversationId":"2wnhv3","sessionId":"session-a1cc9d0b-…","note":"reply auto-delivers as a new message in this conversation — never poll; read only sweeps buffered leftovers"}` |
| **FP-E** steer | `send agent=bfwu-ea3yvg conversationId="rj2u8i" delivery="steer" message="Reply with exactly PONG-FP-E and nothing else."` | `{"outcome":"injected","messageId":"a2a-2e8ffc1a-…","conversationId":"rj2u8i","sessionId":"session-e0c300f2-…","note":…}` |
| **FP-F** world ctx (OMP) | `new_conversation agent=bfwu-0yijnn title="FP-F OMP title/rename regression (0.1.7-a)" message="Reply with exactly PONG-FP-F and nothing else."` | `{"conversationId":"z1u6pj","sessionId":"session-5f8cd596-…","agent":"0yijnn","machine":"bfwu"}` — **no rename error** |

### 4.1 Deliveries into the tester's own session (ground truth, verbatim)

Replies were delivered as `agent/inbox/spliced` events targeting `next-turn` in
`session-0e9183b2…`. The two v3 provenance prefixes are distinguishable at a glance:

```
seq 204  1790630324059  Agent bfwu-ea3yvg — last output at turn end (conversation "FP-A local transcript (0.1.7-a)"):
                        PONG-FP-A
seq 205  1790630324721  Agent 79he-8ah589 replied (conversation "FP-B cross-machine channel (0.1.7-a)"):
                        PONG-FP-B
seq 289  1790630393126  conversation "rj2u8i": turn ended, no reply
seq 315  1790630414009  Agent bfwu-ea3yvg — last output at turn end (conversation "FP-A local transcript (0.1.7-a)"):
                        PONG-FP-D
seq 337  1790630439335  conversation "z1u6pj": turn ended, no reply
seq 340  1790630440389  Agent bfwu-ea3yvg — last output at turn end (conversation "FP-C stop/abort (0.1.7-a)"):
                        PONG-FP-E
```

**Every write leg produced exactly one terminal artifact, and no leg produced a spurious one.**

- **FP-A / FP-D / FP-E** → `— last output at turn end` (transcript fallback; Pi has no `superd-hub`).
- **FP-B** → `replied` (**channel write-back**; the PC DSH *does* have the tool).
- **FP-C** (aborted) and **FP-F** (peer turn errored) → the honest **notice** `turn ended, no reply`.
  This is the D22/taxonomy path: **the old empty-body relay (D3) did not occur.**

### 4.2 Cross-machine channel write-back — peer-side ground truth

The rig's own registry proves the *active* path, not a transcript accident:

```json
{"shortId":"ovgbuk","machine":"bfwu","agent":"0kdzjk","sessionId":"session-c9d750b7-…",
 "title":"FP-B cross-machine channel (0.1.7-a)","hostAgent":"8ah589",
 "channelUsed": true, "lastSentAt": 1790630324625}
```

…and the peer session `session-c9d750b7-…` on the rig shows the peer **using its own tool**:

```
seq 19  assistant/message  "I'll reply through the channel as requested."
seq 20  tool/call  name="superd-hub"  args={"action":"send","agent":"bfwu-0kdzjk","conversationId":"ovgbuk","…"}
seq 21  tool/result
```

Latency: receipt `1790630324625` − conversation `createdAt 1790630322666` ≈ **1.96 s**. The
dev3-side ingest admitted the return envelope (seen-id `a2a-54a6f88a-…`) and spliced it at
`1790630324721`. **Channel-first + monotonic latch verified live, in the dev3→PC direction** (the
acceptance doc verified PC→dev3).

### 4.3 One-turn opening (D21) — verified from the peer's own session log

The dev3 Pi's session `session-a1cc9d0b-…/session.v4.jsonl.zstd` contains **exactly one
`user/message` for the opening turn** (seq 9), and it *is* the v3 teaching envelope with the task
inline:

```
session/title 10  {"title":"A2A message from bfwu-0kdzjk (conversati","messageSeqs":[9],"source":{"kind":"fallback"}}
turn/end      14  {"turn":1,"reason":{"kind":"completed"}}
turn/start    15  {"turn":2}
user/message  16  A2A message from bfwu-0kdzjk (conversation "FP-A local transcript (0.1.7-a)"):
                  Reply with exactly PONG-FP-D and nothing else.
                  …
turn/end      20  {"turn":2,"reason":{"kind":"completed"}}
```

> **Observation C (teaching re-sent every turn).** The full teaching block — including the reply
> address `{action:"send", agent:"bfwu-0kdzjk", conversationId:"2wnhv3", …}` and the "last output at
> turn's end" clause — is **re-appended on every injected turn** (seq 9 and seq 16 both carry it),
> not only on the opening. That is deliberately self-healing (the peer always holds a fresh reply
> address) at a cost of ~600 B of envelope per turn. Worth a conscious decision note.

### 4.4 Stop semantics

| Variant | Result |
|---|---|
| `stop` on a **live** turn (FP-C, mid-`sleep 30`) | `{"action":"stop","stopped":true,"scope":"turn"}` — peer log ends `turn/end {"kind":"aborted","reason":{"kind":"user"}}` |
| `stop` on an **idle** conversation | `{"action":"stop","stopped":false,"scope":"turn","note":"no turn was active"}` |
| `stop scope="session"` | `{"action":"stop","stopped":false,"scope":"turn-only","reason":"no session-close endpoint upstream","note":"no turn was active"}` |

**Both the honest idle shape and the scope degradation are correct** (D5 fixed; see §6).

---

## 5. Facility probes (against the same PID 2290730)

### 5.1 Auth fence — never weaker on any family

Unauthenticated `GET` on the live process → `401 unauthorized` for **every** path, including bogus
ones: `/api/superd/machines`, `/api/agent-runtime`, `/hub`, `/hub/api/remote.mux?agent=x`, and
`/api/superd/nope`. A trusted `Host:` header alone does **not** bypass it. The startup
`?token=` URL → `303 See Other`, `location: ./`, and `Set-Cookie: dsh-auth-…` (Max-Age 2592000,
HttpOnly, SameSite=Strict); with that cookie `/api/superd/machines` and `/api/agent-runtime` → `200`.

### 5.2 Mesh API `/api/superd/machines`

| Request | Response |
|---|---|
| `GET` | `200 {"self":{"id":"bfwu","label":"local"},"machines":[{"id":"79he","name":"pc","label":"PC","origin":"https://test.pc.internal.test","enabled":true,"addedAt":1790590027415,"status":"reachable","lastProbeAt":1790630056039}]}` |
| `POST {}` | `400 mesh-api: pair body must be {name, label?, tokenUrl} with non-empty name and tokenUrl` |
| `POST not-json` | `400 mesh-api: request body is not valid JSON — Unexpected token 'o', "not-json" is not valid JSON` |
| `DELETE ?id=zzzz` | `200 {"removed":false}` |
| `DELETE` (no id) | `400 mesh-api: DELETE on /api/superd/machines requires a non-empty ?id= query parameter` |
| `PUT` | `404 not found` |

### 5.3 `/api/agent-runtime`

- `GET` → `200`; `agents` = **7 local** rows (`id`,`key`,`label`,`path`,`machine:"local"`,`ready`),
  `available` = **14** keys (7 local runtime keys + 7 federated per-agent keys of the peer).
- `GET ?mesh=1` → adds `hub = {"machineId":"bfwu","label":"local","version":"0.1.7-a"}` — the served
  pack version matches the installed pack (D6 comparator consistent).
- `POST {}` → `400 {"error":"selection is per-request (mount path); no server-side switch", "available":[…14…]}`.

### 5.4 `/hub` foreign demux + WS mux

| Request | Response |
|---|---|
| `GET /hub` (cookie) | `404` |
| `GET /hub/api/x`, `?agent=native`, `/hub/api/agent-runtime?agent=native` | `404 {"error":"foreign-only","message":"the /hub family serves ?agent=<label> foreign traffic only; native belongs to /api"}` |
| `GET /hub/api/x?agent=nope` | `404 {"error":"unknown-agent","label":"nope"}` |
| `WS /hub/api/remote.mux?agent=pi` | **`101 Switching Protocols`** |
| `WS /hub/api/remote.mux?agent=omp` | **`101`** |
| `WS /hub/api/remote.mux?agent=nope` / no `agent` | `404` at upgrade |

### 5.5 On-disk registries + observability

`~/.dsh/superd/`: `a2a-conversations.json` (0600, atomic tmp+rename), `a2a-seen.json`,
`a2a-outbox.json` (`{"envelopes":[]}` — nothing parked), `agent-ids.json`, `agent-status.json`,
`machines.json`. The `ovgbuk` row demonstrates write-back fields; `2wnhv3`/`rj2u8i`/`z1u6pj` show
registry-borne titles.

> **Observation D (no journal logging).** `journalctl --user -u dsh.service` contains **zero** A2A /
> superd / envelope / delivery lines across the whole pass. Hub activity is observable only through
> registries and session logs; there is no operational log of ingest, latch, park-retry or notice
> events. That is a real observability gap for debugging a mesh incident.

> **Observation E (legacy `[undefined]` rows).** Rows `c9fk7p` and `7dktzd` (older passes) persist
> with the literal title `[undefined]` and render that way in `agent_status` windows. Pre-fix
> artifacts survive because the registry is append/never-migrate; harmless but visually noisy.

---

## 6. Regression status against the known defect list

| Old defect | Status on `0.1.7-a` | Evidence |
|---|---|---|
| **D1** title rename fails for foreign/world targets, orphaning the conversation | **Resolved (by design change)** | `a2a-service.js:663` — *"D17: title stored normalized at mint, immutable; zero rename calls"*. No rename is attempted. Titles persist in the registry on both sides, and the status shaper surfaces `{title} [hub A2A]`. Legs FP-A/FP-F (incl. the OMP **world** ctx that reproduced D1 in the addendum) minted cleanly with titles intact. |
| **D2** shortId degenerates to `sessionId.slice(0,8)` (`session-…`) | **Fixed** | All new ids are random 6-char: `2wnhv3`, `ovgbuk`, `rj2u8i`, `z1u6pj`. No `session-` rows were minted. |
| **D3** aborted turn fires an empty relay | **Fixed** | FP-C abort produced **no relay**; the only artifact was the notice `conversation "rj2u8i": turn ended, no reply`. |
| **D5** `stop` reports `stopped:true` when nothing ran | **Fixed** | Idle stop → `{"stopped":false,"scope":"turn","note":"no turn was active"}`. |
| **D8** unread buffer not live-reachable | **Unchanged / by design** | Replies arrive as live inbox splices (`seq 204/205/289/315/337/340`); `read` stayed `count:0` throughout. Matches the documented contract ("read only sweeps buffered leftovers"). |
| **D4** dev3 runs a pre-P3 pack | **Stale** | dev3 is on `0.1.7-a` with the full A2A plane; both ends matched. |

---

## 7. Findings

**Facility / behavioural**

1. **OMP local lane is broken (environmental, not hub).** FP-F's turn ended
   `{"kind":"error","error":{"message":"Error: sidecar exited before ready (1): Error: Bun's
   postinstall script was not run. … cd node_modules/bun && node install.js"}}`. The hub still
   behaved correctly: the message was injected (peer log `user/message` seq 6) and the sender got the
   honest notice. *Fix belongs to the OMP lane, not superd-hub.*
2. **No operational logging** (Observation D) — the single highest-value improvement for field
   debugging.
3. **`agent_status` cache latency** (Observation A) — callers must consult `collectedAt`; a
   mid-turn self read returns `idle`.
4. **Teaching envelope re-sent per turn** (Observation C) — deliberate, but ~600 B/turn of envelope
   rides every continuation.
5. **`[undefined]` legacy rows** (Observation E) surface as literal titles in status windows.
6. **Unreachable `E_BAD_ACTION` branch** (Observation B) — dead code behind the schema enum.

**Carried over from the prior addendum (still true)**

7. `PUT /api/superd/machines` → `404 not found` (an undeclared-method fall-through; a `405` would be
   tidier).
8. Bare `/hub` (authenticated) → `404`; the family is foreign-only by design.

**What worked exactly as specified** — the roster and its discipline (14 rows, no drift after all
activity), `exec` placeholder, all error codes and validation order, the one-turn opening (D21), the
transcript fallback and the channel write-back with both provenance prefixes, the honest no-reply
notice, the latch (`channelUsed:true`, `lastSentAt`), `send` continuation reusing the peer session,
`delivery:"steer"`, the live abort, the `scope:"session"` degradation, the auth fence, the mesh API
shapes, the `/hub` demux matrix, and the WS mux (`pi`/`omp` → 101, unknown → 404).

---

## 8. Side effects (this run)

- **Peer sessions created** (all new, no pre-existing session disturbed):
  - dev3 Pi `session-a1cc9d0b-…` (FP-A + FP-D continuation, 2 turns, completed)
  - dev3 Pi `session-e0c300f2-…` (FP-C aborted, then FP-E steer turn, completed)
  - dev3 OMP `session-5f8cd596-…` (FP-F, ended `error` — bun postinstall)
  - PC rig `session-c9d750b7-…` (FP-B, completed; peer called its own `superd-hub` send)
- **Registry rows added**: `2wnhv3`, `rj2u8i`, `z1u6pj` (dev3) · `ovgbuk` (both sides). Local row
  count 7 → 12; peer row count 17 → 20.
- **Seen-set**: 7 → 13 ids (return envelope `a2a-54a6f88a-…` for FP-B, plus leg receipts).
- **Outbox**: `{"envelopes":[]}` before and after — nothing parked, no retry backlog.
- **No** restarts, **no** config/registry edits by hand, **no** `dsh`/pack changes, no other
  services touched. Only the test conversations above and their peer turns are durable artifacts.

---

## 9. Verdict

`superd-hub@0.1.7-a` is **green on a first-person pass**: all seven legs, all error paths, the auth
fence, the mesh API, the `/hub` demux and the WS mux behaved as documented, and the marquee v3 reply
semantics were verified live **in the dev3→PC direction** — the peer's own `superd-hub` write-back
arrived in this session as `Agent 79he-8ah589 replied (…)`, while no-tool peers came back as
`— last output at turn end`, and turns that ended without a reply produced a single honest notice
rather than the old empty relay.

Against the earlier defect list, **D1, D2, D3 and D5 no longer reproduce**, and the D1 resolution is
architectural (titles are immutable registry facts, zero rename calls) rather than a patch — the OMP
world target that failed before now mints cleanly. The only genuine problems found are (a) the
**broken local OMP lane** (bun postinstall; not a hub issue), and (b) an **observability gap**: the
hub emits nothing to the journal, so mesh incidents are diagnosable only from registries and session
logs. Neither blocks the hub surface.

*Tester: `bfwu-0kdzjk` (dev3 DSH native lane, `session-0e9183b2-…`) — 2026-09-29 05:22 CST.*

---

## Addendum — delivery promotion observed live (same session, 05:22 CST)

§4.1 recorded the six artifacts as `agent/inbox/spliced` events targeting `next-turn`. After the
tester's turn ended, the **oldest pending splice was promoted to a real user turn**:

```
seq 431  1790630536677  Agent bfwu-ea3yvg — last output at turn end (conversation "FP-A local transcript (0.1.7-a)"):
                        PONG-FP-A
```

This closes the loop end-to-end: peer reply → hub ingest → inbox splice → **turn in the initiator's
session**, with no polling. At that moment `read` still returned `{"count":0,"messages":[]}` and the
remaining five artifacts (FP-B reply, FP-C notice, FP-D reply, FP-E reply, FP-F notice) were still
pending.

**Observed consequence (turn amplification).** Promotion is FIFO — confirmed across two consecutive promotions (FP-A seq 431, then FP-B seq 460 of the initiator session log) — and is **one splice per
turn end**: a batch of *N* probes sent by one tester yields *N* sequential turns in that tester's
own session, not a coalesced digest. For interactive use (one question → one reply) this is exactly
right; for a fan-out pass like this one it means 6 legs → 6 follow-up turns. Worth a conscious note
for anyone scripting bursts through `superd-hub`. `read` remaining `count:0` throughout also
confirms these are live splices, not buffered leftovers (D8 unchanged / by design).

---

## Addendum 2 — inbox drain sequence, complete (same session, ~05:22–05:24 CST)

All six artifacts from §4 were promoted to real user turns, in strict **FIFO by arrival**
(one splice per turn end). This is the ground-truth drain order read back from the initiator's
session log:

| # | Promoted at | Time | Kind | Conversation |
|---|---|---|---|---|
| 1 | `seq 431` | 05:22:16 CST | transcript fallback | FP-A local transcript (0.1.7-a) |
| 2 | `seq 460` | 05:22:46 CST | channel write-back | FP-B cross-machine channel (0.1.7-a) |
| 3 | `seq 483` | 05:23:13 CST | no-reply notice | rj2u8i |
| 4 | `seq 498` | 05:23:27 CST | transcript fallback | FP-A local transcript (0.1.7-a) |
| 5 | `seq 513` | 05:23:40 CST | no-reply notice | z1u6pj |
| 6 | `seq 528` | 05:23:49 CST | transcript fallback | FP-C stop/abort (0.1.7-a) |

Ordering check: the two **notices** (FP-C abort, FP-F runtime error) were promoted in *arrival*
order, which put FP-F before FP-E — i.e. promotion follows the wire, not the leg naming. FP-E's
`steer` reply is attributed to conversation `FP-C stop/abort (0.1.7-a)`, because the steer resumed
that same aborted session (`session-e0c300f2-…`) — confirming the documented "the conversation stays
resumable: send again to resume it" contract even after a no-reply notice.
