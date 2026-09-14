/**
 * OMP model catalog + modelRoles data plane, served by the shared bun sidecar
 * (which embeds the OMP core via @oh-my-pi/pi-coding-agent) instead of
 * spawning `omp` CLI subprocesses.
 *
 * Two data planes are bridged:
 *   - `models.list`             → the credential-resolved AVAILABLE model
 *     catalog (the same set `omp models --json` returned: ~50 models / 5
 *     providers), keyed the way `models.ts` normalizes them (id/provider/name/
 *     api/baseUrl/reasoning/input/contextWindow/maxTokens/thinking).
 *   - `settings.modelRoles.get/set` → the role→"provider/model[:effort]" map,
 *     including the persisted `default` selector (TUI semantics: the default
 *     model IS config state, surviving sessions). `set` is a whole-object
 *     roundtrip write, matching `omp config set modelRoles` (dotted keys are
 *     rejected; the entire modelRoles object is the unit).
 *
 * The sidecar is a SHARED SINGLETON (src/sdk-client.ts acquire/release) — this
 * module goes through the same instance via `callShared`, never spawning a
 * second sidecar process.
 *
 * Sync variants (`*Sync`) cannot block on sidecar IPC, so they return the last
 * cache and warm it asynchronously: the first boot-time call returns
 * `undefined` (the caller's on-disk fallback engages) and a later background
 * fetch repopulates the cache. The async variants always fetch fresh.
 *
 * Fail-soft: any sidecar failure (not started / crashed) yields `undefined`
 * (reads) or `false` (write), so the provider never fails to boot on a down
 * sidecar.
 *
 * @module omp-web/omp-cli
 */
import { callShared } from "./sdk-client.js";
// ---------------------------------------------------------------------------
// Sidecar plumbing (fail-soft: any failure → undefined/false)
// ---------------------------------------------------------------------------
/** `models.list` over the shared sidecar → validated OmpCliModel[], undefined on failure. */
async function sidecarModelsList() {
    try {
        const data = await callShared("models.list", { refresh: true });
        if (data === null || typeof data !== "object")
            return undefined;
        const models = data.models;
        if (!Array.isArray(models))
            return undefined;
        const out = [];
        for (const model of models) {
            if (model !== null &&
                typeof model === "object" &&
                typeof model.provider === "string" &&
                typeof model.id === "string") {
                out.push(model);
            }
        }
        return out.length > 0 ? out : undefined;
    }
    catch {
        return undefined;
    }
}
/** `settings.modelRoles.get` over the shared sidecar → validated OmpModelRoles, undefined on failure. */
async function sidecarModelRolesGet() {
    try {
        const data = await callShared("settings.modelRoles.get", {});
        const value = data?.modelRoles;
        if (value === null || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const out = {};
        for (const [role, selector] of Object.entries(value)) {
            if (typeof selector === "string" && selector !== "")
                out[role] = selector;
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }
    catch {
        return undefined;
    }
}
/** `settings.modelRoles.set` over the shared sidecar → true only on a durable write. */
async function sidecarModelRolesSet(roles) {
    try {
        const data = await callShared("settings.modelRoles.set", { modelRoles: roles });
        return data?.ok === true;
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------
let modelsCache;
let modelsWarm = null;
async function warmModels() {
    const models = await sidecarModelsList();
    if (models !== undefined)
        modelsCache = models;
}
/** Kick off one background warm of the cache if it is cold (no redundant spawn). */
function ensureModelsWarm() {
    if (modelsCache === undefined && modelsWarm === null) {
        modelsWarm = warmModels().finally(() => {
            modelsWarm = null;
        });
    }
}
/**
 * Synchronous `models.list` — the boot-time variant (the adapter's provider
 * route list must be known before `registerAdapter` returns). Sidecar IPC is
 * async, so this returns the LAST cached catalog (undefined until the first
 * warm completes) and starts a background fetch if the cache is cold. On a
 * cold cache the caller (`models.ts`) falls back to the on-disk registry
 * cache, and `refreshOmpModelsCli` swaps in the fresh catalog on the first
 * reconcile tick.
 */
export function ompAvailableModelsSync() {
    ensureModelsWarm();
    return modelsCache;
}
/**
 * `models.list` — the AVAILABLE model catalog (credential-resolved,
 * `disabledProviders`-aware), fetched fresh from the shared sidecar on every
 * call. `undefined` when the sidecar is unavailable; callers fall back to the
 * on-disk sources.
 */
export async function ompAvailableModels() {
    const models = await sidecarModelsList();
    if (models !== undefined)
        modelsCache = models;
    return models;
}
// ---------------------------------------------------------------------------
// modelRoles
// ---------------------------------------------------------------------------
let rolesCache;
let rolesWarm = null;
async function warmRoles() {
    const roles = await sidecarModelRolesGet();
    if (roles !== undefined)
        rolesCache = roles;
}
/** Kick off one background warm of the roles cache if cold. */
function ensureRolesWarm() {
    if (rolesCache === undefined && rolesWarm === null) {
        rolesWarm = warmRoles().finally(() => {
            rolesWarm = null;
        });
    }
}
/**
 * Synchronous `settings.modelRoles.get` — boot-time variant. Same cache +
 * async-warm semantics as {@link ompAvailableModelsSync}: returns the last
 * known roles (undefined while cold) and warms in the background.
 */
export function ompModelRolesSync() {
    ensureRolesWarm();
    return rolesCache;
}
/**
 * `settings.modelRoles.get` — the current modelRoles object, fetched fresh
 * from the sidecar on every call (the OMP TUI may have rewritten config.yml).
 * `undefined` when unset or the sidecar fails.
 */
export async function ompModelRoles() {
    const roles = await sidecarModelRolesGet();
    if (roles !== undefined)
        rolesCache = roles;
    return roles;
}
/**
 * `settings.modelRoles.set` — the TUI-grade default-model write: the sidecar
 * replaces the whole modelRoles object (matching `omp config set modelRoles`
 * whole-object semantics) and confirms the write landed before returning true.
 */
export async function ompSetModelRoles(roles) {
    return sidecarModelRolesSet(roles);
}
