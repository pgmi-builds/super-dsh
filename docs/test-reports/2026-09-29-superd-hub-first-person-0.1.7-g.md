# superd-hub First-Person Test Report — 0.1.7-g (dev3 → PC)

- Date: 2026-09-29 (UTC)
- Tester: dev3-deepseek-default, first-person, via the `superd-hub` MCP tool surface from a DSH web session (dev3 GUI 127.0.0.1:3080)
- Nodes: local `bfwu` = dev3 (`srv1637772`), peer `79he` = PC (`homepc`)
- Report: written locally, delivered to PC via `scp` over the dev3→pc ssh alias (the hub's 4 096-char `cmd` cap — itself verified live during this round — makes heredoc-through-exec impractical for full reports)

## 1. Versions under test

| Node | Host | Runtime |
|------|------|---------|
| bfwu (dev3) | srv1637772, Linux 7.0.0-27-generic | `dsh web --trusted-host dsh.dev3.internal.test` (PID 2355244) — harness `@deepseek-ai/dsh` **0.1.7-rc.2**; hub package `super-dsh` **0.1.7-g** at `~/.dsh/profiles/web/node_modules/super-dsh` |
| 79he (PC) | homepc, Linux 7.0.0-30-generic | hub lane = `~/workspaces/superd/.worktrees/mesh-p1/upstream/deepseek-harness/apps/cli/lib/bin.js --profile superd-pub` (PID 3027537), worktree HEAD `3b4d87d` (docs(report): P4 §8.2 PTY over WS live acceptance 0.1.7-f/g); in-tree harness 0.1.7-rc.1; global dsh on PC = 0.1.7-rc.2 |

Note: this session runs the freshly installed `super-dsh` **0.1.7-g** (the PTY-over-WS revision) against harness tool schemas that still describe the pre-PTY surface — which is exactly what defect D1 below exposes.

## 2. Surface exercised

`agents` roster · `agent_status` (both machines) · `exec` oneshot (local + cross-machine, happy path, error paths, timeout, signal, truncation, concurrency) · `exec` PTY (MCP leg + raw WS legs) · raw hub HTTP (`/api/superd/exec`) · `a2a` (`new_conversation`, `send` follow-up, error legs, `stop` error leg, `read`) · code-level inspection of installed dist.

## 3. Roster and status

- `agents`: 2 machines × 7 agents, all `ready:true, failed:false`. Local: DSH 0kdzjk (me), Claude 9xpbi4, OMP 0yijnn, Codex 92tgxg, Pi ea3yvg, Hermes dqsdy4, Antigravity yuaisr. PC: Antigravity 74tu6w, Claude 2wmzvq, Codex c6uxel, DSH 8ah589, Hermes zdn2wp, OMP 0d6xzz, Pi xwes79.
- `agent_status 79he-8ah589`: 5-row window, alive-first (a3ba70/c7da70 `agentAvailable:true` first), includes A2A conversation rows (`conversationId` + `agentAvailable:false`). Cache `collectedAt` runs on the 5-minute sweep — a conversation opened mid-round (dvfxsx) was not yet in the window; per spec absence from the window implies nothing.

## 4. exec — oneshot

### 4.1 Happy paths
- Local (`bfwu`, default machine): `exit:0`, stdout/stderr separated, cwd default `/home/u1/.dsh`, durations 42–4092 ms across legs.
- Cross-machine (`79he`): identity leg `exit:0` in 1707 ms; default cwd = PC lane's worktree dir `/home/u1/workspaces/superd/.worktrees/mesh-p1`.
- Nonzero exit: `echo out; echo err >&2; exit 7` → `exit:7`, stdout `stdout-line-1`, stderr `stderr-line-1`, `outcome:"exited"`.

### 4.2 Timeout
- `sleep 5` with `timeoutSec:1` → `exit:null, timedOut:true, outcome:"timeout"`, killed at **1013 ms** (SIGTERM→SIGKILL ladder).
- A 45 s recursive-grep leg also timed out cleanly (`timedOut:true, exit:null`) — accidental but valid second sample.

### 4.3 Signal death
- `kill -KILL $$` → stdout carries the pre-kill line only, `exit:null`, and a NEW `outcome:"signaled"` — 0.1.7-g improvement over 0.1.7-d where signal death was indistinguishable from timeout (`exit:null` only).

### 4.4 Validation — two layers confirmed again
| Input | Rejection layer | Message |
|---|---|---|
| `timeoutSec: 1.5` | harness schema (before hub) | `invalid arguments: "timeoutSec" must be an integer` |
| `cmd: ""` | hub parse | `[E_BAD_EXEC] superd-hub: exec: cmd must be a non-empty string` |
| `cwd: "relative/nope"` | hub parse | `[E_BAD_EXEC] superd-hub: exec: cwd must be an absolute path` |
| `machine: "nonexistent-machine-zzz"` | hub routing | `[E_EXEC_FAILED] superd-hub: unknown machine "nonexistent-machine-zzz" — call agents for the roster` |
| `timeoutSec: 0` / `601` (raw HTTP to PC hub) | hub parse | `mesh-api: exec: timeoutSec must be an integer in [1, 600]` |
| 4097-char cmd (raw HTTP) | hub parse | `mesh-api: exec: cmd exceeds 4096 characters` |

### 4.5 Truncation (30 000-byte boundary, exact)
- 30 000 bytes stdout → `truncated:false`. 30 001 bytes → `truncated:true`.
- Tail semantics: 5 000 `x` + 40 000 `y` → returned (truncated) payload **starts with `y`** — the head is dropped, the last 30 000 bytes are kept.

### 4.6 Concurrency
- Three execs issued in one harness tool block ran **sequentially** (starts 2.07 s apart) — harness-side sequencing, same observation as the 0.1.7-d round.
- Retest over raw HTTP (4 parallel `curl` POSTs to `https://test.pc.internal.test/api/superd/exec`, cookie auth): all four started within **~33 ms** of each other, each ran ~2.10 s, total wall 2.79 s including the 401 probe and node postprocessing. The hub itself executes concurrently.
- Unauthenticated POST → **401 `unauthorized`** (facility fence intact).

### 4.7 execEnabled gate
Code-level: `execEnabled` present in installed 0.1.7-g dist (`a2a-row.js`, `hub-tool.js`, `machines.js`, `mesh-rpc.js`). Live flip test (backup→disable→refusal→byte-identical restore) was validated in the 0.1.7-d round and not repeated on the live mesh this time.

## 5. exec — PTY

### 5.1 D1 (defect): MCP PTY leg rejected by harness output schema
`exec` with `mode:"pty"` on machine `79he` failed **after** the hub side had already acted:

```
Error: tool "superd-hub" returned invalid output: "value.mode" is not a declared property (additionalProperties: false)
```

The 0.1.7-g PTY response carries a `mode` field; the harness tool output schema (`additionalProperties:false`) does not declare it. Net effect: **PTY is unusable through the MCP tool surface** until the harness-side schema is regenerated for 0.1.7-g. (The tool's own description already documents `mode:"pty"` — the input side accepts it; only the output validator rejects.)

### 5.2 D2 (defect): PTY session leak when the caller abandons the call
The failed MCP call above left a live PTY behind on PC: `script -qfec bash /dev/null`, PID 3054315, own pgid, PPID 3027537 (PC hub), still alive **>2 minutes** after the caller got the error. The initiator-side WS stayed ESTAB — the output-validation failure discards the caller's handle without closing the channel, so the executor never sees a close (its only kill trigger besides idle TTL).

Proof of linkage: dev3→PC (123.203.190.98:443) ESTAB count was **9**; after `kill -TERM -3054315` on PC the count dropped to **8** and the child vanished. Cleanup done; recommend initiator-side `ws.close()` in a `finally`/teardown path on tool-result rejection, and/or a hub-side reaper for PTYs whose initiator session is gone.

### 5.3 PTY over raw WS (executor protocol per dist comments)
One WS = one dumb `script -qfec bash /dev/null` byte pump; text frames carry stdin/stdout; child exit announced as `{"op":"exit","code":N}`; WS close group-kills (SIGTERM, SIGKILL after 2 s). Auth = same cookie gate as the `/hub` family (upgrade is never weaker). Driven directly with `ws` from the profile node_modules against `wss://test.pc.internal.test/api/superd/exec/pty`:
- ready-sync via `echo PTY-READY-017G`: ok.
- dispatch 1: `cd ~/workspaces/superd && export HUB_PTY_PROBE=017g` → ack in 50 ms.
- dispatch 2 (separate frame): `pwd` → `/home/u1/workspaces/superd` — **cwd survives across dispatches**; `echo ENVOUT=$HUB_ENV_PROBE` in a later dispatch → `ENVOUT=017g-env` — **env survives** (re-proved in a second session with an independent probe var after the first grep matched the echoed command line instead of the output).
- interrupt: `sleep 30` then raw `\x03` then `echo MARK3-DONE` → recovered in 51 ms.
- clean `ws.close()` from a raw client: child gone after the 2 s grace window (observed: one transient `script` PID present ~1 s after close, gone on recheck; the D2 orphan above is the contrast case).

## 6. a2a

- `new_conversation` → `79he-8ah589`, title `A2A exec-test roundtrip 0.1.7-g [hub A2A]`, message = deterministic probe (opening + first turn as ONE injected turn): receipt `conversationId "dvfxsx"`, `sessionId "session-4e130091-d9f8-4ea9-98ea-5f258efc1666"`.
- Follow-up `send` (same conversation, queue delivery): `outcome:"injected"`, `messageId "a2a-f4783024-c576-48ed-b9e7-ae3f10252ec2"`, note reiterating exactly-once semantics (reply auto-delivers as a new message in the initiator conversation; `read` only sweeps buffered leftovers).
- Error legs:
  - `send` to `no-such-agent-zzz` → `outcome:"failed"` with a message id still allocated (`a2a-ea428afd-…`), error `a2a/unknown-machine: "a2a: unknown-machine no (not paired)"` — the address parser splits at the first dash, so the machine fragment `no` is checked first; an agent-shaped unknown string surfaces as an unpaired-machine error.
  - `stop` on nonexistent conversation `zznonexistent` → registry error `a2a: conversation "zznonexistent" is not in the registry` (distinct from the `stopped:false` soft answer for a real conversation with no active turn — matches spec).
- `read` sweep: `count:0` — nothing buffered; replies route as new messages, not via the buffer.
- Local registry `~/.dsh/superd/a2a-conversations.json`: 16 historical conversations (FP-A/B/C 0.1.7-a, FP-K 0.1.6-k, R8, v3 S1/S2 …); `dvfxsx` syncs on writeback.
- Peer reply: see §8 (arrival leg).

## 7. Mesh plumbing observed

- `machines.json` (dev3): self `bfwu`; remote `79he` origin `https://test.pc.internal.test`, token + `dsh-auth-…` cookie (authority 127.0.0.1:4999), `enabled:true`, addedAt 1790590027415.
- Hub-to-hub channels: 9 dev3→PC ESTAB (pre-cleanup; 8 after the D2 kill) + 6 PC→dev3 ESTAB — persistent outbox/poll + a2a channels riding both front doors (Caddy on dev3 :443, PC origin on 123.203.190.98:443).
- HTTP surface (from dist): `POST /api/superd/exec`, `/api/superd/exec/pty` (WS), `/api/superd/a2a`, `GET /api/superd/a2a/outbox?machine=<m4>`, `/api/superd/machines`.

## 8. Verdict

Core remote-exec surface: **green** — oneshot local/cross, exit/stderr fidelity, [1,600] timeout ladder, 4096-char cap, absolute-cwd rule, roster discipline, 401 fence, exact 30 000-byte tail truncation, true hub-side concurrency (33 ms spread over 4 parallel wire execs), PTY cwd/env/interrupt persistence over WS, group-kill on close.

Two defects, both new-in-0.1.7-g and both rooted in the PTY rollout's harness-side seam rather than the hub wire:
- **D1** MCP PTY output schema mismatch (`value.mode` undeclared) — PTY blocked at the tool surface.
- **D2** PTY session leak when the tool result is rejected upstream (orphan `script` child + ESTAB WS; proven and cleaned).

a2a open/follow-up/error legs green; reply arrival is async by design and lands as a new message in the tester's conversation (see addendum if present below).

### Addendum — reply arrival
(pending at write time; to be appended if the peer reply landed after this file was written)

**Outcome (~07:0x UTC, peer still unreachable):** the initiator yielded the documented single notice — `conversation "dvfxsx": turn ended, no reply`. Interpretation: the PC agent's turn died with the host (opened while PC was up, killed by the outage); no reply was captured; the relay degraded gracefully (no hang, no retry storm, exactly one notice). Reply leg classified **inconclusive due to outage**, not a protocol defect — the open/follow-up/error legs stand green. Re-probe the reply path with a fresh deterministic message once 79he answers again.

**Second notice (minutes later, peer still down):** a second identical `turn ended, no reply` arrived — this is the *follow-up* turn's notice (`a2a-f4783024`), i.e. exactly one notice per injected turn, both turns having been killed by the outage; no duplicate or spurious emissions beyond that. Corroborated by the local registry: `~/.dsh/superd/a2a-conversations.json` now carries the `dvfxsx` record — `machine 79he, agent 8ah589, sessionId session-4e130091-…, initiatorSession session-edb924b9-… (the tester's own dev3 session), createdAt 1790673008988, lastActivityAt 1790673023119` (the ~14 s span between probe and follow-up). The record synced only after the turn-end processing — at check time immediately after the a2a legs it was absent, consistent with writeback-on-turn-end rather than create-time sync.

## 9. Incident: peer 79he (PC) went unreachable mid-round

At ~06:5x UTC, between the concurrency leg and the report-delivery leg, every dev3→PC path died simultaneously:

- tool-level `exec` on `79he` → `[E_EXEC_FAILED] superd-hub: exec: peer unreachable — fetch failed`
- direct `curl` to `https://test.pc.internal.test` (root and API) → `http=000`, full stall to every `--max-time` (12/15/25 s), repeatedly, over 3+ minutes
- `ping 123.203.190.98` still answers (0 % loss, ~40 ms) — that is the home NAT router; the forwarded TCP :443 to the PC host behind it does not answer
- PC→dev3 established sockets decayed 6 → 2 with a growing unacked Send-Q (40 368 B) — half-open TCP to a vanished peer
- the orch-a2a hub, an independent facility also hosted on PC, failed with the same `fetch failed` at the same time
- the Corti memory backend (`memory_add`) also began failing `fetch failed` in the same window — three PC-hosted facilities (superd peer, orch-a2a hub, Corti) dropped together, confirming a single host-level outage on PC

Interpretation: the PC host (not merely one port) dropped off the network — suspend, reboot, or power event. Not attributable to the test traffic (the heaviest wire load was four 2-second `date/sleep` execs, and everything stayed green for minutes after that).

Operational observations worth keeping:
- The `agents` roster kept showing 79he agents `ready:true` for a while after the outage began — readiness is registry/cache state, not instant liveness. Roughly an hour later all seven 79he agents read `ready:false` (still `failed:false`): the sweep had positively marked the dead peer. So the flag converges, with a delay on the order of the sweep cadence plus outage-detection window.
- Consequences for this round: the a2a reply from `79he-8ah589` cannot arrive while PC is down, and this report could not be written to `pc:/home/u1/workspaces/superd/docs/test-reports/` at test time — see §10.

## 10. Delivery status of this report

- Local authoritative copy: `dev3:/home/u1/workspaces/base/2026-09-29-superd-hub-first-person-0.1.7-g.md` (md5 `62a574dee8c2950c3716eb4d888593f6` before this section was appended).
- Intended destination: `pc:/home/u1/workspaces/superd/docs/test-reports/2026-09-29-superd-hub-first-person-0.1.7-g.md`.
- First delivery attempt through `superd-hub` exec heredoc hit the 4 096-char `cmd` cap (expected; good live sample). Second attempt (scp over the dev3→pc ssh alias) was aborted by an ssh strict-host-key failure (PC host key changed vs known_hosts line 10 — NOT overridden; that rotation predates or accompanies the outage and needs the owner's confirmation).
- Chunked base64 delivery over the hub's own HTTP exec endpoint was prepared (4 × 3 800 chars) and is the recommended transfer once 79he answers again: rebuild `/tmp/rpt.b64` from chunks, `base64 -d`, verify md5.
- Delivered: peer recovered at ~10:20 UTC (probe went 000-stall → 502 → healthy 401 front door; wire exec green in 143 ms); report pushed via the chunked base64 route and byte-identity verified by md5 comparison on both hosts.
