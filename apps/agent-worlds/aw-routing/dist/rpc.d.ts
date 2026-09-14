/**
 * App-level selector RPC face (adapted from the shelved route's per-session
 * key face, 2026-09-10 ruling: ONE selector for the whole app).
 *
 * Auth conclusion (upstream source, inherited verbatim from the shelved
 * route): every upstream `/api/*` feature mounts via
 * `ctx.connection.fetch.register(...)` — the client-connection service owns
 * the single `/api` prefix webServer route and runs the Host/Origin
 * browser-trust fence + persistent browser auth before dispatching.
 * Registering our own webServer route would bypass that fence. We mount
 * through `connection.fetch` and inherit it.
 *
 * This face is superd-owned control traffic: it must ALWAYS be answered by
 * CTX0 locally and never forwarded to a foreign context (the selector is
 * the control plane, not the data plane).
 */
import type { Context } from '@deepseek-ai/cordis';
/** The shared-channel Fetch route path this RPC face owns. */
export declare const AGENT_RUNTIME_RPC_PATH = "/api/agent-runtime";
/** What the RPC reads to compute the `available` list. */
export interface RuntimeTargetSource {
    /** Registered runtime keys, including `native`. */
    listRuntimes(): string[];
}
/** The live registry view: native plus every registered foreign context. */
export declare const registryTargets: RuntimeTargetSource;
/**
 * Register the selector RPC face on the shared `/api` connection channel
 * (behind the standard browser-trust + auth fence). No-op when the
 * `connection` service is absent (e.g. fake-ctx unit tests).
 */
export declare function registerSelectorRpc(ctx: Context, source: RuntimeTargetSource): void;
