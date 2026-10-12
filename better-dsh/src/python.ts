/** Better-owned cells delegate to packaged Python modules, never user-global helpers. */
export type NamespaceSpecs = Record<string, {
  functions: string[]
  callable?: true
  errorClass?: { name: string, memberNameProperty: string }
}>

export function buildRunCell(program: string, specJson: string, sentinel: string): string {
  return `await __import__('better_support').run(globals(), ${JSON.stringify(program)}, ${JSON.stringify(specJson)}, ${JSON.stringify(sentinel)})`
}

export interface SnapshotSpec {
  /** Which completed run this snapshot belongs to (the revive "turn-N" counter). */
  turn: number
  /** Minimal replay metadata: skills the kernel environment must provide (none today). */
  skills: string[]
  /** Serialized-size cap in bytes; over-cap snapshots are skipped, not written. */
  sizeCapBytes: number
}

export function buildQueryVarCell(name: string | null, sentinel: string): string {
  return `__import__('better_support').query(globals(), ${JSON.stringify(JSON.stringify(name))}, ${JSON.stringify(sentinel)})`
}

export function buildSetVarCell(name: string, valueJson: string, sentinel: string): string {
  return `__import__('better_support').set_var(globals(), ${JSON.stringify(name)}, ${JSON.stringify(valueJson)}, ${JSON.stringify(sentinel)})`
}

export function buildSnapshotCell(payloadPath: string, manifestPath: string, spec: SnapshotSpec, sentinel: string): string {
  return `__import__('better_snapshot').save(globals(), ${JSON.stringify(payloadPath)}, ${JSON.stringify(manifestPath)}, ${JSON.stringify(JSON.stringify(spec))}, ${JSON.stringify(sentinel)})`
}

export function buildRestoreCell(payloadPath: string, manifestPath: string, sentinel: string, bindings: string[] = []): string {
  return `__import__('better_snapshot').restore(globals(), ${JSON.stringify(payloadPath)}, ${JSON.stringify(manifestPath)}, ${JSON.stringify(sentinel)}, ${JSON.stringify(JSON.stringify(bindings))})`
}
