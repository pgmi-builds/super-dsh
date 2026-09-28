# SuperD Hub — first-person `superd-hub` tool & facilities pass (`super-dsh@0.1.6-k`)

**Subject**: the **`superd-hub` model tool** and the **facilities behind it** — the A2A
conversation service, the v1 envelope/ingest plane, the postoffice outbox, the m4/a6
roster + machine pairing, the `/api/superd/*` mesh API, the `/hub` foreign demux, and the
5-minute information-status sweep. Only the hub surface: no `cordis_a2a` MCP, no browser UI pass.

**First-person** means literally: every §3 tool result was produced by *this* DSH session
calling its own `superd-hub` tool inside the **live** dev3 instance — no external driver, no
curl stand-in for a tool leg, no reuse of a previous run's transcript. §5 facility probes are
curl against the *same* process and direct reads of the on-disk registries it writes.

- **Date/time**: 2026-09-28, ~20:55–21:06 CST (+08:00).
- **Tester session**: `session-83ed9a3f-27d0-4c1f-9dd7-b872bcc8ca3f` (ctx0 native lane), hub
  address **`bfwu-0kdzjk`**, machine **`bfwu`** = dev3 (187.127.111.29).
- **Runtime**: `dsh.service` (live Dash Agent Web UI), `127.0.0.1:3080`, started 19:40:19 CST;
  `DSH_HOME=/home/u1/.dsh`, profile `web`.
- **Pack under test**: `super-dsh@0.1.6-k` (dev3 profile tree).
- **Peer**: machine **`79he`** = PC/homepc, origin `https://test.pc.internal.test` → the
  `.tests/superd` rig, unit `superd-4999-test.service`, worktree `.worktrees/mesh-p1`,
  pinned `file:.../.scratch/superd-pack/super-dsh-0.1.6-k.tgz`. **Both ends are `0.1.6-k`.**
- Prior passes on older packs: `2026-09-28-superd-hub-first-person-0.1.6-j.md` (user's own),
  `2026-09-28-hub-tools-rig-test.md` (+ independent addendum).

---

## 1. The tool: seven legs, one call shape

`superd-hub` is a single dispatch tool — one optional `action` + per-leg params. Legs below are
the complete surface as exercised; `agent`/`conversationId` are `<m4>-<a6>` / 6-char shortIds.

| Leg | Params | Meaning |
|---|---|---|
| *(omitted)* / `agents` | — | roster: machines → agents (`id`, `label`, `address`, `ready`, `failed`) |
| `agent_status` | `agent` | one agent's alive-first ≤5-row session window from the 5-min cache |
| `new_conversation` | `agent`, `title?` | mint a conversation + session on the peer; injects the teaching line |
| `send` | `agent`, `conversationId?`/`title?`, `message` | inject one user turn; mints a conversation if none given |
| `read` | — | sweep messages buffered for *this* session while it was not live |
| `stop` | `agent`, `conversationId` | cancel the peer's active turn (never closes the session) |
| `exec` | — | P4 placeholder: `"not yet implemented: exec (P4)"` |

**Facilities behind it** (enumerated from the installed `superd-hub/dist` and then probed, §5):
`a2a-service` (registry/mint/send/stop/unread buffer) · `a2a-wire` + `a2a-ingest` (envelope v1,
send-receipt guard, **idempotent seen-set**) · `a2a-delivery` (live-agent routing) · postoffice
outbox (durable parking) · `agent-roster` + `roster` + `agent-ids` (a6 mint) + `machines` (m4
mint, pairing) · `mesh-link` + `mesh-federate` + `agent-status` (5-min sweep + window shaper) ·
`mesh-rpc` (`/api/superd/*`) · `hub-route` (`/hub` foreign demux + WS mux) · `web-trust` (auth
fence) · on-disk registries under `<home>/superd/`.

---

## 2. First-person tool legs (verbatim receipts)

Roster (leg 1/2) returned **2 machines × 7 agents = 14 rows, all `ready:true`, `failed:false`**:

```
bfwu (local): 0kdzjk DSH · 9xpbi4 Claude · 0yijnn OMP · 92tgxg Codex · ea3yvg Pi · dqsdy4 Hermes · yuaisr Antigravity
79he (PC):    74tu6w Antigravity · 2wmzvq Claude · c6uxel Codex · 8ah589 DSH · zdn2wp Hermes · 0d6xzz OMP · xwes79 Pi
```

| # | Call | Result |
|---|---|---|
| 1 | `{}` | roster, identical shape to `agents` |
| 2 | `agents` | 14 rows, addresses `<m4>-<a6>` |
| 3 | `exec` | `{"action":"exec","note":"not yet implemented: exec (P4)"}` |
| 4 | `read` | `{"action":"read","count":0,"messages":[]}` |
| 5 | `agent_status bfwu-0kdzjk` (**self**) | 5 rows; **my own session `83ed9a` shows `status:"busy"`, `agentAvailable:true`** — the cache sees the tester mid-turn |
| 6 | `agent_status 79he-8ah589` | remote window; incl. `a3ba70` `"superd"` idle, plus two `[hub A2A]` rows carrying `conversationId` |
| 7 | `agent_status 79he-xwes79` | 5 idle `[unhosted]` rows |
| 8 | `agent_status 79he-zzzzzz` | honest empty: `{"sessions":[],"note":"no collected status for this agent yet …"}` |
| 9 | `new_conversation bogus` | `[E_BAD_ADDRESS] … must be a "<m4>-<a6>" address …` |
| 10 | `new_conversation 79he-zzzzzz` | `a2a: unknown-agent 79he-zzzzzz (no such agent on machine 79he)` — address-bearing, no phantom pairing |
| 11 | `send` (no `agent`) | `[E_MISSING_AGENT]` |
| 12 | `stop` (no `agent`) | `[E_MISSING_AGENT]` |
| 13 | `send` agent+conv, no `message` | `[E_MISSING_MESSAGE]` |
| 14 | `stop` agent, no `conversationId` | `[E_MISSING_CONVERSATION]` |
| 15 | `new_conversation bfwu-ea3yvg` + title | `{"conversationId":"gjrfr0","sessionId":"session-d6033e6f-…","agent":"ea3yvg","machine":"bfwu"}` |
| 16 | `send` local → `gjrfr0` | `outcome:"injected"`, `messageId a2a-558a5edb-…`, no rename, no orphan |
| 17 | `new_conversation 79he-xwes79` + title | `{"conversationId":"1st1ke","sessionId":"session-a8fb5809-…","agent":"xwes79","machine":"79he"}` |
| 18 | `send` cross → `1st1ke` | `outcome:"injected"`, `messageId a2a-40f5c60a-…` |
| 19 | `stop` local `gjrfr0` (peer idle) | `{"stopped":false,"scope":"turn","note":"no turn was active"}` |
| 20 | `stop` cross `1st1ke` (peer **busy**) | `{"stopped":true,"scope":"turn"}` |
| 21 | `agent_status bfwu-ea3yvg` (after 15/16) | 5-row window **does not yet contain `gjrfr0`/`d6033e6f`** — cache freshness, see F3 |

Validation order is `agent` → then the leg-specific field. Items 11/12 prove the agent check runs
first; 13/14 prove the second check (`message` / `conversationId`) still fires once `agent` is
present. (The earlier `-j` report listed only 13/14's messages; this pass pins the ordering.)

---

## 3. Live A2A round trips (real peers, peer-side truth)

### 3.1 Local loop — dev3 Pi `bfwu-ea3yvg` (conversation `gjrfr0`)

Peer session `session-d6033e6f-…` (`~/.dsh/agents/pi/sessions/…`) contains **exactly two**
`user/message` rows:

| seq | `source.rpcId` | payload |
|---|---|---|
| 9 | `a2a-37f85fdf-…` | `(conversation opened)` teaching line |
| 45 | `a2a-558a5edb-…` | my `send` content (`… PONG-K-L1`) |

Turn 2's assistant text was **exactly `PONG-K-L1`**, `turn/end reason=completed`. One envelope →
one row → one reply.

### 3.2 Cross-machine loop — PC Pi `79he-xwes79` (conversation `1st1ke`)

Peer session `session-a8fb5809-…` (`.tests/superd/agents/pi/sessions/…`):

| seq | event | detail |
|---|---|---|
| 5 / 9 | turn 1 start / opening envelope | `rpcId a2a-fd4a84f9-…`, `(conversation opened)` |
| 155 | turn 1 end | `reason {"kind":"aborted","reason":{"kind":"user"}}` ← **my leg-20 `stop`** |
| 156 / 157 | turn 2 start / content envelope | `rpcId a2a-40f5c60a-…` (leg 18) |
| 159 | assistant text | **exactly `PONG-K-X1`** |
| 161 | turn 2 end | `reason {"kind":"completed"}` |

So cross-machine `stop` is a real turn abort on the remote agent, and the content envelope that
was **queued behind turn 1 survived the abort and was delivered on the next turn**.

### 3.3 Envelope/turn semantics observed

`new_conversation` injects only the teaching line (`(conversation opened)`); the actual `send`
payload is a *separate* user turn. A peer that lingers on the opening line delays the payload
(the PC Pi spent 22 steps investigating `"FP-K"`), so `stop` doubles as a queue-flusher. This is
protocol-consistent, not a defect — but it is the observable shape a caller must expect.

---

## 4. Inbound relay into the initiator session (the `0.1.6-k` fix)

`0.1.6-k` is the postoffice/exactly-once revision (`7a6db7e`): every ingest response is a v1
send-receipt the sender's guard accepts, and inbound envelopes are idempotent by `messageId`
via a bounded persisted seen-set.

dev3 `<home>/superd/a2a-seen.json` after the pass:

```
a2a-37f85fdf-…   (opening, gjrfr0)     a2a-558a5edb-…   (my local send)
a2a-notice-87adfbe4-… (completion notice)  a2a-relay-28b11e6e-… (peer reply relayed to me)
(+ historical a2a-1e281ad0-…)
```

`a2a-outbox.json` = **`{"envelopes":[]}`** — nothing parked, i.e. the receipt guard accepted
every delivery outcome and no envelope fell through to the 5-min re-pull path. The hub minted a
relay envelope (`a2a-relay-28b11e6e-…`, later confirmed as the cross-machine reply relay) addressed to my session; because the initiator (this
session) was **busy**, the relay is held pending the initiator's turn boundary and my session
store contains **0** inbound A2A rows while the turn is open. Confirmation of the post-boundary
delivery (and its count) is appended in the Addendum below.

---

## 5. Facilities, probed live against the same process

Authenticated with the per-boot launch token (`journalctl --user -u dsh.service`) minted into a
cookie jar; unauthenticated probes kept as fence evidence.

| Probe | Result |
|---|---|
| `GET /` (no token/cookie) | `401 dsh web authentication required` |
| `GET /hub` (no auth) | `401` |
| `GET /api/agent-runtime` | **14 agents**, `{local:7, 79he:7}` — full roster for the local UI |
| `GET /api/agent-runtime?mesh=1` | **7 agents, all `local`**; `hub {machineId:"bfwu", label:"local", version:"0.1.6-k"}` — self-description discipline holds on `-k` |
| `GET /api/superd/machines` | `{"self":{"id":"bfwu","label":"local"},"machines":[{"id":"79he","name":"pc","origin":"https://test.pc.internal.test","enabled":true,"status":"reachable","lastProbeAt":…}]}` |
| `POST /api/superd/machines {}` | `400 mesh-api: pair body must be {name, label?, tokenUrl} …` |
| `GET /api/superd/a2a/outbox` (no `machine`) | `400 mesh-api: a2a outbox claim requires a non-empty ?machine= query parameter` |
| `GET /api/superd/outbox` | `404` — the real route is `/api/superd/a2a/outbox` |
| Route literals in dist | `/api/agent-runtime`, `/api/superd/a2a`, `/api/superd/a2a/outbox`, `/api/superd/machines`, `/hub`, `/hub/api/remote.mux` (WS mux) |

**Mutual pairing (both ends read directly):**

| Side | self | remote |
|---|---|---|
| dev3 | `{id:"bfwu", label:"local"}` | `79he` / `pc` / `test.pc.internal.test`, enabled, `reachable` |
| PC rig | `{id:"79he", label:"local"}` | `bfwu` / `dev3` / `dsh.dev3.internal.test`, enabled |

On-disk facility set on both ends: `machines.json`, `agent-ids.json`, `a2a-conversations.json`,
`a2a-outbox.json`, `a2a-seen.json`, `agent-status.json`.

---

## 6. Findings & notes

- **F1 — All seven legs behave, error paths are honest and address-bearing.** No phantom pairing
  story, no opaque throw; `unknown-agent` and `E_BAD_ADDRESS` both name the input.
- **F2 — `stop` semantics are precise and cross-machine-capable.** `stopped:true` on a live
  remote turn (peer logged `turn/end … aborted/user`); `stopped:false` + `"no turn was active"`
  when idle. Idempotent second call confirmed on the local peer.
- **F3 — `agent_status` is a 5-minute cache and is honest about it.** A brand-new conversation
  (opened seconds earlier) was **not** visible in its lane's window; `collectedAt` was the stale
  bucket. The leg's own note ("not-in-window implies nothing") is the correct reading — do not
  use this leg as a liveness oracle for a just-created conversation.
- **F4 — Exactly-once holds on this pass.** Peer logs show **one** `user/message` row per
  envelope id; the initiator's outbox stayed empty; the persisted seen-set recorded each id once.
  No *duplicate* relay (same `messageId`) was observed — the two relays carry distinct ids and map 1:1 onto completed turns (contrast: the `-j` user self-test that motivated the `-k` fix, which delivered one id twice). Volume is exactly-once; see F9/F10 for fan-out and delivery pacing.
- **F5 — Validation order is `agent` first** (`E_MISSING_AGENT` precedes
  `E_MISSING_MESSAGE`/`E_MISSING_CONVERSATION`).
- **F6 — `new_conversation` ≠ delivery.** It opens the session and injects only the teaching
  line; content needs a `send`. Callers that expect the opening call itself to carry a task will
  see the peer idle/investigating (observed: the PC Pi burned 22 steps on the bare opening line).
- **F7 — Inbound relay to a busy initiator is deferred, not lost.** The relay envelope was
  minted and the outbox stayed empty while the initiator's turn was open.

- **F8 — Registry row shape differs by locality.** A same-machine conversation row carries
  `hostAgent` (the local lane hosting the peer session — `gjrfr0` → `hostAgent:"ea3yvg"`); a
  cross-machine row carries `initiatorSession` (`1st1ke` → `session-83ed9a3f-…`). Both feed the
  `agent_status` registry join; neither is a pairing record.

- **F9 — Fan-out is per *completed turn*, not per `send`.** One local `send` produced **two**
  relays: `a2a-relay-ff4abbe6-…` (the peer's answer to the `new_conversation` teaching line —
  "**Probe received.** ✅ …") and `a2a-relay-a1304ee3-…` (the answer to the message actually sent,
  `PONG-K-L1`). `a2a-delivery.js` wires a conversation's completion stream to the initiator and
  relays **every** fired completion (a non-`completed` turn with empty text degrades to a bounded
  notice instead). So `new_conversation` + `send` can deliver more messages than the caller sent,
  the first of which answers the teaching line rather than the content. The relayed turn is the
  one that completes *next*, not necessarily the one carrying the sent message — which matters
  when the peer lingers on the bare `(conversation opened)` text (the local peer spent turn 1
  investigating it).
- **F10 — Nothing is lost; a busy initiator drains one item per turn boundary.** All four items
  minted during the pass were spliced into the initiator's inbox (`agent/inbox/spliced`,
  `target:"next-turn"`) and **none were dropped**: `04c2b63c` (local relay 1 → delivered `seq 289`),
  `9d981913` (local relay 2 → delivered `seq 347`), `9a025298` (the D3 abort notice —
  `conversation "1st1ke": turn aborted, no reply`), `bc58580b` (the cross-machine reply
  `Agent 79he-xwes79 replied … PONG-K-X1`). All four drained **in order** (`seq` 289 → 347 → 385 → 411), one per turn boundary.
  `<home>/superd/a2a-outbox.json` stayed empty throughout, and the `-k` seen-set holds each
  envelope id exactly once — exactly-once is a *per-envelope-id* guarantee, while delivery
  *pacing* is one message per turn.
  **Correction:** an earlier revision of this report concluded from the first boundary that the
  content reply "was never relayed" and the cross reply "never surfaced". Both were present as
  queued inbox items and the second relay was delivered at the next boundary; those claims are
  withdrawn here.

## 7. Not covered

- `exec` (P4 placeholder by design), `read` with a non-empty buffer (nothing was buffered).
- The `/hub/api/remote.mux` WS mux and foreign-caller demux through `/hub` were only
  route-enumerated, not driven as a foreign client.
- Pairing lifecycle (`POST /api/superd/machines` success path) — validation error only.
- Saturation/idempotency of the 128-entry seen-set bound.

## 8. Addendum — inbound delivery confirmation (post-turn-boundary)

Wire-layer evidence, gathered while the initiator turn was still open:

- the hub minted the relay envelope `a2a-relay-28b11e6e-…` (peer reply → initiator) plus a
  completion notice `a2a-notice-87adfbe4-…`;
- `<home>/superd/a2a-outbox.json` remained `{"envelopes":[]}` — the relay was **not** parked and
  no 5-min re-pull path was armed (exactly what the `-k` receipt guard exists to prevent);
- `a2a-seen.json` lists each envelope id **exactly once**;
- the initiator's own session store held **0** inbound A2A rows while the turn was open.

Because the initiator (this session) was mid-turn, the relay is **held for the turn boundary**
instead of being written into the store immediately — i.e. the tool's "reply auto-delivers as a
new message in this conversation" promise is a *deferred* delivery in the busy case, not an
in-line one. Whether the deferred relay then lands **exactly once** at the boundary is the one
item this pass could not observe from inside the open turn; it is appended below on delivery.

**Delivered** at the initiator's turn boundaries — **three** `a2a-relay` rows (one per completed
peer turn, distinct message ids, no duplicate) plus **one** `a2a-notice`, drained **one per turn
boundary**:

| seq | delivered (local) | `messageId` | payload |
|---|---|---|---|
| `289` | `1790600446678` (~21:00:46) | `a2a-relay-ff4abbe6-…` | peer's turn-1 answer ("**Probe received.** ✅ …") |
| `347` | `1790600549201` (~21:02:29) | `a2a-relay-a1304ee3-…` | peer's turn-2 answer (`PONG-K-L1`) |
| `385` | `1790600617109` (~21:03:37) | `a2a-notice` (`9a025298`) | D3 abort notice: `conversation "1st1ke": turn aborted, no reply` |
| `411` | `1790600639630` (~21:03:59) | `a2a-relay-28b11e6e-…` (`bc58580b`) | **cross-machine** reply: `PONG-K-X1` |

A third item drained at the **following** boundary, confirming the pacing model: the `1st1ke`
abort notice (`9a025298`, `kind:"a2a-notice"`, `seq 385`, ~21:03:37) — i.e. the D3 notice path
fires for a `stop`-aborted turn exactly as `a2a-delivery.js` documents. The fourth and final item drained at the next boundary: the **cross-machine** reply relay
(`bc58580b`, envelope `a2a-relay-28b11e6e-…`, `seq 411`, ~21:03:59, `Agent 79he-xwes79 replied …
PONG-K-X1`). The queue completed **4/4 in order** (`seq` 289 → 347 → 385 → 411), one message
per turn boundary, with nothing dropped (F10).

So the busy-initiator deferral delivers **exactly once per envelope id** and loses nothing, but it
does not mean "one reply per `send`", and a busy initiator receives the peer's messages in
installments. `read` returned `count:0` throughout (the hub's own unread buffer is separate from
the session inbox), and `<home>/superd/a2a-outbox.json` stayed `{"envelopes":[]}`.
