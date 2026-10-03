/**
 * Claude-backed `LlmAdapter` registered on `ctx.llm` by the Claude provider.
 *
 * The browser model selector never touches the Claude agent directly: it is an
 * RPC round-trip through the apiproxy, which reads `ctx.llm.listProviders /
 * listModels / resolveModel` to build the catalog. This adapter answers those
 * queries under the single provider route `claude`, from TWO sources merged
 * by id: the models Claude actually reported (`models.ts` — observed,
 * primary) and the curated multi-provider store (`claude-providers.ts`),
 * whose models are minted as composite ids (`<providerId>/<modelId>`,
 * claude-route.ts) — the ids a per-session `model/selection` carries and
 * `sessionAgentOptions`/`routeSeed` split back into the wire pair.
 *
 * The curated half follows the codex twin's rule exactly: the store is read
 * LIVE on every call, so a panel edit is visible to the next catalog query
 * without re-registration or cache invalidation. An absent `worldHome` means
 * observed-only (the settings-UI round trip and the unit tests).
 *
 * The route id must be `claude`, NOT `claude-code`: the upstream package
 * `@deepseek-ai/dsh-subagent-claude-code` already occupies the subagent
 * provider name `claude-code`, and a world mounting both must not collide.
 *
 * `stream` is never dispatched: Claude owns generation through its own SDK
 * thread, so the adapter only serves catalog/metadata queries. It throws
 * rather than fabricating a wire route the harness would misuse.
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
import { readProviderStore } from "./claude-providers.js";
import { readModelCatalog, type ClaudeModelEntry } from "./models.js";
import { compositeModelId, parseCompositeModelId } from "./claude-route.js";

/** The one provider route every served Claude model is served under. */
export const CLAUDE_PROVIDER_ID = "claude";

/** Human-readable provider name for selectors and diagnostics. */
const CLAUDE_PROVIDER_NAME = "Claude";

export class ClaudeLlmAdapter extends LlmAdapter {
  /**
   * @param worldHome - the world's DSH home, holding the curated provider
   *   store in `<worldHome>/claude-providers.json`. Read on every call (the
   *   codex twin's rule), so a panel edit is visible to the next catalog query
   *   without re-registration. Absent = observed-only.
   */
  constructor(private readonly worldHome?: string) {
    super();
  }

  /**
   * The curated store's models as catalog entries: composite ids minted via
   * `compositeModelId`, carrying only the fields a store model holds (no
   * description, no reasoning efforts — the store knows neither, and none are
   * invented).
   */
  private curatedEntries(): ClaudeModelEntry[] {
    if (this.worldHome === undefined) return [];
    const entries: ClaudeModelEntry[] = [];
    for (const provider of readProviderStore(this.worldHome).providers) {
      for (const model of provider.models) {
        entries.push({
          id: compositeModelId(provider.id, model.id),
          label: model.displayName ?? model.id,
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        });
      }
    }
    return entries;
  }

  providerInfo(_provider: string): LlmProviderInfo {
    return { id: CLAUDE_PROVIDER_ID, name: CLAUDE_PROVIDER_NAME };
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // Observed first, curated appended, deduped by id with the observed entry
    // winning: the CLI's own report is the primary source and must stay
    // exactly what it reported. The codex twin has no merge to mirror — its
    // one-route-per-provider design makes the store the WHOLE catalog — so
    // observed-first is this adapter's own rule, and resolveModel applies the
    // same precedence so the picker and its resolutions can never disagree.
    const observed = readModelCatalog().models;
    const seen = new Set(observed.map((model) => model.id));
    const curated = this.curatedEntries().filter((model) => !seen.has(model.id));
    return [...observed, ...curated].map((model) => ({
      provider: CLAUDE_PROVIDER_ID,
      id: model.id,
      name: model.label,
      ...(model.description === undefined ? {} : { description: model.description }),
    }));
  }

  async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    // 1. Observed catalog (primary; unchanged behavior).
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
    // 2. Curated composite id: split it, look the pair up in the store. The
    // resolved `id` echoes the composite verbatim (the llm contract rejects
    // `resolved.id !== model`), and the RAW model id is the wire half — the
    // factory's `sessionAgentOptions`/`routeSeed` are what split it when a
    // turn actually launches.
    const composite = parseCompositeModelId(model);
    if (composite !== undefined && this.worldHome !== undefined) {
      const entry = readProviderStore(this.worldHome).providers.find((provider) => provider.id === composite.provider);
      const curated = entry?.models.find((candidate) => candidate.id === composite.model);
      if (entry !== undefined && curated !== undefined) {
        return {
          provider: CLAUDE_PROVIDER_ID,
          id: model,
          name: curated.displayName ?? curated.id,
          ...(curated.contextWindow !== undefined && curated.contextWindow > 0
            ? { context: { contextWindow: curated.contextWindow } }
            : {}),
        };
      }
    }
    throw new LlmError(`Claude provider "${CLAUDE_PROVIDER_ID}" does not serve model "${model}"`, "MODEL_NOT_FOUND");
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      "the Claude adapter does not stream: Claude owns generation through its SDK thread",
      "UNSUPPORTED_STREAM",
    );
  }
}
