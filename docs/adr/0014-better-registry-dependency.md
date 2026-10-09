# Better Dash as an exact registry dependency

Accepted by user direction on 2026-10-09; supersedes the Better physical embedding part of the 2026-10-08 merged delivery decision. Pi and adapter delivery are outside this decision.

Super declares Better as an ordinary synchronized exact npm dependency. One user install fetches both registry packages. Better files/archives never ship in Super. Independent native bundle identities remain because users manage tools and foreign agents separately.

The current host neither recursively registers transitive bundles nor exposes them as installed direct packages. Retain native offline registration after the user install; it consumes the already downloaded exact package, preserves native locks/compatibility/restart boundaries and user disablement/removal, and never invokes install hooks or a second registry fetch. Native Code source truthfully becomes an exact Better registry spec. The automatic offline local package operation is a host limitation, not an extra user installation command.

Build both from current local source. Test-only read-only registry serves these unmodified unpublished artifacts; no public publish until the current release is authorized. Ship Better before Super so its exact dependency is available at installation time. Existing cache and user data remain untouched.

Plain npm consumers use their npm lock/cache: when the exact package is already hoisted, registration updates profile and npm lock root metadata only. A conflicting previous direct Better uses native package operations with npm offline, rather than attempting to reuse a missing pnpm store. pnpm consumers retain the native offline install path.
