/**
 * World composition patches for the mount (AW-B DL1/DL3 → path-separation T-D).
 *
 * A mounted world is a PURE DATA PLANE: no listener (it never had a socket)
 * and since T-D no webui composition either ("disable their webui build, just
 * like disable their webserver" — 2026-09-26 user ruling). The rows that gave
 * the world tree its own web surface are DISABLED here:
 *
 *   1. `webserver` disabled    — the world owns no socket; ctx0's listener is
 *                                the only ingress (pre-T-D posture, kept).
 *   2. `hmr` disabled          — a world's composition is a spawn-time fact;
 *                                the profile-hmr reload chain must never arm.
 *   3. `web-runtime` disabled  — the web-app glue row: it mounted the
 *                                frontend-static fallback owner over the
 *                                virtual server, printed the URL line, opened
 *                                the browser, and registered the web-surface
 *                                prompt section. Its ONE data-plane leg — the
 *                                `webRuntime` values the `connection` row
 *                                injects — moved into the world mount row
 *                                (neutral facts, see `world-entry.ts`).
 *   4. `client-hmr` disabled   — the client-plugin reload chain; nothing ever
 *                                loads a world page to reload.
 *   5. `modules` still waits   — the client-modules row (and any other row
 *                                that injects `webServer`) binds against the
 *                                VIRTUAL per-world server the mount row
 *                                provides; the virtual server swallows every
 *                                registration (T-C), so the tree boots
 *                                unchanged while nothing is ever served.
 *   6. insert the world rows   — the mount row (virtual `webServer` + neutral
 *                                `webRuntime` provider) and the HUB row (the
 *                                `/api/agent-runtime` face /hub can reach
 *                                through the world's own data plane). The
 *                                world page-trust row is GONE (T-D): its only
 *                                consumer was the world page.
 * Patch layers are plain data: the patch engine applies arbitrary entry
 * overrides (`vendor/include/src/index.ts:77-121`).
 */

/** Id of the inserted world-mount row. */
export const WORLD_MOUNT_ROW_ID = 'superd-world-mount'

/** Plugin name providing the world's virtual webServer. */
export const WORLD_MOUNT_PLUGIN = '@pgmi-builds/superd-hub/world'

/** Id of the inserted hub row (the same plugin ctx0 itself composes). */
export const WORLD_HUB_ROW_ID = 'superd-hub'

/** Plugin name of the hub itself — one UI, one roster, every runtime. */
export const WORLD_HUB_PLUGIN = '@pgmi-builds/superd-hub'

/**
 * Parse the deploy-level trusted-authority list the world's connection fence
 * was seeded with (`SUPERD_TRUSTED_HOSTS`, whitespace/comma separated) — the
 * same values `spawnWorld` feeds the world tree as `--trusted-host` extras.
 * Shared so the fence facts keep a single derivation.
 */
export function superdTrustedHosts(value: string | undefined): string[] {
  return (value ?? '').split(/[\s,]+/).filter(Boolean)
}

/** One patch layer understood by the loader (structural; no app-boot import). */
export type WorldPatchLayer =
  | { id: string; disabled?: boolean; inject?: readonly string[]; config?: Record<string, unknown> }
  | { insert: ReadonlyArray<{ id: string; name: string; config?: Record<string, unknown> }> }

/**
 * The layers that turn a listener-owning world into a mounted, webui-less
 * data plane:
 *
 *   1. `webserver` off — the world owns no socket (the hub serves its face);
 *   2. `hmr` off — the composition is a spawn-time fact;
 *   3. `web-runtime` off — no frontend-static mount, no URL line, no browser
 *      handoff, no web-surface prompt (T-D; its `webRuntime` provider moved
 *      into the mount row);
 *   4. `client-hmr` off — no client reload chain (T-D);
 *   5. `modules` waits for the virtual `webServer` the mount row provides;
 *   6. the world rows: the mount (virtual `webServer` + neutral `webRuntime`)
 *      and the hub (`/api/agent-runtime` face on the world's data plane).
 * @param key - runtime key (`omp`, `codex`, …) — the mount label.
 * @returns patch layers to append to the world's composition.
 */

/**
 * Wave-1 of world composition minimization (spec
 * docs/specs/world-composition-minimization): native-agent machinery the
 * foreign runtimes replace. Dependency-cleared 2026-09-27 against the KEEP
 * set (api controllers, session core, adapters' agents/sessions/llm/
 * agentDefaultModel/settings/agentPresets). Wave-2 candidates (client-ui
 * family, tools, bash-sandbox, terminal-controller, …) live in the spec,
 * NOT here.
 */
export const WORLD_WAVE1_DISABLED_ROWS: readonly string[] = [
  'agent-loop',
  'mcp-resources',
  // skills
  'skill', 'skill-filesystem', 'skill-badge', 'tool-skill', 'ui-skill',
  // jobs
  'jobs', 'tool-jobs', 'ui-jobs', 'job-controller',
  // subagents
  'subagent', 'subagent-spawn-in-process', 'subagent-fork-in-process',
  'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
  'tool-subagent-fork', 'tool-subagent-codex', 'tool-subagent-claude-code',
  'subagent-model-selection-settings', 'ui-subagent', 'ui-settings-subagent',
  'ui-settings-agent-loop',
]

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
    // T-D (2026-09-26): the world webui rows off. The `web-runtime` row is the
    // web-app glue that mounted frontend-static over the virtual server and
    // announced a URL nobody can reach (`/hub` is the sole entry); the world
    // keeps only its data plane. Its `webRuntime` provider — the ONE
    // data-plane leg (the `connection` row injects it) — is re-provided by the
    // mount row with the same neutral facts (loopback bind ⇒ no LAN
    // literals; the deploy-level trusted-host extras ride along).
    { id: 'web-runtime', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'modules', inject: ['webServer'] },
    { insert: [
      { id: WORLD_MOUNT_ROW_ID, name: WORLD_MOUNT_PLUGIN, config: { key } },
      { id: WORLD_HUB_ROW_ID, name: WORLD_HUB_PLUGIN },
    ] },
    // Wave-1 minimization: the foreign runtimes replace the native agent
    // machinery — these rows never mount in a world tree.
    ...WORLD_WAVE1_DISABLED_ROWS.map((id) => ({ id, disabled: true })),
  ]
}
