# First-person 0.1.8-d triage — O1b fixed in 0.1.8-e

- Date: 2026-10-02 (UTC afternoon / HKT evening)
- Input: the 0.1.8-d retest report
  (`2026-10-02-superd-hub-first-person-0.1.8-d-retest.md`) — green on **F2** (self-addressed
  continuations), **O1** (post-boot roster/status), the stop live-vs-natural semantics, and the
  F1/F3/F4/O2 regression set; it filed exactly **one new item: O1b**.
- Result: **super-dsh `0.1.8-e` deployed on both machines** — PC rig `superd-4999-test`
  restarted 15:02:31 HKT, dev3 `dsh.service` restarted 15:03:20 CST; both boot clean, both
  keep their remote-roster-at-boot (O1) and neither wipes its local status bucket (O1b).
- Artifact: `.scratch/superd-pack/super-dsh-0.1.8-e.tgz`
  `sha256 b95e835492872eb7f8c1c20d090c61c33e516fb642a0d3ed1243153a7c79eae0`.
- Tests: **486/486** hub (`node --test` spec reporter; was 482 — four new legs).

## 1. O1b — the boot tick sampled the local plane before it was mounted

**Finding (report §4.2).** The O1 win ("run one sweep at boot") also ran the R5 collectors.
At that instant the local session plane is still mounting, so every local agent's
session-list leg failed, and `recordMachineCollection` wrote that all-error result as a
*successful* collection:

```
{a6:"8ah589", rows:[], error:'typert gateway: session/list: active Service "sessionController" is unavailable'}
{a6:"0d6xzz", rows:[], error:'a2a: no gateway for 79he-0d6xzz — machine unreachable or not paired'}
```

Two lies in one write:

1. `rows: []` under a **fresh** `collectedAt` reads as "this agent has no sessions";
2. it **replaced** the prior snapshot — the cache's own documented rule is "only a
   SUCCESSFUL collection replaces rows; a failure keeps the previous snapshot and records an
   error note". An all-error collection is not a successful one, so a warm home lost real
   rows to a boot race.

And the surface could not say so: `agent_status` answered `{collectedAt, sessions: []}` with
the error dropped, so "could not collect" was indistinguishable from "no sessions".

### Fix (one root cause, three parts)

1. **`mesh-link.ts` — the boot tick runs the remote probe loop only.** `runReprobeSweep`
   gained `localCollect?: boolean` (default true); `startReprobeSweep`'s `immediate` tick
   passes `false`. O1's win is the *roster*, and a remote probe is a direct HTTP call that
   needs no local plane; the local leg simply waits for the first regular tick.
2. **`agent-status.ts` — an all-error collection is a machine-level FAILURE.** Both collectors
   now go through `recordCollection(...)`: when the **session-list** leg died for *every*
   agent, record a machine failure (keep the prior snapshot + note why) instead of a fresh
   empty snapshot. An empty-but-collected machine is still a success.
   The discriminator is that leg counter, **not** `AgentStatusAgent.error`: a failed
   *workspace/title* leg sets `error` too while the rows are perfectly fresh. My first draft
   used the error field and the existing `workspace baseline collection` test caught it
   immediately (fresh rows would have been discarded as a failed collection) — the
   review cost was one test run.
3. **`hub-tool.ts` — an empty window must explain itself.** `agent_status` now carries a
   `note` whenever the window has no collection behind it: the agent's own collection error,
   the machine-level error (with the retained snapshot still returned, `collectedAt` keeping
   the data's age), or the existing "no collected status yet". Empty is never presented as a
   fact unless it is one. Tool description + output schema wording synced.

### Why this option (of the report's three), not a retry

The report offered: (a) remote-probe-only at boot, (b) retry the failed local collection
after 15–30 s, (c) treat a `sessionController unavailable` cache as "not collected yet".

- (a) is the smallest, and it fixes the *cause* rather than the symptom: the boot tick's local
  sample can never be right at that instant, so not taking it is the honest action.
- (b) buys a fresher local window within ~30 s but adds a second timing mechanism — the sweep
  module's whole discipline is "one timer, no second probing path".
- (c) is string-matching on error text, and the two observed errors differ per leg
  (`sessionController unavailable` vs `no gateway … not paired`).

Chosen: (a) + the honesty rules in (2)+(3), which also close the same class of bug on the
remote leg (a foreign-runtime `no gateway` sweep would have produced the same empty window).
Consequence, accepted and now documented: at boot the local window is the last collected
snapshot (≤1 interval old; `collectedAt` says when), and a cold home answers "no collected
status for this agent yet" with `collectedAt: 0`. No local data is invented, and none is lost.

## 2. Live verification (both ends on `0.1.8-e`)

| | PC (`79he`, homepc) | dev3 (`bfwu`, srv1637772) |
|---|---|---|
| unit restart | `superd-4999-test` 15:02:31 HKT | `dsh.service` 15:03:20 CST |
| remote re-probed at boot | `bfwu` re-collected 15:02:44 (**boot+13 s**) | `79he` re-collected 15:03:35 (**boot+15 s**) |
| `/api/superd/machines` | `bfwu: reachable`, `lastProbeAt` = boot+9 s | (probed by the PC side above) |
| **local bucket after restart** | `79he` `collectedAt` still **15:02:31−3 min = 14:59:48**, 7 agents / 81 rows / 0 errors / no machine error | `bfwu` `collectedAt` still **15:00:18**, 7 agents / 59 rows |
| O1b before/after | on 0.1.8-d this bucket was overwritten at boot+14 s with `rows: []` + error | same mechanism |

Read 18 s and 16 s after each restart respectively — i.e. inside the window where 0.1.8-d
already had the poisoned empty snapshot. The local bucket is byte-for-byte the pre-restart
snapshot, so the boot tick no longer touches it; the remote half of O1 still lands in seconds.
Boot was otherwise clean: 6/6 world mounts (`hermes/agy/claude/omp/codex/pi`), shell `/` 200,
`/api/superd/machines` 401 without a cookie.

The `note` path itself is now unreachable *live* at boot by construction (that is the fix);
it is covered by unit legs for the agent-level error, the machine-level error with a retained
snapshot, and the no-invented-note case.

## 3. Doc drift fixed while here

- The `send` bullet in spec §7.2 still read `accepted` + `1s×50s 轮询 补 delivered/spawn-failed`
  — a leftover from before D28's second revision, contradicting "no polling surface" and the
  `undelivered` terminal name. Corrected to the D28 wording (10 s sync window → `delivered`;
  else `accepted` with the same in-flight POST continuing inside the 120 s budget).
- Spec §6.3 now records O1 (boot tick) and O1b (boot tick skips the local leg; the cache is
  only replaced by a successful collection); §7.2 records the `agent_status` note.

## 4. Residual / not exercised

- Unchanged from the 0.1.8-d report and still open: D28's `accepted` path has never triggered
  live (every leg settles inside the 10 s sync window — unit-covered only), `read`'s
  unread-buffer branch, `reconnected:true`, the `execEnabled` gate, and D30's ownership
  **negative** leg.
- The tester's own observation about repeated `stop` calls each answering `stopped:true` while
  the first cancellation is still unwinding is **not** changed here — it is a surface-wording
  question (per-call phrasing vs "a cancellation is already in flight") that is the user's to
  rule on, not a defect.
- The retest checklist for `0.1.8-e` is therefore narrow: restart the 4999 rig (or dev3) and
  inspect `agent_status` for a **local** agent within the first minute — expect the pre-restart
  window with its old `collectedAt`, never an empty one; plus the usual O1 check
  (`/api/superd/machines` reachable within seconds, roster populated).
