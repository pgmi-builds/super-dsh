var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
const OMP_PRESET = Object.freeze({
    id: "omp",
    trust: "system",
    path: "",
    name: "OMP",
    description: "OMP agent via the omp-web bridge",
});
const COMPOSITION_TEXT = [
    "# OMP (fixed roster)",
    "",
    "This deployment runs exactly one agent mode: the OMP provider bridges Dash",
    "sessions to a native OMP agent over RPC. There is no per-session plugin",
    "composition to configure, so this preset mounts nothing.",
    "",
    "rows: []",
    "",
].join("\n");
/** The standing scope key every `omp` session reads presenters through. */
const STANDING_KEY = {};
let SingleOmpPresetRoster = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _remoteList_decorators;
    let _remoteRead_decorators;
    let _remoteCopy_decorators;
    let _remoteDelete_decorators;
    let _remoteSelect_decorators;
    return class SingleOmpPresetRoster extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _remoteList_decorators = [Remote("list")];
            _remoteRead_decorators = [Remote("read")];
            _remoteCopy_decorators = [Remote("copy")];
            _remoteDelete_decorators = [Remote("deletePreset")];
            _remoteSelect_decorators = [Remote("select")];
            __esDecorate(this, null, _remoteList_decorators, { kind: "method", name: "remoteList", static: false, private: false, access: { has: obj => "remoteList" in obj, get: obj => obj.remoteList }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteRead_decorators, { kind: "method", name: "remoteRead", static: false, private: false, access: { has: obj => "remoteRead" in obj, get: obj => obj.remoteRead }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteCopy_decorators, { kind: "method", name: "remoteCopy", static: false, private: false, access: { has: obj => "remoteCopy" in obj, get: obj => obj.remoteCopy }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteDelete_decorators, { kind: "method", name: "remoteDelete", static: false, private: false, access: { has: obj => "remoteDelete" in obj, get: obj => obj.remoteDelete }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _remoteSelect_decorators, { kind: "method", name: "remoteSelect", static: false, private: false, access: { has: obj => "remoteSelect" in obj, get: obj => obj.remoteSelect }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        constructor(ctx) {
            super(ctx, "agentPresets");
            __runInitializers(this, _instanceExtraInitializers);
        }
        get defaultId() {
            return OMP_PRESET.id;
        }
        get roots() {
            return [];
        }
        get authorable() {
            return false;
        }
        async list() {
            return [OMP_PRESET];
        }
        async resolve(id) {
            if (id === undefined || id === OMP_PRESET.id)
                return OMP_PRESET;
            throw new RemoteError("agent-preset/not-found", `agent-presets: preset "${id}" not found (available: omp)`, { agentPreset: id, available: [OMP_PRESET.id] });
        }
        async mount(_agentCtx, id) {
            return this.resolve(id);
        }
        async recompose(_agentCtx, id) {
            return this.resolve(id);
        }
        async read(id) {
            await this.resolve(id);
            return COMPOSITION_TEXT;
        }
        // ── Remote RPC surface (alpha: agentPresets routes come from @Remote) ────
        // The stock dsh-host-apiproxy mapped cordis methods to routes; alpha serves
        // them from @Remote decorators on a TypertRemoteService. A plain Service
        // registers no routes, which is why Settings → Agent Preset 404'd.
        async remoteList() {
            if (process.env.OMP_TRACE === "1")
                process.stderr.write("[omp-roster] remoteList INVOKED\n");
            return {
                presets: [
                    {
                        id: OMP_PRESET.id,
                        trust: OMP_PRESET.trust,
                        isDefault: true,
                        name: OMP_PRESET.name,
                        description: OMP_PRESET.description,
                    },
                ],
                authorable: this.authorable,
            };
        }
        async remoteRead(agentPreset) {
            const preset = await this.resolve(agentPreset);
            return {
                agentPreset: preset.id,
                trust: preset.trust,
                content: await this.read(preset.id),
                name: preset.name,
                description: preset.description,
            };
        }
        async remoteCopy(from, id, name) {
            await this.copy(from, id, name);
        }
        async remoteDelete(id) {
            await this.remove(id);
        }
        /** Fixed roster: one preset, so selecting it is a no-op ack; anything else is unknown. */
        async remoteSelect(agent, agentPreset) {
            const preset = await this.resolve(agentPreset);
            return preset.id;
        }
        async copy(_from, id, _name) {
            throw new RemoteError("agent-preset/read-only", `agent-presets: preset "${id}" cannot be written: the OMP roster is fixed and ships exactly one preset`, { agentPreset: id, reason: "the OMP roster is fixed and ships exactly one preset" });
        }
        async remove(id) {
            throw new RemoteError("agent-preset/read-only", `agent-presets: preset "${id}" cannot be written: the OMP roster is fixed and ships exactly one preset`, { agentPreset: id, reason: "the OMP roster is fixed and ships exactly one preset" });
        }
        serviceFor(_agent, _name) {
            return undefined;
        }
        composeFrom(_agentCtx, _parentCtx) {
            return undefined;
        }
        composedPreset(_agentCtx) {
            return OMP_PRESET.id;
        }
        async standingKeyFor(id) {
            await this.resolve(id);
            return STANDING_KEY;
        }
    };
})();
export { SingleOmpPresetRoster };
