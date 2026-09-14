import { OmpSdkClient } from "./sdk-client.js";
/** Synthetic state for a not-yet-spawned child: quiescent by definition. */
const IDLE_STATE = { isStreaming: false };
export class LazyOmpRpc {
    #spawnArgs;
    #cwd;
    #client;
    #spawn;
    #closed = false;
    #eventListeners = new Set();
    #failureListeners = new Set();
    #pendingModel;
    #onSpawned;
    constructor(spawnArgs, cwd) {
        this.#spawnArgs = spawnArgs;
        this.#cwd = cwd;
    }
    /**
     * Bridge hook: runs once when the child first exists (the caller writes the
     * index row + supervisor held-baseline there — the create-time counterparts
     * were deliberately skipped). Registered before or after the spawn; both
     * orders fire exactly once.
     */
    onSpawned(handler) {
        this.#onSpawned = handler;
        if (this.#client !== undefined)
            handler(this.#client);
    }
    get spawned() {
        return this.#client !== undefined;
    }
    /** Spawn once; concurrent and later callers share the same child. */
    #ensure() {
        if (this.#client !== undefined)
            return Promise.resolve(this.#client);
        if (this.#spawn === undefined) {
            this.#spawn = OmpSdkClient.spawn(this.#spawnArgs, this.#cwd).then((client) => {
                // A close() that raced the in-flight spawn wins: dispose immediately.
                if (this.#closed) {
                    client.close();
                    return client;
                }
                this.#client = client;
                for (const listener of this.#eventListeners)
                    client.on(listener);
                for (const listener of this.#failureListeners)
                    client.onFailure(listener);
                this.#onSpawned?.(client);
                return client;
            }).catch((error) => {
                // Allow a later dispatch to retry the spawn.
                this.#spawn = undefined;
                throw error;
            });
        }
        return this.#spawn;
    }
    on(listener) {
        this.#eventListeners.add(listener);
        if (this.#client !== undefined)
            this.#client.on(listener);
        return () => {
            this.#eventListeners.delete(listener);
        };
    }
    onFailure(listener) {
        this.#failureListeners.add(listener);
        if (this.#client !== undefined)
            this.#client.onFailure(listener);
        return () => {
            this.#failureListeners.delete(listener);
        };
    }
    async prompt(message) {
        const client = await this.#ensure();
        // Apply a pre-spawn model selection now, ahead of the prompt (the sidecar
        // records it as the session's model_change, like a pre-turn set_model).
        const pending = this.#pendingModel;
        if (pending !== undefined) {
            this.#pendingModel = undefined;
            await client.setModel(pending.provider, pending.modelId).catch(() => { });
        }
        return client.prompt(message);
    }
    async followUp(message) {
        return (await this.#ensure()).followUp(message);
    }
    async steer(message) {
        return (await this.#ensure()).steer(message);
    }
    async compact(instructions) {
        return (await this.#ensure()).compact(instructions);
    }
    async contextUsage() {
        if (this.#client === undefined)
            return undefined;
        return this.#client.contextUsage();
    }
    async abort() {
        if (this.#client === undefined)
            return undefined;
        return this.#client.abort();
    }
    async ensureStarted() {
        await this.#ensure();
    }
    async getState() {
        if (this.#client === undefined)
            return IDLE_STATE;
        return this.#client.getState();
    }
    async getSubagents() {
        if (this.#client === undefined)
            return [];
        return this.#client.getSubagents();
    }
    async getSessionStats() {
        if (this.#client === undefined)
            return {};
        return this.#client.getSessionStats();
    }
    async getSystemPrompt() {
        if (this.#client === undefined)
            return undefined;
        return this.#client.getSystemPrompt();
    }
    async setModel(provider, modelId) {
        if (this.#client === undefined) {
            // Park it: applied by prompt() immediately after the spawn.
            this.#pendingModel = { provider, modelId };
            return undefined;
        }
        return this.#client.setModel(provider, modelId);
    }
    sendRaw(command) {
        if (this.#client !== undefined)
            this.#client.sendRaw(command);
    }
    close() {
        this.#closed = true;
        const client = this.#client;
        this.#client = undefined;
        client?.close();
    }
}
