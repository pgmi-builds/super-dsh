# Remote tools

Better Dash and Super Dash each provide the native `remote` tool and REPL route. The first enabled provider owns each Agent; unloading it does not hot-transfer ownership. Start a new Agent or cold-resume after changing providers. Super works without Better; Hub transport is optional. See [ADR 0015](adr/0015-independent-bundles-agent-remote.md).

## Choose a call

| Goal | Input |
| --- | --- |
| List locally known targets without dialing | `{}` |
| Probe one target | `{target:"ssh:alias"}` |
| Register an Agent-local SSH identity | `{target:"byossh:build",ssh:{host:"host",user:"user",key:"/origin/key"}}` |
| Stateless command and stdin | `{target:"byossh:build",cmd:"cat",stdin:"hello"}` |
| Stream a local script to fixed `bash -s` | `{target:"ssh:alias",script:"/absolute/script.sh"}` |
| Persistent shell | `{target:"ssh:alias",mode:"pty",cmd:"cd /tmp; export CHECK=ready"}` |
| Official background job | `{target:"ssh:alias",cmd:"long-command",run_in_background:true}` |
| Native CLI copy | `{action:"copy",src:"/absolute/source",dst:"ssh:alias:/absolute/destination",argv:["-p"]}` |
| Native rsync | `{action:"rsync",src:"/absolute/source/",dst:"ssh:alias:/existing/destination/",argv:["-a","--partial","--dry-run"]}` |

`script` cannot combine with cmd/stdin/spawn/PTY. Direct local command execution is not provided; use native local shell tools. Background jobs are oneshot-only, require the official jobs service/controller, and are read/killed with `job_output`/`job_kill`; they have no default foreground timeout. An explicit timeout still applies. SSH keys/config stay on the origin; BYO identities are not persisted across new/cold Agents. PTY backlog recovery and live probes are not part of this release.

Native/PTY output retains at most 4,000,000 UTF-16 units per stream; Hub oneshot retains 4 MiB bytes. Normal returned tails are smaller. Read `outputStats` units and dropped/returned counters rather than treating character counts as bytes. Discarded output is not recoverable after restart.

## File operations: native CLI semantics

`remote` addresses targets once (`ssh:<name>`, `byossh:<label>`, `docker:<name>`, `incus:<name>`, `hub:<machine>`, local paths) and hands the actual transfer to the native CLI. `argv` is an ordered array of native option tokens — one element = one argv token, appended verbatim before the parsed `src`/`dst`. There is no option whitelist, no shell parsing, and no forced defaults: no hidden `--dry-run`, no forced archive/timeout, no automatic verification. A dry run means passing `--dry-run` yourself; unknown or incompatible options fail in the native CLI and its exit code and stderr come back as-is. Success of a native command is never reported as independently verified — `verified:false` on native copy receipts means exactly that.

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

rsync supports SSH/byossh endpoints with at most one local endpoint. Local↔SSH runs `rsync` on the origin with the endpoint's SSH identity wired through `RSYNC_RSH`; an explicit `-e`/`--rsh` in `argv` replaces that wiring per rsync's own rules (the command must then carry its own port/key/config). Nothing else is injected — no archive, no timeout, no dry-run, no remote owner, no `--rsync-path`.

SSH↔SSH prefers the native forwarding route: the destination runs a temporary loopback-only rsync daemon, `ssh -L` brings it to an origin port, `ssh -R` carries it onto the source's loopback, and the source's own native rsync client performs one protocol conversation through the chain. The origin only forwards rsync protocol bytes; the destination's existing file data feeds real delta matching (`--stats` shows Matched data dominating for a small change on a large file). If an endpoint refuses TCP forwarding (`AllowTcpForwarding no`), a standard-stream route would be attempted; on the current OpenSSH/rsync combination (10.2 / 3.4.1) that route reports itself unavailable — the error says so and nothing is copied. rsync never falls back to a full copy or to Python.

Tool-owned daemons/forwards/SSH sessions are torn down on normal exit and observable cancellation; a lost channel is reported with `cleanup:"unknown"` rather than a false success claim.

### Prerequisites

File operations require the corresponding CLI on the origin (`scp`, `rsync`, `docker`, `incus`) and on the SSH/container endpoints that execute it (`rsync` for rsync routes; none beyond the container's own CLI for docker/incus copy). No remote Python, Node or worker is deployed for file transfers. The dual-SSH forwarding route requires `AllowTcpForwarding` on both endpoints. BYO-PTY is not a file endpoint.

## One-shot command requirements

One-shot SSH/byossh commands (foreground, background, script and literal stdin) run through ONE native SSH exec: the command executes under bash with a small POSIX wrapper whose TERM/HUP trap kills the command's whole process group, so backgrounded children do not outlive the session teardown. Remote prerequisites: bash (POSIX) — **no Python, no owner/lease protocol, no flock/monotonic clock, no extra sessions**. On normal completion the wrapper's EXIT trap reaps the command's whole process group (backgrounded children included — they neither outlive the call nor hold the channel open), and the exit code passes through verbatim. On timeout/cancellation the local transport dies at once and a dedicated cleanup session reads the pidfile the wrapper left and kills the group (TERM→KILL); sshd delivers no signal to a no-PTY session, so this explicit cleanup is the remote kill path.

Docker/Incus one-shots use the same pure-CLI lane (`docker exec` / `incus exec` with the same wrapper); container prerequisites are the container's own bash. PTY paths are unchanged (`ssh -tt bash`, docker via script(1), incus interactive) and never required Python.
