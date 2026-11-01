# ADR 0015 — Independent bundles and Agent-owned remote tools

Status: accepted design (2026-10-10); consumer acceptance tracked separately. The
companion-install and Super remote-tool-row legs are superseded by
[ADR 0016](0016-two-independent-packages-no-companion.md) (2026-11-02); the
Better-owned remote tools and the hub-target integration are retained.

## Context

The October 9 user decision supersedes ADR 0014's npm dependency architecture. Better Dash and Super Dash are independent native DSH bundles at synchronized versions. Their independent disable/uninstall choices must remain meaningful.

## Decision

- Super has no Better npm dependency, optional dependency or peer edge. The native Plugin Manager companion operation requests `better-dsh@<installed Super version>`, then `latest`, then the bare name. Existing installation and user choices are preserved; Super upgrade does not reinstall a removed companion. The same native operation serves Settings explicit installation.
- `better-dsh/src/remote/` is the sole editable enhanced-remote source. The build generates Super's self-contained `remote/` ESM/declarations and source SHA-256 provenance, exposed by `super-dsh/remote`. This narrow exception carries neither the Better bundle, client, other tools nor a runtime dependency on Better. Host modules remain external optional peers and single-instance.
- Both remote rows default on. Official Agent creation events allow the first enabled row to own registration for that Agent instance. A loser does not retry. Winner unload cleans its Agent resources; it does not trigger automatic hot takeover. New Agent creation and cold resume can compete again.
- Hub is optional and independent of native remote registration. Hub-body authenticated executors do not depend on the model-facing remote row. No machine availability poller or second background job registry is introduced.

## Consequences and verification

Pack validation covers exports, generated closure/provenance, host externalization, and absence of Better payload/dependency edges. Consumer acceptance must additionally exercise Super's worker while Better is absent, independent Plugin Manager transitions, actual tools and model-visible recovery guidance. Source tests or mounted plugin rows are not substitutes.

See [the feature specification](../specs/remote-tool-enhancement/spec.md), [delivery guide §8](../07-cordis-dsh-dev-test-guides.md#8-better-dash-双构建与原生-companion-交付2026-10-09-再修订), and the dated acceptance report. ADR 0014 and its historical reports are preserved as evidence of the former design.


### 2026-10-10 consumer worker delivery correction

The generated Super `remote/` contains exactly `plugin.js`, `plugin.d.ts`, private `file-worker.js`, and `provenance.json`. The worker leaf is built solely from canonical `better-dsh/src/remote/file-worker.ts`, has Node-builtins-only imports, and is hashed/checked with the closure. It has no public package export, host peer imports, duplicated host modules, source loader or Better dependency. The public plugin contract remains unchanged. The existing owned child-process/group cleanup remains the receiver boundary; no worker-thread lifecycle replacement. This narrow extra generated leaf fixes actual installed receiver resolution, not a general guarantee that host plugins import outside their host resolver.

### Receiving ownership and two-remote byte route (Rulings22–25)

SSH and canonical Docker/Incus oneshots share the portable receiving gate/control/work owner, preserving official jobs and Agent/plugin ownership. Container helpers additionally self-enable unprivileged child-subreaping before work to reap only their own/adopted descendants. Actual receiving helper/group cleanup precedes settlement; unavailable final transport drain is diagnosed honestly. Prerequisites and three-startup cost are explicit in the tool Surface.

Ruling25 supersedes the original two-remote source -R/private-master/sshd-FD/pidfd design after actual default dev3 source failed its permission requirement. A task-owned portable Python loopback proxy, inside the existing receiving helper/group/lease, carries bounded binary frames over authenticated SSH work stdio to an origin TCP bridge into the destination -L tunnel. A real full-route @RSYNCD greeting precedes business admission. No source Linux /proc, pidfd, privileged sshd access or source forwarding permission is required; native find, native rsync and the existing portable Bash/Python/fcntl/shared-monotonic prerequisites remain. No origin Python, credentials on peers, copy fallback, lease increase or second registry. Five-byte type/length frames cap data at64KiB and Python queues at256KiB; one active connection, real backpressure and half-close, prior reader/socket close before next OPEN. Ordinary two-remote transfer measures12 SSH startups: source preflight+inspection clock/work3, relay source/destination preflight2, destination clock/daemon+tunnel2, source proxy clock/owner/work3, native source rsync clock/work2. Fault recovery adds only task-owned authenticated cleanup reconnects, never transfer retries. Same real helper/listener/group/metadata/tunnel/socket cleanup barrier; receiving progress remains an explicit assumption. Historical M permission failure remains in the acceptance report; current default-dev3-source source test passes, installed next-artifact proof is separate.


### CLI binary receiving ownership (consumer correction, Ruling26)

Actual N native SSH copy cancellation settled while the remote import process and its unnamed staging file remained live under a finite work-channel EOF hold. CLI export/import/digest now reuse the canonical portable receiving owner, with raw binary work streams and the same counted lease, admission gate and authenticated recovery. Cancellation/failure waits for receiving helper/group/temp cleanup before local transport teardown/settlement. Normal success must completely drain the binary stream; the oneshot text lane's 2500ms incomplete-output rule does not apply. Archive validation, selected manifest digests, merge/no-delete behavior and canonical SSH identity/ProxyJump are unchanged. Local and Hub file lanes are unchanged.

This intentionally replaces the former Python-only minimum for CLI peers: Bash4.1+, Python3.7+ (macOS3.10+), Unix fcntl.flock/shared non-adjustable cross-process monotonic clock, mktemp/mv/rm/sleep; Linux containers also need stdlib ctypes and permitted unprivileged PR_SET_CHILD_SUBREAPER. No rsync or origin Python requirement, auto-install, second registry, fallback, peer polling or increased lease. Minimal Python-only peers no longer support this CLI lane; use a supported peer or authenticated Hub.

Each remote export/import/digest costs three native transport starts: clock, independent owner/control, literal binary work. Thus verified local→CLI or CLI→local costs six; CLI→CLI twelve. verify:false skips digest operations, reducing counts to three/three/six. Local/Hub operations do not contribute CLI starts. Fault recovery may add same-identity authenticated cleanup starts and may remain pending until genuine cleanup observation is possible. Artifact O must re-prove installed cancellation and complete binary integrity; N failures remain historical evidence.
