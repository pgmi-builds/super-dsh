# First-person 0.1.7-g triage + §8 envelope round — 0.1.7-h…m

- Date: 2026-09-29 (UTC evening)
- Inputs: dev3 first-person `2026-09-29-superd-hub-first-person-0.1.7-g.md` (D1/D2 + outage §9),
  the operator-amended `2026-09-29-superd-hub-first-person-0.1.7-d.md` §8 (R1–R4:
  semantic development is a base requirement), and a direct user ruling on the
  teaching-envelope tail wording.
- Result: **super-dsh 0.1.7-m deployed on both machines** (PC rig `superd-4999-test`,
  dev3 `~/.dsh/profiles/web`), boot `world failed 0` both sides, full E2E envelope
  round verified live cross-machine.

## 1. D1 — MCP PTY output schema rejected `value.mode` (0.1.7-g finding) — FIXED

The pty rollout added `mode` (and shipped `reconnected`) in the tool result without
declaring them in the hub-tool output schema (`additionalProperties:false`).
0.1.7-h declares both, with a comment pinning the lockstep requirement, and the
output-contract test now drives a **pty-shaped value** through
`validateJsonSchemaValue` (it instantly caught my own regression when the fix
briefly ate the `reconnected` declaration — the lock works).

D2 corollary: the leak's only unbounded trigger was D1 itself (a tool-result
rejection discards the caller's handle after our function has already returned —
not catchable in-process). `PtySession` self-heals dead channels (next dispatch
redials with the reconnect notice) and the pool's idle TTL (600 s) reaps
abandoned sessions; with D1 fixed the observed orphan class is closed.

## 2. Teaching-envelope tail — user ruling — APPLIED

`If we do not receive a superd-hub message from you …` →
**`If the hub receive no hub message from you (intentionally or whatever
situation prevents so), your last output at this turn's end is delivered to the
sender as your reply.`** (the receiver is the hub; the message class is a hub
message). Template + comment + spec + all test pins. Verified live: the dev3
peer session's injected teaching envelope carries the new tail (r2e2eh/k/l/m
probes, 4 occurrences in the 0.1.7-l peer log).

## 3. §8 R1/R2 — the model-facing envelope — IMPLEMENTED + LIVE-PROVEN

Every injected turn now opens with one machine-readable `k=v` line (operator's
§8.3 format, ruling followed verbatim; `from=` added to notices for provenance
completeness — the one deviation, flagged here):

- reply: `[superd-hub:a2a] kind=reply form=relay|transcript conversation=<shortId>
  from=<m4>-<a6> message=<messageId>[ note="…"]` + blank line + body.
  `form` keeps the D20 provenance split; the transcript note spells the
  observable fact (no-jargon redline).
- notice: `[superd-hub:a2a] kind=notice[ conversation=<shortId>] from=<m4>-<a6>
  reason=<peer-silent|peer-error|stopped-by-initiator> summary="…"` (one line).
- Wire: `A2aNoticeEnvelope.reason` (additive; older peers fall back to 'peer'),
  and the **strict wire guard now validates it** — found the hard way live (§5c).
- Reason mapping: `stop`→stopped-by-initiator, `peer`→peer-silent,
  `stream-dead`/`aborted`/`send-failed`→peer-error. Inner double quotes in
  summaries sanitized so the k=v line stays parseable; buffered copies carry
  the identical line.

**R2 stop attribution**: a stop envelope that truly cancels a live turn stamps
the row (`stoppedAt`, additive); the completion watch compares it against its
arm watermark — the initiator's own stop can no longer masquerade as
"peer went silent". Unit-tested at ingest level.

## 4. §8 R3 — model-facing prose — FIXED

- `delivery: "queue" lands like an ordinary user message` → "is injected into
  the peer's session as a waking turn — it never interrupts an active turn, it
  queues behind it" (arg description + tool description + module comment).
- The description now teaches the notice vocabulary (reason= distinguishes
  peer-silent / peer-error / stopped-by-initiator) and marks transcript
  deliveries `form=transcript`.
- Address-error honesty (dev3 0.1.7-g §6): `unknown-machine no (not paired)`
  for a malformed address like `no-such-agent-zzz` sent the model hunting for a
  machine it never typed → now
  `a2a: unknown-machine "no" — address "no-such-agent-zzz" is not a paired
  machine (addresses are "<m4>-<a6>")` (split-at-first-dash concat is the raw
  input, so the reconstruction is exact).

## 5. New defect chain found and closed live (r2e2eh→r2e2em probes)

The E2E driver POSTs new-conversation envelopes straight to the peer's ingest
(bypassing the initiator-side registry write — a deliberate probe shortcut),
which exposed a real product hole in the write-back path:

- **a. Artifact loss on permanent send failure.** The peer replied through the
  channel; the initiator-side ingest rejected (`conversation-not-found` — real
  mesh keeps both rows, but e.g. an initiator home-reset reproduces it);
  `markChannelUsed` had already bumped the send watermark, so the completion
  watch went **quiet** — the turn's only artifact was lost and the original
  initiator never heard a word. Fix: the taxonomy's long-reserved
  **`send-failed`** reason is now load-bearing — a failed write-back mints a
  notice to the original initiator (notices deliver without a registry row;
  `deliverLocal` keys off `envelope.to` alone). Parked sends stay silent
  (pending ≠ failed).
- **b. Mirror rows never learned the opener's session.** The notice needs the
  initiator's session address; adoption persisted nothing. `initiatorSession`
  now persists on mirror rows at adoption (additive; the self-route write-back
  branch already expected it there; initiator-row detection keys on `hostAgent`
  absence, never this field).
- **c. The strict wire guard rejected the additive `reason`.** First live
  notice died as `malformed v1 envelope (strict shape check failed)` —
  `isA2aEnvelope`'s notice case didn't know the field. Guard updated
  (optional `reason`, vocabulary-validated) + regression test.
- **d. The silent swallow.** The emission failure was invisible because of
  `.catch(() => {})` — now journaled as `a2a.send.notice-fail` (this log line
  is what pointed at (c) and (e) within minutes).
- **e. Unbounded summary vs the 120 bound.** The long ingest error message
  blew `A2A_NOTICE_SUMMARY_MAX`; the receiving guard 400s over-max summaries,
  surfacing as `unreachable`. The mint pre-bounds now; unit test locks it.
- Also fixed in flight: the summary interpolated the wire error object
  (`[object Object]`) → uses `answer.error.message`.

Final live proof (r2e2em, both machines on 0.1.7-m): peer wakes, teaching
envelope has the new tail, peer replies through the channel, the (bypass)
rejection fires, and the initiator session receives

```
[superd-hub:a2a] kind=notice conversation=r2e2em from=bfwu-0kdzjk reason=peer-error
summary="conversation r2e2em: the peer's reply could not be delivered — a2a:
conversation 'r2e2em' is not in the registry — the …"
```

— bounded, quote-sanitized, cause-attributed. The artifact is no longer
silently lost.

## 6. Letter trail

`0.1.7-h` (D1+wording+R1/R2/R3+stop stamp) → `i` (mirror-row initiatorSession +
notice mint + guard) → `j` (redeploy with (a–c) complete) → `k` (guard fix
verified live) → `l` (`[object Object]` fix) → **`m` (bound-at-mint; final,
deployed both machines)**. Every bump is a pnpm same-name `file:` no-op
avoidance; nothing published to npm (no user order).

## 7. Suites

- hub package: per-file **468/468** (suite additions: pty output-schema lock,
  R2 stop-stamp ingest test, renderA2aNoticeText + reason-map test, wire guard
  additive-reason test, send-failed notice wire test, bounded-summary lock).
- pack bare lane: **946/946** (the bare `node --test` glob run undercounts by
  a couple of tests vs per-file sums — the known runner counting lore; per-file
  numbers are the honest ones).
- Environment fix: `agent-claude`'s executable default test was PATH-dependent
  (a runner without `~/.local/bin` on PATH drove the native-installer fallback
  → absolute path → red). The default leg now pins a stub dir onto PATH.

## 8. Left open

- F7 (UI turn-trigger title "Execution requested") — upstream seam, UI round backlog.
- D2-grade reaper beyond the 600 s idle TTL — not needed while D1 holds.
- The probe bypass shortcut is deliberately NOT a product path (real
  `new_conversation` records the initiator row); the hole it exposed is fixed
  for the real failure modes (registry loss / old rows).
