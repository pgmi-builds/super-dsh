# Reply semantics v3 (D20–D22) — first-person live acceptance (`super-dsh@0.1.7-a`)

**Scope**: the channel-first reply semantics landed as `7b5f61e` on mesh-p1 —
monotonic latch + transcript fallback (D20), one-turn opening (D21), `'pending'`
taxonomy reserve (D22). Verified **live, cross-machine** (PC rig `79he` on
0.1.7-a ↔ dev3 `bfwu` on 0.1.7-a, mutual pairing live), plus the hub package
suite **442/442**.

- **Date**: 2026-09-29 (CST, early hours).
- **PC rig**: `superd-4999-test.service`, tarball line via `start-4999.sh`
  (`super-dsh-0.1.7-a.tgz`, 557,748 B); `/api/agent-runtime?mesh=1` →
  `hub.version 0.1.7-a`, 7 local agents (self-description intact).
- **dev3**: `~/.dsh/profiles/web` + `corepack pnpm@10.33.2 add file:` → user
  unit restart → `hub.version 0.1.7-a`, 7 local agents.
- **Driver**: a fresh native session on the rig (`session-33b5df5c-…`), driven
  via `POST /api/session/{create,prompt}`; ground truth read from BOTH session
  logs (zstdcat) + BOTH registries.

## S1 — transcript fallback (no-tool peer) ✅

Rig agent → `new_conversation bfwu-ea3yvg` (dev3 Pi, **no** superd-hub tool)
with `message:"Reply with exactly PONG-V3-TRANS and nothing else."`.

- Peer session (`~/.dsh/agents/pi/sessions/…/session-f05e9a5d`): **exactly ONE
  `user/message`** — the v3 teaching envelope with the task inline (see S4).
- Initiator session received exactly one relay:

  ```
  [a2a-relay] Agent bfwu-ea3yvg — last output at turn end
  (conversation "v3 S1 transcript"):

  PONG-V3-TRANS
  ```

  The new provenance prefix (`— last output at turn end`, no "transcribed"
  jargon — user redline) renders live; the transcribed text equals the peer's
  last assistant output verbatim.
- dev3 mirror row `x6d8ug`: `channelUsed` unset (the Pi never sent — latch
  never set, transcript path is its only voice). ✔ expected for a no-tool peer.

## S2 — ACTIVE write-back + latch (tooled peer; the path never before exercised live) ✅

Rig agent → `new_conversation bfwu-0kdzjk` (dev3 **native**, has superd-hub)
with a task instructing the peer to reply **through the channel**.

- The peer parsed the v3 teaching envelope and used its tool; the initiator
  received:

  ```
  [a2a-relay] Agent bfwu-0kdzjk replied (conversation "v3 S2 channel reply"):

  PONG-V3-CHANNEL
  ```

  The write-back **send leg** (mirror row + addressing the initiator → envelope
  to the initiator's hub, `from = {self, hostAgent, peer-session}`) delivered
  through the initiator-side ingest — the "正路" that 0.1.6-k could not reach
  (its address-consistency check rejected exactly this shape).
- **Latch**: dev3 mirror row `wrkx2i` → `channelUsed: true`,
  `lastSentAt: 1790629033359`. ✔
- **Suppression**: ZERO `last output at turn end` transcripts for the S2
  conversation — the peer's turn-end output stayed private (the send inside
  the armed window WAS the artifact; the watch added nothing). ✔
- dev3 outbox: 0 parked (write-back delivered on first POST). ✔

The two reply kinds are distinguishable at a glance in the same conversation
list: `replied` (chose the channel) vs `— last output at turn end`
(runtime-delivered fallback).

## S4 — one-turn opening (D21) ✅

The dev3 Pi's session shows exactly ONE `user/message` — opening + content
merged into a single injected turn, and it is the v3 teaching envelope (user
redline wording, verbatim):

```
A2A message from 79he-8ah589 (conversation "v3 S1 transcript"):

Reply with exactly PONG-V3-TRANS and nothing else.

This conversation is initiated through superd-hub by the sender. The sender
sees only what arrives through this conversation.

As superd-hub hosts various kinds of agent runtimes, integration into each
runtime and superd-hub tool availability in each runtime session might differ.

To reply, send a message back: with a superd-hub tool, if available,
{action:"send", agent:"79he-8ah589", conversationId:"x6d8ug", message:"…"}.
You can send at any point, more than once — sending does not end your turn.

If we do not receive a superd-hub message from you (intentionally or whatever
situation prevents so), your last output at this turn's end is delivered to
the sender as your reply.
```

(The 0.1.6-k F6 pathology — a bare `(conversation opened)` turn the peer burns
steps investigating — is gone.)

## Suite

`superd-hub` package: **442/442** (baseline 433 → +9: latch-on notice,
window suppression via a gated stream, `transcribed:true` on the wire,
self-route write-back never-injects, write-back send leg + latch, mirror-row
continuation no-latch guard, one-turn opening, wire guard additive field,
render prefix variants; contract updates for wording/template/signature).
Pack-wide sequential rerun recorded separately (the concurrent runner hit the
known IPC flake twice — died silently at test 16 with zero `not ok` lines).

## Residuals

- The notice path (`turn ended, no reply`) was exercised in unit tests and by
  construction (S2's suppression is its complement); a live sendless-latched
  turn was not separately staged.
- `'pending'` spawn receipt is reserved in the taxonomy only (D22 state machine
  pending; observed create latencies remain seconds).
- E5 seam: confirmed **by construction** — `route()` sends each message to
  exactly one of followup/steer/buffer, so read+splice double delivery has no
  shared path; no code change needed.
