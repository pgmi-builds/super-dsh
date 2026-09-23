/**
 * Antigravity preset registration — the profile's one fixed Agent preset.
 *
 * 0.1.7 alignment (upstream split `dsh-agent-presets` into `dsh-agent-preset`
 * + `dsh-agent-preset-registry` and moved roster, selection, document RPC and
 * the `agentPreset` session projection into the host `AgentPresetRegistry`,
 * mounted by the dsh-web-app bundle's `agent-preset-registry` row): the
 * adapter no longer implements the `agentPresets` service — the 0.1.6
 * SingleAgyPresetRoster and its own projection fold are retired. It only REGISTERS the
 * single fixed preset into the host registry.
 *
 * Antigravity is single-mode: the foreign agent drives its own tools, so no
 * Dash-side preset composition exists to choose from. The preset's
 * composition deliberately mounts nothing.
 */
import type { Context } from "@deepseek-ai/cordis";
// Type-only: pulls the agentPreset domain augmentations into this program's
// view (RemoteErrorDetailsMap `agent-preset/*` keys, SessionEventMap
// `agent-preset/selected`, SessionProjectionStateMap/SessionProjectionMap
// `agentPreset`).
import type {} from "@deepseek-ai/dsh-agent-preset-registry/types";
import type { PresetDefinition } from "@deepseek-ai/dsh-agent-preset-registry";

export const AGY_PRESET_ID = "agy";

/** The single fixed Antigravity preset: mounting it composes nothing. */
export const AGY_PRESET: PresetDefinition = Object.freeze({
  id: AGY_PRESET_ID,
  name: "Antigravity",
  description: "Google Antigravity (Gemini) via the agent-agy adapter",
  plugins: Object.freeze([]),
});

/**
 * Register the fixed preset into the host `AgentPresetRegistry` once the
 * service is up. Registration failure keeps the roster row visible as
 * `broken` inside the registry (upstream owns that lifecycle) — the adapter
 * only owns the disposer.
 */
export function registerAntigravityPreset(ctx: Context): void {
  ctx.inject(["agentPresets"], (scoped: Context) => {
    let dispose: (() => Promise<void>) | undefined;
    let settled = false;
    void scoped.agentPresets.register(AGY_PRESET).then((unregister) => {
      if (settled) {
        void unregister();
      } else {
        dispose = unregister;
      }
    });
    ctx.effect(() => async () => {
      settled = true;
      await dispose?.();
    }, "agyAdapter.preset");
  });
}
