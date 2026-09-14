/**
 * Foreign agent roster (S2: plugin-presence IS the roster).
 *
 * No config file: an agent is in the roster exactly while its adapter
 * plugin is loaded and registered. Adapter plugins self-register on
 * activation (key/label/ready) and the RuntimeSeat chip consumes the
 * snapshot. Module-level state mirrors selector.ts's style — one value,
 * one authority.
 */
export interface RosterEntry {
    /** Runtime key (`omp`, `codex`, …) — what the selector addresses. */
    key: string;
    /** Human label for the selector chip. */
    label: string;
    /** True once the adapter's world context is spawned and its target registered. */
    ready: boolean;
}
/** Register an agent. Duplicate keys are a plugin bug — throw loud. */
export declare function registerAgent(entry: RosterEntry): void;
/** Drop an agent (adapter plugin disposed). */
export declare function unregisterAgent(key: string): void;
/** Flip readiness (world spawned / disposed). Unknown keys are a plugin bug. */
export declare function setReady(key: string, ready: boolean): void;
/** Snapshot copy — callers can hold it without aliasing the roster. */
export declare function listAgents(): RosterEntry[];
/** Subscribe to roster changes; returns an unsubscribe function. */
export declare function onRosterChanged(fn: (entries: RosterEntry[]) => void): () => void;
