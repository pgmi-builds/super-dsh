/**
 * OMP-backed `LlmAdapter` registered on `ctx.llm` by the OMP provider.
 *
 * The browser model selector never touches the OMP agent directly: it is an
 * RPC round-trip through the apiproxy, which reads `ctx.llm.listProviders /
 * listModels / resolveModelInfo` to build the catalog. This adapter answers
 * those queries from OMP's real model registry (`models.ts`) so the selector
 * shows OMP's providers and models — never the native deepseek-official /
 * pi-ai routes, which the profile disables.
 *
 * `stream` is never dispatched: OMP owns generation through its `--mode rpc`
 * agent (`OmpAgent`), so the adapter only serves catalog/metadata queries. It
 * throws rather than fabricating a wire route the harness would misuse.
 */
import { LlmAdapter, LlmError, } from "@deepseek-ai/dsh-llm";
import { loadOmpModels, providerDisplayName, toModelInfo, toResolvedModelInfo } from "./models.js";
export class OmpLlmAdapter extends LlmAdapter {
    providerInfo(provider) {
        return { id: provider, name: providerDisplayName(provider) };
    }
    async listModels(provider) {
        return loadOmpModels()
            .filter((model) => model.provider === provider)
            .map(toModelInfo);
    }
    async resolveModel(provider, model) {
        const found = loadOmpModels().find((candidate) => candidate.provider === provider && candidate.id === model);
        if (found === undefined) {
            throw new LlmError(`OMP provider "${provider}" does not serve model "${model}"`, "MODEL_NOT_FOUND");
        }
        return toResolvedModelInfo(found);
    }
    stream(_options) {
        throw new LlmError("the OMP adapter does not stream: OMP owns generation through its rpc agent", "UNSUPPORTED_STREAM");
    }
}
