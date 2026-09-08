/**
 * agent-loop-echo — the first ForeignAgent (echo Agent Loop).
 *
 * Registers an {@link EchoAgentFactory} under the `echo` routing key on the
 * M0 MultiAgentRegistry via `ctx.agents.appendFactory('echo', …)`. It NEVER
 * calls `setFactory`: the native loop keeps the `native` slot, and the
 * registry's same-key throw is the composition guard.
 *
 * Load order: this plugin `inject`s `agents`, and it requires the registry
 * plugin (`@pgmi-builds/dsh-multi-agent-registry`) to already occupy the
 * `agents` niche — apply() fails loud otherwise.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentFactory, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { EchoAgentFactory } from './external-agent.js'

export const name = 'agent-loop-echo'

/** Required services: the (multi-slot) agent registry. */
export const inject: string[] = ['agents', 'sessions', 'sessionPersistence']

/** The MultiAgentRegistry face this plugin programs against (M0 package). */
type MultiSlotAgents = AgentRegistry & {
  appendFactory(key: string, factory: AgentFactory): () => void
}

/**
 * Mount the echo Agent Loop in the `echo` factory slot.
 * @param ctx - plugin context (must see a MultiAgentRegistry as `ctx.agents`).
 */
export function apply(ctx: Context): void {
  const agents = ctx.agents as MultiSlotAgents
  if (typeof agents?.appendFactory !== 'function') {
    throw new Error("agent-loop-echo: ctx.agents is not a MultiAgentRegistry (load '@pgmi-builds/dsh-multi-agent-registry' before this plugin)")
  }
  ;(ctx as any).on?.('session/event', (s: { id: string }, e: { type: string }) => {
  })
  const factory = new EchoAgentFactory(ctx)
  // appendFactory is itself effect-scoped on the registry side; yield its exact
  // disposer from our own effect for in-order teardown symmetry (M0 pattern).
  ctx.effect(() => agents.appendFactory('echo', factory), 'agent-loop-echo.appendFactory()')
}

export { EchoAgent, EchoAgentFactory, echoContent, ECHO_TURN_DELAY_MS } from './external-agent.js'
export type { EchoPersistence, EchoPersistenceHandle } from './external-agent.js'
