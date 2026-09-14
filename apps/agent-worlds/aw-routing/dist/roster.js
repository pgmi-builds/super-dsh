const entries = new Map();
const listeners = new Set();
function emit() {
    const snap = listAgents();
    for (const fn of listeners)
        fn(snap);
}
/** Register an agent. Duplicate keys are a plugin bug — throw loud. */
export function registerAgent(entry) {
    if (entries.has(entry.key))
        throw new Error(`roster: duplicate agent key ${entry.key}`);
    entries.set(entry.key, { ...entry });
    emit();
}
/** Drop an agent (adapter plugin disposed). */
export function unregisterAgent(key) {
    entries.delete(key);
    emit();
}
/** Flip readiness (world spawned / disposed). Unknown keys are a plugin bug. */
export function setReady(key, ready) {
    const e = entries.get(key);
    if (!e)
        throw new Error(`roster: unknown agent ${key}`);
    e.ready = ready;
    emit();
}
/** Snapshot copy — callers can hold it without aliasing the roster. */
export function listAgents() {
    return [...entries.values()].map((e) => ({ ...e }));
}
/** Subscribe to roster changes; returns an unsubscribe function. */
export function onRosterChanged(fn) {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}
