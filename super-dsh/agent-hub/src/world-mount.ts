/**
 * World composition patches for the mount (AW-B DL1/DL3).
 *
 * A mounted world runs with NO listener and provides the virtual webServer
 * from `<pkg>/world`. Three patches make that composition work:
 *
 *   1. `webserver` disabled      — the world owns no socket; ctx0's listener is
 *                                  the only ingress.
 *   2. `modules` inject webServer — client-modules probes
 *      `ctx.get('webServer')` WITHOUT declaring the dependency
 *      (`client/modules/src/index.ts:576`), so without this patch its row
 *      activates before the provider exists and boot fails. Patching the row's
 *      `inject` makes cordis WAIT for the provider, order-independent.
 *   3. insert the world mount row — provides the virtual webServer inside the
 *      world root and translates every route its plugins declare.
 *
 * Patch layers are plain data: the patch engine applies arbitrary entry
 * overrides (`vendor/include/src/index.ts:77-121`).
 */

/** Id of the inserted world-mount row. */
export const WORLD_MOUNT_ROW_ID = 'aw-world-mount'

/** Plugin name providing the world's virtual webServer. */
export const WORLD_MOUNT_PLUGIN = '@pgmi-builds/agent-hub/world'

/** Id of the inserted hub row (the same plugin ctx0 itself composes). */
export const WORLD_HUB_ROW_ID = 'aw-agent-hub'

/** Plugin name of the hub itself — one UI, one roster, every runtime. */
export const WORLD_HUB_PLUGIN = '@pgmi-builds/agent-hub'

/** Id of the inserted page-trust row (world trees; ctx0 composes its own). */
export const WORLD_WEB_TRUST_ROW_ID = 'aw-web-trust'

/** Page-trust component subpath — world pages emit index-inject on their own root. */
export const WORLD_WEB_TRUST_PLUGIN = '@pgmi-builds/agent-hub/web-trust'

/** One patch layer understood by the loader (structural; no app-boot import). */
export type WorldPatchLayer =
  | { id: string; disabled?: boolean; inject?: readonly string[]; config?: Record<string, unknown> }
  | { insert: ReadonlyArray<{ id: string; name: string; config?: Record<string, unknown> }> }

/**
 * The layers that turn a listener-owning world into a mounted one:
 *
 *   1. `webserver` off — the world owns no socket (the hub serves its face);
 *   2. `modules` waits for the virtual `webServer` the entry row provides;
 *   3. the entry row itself (the world's mount identity);
 *   4. the HUB ROW — the same `@pgmi-builds/agent-hub` native ctx0 composes, so
 *      the foreign agent gets the *identical* selector UI, and the roster it
 *      renders is read from the hub over the world's own `/api` channel;
 *   5. the PAGE-TRUST row — the same component ctx0 composes through the
 *      composite bundle, so a trusted non-loopback page (Caddy domain / LAN
 *      IP) keeps its loopback-equivalent verdict in the WORLD's UI too.
 * @param key - runtime key (`omp`, `codex`, …) — the mount label.
 * @returns patch layers to append to the world's composition.
 */
export function worldMountPatches(key: string): readonly WorldPatchLayer[] {
  if (typeof key !== 'string' || key === '' || key.includes('/')) {
    throw new Error(`world-mount: invalid key ${JSON.stringify(key)}`)
  }
  return [
    // 0.1.7 belt-and-braces: the composition provably carries `disabled: true`
    // (SUPERD_TRACE dump), yet the live world audit still saw the row activate
    // and bind the default 3080 — so pin the config to an EPHEMERAL loopback
    // port too (the audited AW fixture shape: loopback-only, never
    // user-facing). Honored disables bind nothing; ignored disables bind a
    // throwaway socket instead of colliding with a real deployment port.
    { id: 'webserver', disabled: true, config: { host: '127.0.0.1', port: 0 } },
    // 0.1.7: with a profileContext provided (settings requires it), the base
    // hmr row ENABLES itself in world trees (`disabled: !!js
    // !ctx.get('profileContext')`) and its config reload then recomposes the
    // tree from the profile layers alone — DROPPING the spawn-time
    // worldMountPatches (webserver re-enabled on 3080, world rows gone).
    // Worlds must stay hmr-less: their composition is a spawn-time fact.
    { id: 'hmr', disabled: true },
    { id: 'modules', inject: ['webServer'] },
    { insert: [
      { id: WORLD_MOUNT_ROW_ID, name: WORLD_MOUNT_PLUGIN, config: { key } },
      { id: WORLD_HUB_ROW_ID, name: WORLD_HUB_PLUGIN },
      { id: WORLD_WEB_TRUST_ROW_ID, name: WORLD_WEB_TRUST_PLUGIN },
    ] },
  ]
}
