/**
 * spawnWorld (S2): spawn a sibling ROOT context for a foreign agent world
 * from the CTX0 tree — the library form of the PoC (ADR 0008 mechanism,
 * .scratch/multi-context-poc/spawner2.mjs collapsed into a function).
 *
 * AW-A posture: SHARED home (ADR 0008 constraint 2 fallback). The ctxN
 * `dshHomePath` service override is an AW-C1 item (spec §三/§十一.2) — the
 * boot() provide/prepare ordering fact is pinned by
 * test/boot-prepare-ordering.test.mjs. Data detachment at this stage comes
 * from the adapter side (foreign app-home redirection, spec §七).
 *
 * Profile resolution: loadProfile(name, profileName, installAnchor, home)
 * reads profiles under `<home>/profiles/<profileName>` and heals the
 * `@deepseek-ai/*` fallback farm into `<home>/profiles/node_modules` from
 * the install anchor (single instance — same physical installation).
 */
import { boot } from '@deepseek-ai/dsh-app-boot';
export interface SpawnWorldOptions {
    /** App name for the spawned root (also its fiber label). */
    appName: string;
    /** Profile directory name under `<home>/profiles/`. */
    profileName: string;
    /** package.json of the @deepseek-ai installation that owns the bundle closure. */
    installAnchor: string;
    /** The (shared) DSH home — resolved by the caller from the host tree, never process.env inside plugins. */
    home: string;
    /** Extra patch layers appended after the profile's own (e.g. an adapter's insert row). */
    extraPatches?: Parameters<typeof boot>[2];
}
export declare function spawnWorld(opts: SpawnWorldOptions): Promise<import("@deepseek-ai/cordis").Context>;
