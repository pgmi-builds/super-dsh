/** The one app-level selector value (2026-09-10 purity ruling). */
export interface SelectorState {
  /** Active runtime key: `native` or a foreign context key (`omp`, …). */
  runtime: string
}

const state: SelectorState = { runtime: 'native' }

/** Read the selector (the RPC face and the gateway dispatcher share this). */
export function readSelector(): string {
  return state.runtime
}

/** Write the selector. Validation lives in the RPC face; the gateway degrades on unknown keys. */
export function writeSelector(runtime: string): void {
  state.runtime = runtime
}
