# Authentication-only web trust deployment

2026-10-07 user authorized aligning Super D with dashr latest web-trust, releasing 0.1.12 and updating/restarting both PC/dev3 production services.

- Align authentication-only server admission and browser ownership with dashr physical HEAD fe3c99a. Use native Connection.requestRejection / authorizeIndex public APIs; preserve native cookie verification, authority binding and lifetime.
- Shipped composite row enables trustAllHosts. No host/trusted-host CLI arguments, trust-specific environment or manual profile address patches required. Listening sockets retain native defaults / existing proxy topology.
- Test launcher must consume the shipped capability without its own row override. Verify arbitrary Host/Origin with authentic cookies and reject unauthenticated requests; verify the emitted browser script precedes the app/fusion script.
- Release includes the previous authorized adapter repairs already tested on both whole-pack lines. Preserve old corrupt logs and native user data.
- Verify tarball locally at 4999 and on dev3; record evidence before commit/push/publish. This message explicitly authorizes npm publish 0.1.12.
- Install registry 0.1.12 into both real .dsh/profiles/web; back up profile manifest/lock/patch and user service units first. Remove only obsolete trust options/overrides, retain unrelated configuration, reload and restart both dsh.service units, verify health and new behavior. Keep 4999 alive.
