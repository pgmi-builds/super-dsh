import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { getTraceable, symbols } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { readKey } from './routing.js'
import { registerRuntimeKeyRpc } from './rpc.js'

/**
 * Multi-slot {@link AgentRegistry}: the upstream single `#factory` slot is
 * replaced by a keyed factory map. Occupies the `agents` service purely by
 * inheritance — the cordis `Service` base constructor re-runs
 * `reflect.provide('agents', this)` for this subclass, and the accompanying
 * `cordis.patch.yml` repoints the base bundle's `id: agent` line here.
 *
 * M0 shape: routing always resolves to the `native` slot (the upstream
 * agent-loop registers through the `setFactory` compatibility leg), so
 * behavior is a transparent passthrough. M1 adds the routing-key side table
 * (routing.ts): per-session keys select the slot at delivery time.
 */
export default class MultiAgentRegistry extends AgentRegistry {
  constructor(ctx: Context) {
    super(ctx)
    // RPC face for the routing key (M1 Task 5): mounts /api/agent-runtime on
    // the shared connection channel (behind the standard auth fence); a no-op
    // when the connection service is absent (fake-ctx unit tests).
    registerRuntimeKeyRpc(ctx, this)
  }
  // TS-private ORDINARY members, not `#` privates: cordis service proxies
  // delegate property access via the prototype chain, and `#` fields AND
  // methods are per-instance brands only the real constructor can install —
  // so any member invoked through a proxy receiver fails the brand check
  // ("Receiver must be an instance of class MultiAgentRegistry"). Upstream
  // uses TS-private ordinary members throughout; no `#` fields OR methods on
  // cordis Service subclasses.
  // pattern (a plain property, not a private field) exists for exactly this.
  private factories = new Map<string, AgentFactory>()
  private staleKeyWarnings = new Set<string>()

  /**
   * Compatibility leg: the upstream agent-loop constructor calls this by
   * hard-coded name; it lands in the `native` slot. Same-key fail-loud is
   * preserved (upstream threw on any second factory; we throw per key).
   */
  setFactory(factory: AgentFactory): () => void {
    return this.append('native', factory)
  }

  /**
   * Multi-slot registration entry point for foreign agent loops.
   * Same-key fail-loud (dsh composition-surface discipline).
   */
  /**
   * Multi-slot registration entry point for foreign agent loops.
   * Same-key fail-loud (dsh composition-surface discipline).
   */
  appendFactory(key: string, factory: AgentFactory): () => void {
    return this.append(key, factory)
  }

  /**
   * Registered factory keys (the runtime-key face: this IS the list of
   * routable agent runtimes). Public for the RPC layer; order unspecified.
   */
  listFactories(): string[] {
    return [...this.factories.keys()]
  }
  private append(key: string, factory: AgentFactory): () => void {
    if (this.factories.has(key)) throw new Error(`an agent factory is already registered for "${key}"`)
    // Avoid stacking two Cordis shadow layers when a caller passes a Service
    // already read through a context. Calls are re-traced through their
    // actual owner context in create/resume (getTraceable) — same rationale
    // as upstream setFactory's canonicalization.
    const target = (factory as AgentFactory & { [symbols.original]?: AgentFactory })[symbols.original] ?? factory
    this.factories.set(key, target)
    // Effect semantics copied from upstream setFactory: the registration fiber's
    // unload removes the slot; the exact effect disposer is returned so a
    // caller's composite effect can yield it for in-order teardown.
    const dispose = this.ctx.effect(() => {
      return () => {
        if (this.factories.get(key) !== target) return
        this.factories.delete(key)
      }
    }, `agents.append(${key})`)
    return dispose
  }

  /**
   * Delivery-time routing resolution; never touches fiber lifecycles.
   * Key comes from the registry-owned side table (routing.ts): a missing key
   * or a key whose factory got unregistered degrades to `native` (a single
   * warn per stale key — delivery must not die because a runtime went away).
   * Only the total absence of any factory (native itself missing) throws.
   */
  private resolve(sessionId: SessionId): AgentFactory {
    const key = readKey(sessionId) ?? 'native'
    let factory = this.factories.get(key)
    if (factory === undefined && key !== 'native') {
      // Degrade gracefully: optional logger (fake-ctx tests carry none).
      const logger = (this.ctx as { logger?: { warn(...args: unknown[]): void } }).logger
      if (!this.staleKeyWarnings.has(key)) {
        this.staleKeyWarnings.add(key)
        logger?.warn(`agents: runtime "${key}" is not registered; delivering session ${sessionId} to native`)
      }
      factory = this.factories.get('native')
    }
    if (factory === undefined) throw new Error('no agent factory registered (load an agent-loop plugin)')
    return factory
  }

  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    const target = this.resolve(options.sessionId)
    const receiver = getTraceable(ownerCtx, target)
    return Reflect.apply(target.createAgent, receiver, [ownerCtx, options])
  }

  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    const target = this.resolve(options.resumeSessionId)
    const receiver = getTraceable(ownerCtx, target)
    return Reflect.apply(target.resume, receiver, [ownerCtx, options])
  }

}
