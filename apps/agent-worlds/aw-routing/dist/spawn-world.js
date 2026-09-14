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
import { loadProfile, boot } from '@deepseek-ai/dsh-app-boot';
import { provideCmdline } from '@deepseek-ai/dsh-cmdline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const EMPTY_ROOT = '[]\n';
export async function spawnWorld(opts) {
    const profile = loadProfile(opts.appName, opts.profileName, opts.installAnchor, opts.home);
    // Empty include root: the tree is composed entirely as patch layers
    // (bundle rows in profile order + profile patch + extras).
    writeFileSync(join(profile.dir, 'cordis.yml'), EMPTY_ROOT);
    const patches = [
        ...profile.layers.flatMap((l) => l.patches),
        ...profile.patches,
        ...(opts.extraPatches ?? []),
    ];
    // Bare plugin names resolve from the installation's node_modules (the
    // anchor owns the complete plugin closure). Same cordis on both sides —
    // no cross-copy Symbol split.
    const bareModuleBaseUrl = pathToFileURL(join(opts.installAnchor, '..', 'node_modules', '/')).href;
    // Embedding-host facts via the PUBLIC cmdline API (risk-2 probe: boot owns
    // dshHomePath, so the prepare slot is for OUR provides — cmdlineArgs is not
    // boot-provided and upstream documents the empty-args embedding path).
    // Worlds take no flags and never open a browser; exit = dispose own fiber.
    let fiber;
    const ctxW = await boot(opts.appName, join(profile.dir, 'cordis.yml'), patches, (ctx) => {
        provideCmdline(ctx, {
            args: ['--no-open'],
            exit: () => { void fiber?.dispose(); },
        });
    }, bareModuleBaseUrl);
    fiber = ctxW.fiber;
    return ctxW;
}
