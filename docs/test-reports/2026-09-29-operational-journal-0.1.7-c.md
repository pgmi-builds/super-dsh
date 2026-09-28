# Operational journal `a2a.*` — live verification (`super-dsh@0.1.7-c`)

**Subject**: the **operational journal** landed as the `0.1.7-b` headliner (`src/a2a-log.ts` +
call sites in `a2a-ingest.ts` / `a2a-service.ts`) and the **`0.1.7-c` wiring fix** that moves the
line sink from `ctx.logger` to the process console. This pass verifies the fix **live on the 4999
rig**, not in unit tests: an inbound A2A envelope is ingested, the journal is read from the running
unit's append log, and the reply path is exercised over the channel.

- **Date/time**: 2026-09-29, 06:18–06:20 CST (+08:00).
- **Tester session**: `session-679d4185-3ce8-419b-a653-9dde215c2f23` (conversation `jrnlt2`),
  hub address **`79he-8ah589`**, machine **`79he`** (local).
- **Rig**: `4999` on `127.0.0.1`, `DSH_HOME=/home/u1/workspaces/superd/.tests` (symlinked from the
  `mesh-p1` worktree), profile `superd-pub`, cwd = `.worktrees/mesh-p1`.
- **Pack under test**: `super-dsh@0.1.7-c`, installed as
  `file:.scratch/superd-pack/super-dsh-0.1.7-c.tgz` (profile `package.json` read back to confirm).
  Instance restarted 06:18 (last `dsh web:` line, log line 1046).
- **Log of record**: `.scratch/superd-4999.log` (`StandardOutput=append:`, **never rotated**, so the
  pre-restart instance's block is still in-file for a before/after comparison).
- **Source revision**: worktree HEAD `7a6e0de` (`0.1.7-b` headliner) + the uncommitted `0.1.7-c`
  change (`a2a-row.ts`: console sink; `package.json`: `0.1.7-c`).

---

## 1. Why `0.1.7-c` exists — the before/after is in the same file

`0.1.7-b` wired `deps.log` onto `ctx.logger`. The pack composes **no logger-console exporter**, so
those records went nowhere. The append log proves it, not just the code comment:

| Log block | Instance | Probe traffic in block | `a2a.*` lines |
|---|---|---|---|
| lines 980–1045 | `0.1.7-b` (restarted ~06:13) | conversation `jrnlt1` created 06:13:28, channel send 06:14:25 | **0** |
| lines 1046–1055 | `0.1.7-c` (restarted 06:18) | probe `a2a-jrnl-probe-3` → `jrnlt2`, + negative case, + reply attempt | **9** |

`jrnlt1`'s registry row confirms the traffic happened (`channelUsed: true`, `lastSentAt:
1790633665263` = 06:14:25) — and produced **zero** journal lines. The same rig, restarted on
`0.1.7-c`, produced nine. `0.1.7-c`'s console sink is correct for this pack (same precedent as
`world-join` / `world-provision` operational lines).

## 2. Live lines observed (`0.1.7-c`)

Verbatim from `.scratch/superd-4999.log`; the log carries no timestamps itself (journald adds them
on dev3 — see §4):

```
1047  superd-hub: a2a.conversation.adopt conversation=jrnlt2 session=session-679d4185-3ce8-419b-a653-9dde215c2f23 peer=79he-8ah589 hostAgent=8ah589
1048  superd-hub: a2a.completion.armed conversation=jrnlt2 session=session-679d4185-3ce8-419b-a653-9dde215c2f23 watermark=0
1049  superd-hub: a2a.ingest.done kind=new-conversation outcome=injected message=a2a-jrnl-probe-3 conversation=jrnlt2
1050  superd-hub: a2a.ingest.fail code=a2a/conversation-not-found message=a2a-jrnl-probe-4
1051  superd-hub: a2a.ingest.done kind=message outcome=failed message=a2a-jrnl-probe-4 conversation=missing1
1052  superd-hub: a2a.send.channel conversation=jrnlt2 from=79he-8ah589 latch=true
1053  superd-hub: a2a.ingest.fail code=a2a/no-initiator-session conversation=jrnlt2 message=a2a-b07f3883-aef0-4ad6-9db4-018bb316baad
1054  superd-hub: a2a.ingest.done kind=message outcome=failed message=a2a-b07f3883-aef0-4ad6-9db4-018bb316baad conversation=jrnlt2
1055  superd-hub: a2a.send.fail code=a2a/no-initiator-session conversation=jrnlt2 message=a2a-b07f...
```

Coverage: `conversation.adopt`, `completion.armed`, `ingest.done` (both `injected` and `failed`),
`ingest.fail` (two distinct typed codes), `send.channel` (with `latch=true`), `send.fail`. The
formatting contract holds live: single line, `a2a.<event> k=v`, scalar fields only, ids but no
envelope bodies / no secrets.

## 3. The probe itself is a degenerate loopback — and the reply is unaddressable

The wire envelope `a2a-jrnl-probe-3` is **self-addressed**: `from = {machine:79he, agent:8ah589}`,
`to = {machine:79he, id:8ah589}`, no `from.sessionId`. Adoption therefore created a **mirror row
with no `initiatorSession`**:

```json
{"shortId":"jrnlt2","machine":"79he","agent":"8ah589",
 "sessionId":"session-679d4185-3ce8-419b-a653-9dde215c2f23",
 "title":"journal probe c","hostAgent":"8ah589",
 "channelUsed":true,"lastSentAt":1790634019486}
```

The reply went over the channel (`a2a.send.channel … latch=true`) and failed at the ingest's
self-route write-back gate (`a2a/no-initiator-session`), because the address the write-back would
target (`row.initiatorSession`) does not exist. That is **correct for this row**: a local↔local
loopback wire probe has no initiator session to address. It does mean this conversation can never
receive a channel reply, and the envelope's transcript fallback cannot address one either
(`to.sessionId` is undefined by construction) — verified by reading `watchCompletion`'s `to` and
the D20 self-route branch.

**Observation, narrow scope**: `markChannelUsed()` runs *before* routing, and a permanent routing
failure (`no-initiator-session`, unlike `peer-unreachable`, parks nothing) does not un-latch, so the
D20 completion watch takes the `completion.quiet` branch and the turn's last output is dropped
rather than transcribed. For realistic topologies this is harmless — a hosted peer's channel reply
routes to the *peer* machine, whose initiator row *does* carry `initiatorSession`, and transient
failures park in the outbox by design. It only bites the addressless mirror row above, where no path
could deliver anyway. Recorded as a boundary note, not a defect claim.

Live-only coverage still missing (unit-tested formatting, but not observed on this rig):
`send.ok`, `deliver.writeback` / `deliver.local`, `route.deliver|post|park`, `completion.quiet|
transcript|notice|error`, `ingest.park`, `stop` / `stop.refused`, `outbox.claim`,
`conversation.new`, `deliver.buffer`. All of them need a peer with a real initiator session (a
cross-machine or tool-initiated conversation), not a loopback probe.

## 4. Operational notes

- The local rig's append log has **no timestamps**; `grep 'superd-hub: a2a\.'` is the interface, and
  ordering is by file position. On dev3 the same lines land in `dsh.service`'s journald stream, which
  does timestamp them.
- Watermark discipline still applies: take `wc -l` before triggering, then read only lines above it
  (this file spans 16 restarts).
- The 9 lines are the first `a2a.*` lines in the file's whole history — the journal's live debut.

## 5. Verdict

`0.1.7-c` verified live on the 4999 rig: an inbound A2A envelope and its reply attempt produce
greppable `a2a.*` journal lines; the `0.1.7-b` `ctx.logger` sink produced none in the same file.
Resolver: `ctx.logger` has no console exporter in this pack composition — console is the correct
sink, matching the `world-join` / `world-provision` precedent.
