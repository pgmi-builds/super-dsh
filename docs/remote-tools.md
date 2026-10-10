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
| Binary file/tree copy | `{action:"copy",src:"/absolute/source",dst:"ssh:alias:/absolute/destination",verify:true,mkdir:true}` |
| Preview native SSH delta sync | `{action:"rsync",src:"/absolute/source/",dst:"ssh:alias:/existing/destination/",dryRun:true,delete:false}` |

`script` cannot combine with cmd/stdin/spawn/PTY. Direct local command execution is not provided; use native local shell tools. Background jobs are oneshot-only, require the official jobs service/controller, and are read/killed with `job_output`/`job_kill`; they have no default foreground timeout. An explicit timeout still applies. SSH keys/config stay on the origin; BYO identities are not persisted across new/cold Agents. PTY backlog recovery and live probes are not part of this release.

Native/PTY output retains at most 4,000,000 UTF-16 units per stream; Hub oneshot retains 4 MiB bytes. Normal returned tails are smaller. Read `outputStats` units and dropped/returned counters rather than treating character counts as bytes. Discarded output is not recoverable after restart.

## File safety and prerequisites

Copy supports local, SSH/byossh, Docker, Incus and authenticated Hub binary transports, not arbitrary BYO-PTY shells. CLI endpoints require the receiving-owner prerequisites below; Hub uses native Node. Copy fully stages on the origin before delivery, merges directories without deleting extras, and verifies SHA-256 over transferred entries only. `verify:false` skips the independent verification claim. Successful staging is removed; failure receipts identify retained diagnostic payload. Unsafe archive paths/types and symlink escapes (including preserved destination ancestors) are rejected.

Rsync is SSH-only (one endpoint may be local), with no copy fallback. Dry-run is the default; deletion is opt-in. The origin needs Bash/native rsync. SSH peers need Bash ≥4.1, Python ≥3.7 (macOS ≥3.10), Unix `fcntl.flock`, and a shared non-adjustable cross-process monotonic clock. Nothing auto-installs prerequisites. Two-remote source additionally needs native `find`. Its task-owned Python loopback proxy uses authenticated SSH stdio and an origin bridge into the destination `-L` tunnel; no source remote-forwarding permission, Linux `/proc`, pidfd or privileged sshd access is required. The full route must produce a real rsync greeting before transfer; no origin Python prerequisite is added. A normal two-remote operation uses 12 SSH startups (prerequisite/inspection, destination daemon+tunnel, source proxy owner/work and native sender); ambiguous admission can add authenticated cleanup reconnects, never transfer retries.

Two-remote relay uses an existing non-symlink destination directory; unsupported file/new/ambiguous paths and source symlinks are refused before transfer. Ordinary local↔SSH legs retain native path/link semantics. Native rsync stats/itemized changes report real delta behavior. Cancellation/disposal waits for owned cleanup. A startup channel lost before receipt may require restored authenticated connectivity to observe cleanup; recovery never restarts the transfer. Ordinary receiver progress is required, not a hard-real-time guarantee on a frozen host.

Hub addresses use `hub:<machine-id>` only when the optional provider is present; paired remote machines never mean self. Hub errors do not fall back to SSH. The runtime tool description carries the detailed current call and recovery contract.

### Owned SSH command requirements

Foreground/background SSH and BYO-SSH oneshots, including scripts and literal stdin, use the same portable receiving owner. Remote requirements are Bash 4.1+, Python 3.7+ (macOS 3.10+ for the shared cross-process monotonic epoch), Unix `fcntl.flock`, and `mktemp`, `mv`, `rm`, `sleep`. Ordinary commands do **not** require rsync. No origin Python or Linux/pidfd requirement is added; PTY/BYO-PTY is unchanged.

Each oneshot uses three SSH startups: clock-only prerequisite, receiving control owner, and the work channel with untouched stdin/stdout/stderr. Native connection identity, port, key and ProxyJump stay canonical; agent forwarding and reusable multiplexing are disabled for these owned connections. Cleanup waits for the receiving helper and work process group, not merely local SSH exit. The existing 8-second receiving lease, counted 2-second renewals and 3.5-second ordinary-scheduling cleanup allowance also cover the gate. Ambiguous lost startup needs an authenticated same-identity observer; restore connectivity if cleanup observation remains pending. This assumes a progressing receiver, not hard real-time scheduling.

After cleanup proof the separate work stream gets up to 2500ms for final drain. If unavailable, the result explicitly diagnoses potentially incomplete output; counters only count received data. A successful normal completion drains the full work stream. No new registry, availability poller or job completion notifier is introduced.

### Container oneshot ownership

Docker/Incus oneshots require the same Bash/Python/fcntl/shared-monotonic/core-utility receiver prerequisites and three native exec startups. Linux containers also require Python stdlib ctypes and permitted unprivileged PR_SET_CHILD_SUBREAPER; the helper reaps only its own/adopted descendants before settlement, including ordinary non-reaping PID1 containers. Nothing installs or changes images, privileges or configuration. PTY is unchanged.


### CLI binary receiving ownership (consumer correction, Ruling26)

Actual N native SSH copy cancellation settled while the remote import process and its unnamed staging file remained live under a finite work-channel EOF hold. CLI export/import/digest now reuse the canonical portable receiving owner, with raw binary work streams and the same counted lease, admission gate and authenticated recovery. Cancellation/failure waits for receiving helper/group/temp cleanup before local transport teardown/settlement. Normal success must completely drain the binary stream; the oneshot text lane's 2500ms incomplete-output rule does not apply. Archive validation, selected manifest digests, merge/no-delete behavior and canonical SSH identity/ProxyJump are unchanged. Local and Hub file lanes are unchanged.

This intentionally replaces the former Python-only minimum for CLI peers: Bash4.1+, Python3.7+ (macOS3.10+), Unix fcntl.flock/shared non-adjustable cross-process monotonic clock, mktemp/mv/rm/sleep; Linux containers also need stdlib ctypes and permitted unprivileged PR_SET_CHILD_SUBREAPER. No rsync or origin Python requirement, auto-install, second registry, fallback, peer polling or increased lease. Minimal Python-only peers no longer support this CLI lane; use a supported peer or authenticated Hub.

Each remote export/import/digest costs three native transport starts: clock, independent owner/control, literal binary work. Thus verified local→CLI or CLI→local costs six; CLI→CLI twelve. verify:false skips digest operations, reducing counts to three/three/six. Local/Hub operations do not contribute CLI starts. Fault recovery may add same-identity authenticated cleanup starts and may remain pending until genuine cleanup observation is possible. Artifact O must re-prove installed cancellation and complete binary integrity; N failures remain historical evidence.
