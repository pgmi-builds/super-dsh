# Remote tool surface — discussion draft

> **Working surface draft under the approved spec** [docs/specs/remote-default-pty/spec.md](../../../specs/remote-default-pty/spec.md) (2026-11-01). Field-level reconciliation against the real host defineTool projection happens in Task A/D; the reviewed rulings (quota not pre-disclosed, fresh-handoff create-then-detach, native from-0 first job_output read, went-async + completion-notification wording, close takes no job id) are normative in the spec. Original draft note: the concise instruction below uses the existing `run_in_background` field for immediate PTY handoff, retains busy-shell `force:true`, and removes the old `input` action and explicit `<machine>:pty` creation. SSH oneshot connection reuse is an internal transport change. The schema is a proposed runtime projection for discussion. Existing PTY result parsing and receipts are a preservation constraint. See [design-for-review.md](design-for-review.md) and [plan.md](plan.md).

## Proposed model-visible instruction

```text
Remote shell over SSH, Docker, Incus, and Hub. 1 default interactive PTY per machine (retains cwd/env). `mode:"oneshot"` = isolated, no state.

Actions:
- exec {target, cmd? | scriptPath?, stdin?, mode?:"pty"|"oneshot"="pty", run_in_background?:boolean=false, timeout?:120}: Run command or raw write. `cmd`/`scriptPath` are alternatives. PTY mode: `stdin` alone = raw write to interactive PTY (no new framed command). `run_in_background:true` = the command went async (not bash `&`): a job handle returns immediately — oneshot runs async; on a default PTY the framed command starts and that PTY is handed off in the same operation; on an addressable PTY it stays in its session. Completion notification will follow — set it and move on; job_output (reads the command's full stream from byte 0) and job_kill remain available.
- handoff {target:<machine>}: Detach default PTY -> `pty:<id>` at any time, including fresh/idle. Next machine `exec` spawns a fresh default PTY. (Settled output, Task C/D: minimal `handoff` kind — session (+label), connection, cwd, created (fresh warm), running+commandId (busy), ttlSec; no exit/stdout/envDelta since no command runs. Locked against the real renderer in tool.spec.)
- close {target:<machine|pty>, force?:boolean=false}: Close a PTY shell. Machine target closes *only* default PTY. A busy PTY shell refuses close unless `force:true` (interrupts its running command and closes in one step). Cancelling a running command is job_kill's job — the official job registry entry for every job; close takes no job id.
- add {ssh:{host,...} | spawn:"<interactive-shell command>", target?}: Register BYO SSH identity or PTY. Returns name. No default PTY created.
- status {target?}: Without target, scan local SSH config, Docker, Incus, and available Hub targets on demand, then show all of this Agent's live PTY sessions (default + detached) and BYO entries; no dialing or live monitoring. With target, probe/show its current state. No command history retained.

Targets & Semantics:
- Targets: `ssh:<n>`, `docker:<n>`, `incus:<n>`, `hub:<m4>`, `pty:<id|label>`. Machine target = default PTY (unless `mode:"oneshot"`). Busy PTY rejects new cmds (use `job_output`, `job_kill`, handoff, or `oneshot`).
- PTY: Stream includes echo/stderr. `envDelta` lists var names (no values). Expires after 15m idle. Timeout = sync wait limit (job keeps running).
- Oneshot: Separate stdout/stderr, verbatim exit code, no shell state retention. `run_in_background:true` returns jobId instantly. `stdin` = startup only. SSH oneshot may reuse its authenticated transport connection; commands remain isolated.
- Script: `scriptPath` = local absolute path read before connect, runs as Bash script. In PTY, runs as child process (`cd`/`export` don't affect parent shell). Hub inline cmd limit: 4096 chars.
- Stdin & Limits: 
  - oneshot: `fd0 → pipe`
  - PTY: `fd0 → pty slave (/dev/pts/N)`, line disciplines. Literal bytes (`\n`, `\u0003` = Ctrl-C, `\u0004` = line-discipline EOF). Retention: 4M UTF-16 units per PTY stream / 4 MiB Hub oneshot.

Examples:
remote {"action":"exec","target":"ssh:dev4","cmd":"cd /srv/app && pwd"}
remote {"action":"exec","target":"ssh:dev4","cmd":"echo $PWD"}
remote {"action":"exec","target":"ssh:dev4","cmd":"make test","run_in_background":true}
remote {"action":"handoff","target":"ssh:dev4"}
remote {"action":"exec","target":"pty:pty-a1b2","cmd":"make test"}
remote {"action":"exec","target":"pty:pty-a1b2","stdin":"yes\n"}
remote {"action":"close","target":"pty:pty-a1b2","force":true}
remote {"action":"close","target":"pty:pty-a1b2"}
remote {"action":"exec","target":"ssh:dev4","mode":"oneshot","cmd":"uname -a"}
remote {"action":"exec","target":"ssh:dev4","scriptPath":"/home/u1/task.sh","stdin":"data\n"}
remote {"action":"add","spawn":"ssh -t pc ssh -t dev4","target":"pty:dev4via"}
remote {"action":"exec","target":"pty:dev4via","cmd":"hostname"}
remote {"action":"add","ssh":{"host":"10.0.0.8","user":"u1","key":"~/.ssh/id_key4"},"target":"ssh:lab"}
remote {"action":"exec","target":"ssh:lab","cmd":"uname -a"}
```

Examples are independent demonstrations, not one sequential session. The handoff example uses an illustrative ID; the model must use the returned ID. Hub targets appear only when Hub is configured. A local key path such as `~/.ssh/id_key4` must be resolved using the existing SSH path rules before dialing; the draft example does not authorize a new expansion mechanism.

## Existing surface details to preserve while discussing the concise copy

The short instruction is selective; all existing behavior outside the explicit refactor remains. The bullets below are a finite high-risk reminder, not an exhaustive preservation list:

- PTY commands still use nonce-framed output parsing, return command exit/cwd/envDelta/duration, retain command echo and merged stderr, and render a one-shot-like result. A running command's `job_output` remains incremental.
- The old `input` action and explicit `<machine>:pty[:label]` creation are deliberately removed. Their needed behaviors move to `exec` stdin-only and machine default plus `handoff`. The stale-write `commandId` guard remains available on `exec` stdin-only.
- PTY background execution stays under the existing `run_in_background` field, explained as the command going async (not bash `&`) with a completion notification to follow — no polling burden. On a default PTY it immediately hands off the running command; an addressable PTY keeps its identity. `close.force`, `job_output`/`job_kill`, BYO labels and current result fields remain. job_output reads the current command's full stream from byte 0; overlap with the pre-handoff sync receipt is expected (ruled 2026-11-01). Cancelling jobs is job_kill only; close takes no job id.
- SSH oneshot connection multiplexing is tool-owned and transparent to the model. It does not change the selected SSH identity, command isolation, exit/stderr, cancellation or process-group cleanup.
- Output retention statistics, truncation disclosure beyond retention, runner identity, Hub pairing checks/no SSH fallback, and `remote_transfer` are unchanged. Roster keeps its on-demand scan and per-Agent naming scope; it is not a live global inventory. The last-20-command ledger is the explicit historical-state removal.

## Proposed input JSON schema projected to the model

This is a **draft**, not a claim about the current registered tool. DSH `defineTool` projects a flat parameter map to an open object root; action-specific combinations need tool-side validation. The existing `run_in_background` is the only execution flag; old `input` action and explicit machine `:pty` creation are absent by decision.

```json
{
  "type": "object",
  "additionalProperties": true,
  "properties": {
    "action": {"type": "string", "enum": ["exec", "handoff", "close", "add", "status"], "description": "exec runs a command or writes raw PTY stdin; handoff detaches a machine default; close closes a PTY shell (no job id — cancel jobs with job_kill); add registers BYO; status scans a per-Agent roster on demand or probes one target."},
    "target": {"type": "string", "description": "Machine, addressable PTY, or BYO label as appropriate to action. Machine targets select the default PTY for exec unless mode is oneshot."},
    "cmd": {"type": "string", "description": "exec: raw Bash command, alternative to scriptPath. PTY commands retain nonce-framed result parsing."},
    "scriptPath": {"type": "string", "description": "exec: local absolute Bash script read before connection; alternative to cmd. Proposed to work with stdin in PTY and oneshot."},
    "stdin": {"type": "string", "description": "exec: startup input with cmd/scriptPath, or raw write when PTY and no command. Exact bytes; empty string writes zero bytes."},
    "mode": {"type": "string", "enum": ["pty", "oneshot"], "default": "pty", "description": "exec: machine defaults to one reusable PTY; oneshot is isolated and stateless."},
    "timeout": {"type": "number", "default": 120, "description": "exec: seconds. PTY ends synchronous wait and keeps command running; oneshot cancels its command group."},
    "ssh": {"type": "object", "additionalProperties": false, "properties": {
      "host": {"type": "string"},
      "user": {"type": "string"},
      "port": {"type": "integer"},
      "key": {"type": "string"},
      "proxyJump": {"type": "string"}
    }, "required": ["host"], "description": "add: existing BYO SSH identity; key is a local file reference."},
    "spawn": {"type": "string", "description": "add: existing BYO PTY interactive-shell command."},
    "force": {"type": "boolean", "default": false, "description": "close target: refuse a busy PTY shell unless force:true; force interrupts its running command and closes the shell."},
    "commandId": {"type": "string", "description": "exec stdin-only: optional stale-command guard; if supplied, must match the currently running PTY command."},
    "run_in_background": {"type": "boolean", "default": false, "description": "exec with cmd/scriptPath only: the command went async (not bash &) — a running job returns immediately and a completion notification will follow, so no polling is required. Oneshot runs async; on a machine's default PTY the framed command starts and that PTY is handed off in the same operation; on an addressable PTY it keeps its identity. job_output reads the command's full stream from byte 0 (overlap with the pre-handoff receipt is expected); job_kill cancels."}
  },
  "required": ["action"]
}
```

## Output schema preservation rule

The implementation must begin from the **current registered output schema and renderer** in `better-dsh/src/remote/tool.ts`. Preserve `kind`, `text`, `exit`, `durationMs`, `cwd`, `stderr`, `session`, `commandId`, `jobId`, `envDelta`, `runner`, `running`, `ttlSec`, `outputStats`, `outputStatsUnavailable`, `truncated`, `receipt`, `notice`, `writtenBytes`, `closed`, `reason`, `killed` and the current rendering behavior. Only add or reinterpret fields required by the reviewed handoff/default-PTY contract. Do not rename `text` to `stdout` or duplicate the full output in a new field merely to match the shorthand in the discussion draft.

The JSON block below starts from the current `defineTool` output declarations and adds the proposed `handoff` kind. It is a **draft transcription, not yet an observed host projection**. The retained `input` result kind can be used for `exec` stdin-only write receipts even though the old `input` action is removed. Before implementation, compare the block with the actual registered output schema and keep any further delta minimal:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "kind": {"type": "string", "enum": ["exec", "handoff", "status", "roster", "job", "close", "input"]},
    "text": {"type": "string"},
    "jobId": {"type": "string"},
    "receipt": {},
    "exit": {"oneOf": [{"type": "integer"}, {"type": "null"}]},
    "durationMs": {"type": "integer"},
    "cwd": {"type": "string"},
    "stderr": {"type": "string"},
    "timedOut": {"type": "boolean"},
    "reconnected": {"type": "boolean"},
    "truncated": {"type": "integer"},
    "outputStats": {},
    "outputStatsUnavailable": {"type": "boolean"},
    "session": {"type": "string"},
    "label": {"type": "string"},
    "connection": {"type": "string"},
    "byoTag": {"type": "string"},
    "commandId": {"type": "string"},
    "writtenBytes": {"type": "integer"},
    "envDelta": {},
    "created": {"type": "boolean"},
    "notice": {"type": "string"},
    "runner": {"type": "string"},
    "running": {"type": "boolean"},
    "ttlSec": {"type": "integer"},
    "closed": {"type": "boolean"},
    "reason": {"type": "string"},
    "killed": {"type": "array", "items": {"type": "string"}}
  },
  "required": ["kind", "text"]
}
```

The reviewed design must specify the smallest output-schema delta for `handoff` before implementation.
