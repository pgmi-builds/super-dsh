# superd-hub First-Person Test Report — 0.1.8-e retest (O1b)

- Date: 2026-10-02 ~07:08–07:14 UTC (15:08–15:14 HKT)
- Tester: the same native DSH agent as the previous rounds, running **inside** the 4999 pack line on
  **PC** (`homepc`) and calling the `superd-hub` model tool first-person.
- Scope: re-test the single open item **O1b** (the boot tick cached an empty local `agent_status` window),
  plus a regression pass over F1–F4/O2 and the surface, against pack **`0.1.8-e`** with both ends on the
  same revision.
- Report written at `pc:/home/u1/workspaces/superd/docs/test-reports/2026-10-02-superd-hub-first-person-0.1.8-e-retest.md`
  (identical copy in the dev line at `.worktrees/mesh-p1/docs/test-reports/`).

## 1. Versions under test

| Node | Host | Runtime |
|------|------|---------|
| `79he` (PC) | homepc | unit `superd-4999-test.service`, PID 185711, restarted **15:02:31 HKT**; pack **`super-dsh@0.1.8-e`** |
| `bfwu` (dev3) | srv1637772 | hub PID 2801626, restarted **15:03:19 HKT**; pack **`super-dsh@0.1.8-e`** |

Worktree HEAD = `916cd71` (**0.1.8-e**: O1b — the boot tick no longer samples the local session plane, and
an all-error collection is no longer recorded as a fresh empty window. 486/486). Delivered tarball:
`.scratch/superd-pack/super-dsh-0.1.8-e.tgz`.

## 2. O1b — what the fix does, and what this round could observe

The fix has three parts: (a) the boot tick passes `localCollect: false`; (b) a collection in which the
**session-list leg died for every agent** is recorded as a machine-level *failure* (prior snapshot kept +
reason), not as fresh `rows: []`; (c) `agent_status` carries a **`note`** whenever the window has no
collection behind it, so empty is never passed off as "no sessions".

### 2.1 Verified live

| Check | Result |
|---|---|
| **(c) the note on a real dead leg** | `agent_status bfwu-92tgxg` → `{"action":"agent_status","agent":"92tgxg","machine":"bfwu","collectedAt":1790924861324,"sessions":[],"note":"collection failed for this agent — typert gateway: session/list: active Service \"sessionController\" is unavailable"}` — dev3's Codex session-list leg is genuinely dead, and the empty window now names the cause. **On 0.1.8-d this exact shape returned a bare `{"sessions":[]}`.** |
| Local bucket is real, not an early empty snapshot | `agent-status.json`: `79he` → 7 agents present, **81 rows**, **no errors**; `collectedAt ≈15:07:39` (the first regular tick). No empty local window exists. |
| (a) boot-tick skip is in the delivered artifact | installed dist `mesh-link.js` carries `localCollect: false`; `gateway.js` carries the `immediate: true` wiring |
| (b) all-error rule is in the delivered artifact | installed dist `agent-status.js` carries `recordCollection` and the `collection failed for every agent` branch |
| A healthy window stays note-free | `agent_status 79he-8ah589` → 5 rows, no `note`; includes the 0.1.8-b/0.1.8-d before/after pair (`omsgil` poisoned vs `hvxoni` correct) |

### 2.2 Not re-observable this round — stated plainly

The boot window itself could **not** be sampled: the line restarted at **15:02:31** and this round began at
**15:08:42**, by which time the first regular tick (**15:07:31**) had already re-collected the local bucket
and overwritten the boot-time state. The evidence for part (a) is therefore: the mechanism present in the
installed dist, the retained non-empty local snapshot, and the operators' own boot-window numbers recorded
in the commit (`916cd71`): *PC restart 15:02:31 — remote bfwu re-collected at boot+13 s, local 79he bucket
still at its pre-restart 14:59:48 snapshot (81 rows, untouched); dev3 restart 15:03:20 — remote 79he at
boot+15 s, local bfwu still at 15:00:18.* My post-hoc reading (81 rows, no errors, no empty window) is
consistent with those numbers.

**Note for the next round:** to sample the boot tick first-person, the test must start within
`reprobeIntervalSec` (default 300 s) of a restart — i.e. the operators should restart the line *and* tell
the tester to begin immediately, or temporarily raise the interval for the probe. Otherwise the interesting
window is gone before the first call.

## 3. Regression on 0.1.8-e

| Check | Result |
|---|---|
| **F2** self-addressed open + continuation (`9c5usc`) | open → `delivered`; continuation → `delivered` with `sessionId:"session-239cdb07-…"` (**the responder's**); log `a2a.ingest.done kind=message outcome=delivered message=a2a-a41d201b-…`, **no write-back line for that messageId**; **self-echo count 0**; responder answered `PONG-018E-SELF-CONT`; row `lastOutput:"PONG-018E-SELF-CONT"` |
| **Cross-machine** round trip (`h5x6n0` → `bfwu-0kdzjk`) | `delivered`; reply `PONG-018E-DEV3` auto-delivered (`deliver.writeback … via=peer`); row `lastOutput:"PONG-018E-DEV3"` |
| Self-loop open leg | `PONG-018E-SELF` delivered |
| **F3** D30 `lastOutput` | both new conversations correct and surfaced through `agent_status` |
| **F4** one artifact per turn | channel-answered turns logged `completion.quiet reason=channel-send-in-window`; no spurious stop notice |
| **O2** `created` on failure | no junk rows: registry 43 → **45** = exactly the 2 conversations created this round |
| `exec` oneshot cross-machine | `srv1637772` in **49 ms** |
| `exec` PTY local | `cd /tmp` + env survive (`pty-armed pwd=/tmp`, 43 ms) |
| `read` | `{"count":0,"messages":[]}` |
| HTTP fences | `GET /` no cookie **401**; `POST /api/superd/exec` no cookie **401** |
| Roster / machines | 14 agents; `bfwu` `reachable`; `(untitled)` title fix intact |
| **F1** legacy `injected` tolerance | not re-run this round (the fixture path was exercised on 0.1.8-d and the wire guard is untouched by `916cd71`); present in the installed dist |

## 4. Standing items (carried forward, not addressed by `916cd71`)

- **Repeated `stop`** still answers `stopped:true` on every call while the first cancellation is unwinding,
  though the surface says "`stopped:true` means **this call** cancelled a live turn" (observed 3× over
  ~35 s on 0.1.8-d, settling into one `completion.stopped` + one `stopped-by-initiator` notice). Filed as
  an observation in the 0.1.8-d report §5; still open. **This is the one item I would fix next.**
- **D28 `accepted`** still never triggers (all legs settle inside the 10 s sync window) — unit-covered only.
- **O3** (`a2a/conversation-machine-mismatch` naming an agent mismatch) still open.
- `read`'s unread-buffer branch, `reconnected:true`, `execEnabled` disable, D30's gate **negative** leg —
  unchanged, unreachable from a single session.

## 5. Verdict

**Green for O1b within the observable scope, and green on regression.** The durable half of the fix is
verified live on the new pack: an empty window now carries the reason (`note` on a real dead session-list
leg, where 0.1.8-d returned a bare empty window), the local bucket holds real rows with no error, and the
boot-tick skip plus the all-error→machine-failure rule are present in the delivered artifact. The
boot-window behaviour itself is confirmed by mechanism and by the operators' recorded boot-time numbers
rather than by my own sampling, because this round began after the first regular tick — stated explicitly
rather than papered over (§2.2).

The F1–F4/O2 fixes all hold on `0.1.8-e`, including a fresh live F2 reproduction (0 self-echo, responder
participating, D30 recording the peer's reply). The only behavioural item I would still put in front of the
team is the repeated-`stop` answer.

## 6. Test artifacts left behind (for the record)

- Conversations created live: `9c5usc` (F2 regression), `h5x6n0` (cross-machine regression); registry
  43 → 45 rows. No fixture was paired this round.
- One PTY shell for this session on PC (PID 188828, ppid 185711); reaped on session close.
- `GET /api/superd/machines` lists only `bfwu` (reachable); no prod home touched; dev3 left running
  `0.1.8-e`; the 4999 line left running and active.

## 7. Addendum — dev3-INITIATED inbound open, verified live (2026-10-02 15:31 HKT)

Not part of the planned round: the dev3-side agent (bfwu-0kdzjk) opened a conversation **into PC** while the
retest was winding down — the direction the 0.1.8-a report §8 listed as never yet exercised as a full
conversation. It arrived in a PC hub session on this 4999 line and was answered in-channel; both hubs'
registries were read live to check parity.

| | PC row (79he hub) | dev3 row (bfwu hub) |
|---|---|---|
| conversation | `xba6w9` — "dev3 initiated align" | same |
| machine / agent | `bfwu` / `0kdzjk` | `79he` / `8ah589` |
| `sessionId` | `session-53004097-…` (local host, minted for this open) | `session-53004097-…` |
| `hostAgent` | `8ah589` | absent (initiator row, by design) |
| `initiatorSession` | `session-6c6f4b57-…` (dev3 opener) | `session-6c6f4b57-…` |

- PC log: `conversation.adopt xba6w9 session=session-53004097 hostAgent=8ah589` → `completion.armed
  watermark=0` → `ingest.done kind=new-conversation outcome=delivered` (message `a2a-18a02cee-…`),
  15:31:08 HKT. Local `createdAt 1790926268117` vs dev3 `1790926268133`.
- Reply path: `send` with only `conversationId` (agent omitted) → `send.route-derived xba6w9 to=bfwu-0kdzjk`
  → `send.channel … latch=true` → `send.ok message=a2a-d2f56590-…`, receipt `delivered`, landing in the
  opener's session `session-6c6f4b57-…` — D24 route derivation and the channel reply both hold on the
  dev3-initiated side; no self-echo, nothing written back into the responder's own turn.
- Version parity both ends `super-dsh@0.1.8-e`.
- **Side observation:** PC logged `a2a.send.fail code=gateway/service-unavailable` for `a2a-d864d530-…`
  (conversation `nsh2wo`) at 15:31:14; dev3's hub failed the same message in the same second and **neither**
  registry holds an `nsh2wo` row. Shape matches dev3's known Codex session-plane outage (`bfwu-92tgxg`,
  `sessionController` unavailable, §2.2(c)); the no-trace-on-either-side part is recorded as an observation
  only.

- **Closed by mutual agreement:** dev3's final note (`ALIGN-CLOSED-ACK`, 15:34 HKT) declares closing traffic
  final and expects no reply — no further channel message was sent.
- **Harness-version gap across the mesh (worth a ledger note):** dev3 self-reports harness **`0.2.0-rc.2`**
  (its journal label "DSH 0.2.0 boot", 15:15:53) while this PC 4999 dev line runs the repo-pinned checkout
  **`0.1.7-rc.1`** (`upstream/deepseek-harness/apps/cli/package.json`, the documented dev base). Both ends ran
  pack `super-dsh@0.1.8-e` and the full A2A exchange above held **across that harness gap** — the pack's
  `>=0.1.5-0 <0.3.0-0` peer range admits both, and no 0.2.0-shaped wire drift surfaced on these legs. Not a
  substitute for a proper 0.2.0 alignment round (§二 alignment procedure), just the first cross-harness
  evidence point.

No restart of the 4999 line or dev3; prod homes untouched.
