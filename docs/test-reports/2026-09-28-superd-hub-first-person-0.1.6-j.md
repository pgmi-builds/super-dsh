# SuperD Hub — first-person `superd-hub` tool & facilities pass (`0.1.6-j`, 2026-09-28)

**Subject**: the **SuperD Hub tool** (`superd-hub`, spec §9 / D13) and the facilities behind it —
the A2A envelope plane, the mesh roster, the `/hub` demux + mux, the 5-min information-status
sweep, and the on-disk registries. **Not** any other A2A mechanism (no `cordis_a2a` MCP, no
manual CLI delegation).

**First-person** here means literally: every tool result in §3 was produced by *this* DSH agent
session calling the `superd-hub` tool over its own tool surface inside the running 4999 rig —
no external driver, no curl stand-in for a tool leg, no reuse of an earlier run's steps.
Facility probes (§4) are curl/WS against the same process.

- **Rig**: worktree `.worktrees/mesh-p1` @ `262ca38`, unit `superd-4999-test`, booted **18:40:15 HKT**.
- **Pack**: `super-dsh@0.1.6-j` (profile `superd-pub`, `file:` tarball `.scratch/superd-pack/super-dsh-0.1.6-j.tgz`).
- **Runtime**: repo dsh build `dsh-v0.1.7-rc.1` (`upstream/deepseek-harness/apps/cli/lib/bin.js`).
- **Home**: `DSH_HOME=.tests/superd` — note `.worktrees/mesh-p1/.tests` is a **symlink** to
  `/home/u1/workspaces/superd/.tests`, so the rig's home is the master repo's shared test home.
- **Initiator session**: `session-a3ba70af-6415-40f3-871e-40fb31d5ced4` (ctx0 native).
- **Peer**: dev3 (`bfwu`, `https://dsh.dev3.internal.test`), mutually paired, same pack `0.1.6-j`.

Prior coverage, for contrast — both cover the **older** `0.1.6-f`/`0.1.6-i` code and are now stale
on several points this pass re-tests:
[`2026-09-28-hub-tools-rig-test.md`](./2026-09-28-hub-tools-rig-test.md) (D1–D8) and its
[independent addendum](./2026-09-28-hub-tools-rig-test-addendum-independent.md).

---

## 1. What "hub tools, facilities" actually is

| Surface | Entry point | This pass |
|---|---|---|
| Model tool `superd-hub`, single call-shape dispatch | ctx0 `tools` service, row `superd-a2a` → `super-dsh/a2a` | ✅ all 7 legs |
| A2A conversation service (registry, mint, send/stop, unread buffer) | `a2a-service.ts` | ✅ via tool |
| Envelope protocol v1 + ingest + outbox | `a2a-wire.ts` / `a2a-ingest.ts` / `POST /api/superd/a2a` | ✅ tool + wire |
| Completion capture → reply/notice return envelopes | `a2a-ingest.ts` (D16) | ✅ peer-side logs |
| Roster + federation (a6/m4 adoption, self-description discipline) | `agent-roster.ts` / `mesh-link.ts` / `probeMachine` | ✅ |
| `/hub` family: foreign demux, envelope forward, WS mux | `hub-route.ts` | ✅ |
| 5-min information-status sweep + per-agent window | `mesh-link.ts` → `agent-status.ts` → `agent_status` leg | ✅ |
| Mesh own API (`/api/superd/machines`, `/api/superd/a2a`, `.../outbox`) | `mesh-rpc.ts` | ✅ |
| Registries under `<home>/superd/` | `machines.json`, `agent-ids.json`, `a2a-conversations.json`, `a2a-outbox.json`, `agent-status.json` | ✅ |
| `exec` leg | P4 placeholder | ✅ placeholder returned |

---

## 2. Build & unit hygiene

| Check | Result |
|---|---|
| `node --test --test-force-exit --test-concurrency=4 test/*.test.mjs` (superd-hub) | **433 tests / 433 pass / 0 fail**, exit 0 |
| Rig boot log (`world failed` count) | **0**; no `error`/`fail`/`refus` lines in the boot segment |
| Served hub self-description | `{"machineId":"79he","label":"local","version":"0.1.6-j"}` |

Hygiene only — §3/§4 are the acceptance evidence.

---

## 3. Tool legs, first-person (verbatim shapes)

| # | Call | Result | Evidence |
|---|---|---|---|
| 1 | `{}` (no action → roster) | ✅ | same payload as `agents` |
| 2 | `{action:'agents'}` | ✅ | 2 machines × 7 agents = **14 rows**, all `ready:true`, `failed:false`; addresses `<m4>-<a6>` |
| 3 | `{action:'exec'}` | ✅ placeholder | `{"action":"exec","note":"not yet implemented: exec (P4)"}` |
| 4 | `{action:'read'}` | ✅ empty | `{"action":"read","count":0,"messages":[]}` |
| 5 | `agent_status` local Pi `79he-xwes79` | ✅ | `collectedAt 1790592324205`; 5-row window; `R8 self-loop [hub A2A]`, `[undefined] [hub A2A]`, `[unhosted]`, sessionIds truncated to 6 |
| 6 | `agent_status` dev3 Pi `bfwu-ea3yvg` | ✅ | `collectedAt 1790592326051`; window over the **presentation lane** (native titles `dashr`, `base` + the `[hub A2A]` join row) |
| 7 | `agent_status` unknown `79he-zzzzzz` | ✅ honest | `{"sessions":[],"collectedAt":<bucket>,"note":"no collected status for this agent yet …"}` |
| 8 | `new_conversation` `bogus` | ✅ reject | `[E_BAD_ADDRESS] superd-hub: agent must be a "<m4>-<a6>" address …` |
| 9 | `new_conversation` `79he-zzzzzz` | ✅ **D7 fixed** | `Error: a2a: unknown-agent 79he-zzzzzz (no such agent on machine 79he)` — address-bearing, no phantom pairing story |
| 10 | `send` without `message` | ✅ reject | `[E_MISSING_MESSAGE]` |
| 11 | `stop` without `conversationId` | ✅ reject | `[E_MISSING_CONVERSATION]` |
| 12 | `new_conversation` **world (Pi) + title** | ✅ **D1 gone** | `{"conversationId":"cbyhwu","sessionId":"session-97601d69-…","agent":"xwes79","machine":"79he"}` — no rename, no error, no orphan |
| 13 | `send` local, into `cbyhwu` | ✅ `injected` | `messageId a2a-a130a745-…`, `conversationId cbyhwu`, `sessionId session-97601d69-…`, `note` (NEVER poll) |
| 14 | `send` **cross-machine** dev3 Pi | ✅ `injected` | `messageId a2a-eeb19a22-…`, `conversationId c9fk7p`, remote `sessionId session-1505d957-…` |
| 15 | `stop` **turn** while peer ran `sleep 90` | ✅ | `{"action":"stop","stopped":true,"scope":"turn"}` |
| 16 | `stop` again, peer now idle | ✅ **D5 fixed** | `{"action":"stop","stopped":false,"scope":"turn","note":"no turn was active"}` |
| 17 | `send` after stop (resume) | ✅ | receipt + peer produced `RESUMED-FP-D6` |

### 3.1 Peer-side truth (world session log, Pi `session-97601d69…` / `session-62727505…`)

The tool's claims were checked against what actually landed on the peer:

* **Injection is the teaching envelope** (M1, verbatim):
  ```
  A2A message from 79he-8ah589 (conversation "FP probe B1 (superd-hub first-person)"):
  (conversation opened)
  Reply normally in this conversation — your reply is relayed to the sender automatically.
  If you also have a superd-hub tool, you may use it with conversationId cbyhwu for later or asynchronous replies.
  ```
* `new_conversation` really opened the conversation: peer turn 1 = the opening line; the B2 send
  arrived as **turn 2**, whose assistant text was exactly `PONG-FP-B2`, `turn/end reason=completed`.
* **D17 is honest**: the registry title is `FP probe B1 (superd-hub first-person)`, and the world
  session's own title is the *upstream fallback* derived from the first message text
  (`session/title {"source":{"kind":"fallback"}}`) — **no hub `session/rename` write-through**.
* **`stop` is a real turn abort**: peer `turn/end {"turn":1,"reason":{"kind":"aborted","reason":{"kind":"user"}}}`,
  and the `sleep 90` never completed.
* **Resume after stop works**: peer turn 2 started on the same session and completed `RESUMED-FP-D6`.

### 3.2 Cross-machine both sides (dev3, `0.1.6-j`)

* dev3's `/api/superd/machines` reports **our** machine in its own remotes:
  `{"id":"79he","name":"pc","label":"PC","origin":"https://test.pc.internal.test","status":"reachable","lastProbeAt":1790592360150}`
  → **mutual pairing is real**, not one-sided.
* dev3's `?mesh=1` roster: `hub={"machineId":"bfwu","label":"local","version":"0.1.6-j"}`, **7 agents, all local**.
* dev3's own session list contains our send's target `session-1505d957-…` (`agentAvailable:true, running:false, blank:false`)
  — the peer conversation exists on the peer.
* Local registry holds the **initiator row** for the cross-machine send:
  `{"shortId":"c9fk7p","machine":"bfwu","agent":"ea3yvg","sessionId":"session-1505d957-…","title":"[undefined]","initiatorSession":"session-a3ba70af-…"}`
  — peer-addressed row + `initiatorSession`; the self-loop rows carry the complementary `hostAgent` field.

---

## 4. Facilities (curl / WS / on-disk), same process

| Probe | Result |
|---|---|
| `GET /api/agent-runtime` (browser roster) | 14 agents — `{local:7, bfwu:7}`, **no phantom/chimera rows** |
| `GET /api/agent-runtime?mesh=1` (probe shape) | **7 agents, all `machine:"local"`** — self-description discipline (0.1.6-j) holds |
| `GET /api/superd/machines` | 200 `{self:{79he}, machines:[bfwu reachable lastProbeAt]}` |
| `POST /api/superd/machines {}` | 400 `mesh-api: pair body must be {name, label?, tokenUrl} …` |
| `PUT /api/superd/machines` | 404 (method not declared — cosmetic; a 405 would be tidier) |
| `DELETE /api/superd/machines?id=zzzz` | 200 `{"removed":false}` (non-destructive) |
| `POST /api/superd/a2a {}` | 400 `a2a-wire: unsupported frame version undefined (protocol v1)` |
| `POST /api/superd/a2a` (no body) | 400 `mesh-api: a2a body is not valid JSON …` |
| `POST /api/superd/a2a` (no cookie) | **401** |
| `GET /api/superd/a2a/outbox?machine=79he` | `{"v":1,"envelopes":[]}` (nothing parked) |
| `GET /hub/api/x?agent=native` | 404 `foreign-only` |
| `GET /hub/api/x?agent=nope` | 404 `unknown-agent` |
| `POST /hub/api?agent=pi` envelope `session/list` | `{"ok":true,"value":{"items":[…]}}` — the **live Pi session plane** answered (see R2 for the arg shape) |
| `WS /hub/api/remote.mux?agent=pi` | **OPEN**, held 2.5 s |
| `WS …?agent=nope` / no agent | HTTP **404** at upgrade |
| `agent-status.json` buckets | `79he` 7 agents / 59 rows @ `1790592624201`; `bfwu` 7 agents / 51 rows @ `1790592625098` — cross-machine collection works |
| Sweep cadence | two local readings 300 s apart (`…2324205` → `…2624201`, Δ=299 996 ms) — the **5-min** cadence is real |
| On-disk registries | all `0600`; `a2a-outbox.json` empty; conversation rows carry `hostAgent` (mirror) / `initiatorSession` (initiator) |

---

## 5. Deltas against the two earlier `0.1.6-f` reports

| Earlier finding | Status on `0.1.6-j` |
|---|---|
| **D1** title rename fails in every world ctx | ✅ **moot/fixed** — the post-office path has zero `session/rename`; `new_conversation` + title succeeds on a world target (leg 12), title lives registry-only (D17) |
| **D2** degenerate `session-` short ids | ✅ **fixed** — initiator-minted random 6-char (`cbyhwu`, `93wdz0`, `c9fk7p`); legacy rows persist as-is |
| **D3** aborted turn fires an **empty** relay | ✅ **fixed in source** — `a2a-ingest.ts:280` routes a non-`completed` turn with no text to a bounded `notice` (`turn aborted, no reply`) instead of a relay. (Narrow residual: a *completed* turn with empty text still relays empty — not exercised here.) |
| **D4** dev3 `codex` world session plane unavailable | ⚠️ **not re-probed** this pass (peer-side, unrelated to the tool) |
| **D5** `stop` reports `stopped:true` when idle | ✅ **fixed** — `{stopped:false, scope:'turn', note:'no turn was active'}` (leg 16) |
| **D6** version-mismatch warning dead (`0.1.0` constant) | ✅ **fixed** — `hub.version` now serves the **pack** version (`0.1.6-j` on both machines) |
| **D7** unknown *local* a6 → machine-level error | ✅ **fixed** — `a2a: unknown-agent <addr> (no such agent on machine <m4>)` |
| **D8** unread buffer not live-reachable | unchanged, **by design** — `read` = 0 while the initiator is live; replies ride auto-delivery, not the buffer |

---

## 6. Observations / residuals (new, non-blocking)

* **R1 — P5 gap is the live shape of the peer experience.** World agents still compose **no**
  `superd-hub` row, so the envelope's "if you also have a superd-hub tool … conversationId"
  clause is inert for them. The mechanism still works (the completion capture relays plain text),
  but the Pi peer spent its opening turn improvising (11 steps, MCP hunting) before answering.
  Cross-runtime A2A *reply* is a text contract today; only ctx0 native has the tool.
* **R2 — `/hub` typert arg field is `_request`, not `request`.** `{"args":{"request":{}}}` →
  `gateway/arguments-invalid: … missing "_request"; unexpected "request"`; `{"args":{"_request":{}}}`
  → `ok:true`. Cheap to document for any foreign caller / future transport work.
* **R3 — `PUT /api/superd/machines` answers 404**, not 405 (carried over from the addendum; cosmetic).
* **R4 — `send` without `conversationId` is a genuine "open + inject"**: it minted `c9fk7p`,
  created the remote session, and returned the receipt in one call. The conversation title is the
  `[undefined]` placeholder (D17) — correct, but it means a peer-opened conversation reads as
  untitled until someone titles it at creation.
* **R5 — replies arrive as real turns in the initiator session, not via `read`.** At the time of
  writing, the five return messages produced by this pass (2× `cbyhwu` reply, 1× `93wdz0` abort
  notice, 1× `c9fk7p` cross-machine reply, 1× `93wdz0` `RESUMED-FP-D6` reply) are **queued on this
  session's next turn boundary** — `read` correctly returns 0 because delivery is in-band, not
  buffered. Delivery confirmation is in §7 (and §7.1 for the cross-machine duplicate).

---

## 7. Delivery confirmation (auto-relay, receiving side)

The returns queued in §6/R5 did **not** need polling: each arrived as an ordinary user turn in the
initiating session `session-a3ba70af…`, prefix `Agent <m4>-<a6> replied (conversation "<title>"):`.

| # | Source | Kind/form | Landed as |
|---|---|---|---|
| 1 | `79he-xwes79` (Pi) | relay | ✅ initiator log `seq 345` — `sender 79he/xwes79`, `conv cbyhwu` |
| 2 | `79he-xwes79` (Pi, B2) | relay | ✅ initiator log `seq 372` — body `PONG-FP-B2` (the exact requested token) |
| 3 | `79he-xwes79` (D1 stop) | **notice** | ✅ initiator log `seq 518` — `a2a-notice`/`notice`, `reason:"aborted"` (D3 fix, live) |
| 4 | `bfwu-ea3yvg` (dev3 Pi, C1) | relay | ⚠️ **delivered TWICE** — `seq 399` **and** `seq 426`, identical `messageId a2a-relay-7b00cab5…` (defect §7.1) |
| 5 | `79he-xwes79` (D6 resume) | relay | ✅ initiator log `seq 545` — body `RESUMED-FP-D6` |

**Tally: 5 returns produced → 6 deliveries** (the extra one is the §7.1 duplicate). Initiator-log
sequence numbers: `345, 372, 399, 426, 518, 545`.

**Relay #1 (verbatim, abridged only where it quotes the peer's own reasoning):**

> Agent 79he-xwes79 replied (conversation "FP probe B1 (superd-hub first-person)"):
>
> Received — replying in-conversation (no `superd-hub` MCP tool in this session, so this text is the
> whole payload).
>
> Self-description (per 0.1.6-j discipline, my own row only): agent `xwes79` (pi adapter), machine
> `79he` (local); runtime pi session `01a0e7a2-…`; worktree `.worktrees/mesh-p1`, `DSH_HOME=.tests/superd`;
> hub instance `superd-4999-test`, paired remote `bfwu` = dev3.
>
> … If you were expecting the actual B1 prompt text, it arrived empty here ("conversation opened"
> only) — resend the body and I'll answer it directly; otherwise treat this as the round-trip
> receipt for sender-attribution checking.

Two things this single delivery already proves first-person: the **sender attribution is the target
agent** (`79he-xwes79` = the responder, not the initiator — the R8-fix `309e5c5` shape), and the
**conversation title rides the prefix** from the initiator's registry row (D17).

*New observation from it:* `new_conversation` opens the peer with the **content-free**
`(conversation opened)` line, so the peer's *first* relay can be an unmoored "what do you want?"
turn — here it answered the opener before the real B2 body arrived as turn 2. Harmless but noisy;
a caller that wants a substantive first turn should use `send` (no `conversationId`) rather than
`new_conversation` + a separate `send`.

**Relay #2 (verbatim):** `PONG-FP-B2`

That is the clean end-to-end proof: the token placed in `send` is the token that came back as a user
turn in this session — injection → peer turn (`turn/end completed`) → completion capture → return
envelope → in-process delivery, with the initiator never polling.

**Relay #4 (verbatim, cross-machine):**
> Agent bfwu-ea3yvg replied (conversation "(untitled)"):
>
> PONG-FP-C1

Cross-machine proof: dev3's Pi turn completed **on the peer**, dev3's hub POSTed the return envelope
back over the wire, and our ingest delivered it in-process — `senderMachine:"bfwu"` (the peer), so
the R8-fix attribution (`309e5c5`) holds end-to-end. Note the untitled placeholder renders as
`(untitled)` in the envelope prefix while the registry stores `[undefined]`.

**Relay/notice #3 (verbatim — the D3 path, live):**
> conversation "93wdz0": turn aborted, no reply

The `stop` leg's terminal turn produced a **bounded notice** (`kind a2a-notice`, `form notice`,
`reason:"aborted"`, no `Agent … replied` prefix), which is the §5/D3 fix seen from the receiving
side rather than only in source. The old `0.1.6-f` behaviour — an *empty relay* that could wake an
idle initiator with a content-free turn — did not occur.

*Ordering note:* #3 landed **after** #4, and both after #1/#2. Returns are queued as `followup` and
drain one per initiator turn boundary, so arrival order here reflects initiator turn cadence, not
production order (the same reason the §7.1 duplicate surfaced one turn after its twin).

**Relay #5 (verbatim — resume after stop):**
> Agent 79he-xwes79 replied (conversation "(untitled)"):
>
> RESUMED-FP-D6

The `stop`-aborted conversation (`93wdz0`) accepted a later `send` on the same `conversationId` and
returned the requested token — so "hard stop, conversation stays resumable" is verified from the
initiator's side as well as from the peer's `turn/2 completed` log.


---

## 7.1 Defect — a cross-machine return envelope is delivered **twice** (exactly-once violated)

**Symptom (first-person, live).** The cross-machine reply arrived as *two* user turns with the
**same `messageId`** — i.e. one envelope, delivered twice:

```
seq 399  kind=a2a-relay  sender=bfwu/ea3yvg  conv=c9fk7p  messageId=a2a-relay-7b00cab5-2607-48d0-b1d5-06b104fb6f67
seq 426  kind=a2a-relay  sender=bfwu/ea3yvg  conv=c9fk7p  messageId=a2a-relay-7b00cab5-2607-48d0-b1d5-06b104fb6f67   ← duplicate
```

**Mechanism (pinned in code, then proven at the wire).** The return path is not idempotent because
the *receiver's 200 body* is not a shape the *sender's* guard accepts:

1. `a2a-ingest.ts:485` — an inbound `reply`/`notice` envelope returns
   `deliverLocal(...)`, i.e. an **`A2aDeliveryOutcome`** (`{delivered:'followup'|'buffered'|'dropped'}`).
2. `mesh-rpc.ts:245-246` — `handleA2aIngestPost` answers `json(200, receipt)`, so the peer gets
   e.g. `{"delivered":"followup"}` — **no `outcome`/`messageId`/`sessionId` keys**.
3. `a2a-wire.ts:404-405` — `postA2aEnvelope` accepts only `isSendReceipt(body) || isStopReceipt(body)`
   (`a2a-wire.ts:333-351`) and otherwise **throws**
   `a2a-wire: ingest receipt from <origin> is not a v1 receipt shape — {"delivered":"followup"}` —
   *after* the receiver has already delivered.
4. `a2a-ingest.ts:248-258` — `routeReturn`'s `catch` therefore runs `parkInOutbox(envelope)`.
5. The R5 sweep's outbox pull (`onRemoteProbed` → `fetchA2aOutbox` → `ingest(...)`) later claims that
   parked envelope and re-delivers the **same** envelope — the receiver keeps no `messageId` dedup
   (grep confirms: no seen-set anywhere in `a2a-ingest.ts` / `a2a-delivery.ts`).

Live wire proof of step 2–3, taken against the running instance:

```
POST /api/superd/a2a   {v:1, envelope:{kind:"reply", …, messageId:"a2a-relay-fp-shape-probe"}}
→ HTTP 200  {"delivered":"buffered"}
```

That body satisfies neither receipt guard, so the producing hub parks it and the next sweep
re-delivers. The observed timing fits exactly: the dev3 turn completed ~10:50:07, the sweep probed
`bfwu` at 10:50:25 (and re-pulled), and both copies drained at successive turn boundaries
(10:53:18 / 10:53:32) — hence the second copy appearing *after* later-produced messages.

**Confidence / caveat.** Steps 1–3 and the wire shape are directly verified here. Step 4's *park* ran
on **dev3**, and its outbox is claim-and-clear, so the parked copy itself was not observed — it had
already been claimed. The mechanism is nonetheless the only path that explains an
identical-`messageId` duplicate, given that `postA2aEnvelope` performs **no** client-side retry and
the receiver holds no `messageId` seen-set.

**Scope.** Every **cross-machine** `reply`/`notice` inherits this (one extra delivery per return,
≤ the sweep period later). **Self-machine** returns do not: `routeReturn` short-circuits at
`envelope.to.machine === selfId()` (`a2a-ingest.ts:242-244`) and never touches the wire or outbox —
which is why the local `cbyhwu`/`93wdz0` returns in this pass arrived once each.

**Impact.** A peer reply wakes the initiating agent twice; duplicated text in the transcript; and
any future reply-driven side effect runs twice. It also silently inflates an "outbox" that should be
empty, and it defeats spec §7.3's no-double-delivery discipline for exactly the cross-machine case.

**Fix direction (either/both).** (a) Give return envelopes a **receipt-shaped ack**: return
`{outcome:'injected', messageId, sessionId}` (or a dedicated accepted ack) for `reply`/`notice`, or
teach `postA2aEnvelope` to accept the delivery-outcome shape — the v1 wire contract simply has no
ack defined for return envelopes today. (b) Add **`messageId` dedup** at the receiver's `deliverLocal`
(a bounded LRU) — belt-and-braces that also covers a genuinely lost response, which the current
park-then-pull design cannot distinguish from a failure.

---

## 8. Rig state & side effects

* **No restarts performed by this pass**; the 4999 unit was already up (booted 18:40:15) and prod
  3080/3081 were untouched. dev3 was not restarted.
* Artifacts created in the shared test home (`.tests/superd/`):
  * registry rows `cbyhwu` (Pi, titled), `93wdz0` (Pi, untitled), `c9fk7p` (dev3 Pi, untitled, `initiatorSession` = this session);
  * Pi world sessions `session-97601d69…` (2 turns), `session-62727505…` (turn 1 aborted by `stop`, turn 2 `RESUMED-FP-D6`);
  * dev3 world session `session-1505d957…` (C1).
  * `a2a-outbox.json` empty; no parked envelopes.
* The `sleep 90` peer turn was deliberately aborted; nothing else was killed.

## 9. Verdict

The `superd-hub` tool and its facilities work **first-person end to end on `0.1.6-j`**:
roster (self-described, phantom-free) → `agent_status` window with the `[hub A2A]` overlay →
`new_conversation` **with title** on a world target → `send` → peer turn → auto-relayed return →
`stop` (real abort, honest idle answer) → resume; plus the full facility surface (envelope guards,
mesh API, `/hub` demux + WS mux, 5-min sweep, cross-machine registry symmetry) and mutual pairing
with dev3 on the same pack. **433/433** unit tests pass.

Every defect that blocked the `0.1.6-f` acceptance (D1, D2, D3, D5, D6, D7) is resolved or moot
under the post-office design; D4 (dev3 codex session plane) and D8 (buffer branch) were out of
scope for this pass and remain as previously recorded. The structural residual is **R1** — the P5
injection gap, which is why world peers still answer in text rather than calling the tool.

**One new functional defect was found first-person and is the reason this pass is not a clean
pass: §7.1 — every cross-machine return envelope is delivered twice** (identical `messageId`,
second copy via the sender's park-then-sweep-pull path, because the receiver answers a return POST
with a delivery outcome that the sender's receipt guard rejects). It is deterministic for the
cross-machine leg, it is user-visible (duplicated turns in the initiator's transcript), and its fix
is small (receipt-shaped ack and/or `messageId` dedup) — but it must be settled before the A2A
plane can be called exactly-once. Local (self-machine) legs are unaffected.

No version bump, no publish, no merge performed.
