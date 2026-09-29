# First-person 0.1.7-m triage → 0.1.7-n

- Date: 2026-09-29 (UTC night)
- Input: dev3-hosted first-person report `2026-09-29-superd-hub-first-person-0.1.7-m.md`
  (PC native agent **inside** the 4999 line, direction PC → dev3 — the reverse direction
  from the two preceding rounds, so also an independent replication).
- Outcome: F1 fixed, F2 fixed, O3/O4 documentation gaps closed; **super-dsh 0.1.7-n
  deployed on both machines** (rig `superd-4999-test`, dev3 `~/.dsh/profiles/web`,
  `world failed 0` both).

## 1. What the report closed (accepted as verified)

- **D1 (PTY blocked by the tool output schema)** — confirmed fixed; PTY now usable over
  the DSH-native tool surface, 7/7 dispatches, local + cross-machine.
- **D2 (orphaned executor/WS)** — no orphans in the normal lifecycle on either host. The
  report is honest about the boundary: the original trigger (harness rejecting the tool
  result) is unreachable now that D1 is fixed, so this is "old path cannot recur", not
  "re-proven under fault injection". Accepted with that framing; the abandonment path
  stays unit-covered.
- **Unknown-agent error precision** (0.1.7-g §6 fix) — confirmed live.
- **Reply leg** — moved from *inconclusive (outage)* to **green**: 4/4 replies landed as
  relay-envelope turns with exact payloads, one per injected turn, no duplicates.

## 2. F1 — `cwd` silently ignored on the PTY leg — FIXED (0.1.7-n)

Verified in source: the pty branch never read `args.cwd`; oneshot honors it. Silent
parameter no-ops are the worst option, and honoring it per-dispatch would mutate the
persistent shell's own state (the PTY's cwd is session state by design). Chosen fix =
**explicit refusal + teaching error**:

```
[E_BAD_EXEC] superd-hub: exec: cwd is not supported with mode "pty" — the persistent
shell keeps its own cwd; use `cd <dir> && …` inside the command
```

Tool description + parameter description now say `cwd` is oneshot-only and name the
workaround; spec §8.1 records the ruling. Unit test locks the refusal and that oneshot
still receives `cwd`.

## 3. F2 — `[undefined]` reached the human surface — FIXED (0.1.7-n)

The sentinel is correct at the wire/registry layer (D17 verbatim adoption), but
`shapeAgentStatusWindow` interpolated it straight into the display title
(`[undefined] [hub A2A]`). D17 already sanctions display-layer beautification, so the
display now maps absent/empty/sentinel → **`(untitled) [hub A2A]`**; the registry keeps
`[undefined]` untouched (verified: `lunx18` still `'[undefined]'` on disk — the change is
presentation-only).

Live check against the rig's real cache + registry through the same code path as the
installed dist: the exact row the tester cited and 5 more render `(untitled) [hub A2A]`,
**0** `[undefined]` leaks in the whole window set.

## 4. O3 / O4 — model-facing contract gaps — CLOSED (0.1.7-n)

- **O3 (address semantics)**: the `agent` field is the *conversation's owner* address —
  the peer for a conversation you opened, your own address for one a peer opened with
  you. The description said "the peer", which is wrong for mirror rows. Now stated
  explicitly (the refusal message already names the correct address).
- **O4 (message-less open)**: an open without `message` is **not** silent — the peer still
  receives one waking turn carrying `(conversation opened)`. The description read as
  though omitting it opened without a turn; it now says so and tells callers to pass a
  message unless they want exactly that.
- Both were doc-only; a test pins the new wording so it cannot silently drift back.

## 5. Residual (unchanged, honestly bounded)

- `read`'s unread-buffer branch still not live-reachable (needs the initiator torn down
  mid-flight) — unit-covered.
- `reconnected:true` (PTY transport-death recovery) not yet triggered live.
- `execEnabled=false` not flipped on the live mesh (would disrupt the peer).
- The tool legs themselves (F1 refusal, the beautified titles in the GUI) get their
  first-person acceptance in the next browser pass — this round verified F2 against live
  data through the identical code path and F1 by unit + installed-dist inspection; the
  model-in-the-loop call is the remaining step.

## 6. Suites / artifacts

- hub package per-file **470/470** (468 + F1 refusal/cwd-symmetry test + description lock).
- Pack bare lane re-run at the round's end.
- Tarball `super-dsh-0.1.7-n.tgz`; both ends on 0.1.7-n (`world failed 0`).
- Registry/cache untouched by the display fix; no service restarted beyond the two test
  lines; nothing published.
