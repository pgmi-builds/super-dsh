# Remote tools

Better Dash and Super Dash each provide the native `remote` tool and REPL route. The first enabled provider owns each Agent; unloading it does not hot-transfer ownership. Start a new Agent or cold-resume after changing providers. Super works without Better; Hub transport is optional. See [ADR 0015](adr/0015-independent-bundles-agent-remote.md).

## Choose a call

`remote` declares its action; `remote_transfer` declares its mode. Nothing dispatches on which fields happen to be present.

| Goal | Input |
| --- | --- |
| List locally known targets without dialing | `remote {action:"status"}` |
| Probe one target / show a session card | `remote {action:"status",target:"ssh:alias"}`, `remote {action:"status",target:"pty:<id\|label>"}` |
| Register an Agent-local SSH identity (no dialing) | `remote {action:"add",target:"ssh:build",ssh:{host:"host",user:"user",key:"/origin/key"}}`; omit `target` for an auto id (`ssh-xxxx`) |
| Register a BYO PTY from a spawn command | `remote {action:"add",spawn:"docker exec -it img bash",target:"pty:build"}`; then address it like any session |
| Stateless command and stdin over an identity | `remote {action:"exec",target:"ssh:build",cmd:"cat",stdin:"hello"}` |
| Stream a local script to fixed `bash -s` | `remote {action:"exec",target:"ssh:alias",scriptPath:"/absolute/script.sh"}` |
| Create a persistent shell (tab semantics) | `remote {action:"exec",target:"ssh:alias:pty",cmd:"cd /tmp; export CHECK=ready"}`; append `:label` (`ssh:alias:pty:build`) to name it |
| Reuse a persistent shell | `remote {action:"exec",target:"pty:<id\|label>",cmd:"…"}` |
| Answer a prompt / feed a running command (password, OTP, token, choice, REPL line, `\u0003`/`\u0004`) | `remote {action:"input",target:"pty:<id\|label>",stdin:"the-answer\n"}` — optional `commandId` guards against stale prompts |
| Close a PTY session | `remote {action:"close",target:"pty:<id\|label>",force:true}` |
| Native CLI copy | `remote_transfer {mode:"copy",src:"/absolute/source",dst:"ssh:alias:/absolute/destination",argv:["-p"]}` |
| Native rsync | `remote_transfer {mode:"rsync",src:"/absolute/source/",dst:"ssh:alias:/existing/destination/",argv:["-a","--partial","--dry-run"]}` |

## PTY is a persistent, interactive terminal session

Prefer the PTY lane. A PTY dispatch returns synchronously with the same receipt a oneshot returns — output text, exit code, duration — and only adds state: `session`, `cwd`, `envDelta`, `commandId`, `ttlSec`. Nothing is withheld at read time; the terminal merges stderr into the output stream, which is the only receipt difference. What the session buys is durability: cwd, exported environment, shell variables, activated virtualenvs, aliases and an open REPL survive between calls, so a multi-step task becomes N cheap calls instead of N stateless logins, and a command that outlives its timeout hands off to a pollable job instead of being killed. It is also the only interactive lane: a running command can be observed and then fed more stdin (`input`), which a oneshot never offers.

Interactive flow — see a prompt, answer it, read the response:

1. Start the program: `exec` with `cmd` (foreground, `run_in_background`, or after a timeout handoff — identity is preserved either way). The running receipt carries the output so far plus `session` / `commandId` / `jobId`.
2. Watch for the prompt in that output; use `job_output <jobId>` when you need more.
3. Send the answer: `{action:"input", target:"pty:<id|label>", stdin:"the-answer\n"}`. `stdin` passes through verbatim — include the trailing `\n` to submit a line; `\u0003` is Ctrl-C and `\u0004` is Ctrl-D as raw characters; a literal backslash-x-0-4 stays four characters; `""` writes zero bytes (not EOF). The optional `commandId` must equal the running command's id; a stale id refuses the write instead of feeding the next command.
4. Read the response with `job_output` on the SAME job. The input receipt only confirms N bytes were written — it never means the password was accepted or the login succeeded; judge from the program's output and the job's exit.

Honest limits of the input lane: Ctrl-D is not a universal EOF (on a line without a trailing newline it first delivers that text — send it again on the emptied line to end a reader like `cat`); Ctrl-C only interrupts where the terminal mode allows; `job_kill` remains the explicit cancel; `input` never creates, dials, reconnects or replays — address a live session as `pty:<id|label>`, any transport. A command waiting for input IS the busy state — a new `cmd` gets `[E_SESSION_BUSY]`; feed the running command instead of queueing a second one. On a oneshot, `stdin` is startup-only: known data may ride the initial `exec`, but a oneshot cannot be fed after it starts and its timeout still cancels the whole group — a prompt there means cancel and switch to PTY. Heredocs and input redirection remain valid bulk-input alternatives; there is no global stdin ban.

Use the stateless oneshot when a step is genuinely one-shot (a probe, a pipeline stage, a supervised build you will not revisit) or when the `runner` supervision guarantee matters. On dumb-pipe transports the supervisor is the pinned `superd-run` helper (or its POSIX wrapper) — receipts say which ran. On the Hub lane the peer IS our own server: supervision is native there (`bash -lc` in a detached group, TERM→2s→KILL, output rings, lease lifecycle) and receipts say `hub-lease`; the helper is a dumb-pipe artifact and is never uploaded over the Hub. Note that `exec` always executes something: a warm session is created by running a command (`true` is enough), never by omitting `cmd`.

There is no `mode` field: append `:pty` to a transport target to create, address a live shell as `pty:<id|label>`. `add` only registers (BYO identity or BYO PTY) and never runs a command. `scriptPath` cannot combine with cmd/stdin/PTY and is `exec`-only. Direct local command execution is not provided; use native local shell tools. Background jobs require the official jobs service/controller and are read/killed with `job_output`/`job_kill`; on PTY lanes a background job's jobId is the commandId (a timeout handoff keeps them as separate ledger fields). SSH keys/config stay on the origin; BYO identities are not persisted across new/cold Agents. PTY backlog recovery and live probes are not part of this release.

PTY state is durable and readable: every dispatch returns exit, cwd and `envDelta` (variable names and change markers only — values never leave the endpoint; fetch them yourself if needed). `close` is idempotent (`closed:false, reason:"not-found"|"already-closed-or-reaped"`); a session with a running job refuses close unless `force:true`, which kills the group and reports `killed`. A busy session rejects new commands instead of queueing (`[E_SESSION_BUSY]` names the running id and the ways out: `input` more stdin, `job_output`, `job_kill`, or another session/oneshot); open another PTY or use a oneshot for parallel work. Idle PTYs are reaped after 15 minutes; an Agent holds at most 10 live sessions across connections, and dead sessions do not count. `hub:<m4>:pty[:label]` opens the same session shape over the Hub WebSocket lane — identity, labels, input, parallelism and background work exactly like ssh/docker/incus/BYO.

Native/PTY output retains at most 4,000,000 UTF-16 units per stream; Hub oneshot retains 4 MiB bytes. Normal returned tails are smaller. Read `outputStats` units and dropped/returned counters rather than treating character counts as bytes. Discarded output is not recoverable after restart.

## File operations: native CLI semantics

`remote_transfer` addresses targets once (`ssh:<name>`, `ssh:<label>` for a BYO identity, `docker:<name>`, `incus:<name>`, `hub:<machine>`, local paths) and hands the actual transfer to the native CLI. `mode:"copy"|"rsync"` is required and spans only transfer fields. `argv` is an ordered array of native option tokens — one element = one argv token, appended verbatim before the parsed `src`/`dst`. There is no option whitelist, no shell parsing, and no forced defaults: no hidden `--dry-run`, no forced archive/timeout, no automatic verification. A dry run means passing `--dry-run` yourself; unknown or incompatible options fail in the native CLI and its exit code and stderr come back as-is. Success of a native command is never reported as independently verified — `verified:false` on native copy receipts means exactly that.

### copy routes

| Route | Command | Notes |
| --- | --- | --- |
| local↔SSH | `scp` | default SFTP; caller may pass `-O` explicitly |
| SSH↔SSH | `scp -3` (data through the origin) | both identities stay on the origin; differing BYO identities are separated by a temporary origin-only SSH config, removed afterwards. `scp -R` is refused before start: it would authenticate from the source host |
| local↔Docker | `docker cp` | |
| local↔Incus | `incus file push/pull` | |
| other cross-endpoint pairs (SSH↔Docker, Docker↔Incus, …) | two native commands with origin staging | each half takes its own options via `pullArgv`/`pushArgv` (mutually exclusive with `argv`); the receipt states both commands |
| Hub↔local↔local | existing staged archive lane | the only lane where `verify`/`mkdir` apply; it keeps SHA-256 verification and destination-parent creation. CLI-option fields are rejected on this lane |

The native CLIs do not create destination parents or verify results on their own; receipts report each command's exit, stdout/stderr and the sanitized argv. Two-segment routes stage in an origin scratch directory that is removed on normal exit (`cleanup:"released"`); an interrupted channel is reported as `cleanup:"unknown"`.

### rsync routes

rsync supports SSH endpoints (native aliases and BYO identities) with at most one local endpoint. Local↔SSH runs `rsync` on the origin with the endpoint's SSH identity wired through `RSYNC_RSH`; an explicit `-e`/`--rsh` in `argv` replaces that wiring per rsync's own rules (the command must then carry its own port/key/config). Nothing else is injected — no archive, no timeout, no dry-run, no remote owner, no `--rsync-path`.

SSH↔SSH prefers the native forwarding route: the destination runs a temporary loopback-only rsync daemon, `ssh -L` brings it to an origin port, `ssh -R` carries it onto the source's loopback, and the source's own native rsync client performs one protocol conversation through the chain. The origin only forwards rsync protocol bytes; the destination's existing file data feeds real delta matching (`--stats` shows Matched data dominating for a small change on a large file). If an endpoint refuses TCP forwarding (`AllowTcpForwarding no`), a standard-stream route would be attempted; on the current OpenSSH/rsync combination (10.2 / 3.4.1) that route reports itself unavailable — the error says so and nothing is copied. rsync never falls back to a full copy or to Python.

Tool-owned daemons/forwards/SSH sessions are torn down on normal exit and observable cancellation; a lost channel is reported with `cleanup:"unknown"` rather than a false success claim.

### Prerequisites

File operations require the corresponding CLI on the origin (`scp`, `rsync`, `docker`, `incus`) and on the SSH/container endpoints that execute it (`rsync` for rsync routes; none beyond the container's own CLI for docker/incus copy). No remote Python, Node or worker is deployed for file transfers. The dual-SSH forwarding route requires `AllowTcpForwarding` on both endpoints. BYO-PTY is not a file endpoint.

## One-shot command requirements

One-shot SSH commands (native alias or BYO identity; foreground, background, scriptPath and literal stdin) run through ONE native SSH exec: the command executes under bash with a small POSIX wrapper whose TERM/HUP trap kills the command's whole process group, so backgrounded children do not outlive the session teardown. Remote prerequisites: bash (POSIX) — **no Python, no owner/lease protocol, no flock/monotonic clock, no extra sessions**. On normal completion the wrapper's EXIT trap reaps the command's whole process group (backgrounded children included — they neither outlive the call nor hold the channel open), and the exit code passes through verbatim. On timeout/cancellation the local transport dies at once and a dedicated cleanup session reads the pidfile the wrapper left and kills the group (TERM→KILL); sshd delivers no signal to a no-PTY session, so this explicit cleanup is the remote kill path.

Docker/Incus one-shots use the same pure-CLI lane (`docker exec` / `incus exec` with the same wrapper); container prerequisites are the container's own bash. PTY paths are unchanged (`ssh -tt bash`, docker via script(1), incus interactive) and never required Python.
