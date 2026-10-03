/**
 * Codex-backed `LlmAdapter` registered on `ctx.llm` by the Codex provider.
 *
 * The browser model selector never touches the Codex agent directly: it is an
 * RPC round-trip through the apiproxy, which reads `ctx.llm.listProviders /
 * listModels / resolveModelInfo` to build the catalog. This adapter answers
 * those queries from the ADAPTER's canonical provider store
 * (`codex-providers.ts`), registering ONE ROUTE PER CONFIGURED PROVIDER.
 *
 * That one-route-per-provider shape is the 2026-10-04 rework, and it is what
 * makes the whole feature DSH-native: the harness's own model selector already
 * renders a provider-grouped catalog, already keeps the choice per session
 * (`session/selectModel` → the durable `model/selection` event + the
 * `modelSelection` projection), and already reports which route a session last
 * used. Registering the Codex providers as real routes means Super D gets all
 * of that by construction instead of re-implementing it — there is no "active
 * provider" left for the UI to hold.
 *
 * `stream` is never dispatched: Codex owns generation through its app-server
 * thread (`CodexAgent`), so the adapter only serves catalog/metadata queries.
 * It throws rather than fabricating a wire route the harness would misuse.
 *
 * @module agent-codex/adapter
 */

import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { readProviderStore, type CodexProviderEntry, type CodexProviderStore } from "./codex-providers.js";

/**
 * The single route every Codex model was served under before the multi-provider
 * rework. No longer registered (a session pinned to it falls back to whatever
 * the native `config.toml` runs), but kept as the one named constant so the
 * legacy value is greppable in session logs.
 */
export const CODEX_PROVIDER_ID = "codex";

/** Whether a provider may be registered as a model route. */
export function routableProvider(entry: CodexProviderEntry): boolean {
  return entry.models.length > 0;
}

/** The route ids a store currently contributes to `ctx.llm`. */
export function routeIds(store: CodexProviderStore): readonly string[] {
  return store.providers.filter(routableProvider).map((entry) => entry.id);
}

/** The provider entry a route id names, or `undefined`. */
export function providerFor(worldHome: string, providerId: string): CodexProviderEntry | undefined {
  return readProviderStore(worldHome).providers.find((entry) => entry.id === providerId);
}

export class CodexLlmAdapter extends LlmAdapter {
  /**
   * @param worldHome - the world's DSH home, holding the canonical provider
   *   store in `<worldHome>/codex-providers.json`. Read on every call, so a
   *   panel edit is visible to the next catalog query without re-registration.
   */
  constructor(private readonly worldHome: string) {
    super();
  }


  providerInfo(provider: string): LlmProviderInfo {
    // The display name is the entry's label — for a provider folded in from the
    // user's own config that is its endpoint URL, which is the only name a
    // hand-written codex config supplies.
    return { id: provider, name: providerFor(this.worldHome, provider)?.label ?? provider };
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const entry = providerFor(this.worldHome, provider);
    if (entry === undefined) return [];
    return entry.models.map((model) => ({
      provider,
      id: model.id,
      name: model.displayName ?? model.id,
    }));
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const entry = providerFor(this.worldHome, provider);
    const found = entry?.models.find((candidate) => candidate.id === model);
    if (found === undefined) {
      throw new LlmError(
        `Codex provider "${provider}" does not serve model "${model}"`,
        "MODEL_NOT_FOUND",
      );
    }
    return {
      provider,
      id: found.id,
      name: found.displayName ?? found.id,
      ...(found.contextWindow !== undefined && found.contextWindow > 0
        ? { context: { contextWindow: found.contextWindow } }
        : {}),
    };
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      "the Codex adapter does not stream: Codex owns generation through its app-server thread",
      "UNSUPPORTED_STREAM",
    );
  }
}
