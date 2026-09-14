const state = { runtime: 'native' };
/** Read the selector (the RPC face and the gateway dispatcher share this). */
export function readSelector() {
    return state.runtime;
}
/** Write the selector. Validation lives in the RPC face; the gateway degrades on unknown keys. */
export function writeSelector(runtime) {
    state.runtime = runtime;
}
