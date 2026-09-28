# Post-office rework — 4999 rig + dev3 first-person acceptance (2026-09-28)

**Scope**: mesh-p1 branch R0–R8 (ADR 0011 / spec D16–D19 implementation), pack
`super-dsh@0.1.6-i` (chain `933cd23`→`309e5c5`). Suite **432/0/0** at
`--test-concurrency=4` (Node runner IPC flake avoidance flag, adopted for gates).

## Chain of custody

| Round | Deliverable | Commit |
|---|---|---|
| R0 | spawnWorld scan guard (farm-less worlds silent) | `933cd23` |
| R1 | `a2a-wire.ts` envelope protocol v1 (strict guards, notice ≤120, `[undefined]` placeholder) | `ec38289` |
| R2 | D17 title semantics (registry-only, immutable, zero rename write-through) | `043fb85` |
| R3 | ingest handler + `POST /api/superd/a2a` + outbox (≤32, persistent) | `c0eb4b9` |
| R3a/R4 | routing-marker row fields (`hostAgent`/`initiatorSession`) + initiator re-route (envelopes only; federated session-plane driving deleted) | `3c576db`/`58e59c0` |
| R5 | sweep dual responsibility (outbox pull + session/workspace collection into `agent-status.json`) | `a9832ac` |
| R6 | agents strip + `agent_status` leg (window + title overlay + `[hub A2A]` marker) | `ab5c5c8` |
| R7 | client half (last-fetch line + 5-min note + refresh control; server already had `lastProbeAt`) | `d14d0fd` |
| R8-fix | return-envelope sender attribution (envelope-carried `sender`, registry fallback, never selfId) | `309e5c5` |

## PC rig (4999, `0.1.6-h`→`0.1.6-i`)

- boot: `world failed` 0; `hub.version` served `0.1.6-h` then `0.1.6-i`.
- **Self-loop A2A (envelope path)**: ctx0 native session `486373ae` →
  `new_conversation` 79he-xwes79 (title "R8 self-loop") → **single mirror row**
  `{shortId 8gxynz (random mint), machine 79he, agent 8ah589 (initiator),
  sessionId <local pi session>, hostAgent xwes79}` — no dual-row collision;
  `send` → **two auto-delivered `a2a-relay`s** (opening-message turn + ping turn),
  attribution `Agent 79he-xwes79 replied`.
- **`agent_status` live** (tool result, verbatim fields): window carries
  `R8 self-loop [hub A2A]` (registry join + marker), `[undefined] [hub A2A]`
  (placeholder verbatim), `[unhosted]` (double-miss fallback), `conversationId`
  present/omitted per registry join, truncated sessionIds, `collectedAt`.

## dev3 (VPS bfwu, `0.1.6-i`)

- tarball `corepack pnpm@10.33.2 add file:` → user-unit restart → `world failed` 0,
  `hub.version = 0.1.6-i`.
- **Mutual pairing**: dev3 added PC (`{id:"79he", status:"reachable",
  lastProbeAt}`); PC already held bfwu → bidirectional topology. dev3's probe of
  PC reports `version 0.1.6-i`; PC's persisted cookie survived PC's rig restart
  (seed-persistent discipline).
- **Cross-machine round-trip**: dev3 native session `3c2e7c96` → send to
  `79he-8ah589` → envelope over wire → PC mirror row
  `{machine bfwu, agent 0kdzjk, sessionId <PC-local>, hostAgent 8ah589}`;
  dev3 initiator row `{machine 79he, agent 8ah589, initiatorSession <dev3 session>}`
  — dual-sided symmetric registry confirmed across machines.
- **Attribution defect caught & fixed**: first cross reply landed as
  `Agent bfwu-8ah589 replied` (receiver's selfId stamped as sender machine —
  nonexistent address). Fix `309e5c5`: return envelopes carry additive
  `sender {machine, agent}` stamped by the producing hub; receiver falls back to
  the registry row (points at the peer), else honest `unknown`. Re-run on
  `0.1.6-i`: **`Agent 79he-8ah589 replied`, `senderMachine:"79he"`** ✓.
- **Cross-machine status cache**: PC `agent-status.json` carries both buckets —
  79he (7 agents) and **bfwu (7 agents, rows collected over the presentation
  lane)**.

## Known residuals

- dev3 codex/hermes session planes (pre-existing D4-dev3, unchanged scope).
- stop cross-machine live-run not repeated this round (unit-covered; D5
  semantics untouched by the pivot).
- client-bundle-drift flake (~1/4 under load, pre-existing) — isolated runs green.

## Addendum — roster self-description discipline (0.1.6-j, `dc8ba5e`)

User browser acceptance caught the PC roster showing 14 "remote" agents after
mutual pairing: dev3's additive response advertised its federated copy of PC's
agents, and PC's probe adopted all of them (phantom rows, chimera labels like
"OMP PC DEV3"). Ruling: hub-to-hub is P2P — each hub reports ONLY its own
agents; the requester fans out one probe per paired machine and merges locally.

Fix both ends: probes carry `?mesh=1` → the additive response serves
self-hosted rows only (plain browser GET keeps the full roster for the local
UI); `probeMachine` adopts only `machine === 'local'` rows (belt-and-braces
for older peers). Phantoms converged away on the next reprobe.

Live verification (both machines on 0.1.6-j): PC `?mesh=1` → 7 rows all
`local`; PC→dev3 probe → bfwu 0.1.6-j **7 agents**; **PC full roster
{local: 7, bfwu: 7}** — duplicates gone; dev3 `?mesh=1` → 7 local; dev3→PC
probe → 79he 0.1.6-j 7 agents. Suite 433/0/0.
