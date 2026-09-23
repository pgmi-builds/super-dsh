/**
 * OMP preset registration — the profile's one fixed Agent preset.
 *
 * 0.1.7 alignment (upstream split `dsh-agent-presets` into `dsh-agent-preset`
 * + `dsh-agent-preset-registry` and moved roster, selection, document RPC and
 * the `agentPreset` session projection into the host `AgentPresetRegistry`,
 * mounted by the dsh-web-app bundle's `agent-preset-registry` row): the
 * bridge no longer implements the `agentPresets` service — the 0.1.6
 * SingleOmpPresetRoster and its own projection fold are retired. It only
 * REGISTERS the single fixed preset into the host registry.
 *
 * OMP is single-mode: the OMP agent drives its own tools through its RPC
 * process, so no Dash-side preset composition exists to choose from. The
 * preset's composition deliberately mounts nothing — mounting it composes
 * nothing, exactly the rosterless behavior the provider runs on. Side benefit
 * over the 0.1.6 disabled-row posture: `pluginInventory/list` works again
 * (the registry provides `compositionInventory`, which the stock plugin
 * inventory page calls unconditionally).
 */
import type { Context } from "@deepseek-ai/cordis";
// Type-only: pulls the agentPreset domain augmentations into this program's
// view (RemoteErrorDetailsMap `agent-preset/*` keys, SessionEventMap
// `agent-preset/selected`, SessionProjectionStateMap/SessionProjectionMap
// `agentPreset`).
import type {} from "@deepseek-ai/dsh-agent-preset-registry/types";
import type { PresetDefinition } from "@deepseek-ai/dsh-agent-preset-registry";

export const OMP_PRESET_ID = "omp";

/** The single fixed OMP preset: mounting it composes nothing. */
export const OMP_PRESET: PresetDefinition = Object.freeze({
  id: OMP_PRESET_ID,
  name: "OMP",
  description: "OMP agent via the omp-web bridge",
  plugins: Object.freeze([]),
});

/**
 * Register the fixed preset into the host `AgentPresetRegistry` once the
 * service is up. Registration failure keeps the roster row visible as
 * `broken` inside the registry (upstream owns that lifecycle) — the bridge
 * only owns the disposer.
 */
export function registerOmpPreset(ctx: Context): void {
  ctx.inject(["agentPresets"], (scoped: Context) => {
    let dispose: (() => Promise<void>) | undefined;
    let settled = false;
    void scoped.agentPresets.register(OMP_PRESET).then((unregister) => {
      if (settled) {
        void unregister();
      } else {
        dispose = unregister;
      }
    });
    ctx.effect(() => async () => {
      settled = true;
      await dispose?.();
    }, "ompProvider.preset");
  });
}
