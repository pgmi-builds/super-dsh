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
 * The stream-face bridge: T2's `A2aGateway` declares a 3-arg
 * `openWireStream(endpoint, payload, signal)`, but a RAW typertGateway
 * instance speaks the upstream canonical 6-arg order
 * `openWireStream(endpoint, payload, uplink, peer, signal, control)`
 * (dsh-api-gateway/src/index.ts:434; the 0.1.3-j lesson — positional
 * misbinding strands streams forever). This row hands the RAW ctx0
 * instance to `createA2aHost`. NOTE: T3's resolver hands LOCAL world rows
 * from the shared target registry RAW (world-join.ts registers the instance
 * verbatim) — fixed in round 1 (2026-09-28 review): the resolver now bridges
 * ALL local rows + the native seam through the shared `bridgeTypertGateway`
 * (a2a-host.ts), and FEDERATED wire adapters pass through unwrapped.
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createSuperdHubTool } from './hub-tool.js'
import { createA2aIngest, type A2aIngest } from './a2a-ingest.js'
import { statusSweepLegs, loadAgentStatus } from './agent-status.js'
import { setSweepCollectors } from './mesh-link.js'
import { formatA2aLogLine, type A2aLogFn } from './a2a-log.js'
import { createA2aService } from './a2a-service.js'
import { resolveA2aGatewayFor, localA2aInitiator } from './a2a-host.js'
import { registerA2aRpc, registerExecRpc } from './mesh-rpc.js'
import { runOneShotExec, postOneShotExec } from './exec.js'
import { ensureSelf, listRemotes } from './machines.js'
import { cookieOf } from './mesh-link.js'
import type { HubToolExecFace, HubRosterView } from './hub-tool.js'
import type { RawTypertGatewayFace } from './a2a-host.js'
import type { A2aAgentHandle, A2aDeliveryCtx } from './a2a-delivery.js'
import type { A2aGateway } from './a2a-service.js'
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
    // RAW instance in, bridged at the resolver (fix round 1: one shared
    // bridge in a2a-host.ts covers the native seam AND all local world rows).
    const raw = t.get('typertGateway') as RawTypertGatewayFace | undefined
    // postoffice R4: ONE resolver, ONE ingest, TWO consumers — the initiator
    // service's self-routing leg calls the very same ingest handler the HTTP
    // endpoint calls (protocol-identical by construction). The service takes
    // a LAZY provider: the ingest's delivery face buffers through the
    // service's own buffer leg, so it can only be built after the service.
    const gatewayFor = resolveA2aGatewayFor({ home, nativeGateway: raw })
    // Operational journal: the pure modules only format lines; this is
    // where they meet the process console and land in the unit log (4999 rig
    // / dev3 dsh.service journal). NOT ctx.logger: the pack composes no
    // cordis logger-console exporter, so ctx.logger records go nowhere
    // (verified live 2026-09-29 — zero a2a lines through a full envelope
    // flow). Console matches the world-join/world-provision precedent for
    // operational lines. One line per machine event, no secrets.
    const alog: A2aLogFn = (level, event, fields) => {
      const line = formatA2aLogLine(event, fields)
      if (level === 'warn') console.warn(line)
      else if (level === 'error') console.error(line)
      else console.log(line)
    }
    let ingestRef: A2aIngest | undefined
    const service = createA2aService({ home, gatewayFor, ingest: () => ingestRef, log: alog })
    const delivery: A2aDeliveryCtx = {
      agents: { get: (sessionId) => liveAgentHandle(ctx, sessionId) },
      buffer: (initiatorSessionId, message) => { service.buffer(initiatorSessionId, message) },
    }
    ingestRef = createA2aIngest({ home, gatewayFor, delivery, log: alog })
    // postoffice R5: the sweep's dual-responsibility legs (outbox pull +
    // session-list collection) over THIS assembly — registered process-level;
    // gateway.ts's existing sweep timer picks them up (no second timer).
    setSweepCollectors(statusSweepLegs({ home, gatewayFor, ingest: ingestRef }))
    // the a2a endpoints (POST /api/superd/a2a + GET outbox) ride the shared
    // /api fence like the machines route; registered on the same inject scope
    // (they live and die with the typertGateway seam).
    registerA2aRpc(t, ingestRef)
    // P4: the exec endpoint rides the same shared /api fence (spec §8.1).
    registerExecRpc(t, alog)
    // P4 exec face: the local executing side + the wire leg over the pairing
    // cookie. The initiator-side per-machine knob (execEnabled) is honored
    // here, before any bytes leave (spec §5).
    const execFace: HubToolExecFace = {
      selfM4: () => ensureSelf(home, 'local').id,
      run: (input) => runOneShotExec(input, alog),
      post: async (machineId, input) => {
        const row = listRemotes(home).find((r) => r.id === machineId)
        if (row === undefined) throw new Error(`unknown machine "${machineId}" — call agents for the roster`)
        if (row.execEnabled === false) throw new Error(`exec is disabled for machine "${machineId}" on this registry row (execEnabled=false)`)
        alog?.('info', 'exec.remote', { machine: machineId, cmd: input.cmd, timeoutSec: input.timeoutSec ?? 120 })
        const result = await postOneShotExec(row.origin, input, { cookie: cookieOf(row.id, home) })
        // F6 (first-person 0.1.7-d finding): the initiator side needs its own
        // completion line — without it a remote result lives only in the tool
        // response and the initiator's journal stays blind to the outcome.
        alog?.('info', 'exec.remote.done', {
          machine: machineId,
          exit: result.exit ?? 'none',
          durationMs: result.durationMs,
          ...(result.outcome === 'exited' ? {} : { outcome: result.outcome }),
          ...(result.truncated ? { truncated: true } : {}),
        })
        return result
      },
    }
    // the a2a endpoints (POST /api/superd/a2a + GET /api/superd/a2a/outbox) ride the shared
    t.tools.register(createSuperdHubTool({
      service,
      delivery,
      exec: execFace,
      // R6: the agent_status leg reads the R5 cache (the sweep's legs fill it)
      status: () => loadAgentStatus(home),
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
