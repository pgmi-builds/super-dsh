/**
 * Protected system-surface head co-writer for bridge sessions (2026-09-24).
 *
 * dsh session format v4 (0.1.7 reader) constrains every `system/message`
 * twice: it must sit INSIDE an open, matching turn+step (`requireStep`), and
 * it must either BE the surface's first node (the protected head) or replace
 * one ("system/message requires a protected first surface head"). Bridge
 * adapters learn the runtime's real prompt only after the first user message
 * is already on the surface, and most write the user message at turn level
 * (before any step) — so every bridge-written log violated one rule or the
 * other and became unresumable across restarts.
 *
 * The wrap installs the co-writer as OWN PROPERTIES on the session object
 * itself (an `append` own-property shadow over the prototype method, plus
 * `stampSystemPrompt`) and tracks the open turn/step (exactly as the v4
 * reader does), intervening minimally:
 *
 *   - the FIRST `user/message` append on a still-headless, still-empty
 *     surface first opens the turn's next step (when a turn is open but no
 *     step is) and appends a placeholder head; the adapters' real prompt
 *     later REPLACES it (replaced heads are shadowed out of derived model
 *     history, so the empty placeholder never reaches the model or the UI);
 *   - the adapter's own `step/start` for a step THIS wrap opened is dropped
 *     (the log already carries it — appending again would duplicate), and a
 *     wrap-opened step still open at `turn/end` is closed just before it;
 *   - `stampSystemPrompt(turn, step, message)` appends-or-replaces the
 *     protected head with the runtime's real prompt. A stamp arriving with
 *     no open step (an adapter bootstrapping before the first turn) is
 *     queued and flushed inside the next step the adapter opens;
 *   - everything else delegates unchanged.
 *
 * IDENTITY IS THE CONTRACT (2026-09-28, D1): the wrap must return the session
 * object ITSELF, never a wrapper. Upstream identity-checks live sessions by
 * object equality — `session-title`'s `rename()` refuses unless
 * `ctx.sessions.get(session.id) === session` (session-title/src/index.ts),
 * and adapters register the RAW prepared session with `sessions.enter()` /
 * `announce()` (e.g. agent-pi/src/index.ts). An earlier revision returned a
 * transparent `Proxy`; every world-context rename then failed with
 * `session "<id>" is not live in this store` because the Agent handle's
 * `session` (the Proxy) was never the store-registered object. Returning the
 * same object keeps `agent.session === ctx.sessions.get(id)` true, so the
 * whole upstream session plane (rename included) sees one identity.
 *
 * A surface that already starts with a user message and has no head (legacy
 * logs) stays headless — valid — and is never stamped: appending a head
 * there is exactly the corruption this module exists to prevent.
 */

/** The system-head append the co-writer issues on the wrapped session. */
interface SystemHeadAppend {
  (type: 'system/message', data: { turn: number; step: number; message: unknown }, opts:
    | { surfaceOp: 'append' }
    | { surfaceOp: { op: 'replace'; startSeq: number; endSeq: number }; sourceEventSeqs: number[] }): { seq: number }
}

/**
 * The session slice the co-writer reads. Deliberately loose so the real
 * (generic-typed) `Session.append` satisfies it; the system-head calls go
 * through {@link SystemHeadAppend}, the shape this module itself issues.
 */
export interface HeadAwareSessionFace {
  append(...args: never[]): unknown
  snapshotEvents(): ReadonlyArray<{ type: string; seq: number; surfaceOp?: unknown }>
}

/** Builds the placeholder head message (adapters pass their createSystemMessage). */
export type HeadPlaceholder = () => unknown

/** One co-written session: the session itself, carrying head bookkeeping (object identity preserved — see the module note). */
export type WithSystemHead<S> = S & {
  /** Append-or-replace the protected head with the runtime's system prompt. */
  stampSystemPrompt(turn: number, step: number, message: unknown): void
}

/** Events that occupy a slot on the ordered message surface. */
const SURFACE_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])

/** Seq of the live protected head: the LAST `system/message` on the surface (replacements shadow their source). */
function liveHeadSeq(events: ReadonlyArray<{ type: string; seq: number; surfaceOp?: unknown }>): number | undefined {
  let head: number | undefined
  for (const event of events) {
    if (event.type === 'system/message' && event.surfaceOp !== undefined) head = event.seq
  }
  return head
}

/** Whether any surface node exists yet. */
function surfaceIsEmpty(events: ReadonlyArray<{ type: string; surfaceOp?: unknown }>): boolean {
  return !events.some(event => SURFACE_TYPES.has(event.type) && event.surfaceOp !== undefined)
}

/**
 * Wrap one bridge session with protected-head co-writing.
 * @param session - the adapter's real Session.
 * @param placeholder - builds the placeholder head message when the first
 *   user message arrives on an empty surface.
 * @returns the SAME session object with the co-writer installed as own
 *   properties (`append` shadow + `stampSystemPrompt`). Identity is the
 *   contract (D1): upstream liveness checks compare
 *   `ctx.sessions.get(id) === agent.session`, so the returned object must be
 *   the one registered with `sessions.enter()` — never a wrapper.
 */
export function withSystemHead<S extends HeadAwareSessionFace>(session: S, placeholder: HeadPlaceholder): WithSystemHead<S> {
  // Idempotent: a session already carrying the co-writer is returned as-is.
  if (Object.prototype.hasOwnProperty.call(session, 'stampSystemPrompt')) return session as WithSystemHead<S>
  // The one narrow this module performs: the loose face above is what makes
  // the generic real Session assignable; every call below issues exactly the
  // SystemHeadAppend shape.
  const appendHead = session.append.bind(session) as unknown as SystemHeadAppend
  const rawAppend = session.append.bind(session) as unknown as (type: string, data: unknown) => unknown
  const rawAppendFull = session.append.bind(session) as unknown as (type: string, data: unknown, opts?: unknown) => unknown
  // Reader-mirrored turn/step state.
  let turn: number | null = null
  let step: number | null = null
  let nextStep = 1
  let wrapOpenedStep = false
  let wrapClosedStep: number | undefined
  let headSeq: number | undefined
  let queuedStamp: { turn: number, step: number, message: unknown } | undefined

  const openWrapStep = (): boolean => {
    if (turn === null || step !== null) return step !== null
    rawAppend('step/start', { turn, step: nextStep })
    step = nextStep
    wrapOpenedStep = true
    return true
  }
  const ensureHead = (): void => {
    if (headSeq !== undefined) return
    headSeq = liveHeadSeq(session.snapshotEvents())
    if (headSeq !== undefined) return
    if (!surfaceIsEmpty(session.snapshotEvents())) return // headless-but-valid legacy surface: never append here
    if (!openWrapStep()) return // no open turn: a head is impossible; stay headless
    headSeq = appendHead('system/message', { turn: turn as number, step: step as number, message: placeholder() }, { surfaceOp: 'append' }).seq
  }
  const stamp = (turnArg: number, stepArg: number, message: unknown): void => {
    if (step === null) {
      // No open step (adapter bootstrapping before the first turn): queue and
      // flush inside the step the adapter opens next.
      queuedStamp = { turn: turnArg, step: stepArg, message }
      return
    }
    if (headSeq === undefined) {
      headSeq = liveHeadSeq(session.snapshotEvents())
      if (headSeq === undefined && surfaceIsEmpty(session.snapshotEvents())) {
        headSeq = appendHead('system/message', { turn: turnArg, step: stepArg, message }, { surfaceOp: 'append' }).seq
        return
      }
    }
    if (headSeq === undefined) {
      queuedStamp = { turn: turnArg, step: stepArg, message }
      return // headless legacy surface: stamping would corrupt it
    }
    headSeq = appendHead(
      'system/message',
      { turn: turn ?? turnArg, step: step ?? stepArg, message },
      { surfaceOp: { op: 'replace', startSeq: headSeq, endSeq: headSeq }, sourceEventSeqs: [headSeq] },
    ).seq
  }
  const interceptAppend = (type: string, data: unknown, opts?: unknown): unknown => {
    if (type === 'turn/start') {
      turn = (data as { turn: number }).turn
      nextStep = 1
      wrapOpenedStep = false
      wrapClosedStep = undefined
    } else if (type === 'turn/end') {
      // A step THIS wrap opened must not survive the turn boundary.
      if (step !== null && wrapOpenedStep) {
        rawAppend('step/end', { turn, step })
        wrapClosedStep = step
        step = null
        nextStep += 1
      }
      turn = null
    } else if (type === 'step/start') {
      const dataStep = (data as { turn?: number, step?: number })
      if (step !== null && wrapOpenedStep && dataStep.turn === turn && dataStep.step === step) {
        // The adapter opened the step the wrap already wrote: drop the
        // duplicate (the adapter's own counters stay consistent).
        return { type, seq: session.snapshotEvents().length, time: Date.now(), data }
      }
      if (step === null && dataStep.step !== undefined) step = dataStep.step
      wrapOpenedStep = false
      const applied = rawAppendFull(type, data)
      if (queuedStamp !== undefined && step !== null) {
        const pending = queuedStamp
        queuedStamp = undefined
        stamp(pending.turn, pending.step, pending.message)
      }
      return applied
    } else if (type === 'step/end') {
      const dataStep = (data as { turn?: number, step?: number })
      if (step === null && wrapClosedStep !== undefined && dataStep.step === wrapClosedStep) {
        wrapClosedStep = undefined
        return { type, seq: session.snapshotEvents().length, time: Date.now(), data } // the wrap already closed it
      }
      step = null
      if (dataStep.step !== undefined) nextStep = dataStep.step + 1
    } else if (type === 'user/message') {
      ensureHead()
    } else if (type === 'system/message') {
      // A direct adapter append (notices, bootstraps): give it the step
      // context the reader demands — open the turn's next step when
      // none is open and NORMALIZE the coordinates to that context
      // (requireStep compares them for equality; a mismatched append
      // is doomed otherwise). Surface ordering beyond the head rules
      // stays the adapter's own responsibility.
      if (step === null && turn !== null) openWrapStep()
      if (step !== null && turn !== null) {
        const direct = data as { turn?: number, step?: number }
        if (direct.turn !== turn || direct.step !== step) data = { ...(data as object), turn, step }
      }
    }
    return rawAppendFull(type, data, opts)
  }
  // Install the co-writer as OWN PROPERTIES on the session itself. The
  // `append` shadow covers every holder of the object (the adapter's Agent
  // AND upstream services that resolved the session from the store); both
  // properties are non-enumerable so scans/serialization of the session see
  // nothing, and writable/configurable so it stays an ordinary instance.
  Object.defineProperty(session, 'append', {
    value: interceptAppend, writable: true, configurable: true, enumerable: false,
  })
  Object.defineProperty(session, 'stampSystemPrompt', {
    value: (turnArg: number, stepArg: number, message: unknown): void => { stamp(turnArg, stepArg, message) },
    writable: true, configurable: true, enumerable: false,
  })
  return session as WithSystemHead<S>
}
