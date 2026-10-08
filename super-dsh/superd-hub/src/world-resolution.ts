/** Preserve the host's native package refresh while retaining world import roots. */
import * as AppBoot from '@deepseek-ai/dsh-app-boot'
import type { ProfileRuntimeResolution, RuntimeResolution } from '@deepseek-ai/dsh-app-boot'

type ResolutionSource = ConstructorParameters<typeof ProfileRuntimeResolution>[0]
type WorldEntry = RuntimeResolution['entries'][number]
type WorldRoot = RuntimeResolution['linkedRoots'][number]

/** A native recomputable generation with the worlds' additional mappings. */
const WorldRuntimeResolution = typeof AppBoot.ProfileRuntimeResolution === 'function'
  ? class WorldRuntimeResolution extends AppBoot.ProfileRuntimeResolution {
    // The parent freezes `this`; private slots still accept constructor values.
    readonly #source: ResolutionSource
    readonly #worldEntries: readonly WorldEntry[]
    readonly #worldRoots: readonly WorldRoot[]

    constructor(base: RuntimeResolution, source: ResolutionSource, entries: readonly WorldEntry[], roots: readonly WorldRoot[]) {
      const names = new Set(base.entries.map((entry) => entry.name))
      const rootNames = new Set(base.linkedRoots.map((root) => root.name))
      super(source, {
        ...base,
        // A package now supplied by the native table owns its own mapping.
        entries: Object.freeze([...base.entries, ...entries.filter((entry) => !names.has(entry.name))]),
        linkedRoots: Object.freeze([...base.linkedRoots, ...roots.filter((root) => !rootNames.has(root.name))]),
      })
      this.#source = source
      this.#worldEntries = entries
      this.#worldRoots = roots
    }

    override async computeLatestResolution(): Promise<ProfileRuntimeResolution> {
      // Recompute native mappings from disk, then widen the successor again.
      // Keeping only world additions prevents removed native packages lingering.
      return new WorldRuntimeResolution(await super.computeLatestResolution(), this.#source, this.#worldEntries, this.#worldRoots)
    }
  }
  : undefined

export function widenWorldResolution(
  base: RuntimeResolution,
  source: ResolutionSource,
  entries: Iterable<WorldEntry>,
  linkedRoots: Iterable<WorldRoot>,
): RuntimeResolution {
  const worldEntries = Object.freeze([...entries])
  const worldRoots = Object.freeze([...linkedRoots])
  // Earlier supported hosts expose data generations and have no refresh API.
  // Keep that contract without evaluating a class extending a missing export.
  if (WorldRuntimeResolution === undefined) {
    return { ...base, entries: [...base.entries, ...worldEntries], linkedRoots: [...base.linkedRoots, ...worldRoots] }
  }
  return new WorldRuntimeResolution(base, Object.freeze({ ...source }), worldEntries, worldRoots)
}
