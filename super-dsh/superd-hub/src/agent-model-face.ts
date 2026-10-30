/**
 * agent-model-face.ts — the 0.2.2+ `Agent.model` face for foreign-runtime
 * bridges.
 *
 * dsh 0.2.2 made `model` a required `Agent` member: the Web UI's model switcher
 * reaches every agent — native and foreign alike — through
 * `session/selectModel` → `agent.model.select()` (session-controller
 * commands.ts). The native `AgentModel` (dsh-agent model-selection.ts) records
 * a `model/selection` session event durably and resolves `current()` as
 * pending ?? lastUsed ?? live options.
 *
 * This module hands the foreign bridges (claude/codex/hermes/pi/agy/omp) the
 * same semantics without mounting the projection registry:
 *
 *  - {@link recordedModelSelection} — the native `modelSelection` projection
 *    fold, replayed as one pass over the session's events. A recorded
 *    `model/selection` is the pending choice and survives non-matching
 *    `request/header`s; a matching header retires it; `lastUsed` is the last
 *    header's config. (The adapters that DO mount `sessionProjections` —
 *    claude, codex — may keep reading the projection directly; both produce
 *    the same answer.)
 *  - {@link createAgentModelFace} — the face itself: `current()` resolves
 *    pending → logged header → deployment default → agent options (each level
 *    must name both halves), `select()` appends the same durable
 *    `model/selection` event as the native face, deduped against the recorded
 *    choice.
 *
 * Structural session face on the system-head pattern: the real (generic-typed)
 * `Session` satisfies it without this package taking a dsh-agent dependency.
 *
 * @module superd-hub/agent-model-face
 */

/** A model selection: both route halves, with an optional explicit effort. */
export interface ModelSelectionLike {
  provider: string
  model: string
  reasoningEffort?: unknown
}

/** The `Agent.model` shape (dsh-agent runtime-types `Model`), over the bridge's own selection type. */
export interface BridgeModelFace<Sel extends ModelSelectionLike> {
  current(): Readonly<Sel> | undefined
  select(selection: Readonly<Sel>): void
}

/**
 * The session slice the fold reads. Deliberately loose so the real
 * (generic-typed) `Session` satisfies it; the events the fold inspects arrive
 * as `unknown` data and are narrowed inside this module only.
 */
export interface ModelSessionFace {
  snapshotEvents(): ReadonlyArray<{ type: string; data: unknown }>
  requestHeader(): { readonly config: { readonly provider: string; readonly model: string } } | undefined
}

/** One recorded selection read structurally; incomplete routes answer `null`. */
function selectionOf(value: unknown): ModelSelectionLike | null {
  if (typeof value !== 'object' || value === null) return null
  const { provider, model } = value as { provider?: unknown; model?: unknown }
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return null
  const reasoningEffort = (value as { reasoningEffort?: unknown }).reasoningEffort
  return {
    provider,
    model,
    ...(typeof reasoningEffort === 'string' && reasoningEffort !== ''
      ? { reasoningEffort }
      : {}),
  }
}

/** Route equality without the effort, and full equality with it (the fold's own rules). */
function sameRoute(left: ModelSelectionLike, right: ModelSelectionLike): boolean {
  return left.provider === right.provider && left.model === right.model
}

function sameSelection(left: ModelSelectionLike, right: ModelSelectionLike): boolean {
  return sameRoute(left, right) && left.reasoningEffort === right.reasoningEffort
}

/**
 * The native `modelSelection` projection fold over one session's events.
 * @param events - the session's full event snapshot (order is the log order).
 * @returns the recorded choice — a pending selection, else the last request
 * header's config — or `null` when the log names neither.
 */
export function recordedModelSelection(
  events: ReadonlyArray<{ type: string; data: unknown }>,
): ModelSelectionLike | null {
  let pending: ModelSelectionLike | null = null
  let lastUsed: ModelSelectionLike | null = null
  for (const event of events) {
    if (event.type === 'model/selection') {
      const selection = selectionOf(event.data)
      if (selection !== null && !(pending !== null && sameSelection(pending, selection))) pending = selection
    } else if (event.type === 'request/header') {
      const header = event.data as { header?: { config?: unknown } } | undefined
      const config = header === null || typeof header !== 'object' ? undefined : header.header?.config
      const selection = selectionOf(config)
      if (selection !== null) {
        lastUsed = selection
        if (pending !== null && sameRoute(pending, selection)) pending = null
      }
    }
  }
  return pending ?? lastUsed
}

/** Readers the face resolves through; each adapter wires its own sources. */
export interface AgentModelFaceParts<Sel extends ModelSelectionLike> {
  /** The session whose events and request header back the fold. */
  session: ModelSessionFace
  /** The agent's live route options (the options fallback names both halves or neither). */
  options: { readonly provider?: string; readonly model?: string }
  /** Appends the durable `model/selection` event (the adapter's own typed append). */
  appendSelection: (selection: Sel) => void
  /** Reads the deployment default (`ctx.agentDefaultModel`); absent when the service is not mounted. */
  readDefault?: () => { provider: string; model: string } | undefined
}

/**
 * Build the `Agent.model` face for one foreign-runtime agent.
 * @param parts - the session, options, typed append, and optional default reader.
 * @returns the face; assign it to the agent's `model` member.
 */
export function createAgentModelFace<Sel extends ModelSelectionLike>(
  parts: AgentModelFaceParts<Sel>,
): BridgeModelFace<Sel> {
  const recorded = (): ModelSelectionLike | null =>
    recordedModelSelection(parts.session.snapshotEvents())
  const current = (): Readonly<Sel> | undefined => {
    const fold = recorded()
    if (fold !== null) return { ...fold } as Readonly<Sel>
    const preferred = parts.readDefault?.()
    if (preferred !== undefined && preferred.provider !== '' && preferred.model !== '') {
      return { provider: preferred.provider, model: preferred.model } as Readonly<Sel>
    }
    const { provider, model } = parts.options
    return provider !== undefined && provider !== '' && model !== undefined && model !== ''
      ? ({ provider, model } as Readonly<Sel>)
      : undefined
  }
  return {
    current,
    select(selection: Readonly<Sel>): void {
      const fold = recorded()
      if (fold !== null && sameSelection(fold, selection)) return
      parts.appendSelection({ ...selection } as Sel)
    },
  }
}
