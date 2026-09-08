/**
 * EchoAgent — the first ForeignAgent (external agent loop).
 *
 * Implements the upstream `Agent` runtime face (`@deepseek-ai/dsh-agent`
 * runtime-types.ts) with a minimal but real event-sourced turn: a follow-up is
 * logged as `turn/start` → `user/message` → `step/start` → (cancellable delay)
 * → `assistant/message` (echo of the user blocks, `[echo] ` prefixed) →
 * `step/end` → `turn/end: completed`. No process is spawned and no LLM is
 * called; the durable session log is the entire machine.
 *
 * The factory (`EchoAgentFactory`) mirrors the minimal slice of upstream
 * agent-loop's createAgent chain: `sessions.prepare` → opening events
 * (`permission/preset`, `sandbox/mode`, `approval/policy`) → optional
 * persistence create + suffix flush → setup (compose-only, optional commit) →
 * `sessions.enter` → `agents.enter` → `sessions.announce` → `agents.announce`
 * → `agent/session-start`.
 *
 * Hard rules honored here:
 * - NO `#` private members (cordis proxy brand check — M0 lesson).
 * - The factory NEVER calls `ctx.agents.setFactory`; it is registered only via
 *   the MultiAgentRegistry `appendFactory('echo', …)` side slot.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import { createScope as localCreateScope } from '@deepseek-ai/dsh-scope'

/**
 * dsh-scope MUST be the HOST process's module instance: its scope key is a
 * module-level `Symbol("dsh.scope")` (NOT Symbol.for), so a second copy of the
 * package mints a different symbol and host plugins (agent-presets) cannot see
 * the scope we attach — "refusing to compose an unscoped context". Resolve the
 * running dsh binary's own module tree first (argv[1] realpath anchors inside
 * the host install), fall back to this repo's copy for unit tests.
 */
async function loadHostScopeModule(): Promise<typeof import('@deepseek-ai/dsh-scope')> {
  try {
    const moduleMod = (await import('node:module')).default
    const fsMod = await import('node:fs')
    const anchorPath = fsMod.realpathSync(process.argv[1] ?? process.cwd())
    const req = moduleMod.createRequire(anchorPath)
    const resolved = req.resolve('@deepseek-ai/dsh-scope')
    return await import(resolved) as typeof import('@deepseek-ai/dsh-scope')
  } catch {
    return await import('@deepseek-ai/dsh-scope')
  }
}
const scopeModule: Awaited<ReturnType<typeof loadHostScopeModule>> = await loadHostScopeModule()
const createScope = scopeModule.createScope
import type {
  Agent, AgentCancelCause, AgentFactory, AgentHandle, AgentOptions, AgentStatus,
  CancelOptions, CreateAgentOptions, ResumeAgentOptions, SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import { SessionLogOffset, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type {
  Session, SessionEvent, SessionHeader, SessionId as Sid, SessionLogOffset as Slo,
  SessionSeedEventState,
} from '@deepseek-ai/dsh-session'
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'

/** Delay before the echo assistant message commits (cancellable). */
export const ECHO_TURN_DELAY_MS = 50

/**
 * Minimal structural slice of `@deepseek-ai/dsh-session-persistence`
 * (SessionPersistence + SessionHandle). Declared locally because that package
 * is not a root-node_modules dependency of this repo; shapes are copied from
 * its published interface at 0.1.3-alpha.2. If the upstream interface drifts,
 * this slice is the single place to reconcile.
 */
export interface EchoPersistenceHandle {
  readonly header: SessionHeader
  readonly inheritedEventCount: Slo
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[]; eventState: SessionSeedEventState }>
  append(events: readonly SessionEvent[], options?: { signal?: AbortSignal }): Promise<void>
  close(): Promise<void>
}

/** Structural persistence service slice (see {@link EchoPersistenceHandle}). */
export interface EchoPersistence {
  create(header: SessionHeader, options?: { inheritedEventCount?: Slo; signal?: AbortSignal }): Promise<EchoPersistenceHandle>
  open(id: Sid, access: 'write', options?: { signal?: AbortSignal }): Promise<EchoPersistenceHandle>
}

/** Read the optional persistence service without importing its package. */
function getPersistence(ctx: Context): EchoPersistence | undefined {
  return (ctx as Context & { get?: (name: string) => unknown }).get?.('sessionPersistence') as EchoPersistence | undefined
}

/** Prefix the echo marker onto the user's content blocks (same blocks otherwise). */
export function echoContent(blocks: readonly ContentBlock[]): ContentBlock[] {
  const first = blocks[0]
  if (first !== undefined && first.type === 'text') {
    return [{ ...first, text: `[echo] ${first.text}` }, ...blocks.slice(1)]
  }
  return [{ type: 'text', text: '[echo]' }, ...blocks]
}

interface PendingEcho {
  readonly turn: number
  readonly abort: AbortController
  done: boolean
}

/**
 * A minimal ForeignAgent. Known, documented simplifications vs the native
 * loop (honest boundary, revisit for real providers in M2+):
 * - `agent.ctx` is the create/resume caller's context, not a fresh scoped
 *   world; setup registrations land on the caller's fiber.
 * - `steer`/`inject` are typed no-ops (their input is discarded — echo has no
 *   in-flight model request to redirect).
 * - The durable inbox projection is never driven: the live `Inbox` instance
 *   exists for face compatibility but follow-up messages go straight to
 *   `user/message` (no `agent/inbox/spliced` events).
 * - Creation/resume cancellation (`options.signal`) is checked up front, not
 *   raced against every await.
 */
export class EchoAgent implements Agent {
  readonly id: Sid
  readonly session: Session
  readonly ctx: Context
  readonly options: AgentOptions
  readonly inbox: Inbox


  /** Current lifecycle state (Agent face; mirrored via agent/status events). */
  get status(): AgentStatus {
    return this.statusValue
  }
  private dispatch: ReturnType<typeof agentEvents>
  private statusValue: AgentStatus = 'idle'
  private turnCount = 0
  private queue: UserMessage[] = []
  private pending: PendingEcho | undefined
  private idleWaiters: Array<() => void> = []
  private disposed = false
  private scope: ReturnType<typeof createScope>
  private maintenanceAbort: AbortController | undefined

  constructor(ctx: Context, options: AgentOptions, session: Session) {
    // Scoped world contract (upstream ReactLoopAgent pattern): setup callbacks
    // receive a context CARRYING the agent (`agentCtx.agent` must resolve —
    // e.g. api-session-controller's installSelection throws otherwise). The
    // upstream loop uses scope.ctx.extend({ agent: this }); extend() with own
    // properties is the minimal equivalent.
    this.scope = createScope(ctx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.options = options
    this.session = session
    this.id = session.id
    this.dispatch = agentEvents(ctx, this)
    // Real Inbox for face compatibility; echo never splices it (see class doc).
    this.inbox = new Inbox(session, {
      inserted: () => {},
      discarded: () => {},
      claimed: () => {},
    })
  }

  /** Factory hook: emit the session lifecycle start after publication. */
  emitSessionStart(source: SessionStartSource): void {
    this.dispatch.emit('agent/session-start', { source })
  }

  private setStatus(status: AgentStatus): void {
    if (this.statusValue === status) return
    this.statusValue = status
    this.dispatch.emit('agent/status', { status })
  }

  private settleIdle(): void {
    if (this.statusValue !== 'idle' || this.queue.length > 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  send(message: UserMessage, _target: 'next-turn' | 'next-step', _wakeup: boolean): void {
    if (this.disposed) return
    this.queue.push(message)
    this.pump()
  }

  /** Documented no-op: echo has no in-flight request to redirect. */
  steer(_message: UserMessage): void {}

  /** Documented no-op: echo has no next pre-step to inject into. */
  inject(_message: UserMessage): void {}

  private pump(): void {
    if (this.disposed || this.statusValue === 'running') return
    const message = this.queue.shift()
    if (message === undefined) {
      this.settleIdle()
      return
    }
    // Turn numbering continues from the persisted log (resume path).
    this.turnCount = this.session.ownEvents().filter((event) => event.type === 'turn/start').length + 1
    const turn = this.turnCount
    this.setStatus('running')
    this.session.append('turn/start', { turn })
    this.session.append('user/message', message, { surfaceOp: 'append' })
    this.session.append('step/start', { turn, step: 1 })
    const pending: PendingEcho = { turn, abort: new AbortController(), done: false }
    this.pending = pending
    const timer = setTimeout(() => { this.commitEcho(pending, message) }, ECHO_TURN_DELAY_MS)
    pending.abort.signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
  }

  private commitEcho(pending: PendingEcho, message: UserMessage): void {
    if (pending.done || this.pending !== pending) return
    pending.done = true
    this.pending = undefined
    this.session.append('assistant/message', {
      turn: pending.turn,
      step: 1,
      message: {
        id: randomUUID() as MessageId,
        role: 'assistant',
        content: echoContent(message.content),
        source: { kind: 'model', provider: 'echo', model: 'agent-loop-echo' },
      },
      stream: [],
    }, { surfaceOp: 'append' })
    this.session.append('step/end', { turn: pending.turn, step: 1 })
    this.session.append('turn/end', { turn: pending.turn, reason: { kind: 'completed' } })
  
    this.setStatus('idle')
    this.pump()
  }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    const pending = this.pending
    if (pending !== undefined) {
      pending.done = true
      this.pending = undefined
      pending.abort.abort(new Error(`echo turn ${pending.turn} cancelled: ${cause.kind}`))
      // Mirror the native shape: no assistant message, turn closes aborted.
      this.session.append('turn/end', { turn: pending.turn, reason: { kind: 'aborted', reason: cause } })
      this.setStatus('idle')
    }
    if (options?.keepInbox !== true) {
      // Simplified keepInbox semantics: queued (unstarted) drives are dropped.
      this.queue.length = 0
    }
    this.pump()
  }

  whenIdle(): Promise<void> {
    if (this.statusValue === 'idle' && this.queue.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => { this.idleWaiters.push(resolve) })
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.statusValue === 'running' || this.maintenanceAbort !== undefined) {
      throw new Error('echo agent is busy (turn or maintenance already active)')
    }
    this.maintenanceAbort = new AbortController()
    const run = task(this.maintenanceAbort.signal)
    void Promise.resolve(run).then(() => {}, () => {}).finally(() => {
      this.maintenanceAbort = undefined
      this.settleIdle()
    })
    return run
  }

  /** Structural teardown used by the factory handle disposer. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel({ kind: 'disposed' })
    this.maintenanceAbort?.abort(new Error('echo agent disposed'))
    this.settleIdle()
  }
}

/**
 * The ForeignAgent factory registered under the `echo` routing key via
 * `appendFactory`. Never touches `setFactory` — the native loop keeps the
 * `native` slot.
 */
export class EchoAgentFactory implements AgentFactory {
  /**
   * The plugin's OWN context (declares the service injects). Service access
   * (sessions / persistence) must go through this context, mirroring upstream
   * agent-loop's `runtime.ctx` "Plain holder" pattern: the caller's ownerCtx
   * does not inject our dependencies, so touching ctx.sessions there throws
   * "cannot get property ... without inject". ownerCtx remains authoritative
   * for publication and ownership only.
   */
  constructor(private readonly svcCtx: Context) {}

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    options.signal?.throwIfAborted()
    const session = this.svcCtx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    })
    // Minimal opening set, modeled on the M0-observed native sequence.
    // These event types are merged into SessionEventMap by upstream preset
    // plugins, not by the base dsh-session map this package compiles against;
    // append() runtime-validates JSON + surface contract only, so cast the type.
    // NOTE: call session.append BOUND (arrow wrapper) — detaching the method
    // (`const f = session.append`) runs it with `this === undefined` in ESM
    // strict mode and throws "Cannot read properties of undefined (reading 'log')".
    // The cast only widens the event-type union (preset plugins merge these
    // types into SessionEventMap; runtime validates JSON + surface contract).
    const appendExtended = (type: string, data: unknown, ...rest: unknown[]) =>
      Reflect.apply(session.append, session, [type, data, ...rest] as Parameters<typeof session.append>)
    appendExtended('permission/preset', { preset: 'workspace-write' })
    appendExtended('sandbox/mode', { mode: 'workspace-write' })
    appendExtended('approval/policy', { policy: 'ask' })

    const persistence = getPersistence(this.svcCtx)
    let stored: EchoPersistenceHandle | undefined
    if (persistence !== undefined) {
      options.signal?.throwIfAborted()
      stored = await persistence.create(session.header, {
        inheritedEventCount: session.inheritedEventCount,
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      // Pre-publication events (the opening set above) never re-emit through
      // session/event, so flush them through the handle before announce —
      // the same suffix-flush contract as upstream.
      const suffix = session.snapshotEvents(SessionLogOffset(0))
      if (suffix.length > 0) await stored.append([...suffix])
    }

    return this.setupAndPublish(ownerCtx, session, options, 'startup', stored)
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = getPersistence(this.svcCtx)
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    options.signal?.throwIfAborted()
    const id = options.resumeSessionId
    const handle = await persistence.open(id, 'write', {
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    let session: Session
    try {
      const coldRead = await handle.read(0, undefined, {
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      options.signal?.throwIfAborted()
      const closers = interruptedTurnClosers(coldRead.events)
      if (closers.length > 0) await handle.append(closers)
      session = this.svcCtx.sessions.prepare(id, {
        seed: [...coldRead.events, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: coldRead.eventState,
      })
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
    return this.setupAndPublish(ownerCtx, session, options, 'resume', handle)
  }

  private async setupAndPublish(
    ownerCtx: Context,
    session: Session,
    options: CreateAgentOptions | ResumeAgentOptions,
    source: SessionStartSource,
    stored: EchoPersistenceHandle | undefined,
  ): Promise<AgentHandle> {
    // The agent's scoped world must root in OUR plugin ctx (injects sessions
    // etc.); ownerCtx (request-scoped, no injects) is only the ownership caller.
    const agent = new EchoAgent(this.svcCtx, options.agentOptions ?? {}, session)
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposed = false
    // Lifecycle ownership: register under OUR plugin context (svcCtx), NOT the
    // caller's ownerCtx. ownerCtx is request-scoped — entering the session and
    // agent there unwinds them when the RPC request ends, so a turn completing
    // after the response appends to a DETACHED session (memory-only, no
    // session/event dispatch, nothing persists, and the next prompt re-resumes).
    // Upstream enters both under agent.ctx / the loop's own ctx: the agent
    // outlives requests, living under the plugin's fiber until unload.
    const dispose = this.svcCtx.effect(() => () => {
      if (disposed) return
      disposed = true
      agent.dispose()
      detachAgent?.()
      detachSession?.()
      void stored?.close().catch(() => {})
    }, `agent-loop-echo.lifecycle(${session.id})`)
    try {
      // Setup is compose-only; the optional sync commit runs at the exact
      // publication boundary (upstream AgentSetup contract).
      const setupCommit = await options.setup?.(agent.ctx)
      options.signal?.throwIfAborted()
      setupCommit?.commit()
      // Publication order mirrors upstream agent-loop's publish():
      // enter both, announce session, announce agent, then session-start.
      detachSession = agent.ctx.sessions.enter(session)
      detachAgent = this.svcCtx.agents.enter(agent, ownerCtx.agent)
      agent.ctx.sessions.announce(session)
      this.svcCtx.agents.announce(agent)
      agent.emitSessionStart(source)
    } catch (error) {
      dispose()
      throw error
    }
    return { agent, dispose }
  }
}
