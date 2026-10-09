# Desktop transport and UID-based reciprocal pairing

2026-10-09. Implements the user's approved desktop adapter direction and revised reciprocal-pairing contract.

## Requirements

- DSH baseline: `0.2.1-alpha.1`. Super and Better retain synchronized letter versions; runtime acceptance used `0.3.0-k`. The user subsequently authorized publication as `0.3.0-e`, the next letter after registry latest `0.3.0-d`.
- Preserve upstream ownership of the desktop carrier, host address, authentication and Connection lifecycle. Route native traffic unchanged; route foreign API requests and WebSocket streams through `/hub` with the active agent parameter.
- Discover the page address and upstream `__DSH_TRANSPORT__.streamBaseUrl` dynamically. Resolve document-relative paths against the document base, preserve custom schemes, and never generalize the rewrite to all loopback hosts. Control-plane exemptions remain native.
- A successful outgoing pair offers its own address, token and Hub UID to the peer without reachability heuristics. The client may supply its page address; old clients fall back to the request Host.
- The receiver checks the offered UID before dialing. Self is skipped; an already authenticated row with that UID keeps its saved endpoint and is re-probed for the current outcome. Distinct loopback instances may pair normally.
- A failed reciprocal dial persists a single incoming row by offered UID, with the offered address/token and gray unreachable state. An unverified UID/address may not expose any agent gateway. A successful authenticated roster must match the expected UID.
- Existing periodic/manual probes recover incoming rows when their endpoint becomes reachable. Retain the row across restarts, deduplicate by UID, preserve existing disabled/exec settings, and never overwrite a healthy pairing with a failed duplicate offer.
- Reciprocal failure never rolls back the initiator's successful outgoing connection. Do not report mutual success without an explicit successful reverse outcome. No address-format warnings or tunnel/proxy feature.
- URLs with unsupported schemes fail at the actual dial adapter and are retained as incoming records, rather than being rejected by a reachability pre-check. UID is identity; native cookie/token verification remains authentication.

- Better's root password gate preserves native token exchange only for the official `profileContext.name === desktop`, because Electron authenticates its Host before GUI boot. The optional launcher fact is read through Cordis's public `get` API; a non-profile composition still works.
- Super's dedicated `/superd/pair-auth` exact WebServer route delegates GET token exchange to native `connection.authorizeIndex`; no copied cookie verifier, no upstream edits. Pairing tries the normal root exchange first and falls back here when a successful root response mints no cookie (the Better password page). Management and roster routes remain cookie-authenticated.

## Verification

Regression tests cover desktop HTTP/WS alignment, custom-scheme relative URLs, controls/native pass-through, UID pre-dial self/duplicate checks, incoming failure persistence, UID mismatch, loopback pairing, concurrent deduplication and recovery. Delivery verification uses the official dual-tarball launcher on PC4999 and dev3. Real Electron acceptance requires an available supported desktop host; a synthetic browser carrier must be labeled as such. No production changes, publish, commit, tag or push are authorized by this task.

After reviewing acceptance, the user separately authorized Git push and npm publication as the next public letter `0.3.0-e`. See the release report; this does not change the pending actual Electron acceptance boundary or authorize production deployment.
