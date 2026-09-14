/** The one app-level selector value (2026-09-10 purity ruling). */
export interface SelectorState {
    /** Active runtime key: `native` or a foreign context key (`omp`, …). */
    runtime: string;
}
/** Read the selector (the RPC face and the gateway dispatcher share this). */
export declare function readSelector(): string;
/** Write the selector. Validation lives in the RPC face; the gateway degrades on unknown keys. */
export declare function writeSelector(runtime: string): void;
