/**
 * Claude-backed `LlmAdapter` registered on `ctx.llm` by the Claude provider.
 *
 * The browser model selector never touches the Claude agent directly: it is an
 * RPC round-trip through the apiproxy, which reads `ctx.llm.listProviders /
 * listModels / resolveModel` to build the catalog. This adapter answers those
 * queries from TWO sources, one route each (the codex twin's one-route-per-
 * provider shape, 2026-10-04 F-A rework):
 *
 *   - the fixed native route `claude` serves the OBSERVED catalog only (raw
 *     ids — what the CLI itself reports, `models.ts`); its group stays "Claude".
 *   - one route PER configured provider (route id = provider id) serves that
 *     provider's curated `models[]` (RAW model ids, `claude-providers.ts`).
 *
 * The route/model composition therefore yields selection ids identical to the
 * old composite keys (`deepseek/deepseek-flash`, `glm/glm-5.3`), so route seeds
 * and logged selections keep working — the route half simply moved from the
 * hardcoded `claude` to the provider id itself.
 *
 * The curated half follows the codex twin's rule exactly: the store is read
 * LIVE on every call, so a panel edit is visible to the next catalog query
 * without re-registration. An absent `worldHome` means observed-only (the
 * settings-UI round trip and the unit tests).
 *
 * The route id must be `claude`, NOT `claude-code`: the upstream package
 * `@deepseek-ai/dsh-subagent-claude-code` already occupies the subagent
 * provider name `claude-code`, and a world mounting both must not collide.
 *
 * `stream` is never dispatched: Claude owns generation through its own SDK
 * thread, so the adapter only serves catalog/metadata queries. It throws
 * rather than fabricating a wire route the harness would misuse.
 *
 * @module agent-claude/adapter
 */

import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { readProviderStore, type ClaudeProviderEntry, type ClaudeProviderStore } from "./claude-providers.js";
import { readModelCatalog } from "./models.js";

/** The fixed native route every observed Claude model is served under. */
export const CLAUDE_PROVIDER_ID = "claude";

/** Human-readable provider name for the fixed native route. */
const CLAUDE_PROVIDER_NAME = "Claude";

/** Whether a provider may be registered as a model route. */
export function routableProvider(entry: ClaudeProviderEntry): boolean {
  return entry.models.length > 0;
}

/** The route ids a store currently contributes to `ctx.llm`: the fixed `claude`
 *  route first, then one route per provider that has models (store order). */
export function routeIds(store: ClaudeProviderStore): readonly string[] {
  return [CLAUDE_PROVIDER_ID, ...store.providers.filter(routableProvider).map((entry) => entry.id)];
}

export class ClaudeLlmAdapter extends LlmAdapter {
  /**
   * @param worldHome - the world's DSH home, holding the curated provider
   *   store in `<worldHome>/claude-providers.json`. Read on every call (the
   *   codex twin's rule), so a panel edit is visible to the next catalog query
   *   without re-registration. Absent = observed-only (the fixed `claude` route).
   */
  constructor(private readonly worldHome?: string) {
    super();
  }

  /** The curated store entry a provider route id names, or `undefined`. */
  private curatedProvider(providerId: string): ClaudeProviderEntry | undefined {
    if (this.worldHome === undefined) return undefined;
    return readProviderStore(this.worldHome).providers.find((entry) => entry.id === providerId);
  }

  providerInfo(provider: string): LlmProviderInfo {
    if (provider === CLAUDE_PROVIDER_ID) return { id: CLAUDE_PROVIDER_ID, name: CLAUDE_PROVIDER_NAME };
    // The display name is the entry's label — for a provider folded in from the
    // user's own settings that is its endpoint URL, the only name it supplies.
    return { id: provider, name: this.curatedProvider(provider)?.label ?? provider };
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (provider === CLAUDE_PROVIDER_ID) {
      // Observed catalog only, raw ids exactly as the CLI reported them.
      return readModelCatalog().models.map((model) => ({
        provider: CLAUDE_PROVIDER_ID,
        id: model.id,
        name: model.label,
        ...(model.description === undefined ? {} : { description: model.description }),
      }));
    }
    const entry = this.curatedProvider(provider);
    if (entry === undefined) return [];
    return entry.models.map((model) => ({
      provider,
      id: model.id,
      name: model.displayName ?? model.id,
    }));
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (provider === CLAUDE_PROVIDER_ID) {
      // Observed catalog (primary; unchanged behavior for the native route).
      const found = readModelCatalog().models.find((candidate) => candidate.id === model);
      if (found !== undefined) {
        return {
          provider: CLAUDE_PROVIDER_ID,
          id: found.id,
          name: found.label,
          ...(found.description === undefined ? {} : { description: found.description }),
          // Only a positive window is real metadata: an absent or zero window must
          // never become `context: { contextWindow: 0 }`.
          ...(found.contextWindow !== undefined && found.contextWindow > 0
            ? { context: { contextWindow: found.contextWindow } }
            : {}),
          // The CLI's advertised effort levels become adapter-owned reasoning
          // efforts (omp thinking.efforts parity); the CLI names no default, so
          // none is invented.
          ...(found.reasoningEfforts !== undefined && found.reasoningEfforts.length > 0
            ? { reasoning: { efforts: found.reasoningEfforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })) } }
            : {}),
        };
      }
      throw new LlmError(`Claude provider "${CLAUDE_PROVIDER_ID}" does not serve model "${model}"`, "UNKNOWN_MODEL");
    }
    const entry = this.curatedProvider(provider);
    const curated = entry?.models.find((candidate) => candidate.id === model);
    if (entry !== undefined && curated !== undefined) {
      return {
        provider,
        id: curated.id,
        name: curated.displayName ?? curated.id,
        ...(curated.contextWindow !== undefined && curated.contextWindow > 0
          ? { context: { contextWindow: curated.contextWindow } }
          : {}),
      };
    }
    throw new LlmError(`Claude provider "${provider}" does not serve model "${model}"`, "UNKNOWN_MODEL");
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      "the Claude adapter does not stream: Claude owns generation through its SDK thread",
      "UNSUPPORTED_OPTION",
    );
  }
}
