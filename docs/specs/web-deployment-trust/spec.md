# Web deployment trust

2026-10-09 user instruction: align PC and dev3 systemd deployment with official trusted-host CLI flags and no Caddy Host/Origin replacements. Apply the same mechanism to test rigs: declare the direct machine IP plus the test port; `test.pc.internal.test` belongs only to port 4999. Extra explicitly configured test authorities remain additive.

- PC production declares `dsh.pc.internal.test`; dev3 declares `dsh.dev3.internal.test`.
- PC and dev3 production Caddy blocks transparently reverse proxy their existing 3080 upstreams. PC test domain transparently proxies its existing 4999 upstream. Other sites, including 3081, remain outside this change.
- Test launcher derives the existing primary machine IP (`LAN_IP`) and declares `IP:port`. Port 4999 additionally declares `test.pc.internal.test`. `SUPERD_TEST_TRUSTED_HOSTS` adds deployment-specific authorities.
- Repeat profile rebuilds retain the coordinator's already registered Better dependency and independent bundle enablement, rather than inadvertently representing a user removal while keeping its delivery receipt. First consumption still relies on the shipped coordinator. Only loopback relay mode requires socat.
- Preserve production and test user data, credentials, settings, sessions, installation anchors, consumer choice, and bind policy. Reuse accepted 0.3.0-c artifact pairs via the existing verified-artifact launcher option.
- Keep Better's delivered authentication-only admission behavior unchanged. CLI declarations support the native fence when that policy is absent; explicit flags do not imply a listener bind or replace authentication.
- Public URL advertisement remains a separate optional CLI setting, explained with a remote-browser example; this instruction does not request enabling it.
- Acceptance: inspect actual process flags and live proxy configuration; authenticated actual-domain session and directory calls plus WebSocket/UI; direct LAN tests for PC rigs; dev3 test via its existing review tunnel because its public test port is not firewall-open. Retain test URLs for user acceptance.
- No package version change, publish, commit or push is part of this operational alignment.
