# SuperD Hub tools & facilities — independent verification (addendum, 2026-09-28)

**Why this file exists.** The subject is already covered by
[`2026-09-28-hub-tools-rig-test.md`](./2026-09-28-hub-tools-rig-test.md) (mtime `10:15:18 HKT`), authored
first-person from an in-rig native DSH session. This addendum is a **second, independent observer**: a
separate session on **dev3** (`srv1637772`) driving the same 4999 line over its sanctioned control-plane
RPCs plus raw HTTP/WS — no in-rig agent, no reuse of the author's steps. It exists so the canonical
verdict has an external replication, and it records facilities the canonical report did not probe
(WS mux upgrade, auth fence matrix, mesh-API error shapes).

Written: `2026-09-28 ~10:30 HKT`. Rig: `superd-4999-test` (worktree `.worktrees/mesh-p1` @ `f9aa4f3`,
pack `super-dsh@0.1.6-f`, `DSH_HOME=.tests/superd`, `--profile superd-pub`). No restarts were performed.

---

## 0. "hub tools, facilities, if any" — the answer

| Surface | Where it exists | dev3 availability |
|---|---|---|
| Model tool **`superd-hub`** (single, call-shape dispatch: `agents` / `new_conversation` / `send` / `read` / `stop` / `exec`) | ctx0 `tools` service, row `superd-a2a` → `super-dsh/a2a` (`a2a-row.ts`) | **absent** |
| A2A conversation service (registry, create/resume, receipt, completion capture, bounded buffer) | `a2a-service.ts` / `a2a-delivery.ts` | absent |
| `/hub` route family (foreign demux by `?agent=`, envelope forward, WS mux) | `hub-route.ts` | absent (no a2a row in pack) |
| Mesh federation (`/api/superd/machines`, wire RPC, `machines.json` / `agent-ids.json`) | `mesh-*.ts` | present (P1/P2, 0.1.6-a) |
| Control plane `/api/agent-runtime` | `rpc.ts` | present |

Branch facts (verified by `git ls-tree`): **master has no `a2a-*.ts` / `hub-tool.ts` and no `superd-a2a`
row**; the feature lives only on the unmerged `mesh-p1` branch (worktree HEAD `f9aa4f3`).
dev3's own installed pack corroborates canonical D4: `super-dsh@0.1.6-a`, `grep -ci a2a
superd-hub/dist` = **0**, `grep -c 'superd-a2a' cordis.patch.yml` = **0**.

---

## 1. Method

* **Unit**: `tsc -p .` clean; every `test/*.test.mjs` file run separately →
  **36 files, 355 tests, 354 pass, 1 fail**. The single failure is `spawn-world.test.mjs`
  (`Error: source profile missing: .tests/profiles/ctx1-min`) — a fixture gap, identical to the
  canonical report's finding, not a P3 regression. Compiling did **not** dirty the committed `dist/`
  (`git status --short dist` empty).
* **Live tool**: fresh ctx0 session created through `POST /api/session/create`, driven with
  `POST /api/session/prompt`; every call/result read back out of the zstd session log.
  Initiator: `session-a89bf3e9-600c-49a7-9a44-1ed2292cf70d`; tool-call records at seq 20/35/53/83/107/122.
* **Live facilities**: `curl` (cookie minted from the boot token URL) against `/api`,
  `/api/agent-runtime`, `/api/superd/machines`, `<method> /hub/...`; one WebSocket upgrade probe with
  the rig's own `ws` module.

---

## 2. Tool legs, live (independent run)

| # | Call | Result | Raw evidence |
|---|---|---|---|
| 1 | `{"action":"agents"}` | ✅ | 2 machines × 7 agents = 14 rows, all `ready:true`; local `79he-*` + dev3 `bfwu-*`, each address `<m4>-<a6>` |
| 2 | `{"action":"exec"}` | ✅ placeholder | `{"action":"exec","note":"not yet implemented: exec (P4)"}` (`isError:false`) |
| 3 | `{"action":"read"}` | ✅ empty | `{"action":"read","count":0,"messages":[]}` |
| 4 | `{"action":"send","agent":"bogus",...}` | ✅ rejected | `Error: [E_BAD_ADDRESS] superd-hub: agent must be a "<m4>-<a6>" … (got "bogus")` (`isError:true`) |
| 5 | `send` → local OMP `79he-0d6xzz` | ✅ `injected` | opened conversation `session-f` (`session-f13a6e99-365b-…`), messageId `a2a-5a90a0f8-…` |
| 6 | `read` after (5), while live | ✅ 0 | reply had not landed; correct for a live initiator |
| 7 | `stop` scope `turn` on `session-f` | ✅ | receipt `{"action":"stop","stopped":true,"scope":"turn"}` |
| 8 | peer effect of (7) | ✅ | OMP peer turn 1 → `turn/end {"reason":{"kind":"aborted","reason":{"kind":"user"}}}` |
| 9 | delivery after (7) | ✅ relay, **empty body** | initiator `user/message` `source:{kind:"a2a-relay",form:"relay",senderMachine:"79he",senderAgent:"0d6xzz",conversationId:"session-f"}`, text `Agent 79he-0d6xzz replied (conversation "(untitled)"):\n\n` |
| 10 | `new_conversation` OMP, **no title** | ✅ | `{"action":"new_conversation","conversationId":"session-d","sessionId":"session-d1769ac5-…","agent":"0d6xzz","machine":"79he"}` |
| 11 | `new_conversation` **native** + title | ✅ control | `conversationId session-2`; title persisted in `a2a-conversations.json` |
| 12 | `new_conversation` **OMP world** + title | ❌ **repro D1** | `Error: failed to rename session "session-029685d0-…": Error: session "…" is not live in this store` |

Result 12 reproduces canonical **D1** on a target the canonical report did not use (OMP; the canonical
ones were Pi / Codex / dev3-Pi). Results 10 + 11 isolate the failing step to *world context × title*
(rename), exactly as the canonical report concluded.

---

## 3. Facility probes (not in the canonical report)

**Auth fence** — `/hub/api/x?agent=omp` and `/api/agent-runtime` both → **401** with no cookie;
token URL → **303** to `/`, then **200**. The `/hub` family is never weaker than `/api`. ✅

**`/hub` demux matrix** (with cookie):

| Request | Response |
|---|---|
| `GET /hub/api/x` / `?agent=native` | 404 `{"error":"foreign-only",…}` |
| `GET /hub/api/x?agent=nope` | 404 `{"error":"unknown-agent","label":"nope"}` |
| `GET /hub/api/agent-runtime?agent=omp` | 200, ctx0-identical roster payload |
| `POST /hub/api?agent=omp` (client-request envelope) | 200 `{"type":"server-response",…"session/list"…}` |
| `POST /api` (bare, envelope) | 404 — native endpoints are path-addressed (`/api/<endpoint>`); not a hub issue |

**WebSocket mux** — `ws://127.0.0.1:4999/hub/api/remote.mux?agent=omp` → **OPEN** (held 4 s, closed only
by the probe); `?agent=nope` and no `agent` → **HTTP 404 at upgrade**. The fusion mux demux works. ✅

**Mesh API** `/api/superd/machines` — `GET` 200 `{self:{id:"79he"},machines:[{id:"bfwu",name:"dev3",
origin:"https://dsh.dev3.internal.test",status:"reachable"}]}`; `POST {}` → 400
`mesh-api: pair body must be {name, label?, tokenUrl} …`; `POST` empty body → 400
`request body is not valid JSON …`; `DELETE ?id=zzzz` → 200 `{"removed":false}`; **`PUT` → 404
`not found` (method not declared → falls through; a 405 would be tidier)**.

**`/api/agent-runtime`** — `GET` → `{available, agents, hub}` (14 agents); `POST` → **400**
`{"error":"selection is per-request (mount path); no server-side switch", "available":[…]}` (DL7 holds).
Note: `available` mixes local runtime keys (`native, agy, omp, …`) with federated remote per-agent keys
(`0kdzjk, 9xpbi4, …`) — 14 entries; consistent with remote gateways registering per-agent keys.

---

## 4. Agreement with the canonical report

| Canonical claim | Independent observation |
|---|---|
| D1 title rename broken in every world ctx | ✅ reproduced on OMP (new target); native ✅, OMP untitled ✅ |
| D1 consequence: row persists, caller gets no id | ✅ orphan row `session-0` (OMP, no title) sits in the registry; no conversationId was returned |
| D2 shortId = `sessionId.slice(0,8)` degeneracy | ✅ my new rows: `session-f`, `session-0`, `session-d`, `session-2`; the registry also still carries the *legacy* row `session-` (empty suffix), i.e. ids are persisted across algorithm changes |
| D3 aborted turn fires an empty relay | ✅ relay `a2a-relay` from `79he-0d6xzz`, body empty, immediately after the stop |
| D5 `stopped:true` even when nothing ran | ✅ `stop` reports `{stopped:true,scope:"turn"}` (a `cancelled:false`/idle note would be honest) |
| D8 buffer not live-reachable | ✅ observed: `read` = 0 while live, then the reply arrived as a relay splice, not via `read` |
| D4 dev3 runs a pre-P3 pack | ✅ dev3 `super-dsh@0.1.6-a`: 0 `a2a` files in `superd-hub/dist`, 0 `superd-a2a` rows |

**No contradiction found** between the two independent runs.

---

## 5. Extra observations

* **Reply-teaching envelope vs world composition.** The envelope says *"reply via SuperD Hub send with
  conversationId …"*, but world trees never compose the `superd-a2a` row (by ruling; P5 pending). The OMP
  peer therefore improvised with its own `cordis_a2a` MCP tools (`xd://mcp__cordis_a2a_a2a_send`), spent
  11 steps hunting a daemon, produced no plain text in ~5 min, and was ended by our `stop` — whose
  completion capture then relayed the empty body (D3). This is the live shape of the known P5 gap.
* **Possible out-of-band traffic:** that peer attempted `a2a_send` with `to:"79he-8ah589",
  session_id:"session-f"` through its own MCP client, i.e. outside this hub's A2A plane. Worth knowing
  before the next foreign-runtime run.
* `new_conversation`'s rename failure is **not** wrapped into a receipt (unlike `send`'s create path), so
  the model sees a bare `Error:` with no structured recovery — a small robustness gap additional to D1.

---

## 6. Side effects (this run)

No restarts; 4999 line, dev3 and the prod 3080/3081 instances untouched. Created in the rig's test home:
ctx0 `session-a89bf3e9…` (5 model turns), registry rows `session-f` (OMP send), `session-0` (D1 orphan),
`session-d` (OMP untitled), `session-2` (native titled), OMP world session `session-f13a6e99…` with its
turn aborted by `stop`.

---

## 7. Verdict

Independently replicated: the hub tool **is** composed and dispatching on the 4999 line, and the core
mechanism (roster → send → auto-relay → stop, with turn-abort honoured) works, including the federated
roster. The canonical report's two headline defects — **D1** (title rename fails for every foreign
target, orphaning the created conversation) and **D2** (degenerate `session-` short ids handed to peers)
— reproduce cleanly from a different origin and on a different target. Recommended order is the
canonical one: **D2 → D1 → D3/D5 → D6**, with the P5 injection needed before the envelope's "reply via
SuperD Hub send" instruction is actionable for world peers.
