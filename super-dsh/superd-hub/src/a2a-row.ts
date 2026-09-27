/**
 * `super-dsh/a2a` — the SuperD Hub TOOL row (mesh P3 Task 4, spec §9):
 * composes the single model-facing `superd-hub` tool onto ctx0's `tools`
 * service and closes T3's `nativeGateway` seam with the hub process's OWN
 * in-process session-plane gateway.
 *
 * WHY A SUBPATH ROW (documented ruling, not riding the bare `superd-hub`
 * row): world trees compose the `superd-hub` row too (world-mount.ts
 * `WORLD_HUB_ROW`) and they DO provide a `tools` service (the base web-app
 * composition's `tools` row is not in the wave-1/wave-2 disable lists) — so
 * riding gateway.ts's apply would register a mis-wired A2A tool inside every
 * world (its `nativeGateway` would be THAT WORLD's typertGateway, while the
 * 'native' a6 belongs to ctx0's agent). The pack's precedent for an
 * explicitly-composed capability is the subpath row (web-trust,
 * fusion-transport — "composing this row IS the switch"): this row lives
 * only in the pack's own cordis.patch.yml, which world profiles never
 * compose (world-provision.ts `WORLD_BASE_BUNDLES`), so it mounts in ctx0
 * only — exactly the P3 initiator surface (native DSH sessions; foreign
 * runtimes get their own injection in P5, spec §10). Individually
 * toggleable per the pack's row discipline.
 *
 * Dormancy (better-dash plugin.ts discipline): zero static injects; the
 * dynamic `ctx.inject(['tools', 'typertGateway'])` keeps the row dormant —
 * and side-effect-free — until BOTH the tool registry and ctx0's session
 * plane exist. `tools.register` scopes the registration to the calling
 * fiber, so the tool unregisters with the row.
 *
 * The native seam bridge: T2's `A2aGateway` declares a 3-arg
 * `openWireStream(endpoint, payload, signal)`, but a RAW typertGateway
 * instance speaks the upstream canonical 6-arg order
 * `openWireStream(endpoint, payload, uplink, peer, signal, control)`
 * (dsh-api-gateway/src/index.ts:434; the 0.1.3-j lesson — positional
 * misbinding strands streams forever). `bridgeTypertGateway` below feeds the
 * canonical order with an immediately-done uplink: session-plane traffic is
 * downstream-only. NOTE: T3's resolver hands LOCAL world rows from the
 * shared target registry RAW (world-join.ts registers the instance
 * verbatim), so completion streams over LOCAL worlds still need the same
 * bridge at that layer — reported for T5; this row owns only ctx0's seam.
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createSuperdHubTool } from './hub-tool.js'
import type { HubRosterView } from './hub-tool.js'
import { createA2aHost, localA2aInitiator } from './a2a-host.js'
import type { A2aAgentHandle, A2aDeliveryCtx } from './a2a-delivery.js'
import type { A2aGateway } from './a2a-service.js'
import { ensureSelf, listRemotes } from './machines.js'
import { agentLinks } from './agent-roster.js'

/** Stable Cordis plugin (row) name. */
export const name = 'superd-a2a'

/** Zero static injects — the tools/typertGateway legs are dynamic (dormancy). */
export const inject: string[] = []

/** Injection seam for tests: a tmpdir home instead of the ambient/prod DSH_HOME (rpc.ts discipline). */
export interface HubToolRowOptions {
  /** Hub home backing the registries; defaults to `resolveDshHome()` at wiring time. */
  home?: string
}

/** The RAW typertGateway service face — upstream canonical 6-arg stream order. */
interface RawTypertGatewayFace {
  dispatchRpc(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown>
  openWireStream(
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    peer: undefined,
    signal: AbortSignal,
    control: AbortController,
  ): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>
}

/** A fresh immediately-done uplink: session-plane streams are downstream-only. */
function emptyUplink(): AsyncIterable<unknown> {
  return (async function*() { })()
}

/**
 * Bridge one raw typertGateway instance to T2's 3-arg `A2aGateway` face.
 * The remote-wire gateways (mesh-gateway) already accept BOTH faces via
 * their 3rd-argument dispatch, so a canonical call is safe there too — this
 * bridge is the ONE spelling for raw in-process instances.
 * @param real - ctx0's own typertGateway service instance.
 * @returns the gateway T2's service consumes.
 */
export function bridgeTypertGateway(real: RawTypertGatewayFace): A2aGateway {
  return {
    dispatchRpc: (endpoint, payload, signal) => real.dispatchRpc(endpoint, payload, signal),
    openWireStream: (endpoint, payload, signal) =>
      real.openWireStream(endpoint, payload, emptyUplink(), undefined, signal, new AbortController()),
  }
}

/** The live-agent registry face (structural subset of ctx.agents / AgentRegistry). */
interface AgentRegistryFace {
  get(sessionId: string): unknown
}

/**
 * Resolve one initiator's live agent handle. Read LAZILY at delivery time
 * (`ctx.get`, no declaration): the registry's availability must not gate the
 * row, and the runtime Agent object carries followup/steer/inject even though
 * its public type surface says `{id}` (dsh-agent runtime-types.ts interface
 * merge — compile-time only, one object at runtime; T3's A2aAgentHandle is
 * its structural subset).
 */
function liveAgentHandle(ctx: Context, sessionId: string): A2aAgentHandle | undefined {
  const registry = ctx.get('agents') as AgentRegistryFace | undefined
  const agent = registry?.get(sessionId)
  return agent === undefined || agent === null ? undefined : (agent as A2aAgentHandle)
}

/** The default roster view over the hub home (the /api/agent-runtime facts). */
function rosterViewOf(home: string): HubRosterView {
  return {
    self: ensureSelf(home, 'local'),
    remotes: listRemotes(home).map((row) => ({ id: row.id, label: row.label !== '' ? row.label : row.name })),
    agents: agentLinks(home),
  }
}

/**
 * Wire the tool row: build T2+T3's service with ctx0's own gateway injected
 * at the native seam, then register the `superd-hub` tool once the `tools`
 * service and the session plane are both live.
 * @param ctx - the hub host root context (ctx0).
 * @param opts - optional home override (tests inject a tmpdir).
 */
export function wireHubToolRow(ctx: Context, opts: HubToolRowOptions = {}): void {
  const home = opts.home ?? resolveDshHome()
  ctx.inject(['tools', 'typertGateway'], (t) => {
    const raw = t.get('typertGateway') as RawTypertGatewayFace | undefined
    const service = createA2aHost({ home, nativeGateway: raw === undefined ? undefined : bridgeTypertGateway(raw) })
    const delivery: A2aDeliveryCtx = {
      agents: { get: (sessionId) => liveAgentHandle(ctx, sessionId) },
      buffer: (initiatorSessionId, message) => { service.buffer(initiatorSessionId, message) },
    }
    t.tools.register(createSuperdHubTool({
      service,
      delivery,
      roster: () => rosterViewOf(home),
      // This row mounts in ctx0 only (header ruling): every caller is a
      // native DSH session, so the initiator's a6 is the 'native' row's.
      initiatorOf: (sessionId) => localA2aInitiator(home, 'native', sessionId),
      onWatch: (dispose) => { ctx.effect(() => dispose, 'superd-a2a: a2a completion watch') },
    }))
  })
}

/** MUST stay an arrow (RM0/better-dash note: function declarations get `new`-called, disposers lost). */
export const apply = (ctx: Context): void => {
  wireHubToolRow(ctx)
}

export default { name, inject, apply }
