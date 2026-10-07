/**
 * Where the omp-sdk world lives on disk.
 *
 * The world home is `<dshHome>/agents/omp-sdk` — the SAME derivation the world
 * plugin (`world-plugin.ts`) uses, kept in one pure function so the adapter's
 * lazy runtime fetch lands exactly where `provisionWorldProfile` provisioned
 * the world.
 *
 * `resolveDshHome()` (the harness resolver: `$DSH_HOME` → `~/.dsh`) is used
 * rather than a bare `process.env.DSH_HOME` read — a consumer install has no
 * DSH_HOME exported, and the bare read resolves to the wrong tree (recorded
 * pit in the RPC line's AGENTS.md §五). Nothing here touches the filesystem:
 * the caller only ever writes through the runtime bootstrap, which is reached
 * from the first real prompt.
 */
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { join } from "node:path";

/** The roster/world key — also the directory name under `agents/`. */
export const OMP_SDK_WORLD_KEY = "omp-sdk";

/** `<dshHome>/agents/omp-sdk`. */
export function resolveOmpSdkWorldHome(dshHome: string = resolveDshHome()): string {
  return join(dshHome, "agents", OMP_SDK_WORLD_KEY);
}
