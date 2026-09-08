import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { getTraceable } from '@deepseek-ai/cordis'

/**
 * Multi-slot {@link AgentRegistry}: the upstream single `#factory` slot is
 * replaced by a keyed factory map. Occupies the `agents` service purely by
 * inheritance — the cordis `Service` base constructor re-runs
 * `reflect.provide('agents', this)` for this subclass, and the accompanying
 * `cordis.patch.yml` repoints the base bundle's `id: agent` line here.
 *
 * M0 shape: routing always resolves to the `native` slot (the upstream
 * agent-loop registers through the `setFactory` compatibility leg), so
 * behavior is a transparent passthrough. M1 will source routing keys from
 * header config.runtime / RPC side-channel in resolve.
 */
export default class MultiAgentRegistry extends AgentRegistry {
  // TS-private ORDINARY members, not `#` privates: cordis service proxies
  // delegate property access via the prototype chain, and `#` fields AND
  // methods are per-instance brands only the real constructor can install —
  // so any member invoked through a proxy receiver fails the brand check
  // ("Receiver must be an instance of class MultiAgentRegistry"). Upstream
  // uses TS-private ordinary members throughout; no `#` fields OR methods on
  // cordis Service subclasses.
  // pattern (a plain property, not a private field) exists for exactly this.
  private factories = new Map<string, AgentFactory>()

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
  appendFactory(key: string, factory: AgentFactory): () => void {
    return this.append(key, factory)
  }

  private append(key: string, factory: AgentFactory): () => void {
    if (this.factories.has(key)) throw new Error(`an agent factory is already registered for "${key}"`)
    this.factories.set(key, factory)
    // Effect semantics copied from upstream setFactory: the registration fiber's
    // unload removes the slot; the exact effect disposer is returned so a
    // caller's composite effect can yield it for in-order teardown.
    const dispose = this.ctx.effect(() => {
      return () => {
        if (this.factories.get(key) !== factory) return
        this.factories.delete(key)
      }
    }, `agents.append(${key})`)
    return dispose
  }

  /**
   * Delivery-time routing resolution; never touches fiber lifecycles.
   * M0: no routing-key source exists yet, so always `native`. M1 hooks
   * header config.runtime / RPC side-channel here.
   */
  private resolve(_sessionId: SessionId): AgentFactory {
    const factory = this.factories.get('native')
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
