/**
 * Federation registrar (machine-mesh P2 Task 3): adopts a paired machine's
 * PROBED roster into the LOCAL registries, so a remote agent is addressable
 * and visible exactly like a local world:
 *
 *   targets.ts  `registerForeignTarget({key: a6, gateway})` — the a6-keyed
 *               wire gateway (Task 2's `createRemoteGateway`), so the `/hub`
 *               family demuxes `?agent=<a6>` to the peer's `/hub` family
 *               carrying the remote RUNTIME key (`?agent=codex` at the peer).
 *               The peer's NATIVE agent row federates the same way — its
 *               row carries a minted a6 plus `key:'native'`, and its gateway
 *               is built with the NATIVE face (Task 2's `face` option): the
 *               peer's ctx0 `/api` surface, no demux key — exactly how a
 *               browser ON the peer consumes its native DSH (the `/hub`
 *               family would 404 `?agent=native` as foreign-only).
 *   roster.ts   one row per agent: `{key: a6, label: '<Label> · <machine
 *               name>', machine: m4, ready, failed}` — `machine` set marks
 *               the row federated; `agentLinks` projects it into the UI rows.
 *
 * The a6 IS the local registration key (spec §3.2): runtime keys are NOT
 * reused across machines (a remote `codex` would collide with — and silently
 * replace — the local codex world), while a6s are owner-minted 6-char ids
 * adopted verbatim. EVERY row federates, the peer's native included — the
 * face selector is `agent.key === 'native'`, never an a6 test (only
 * `'native'` is pre-screened as a hard reserve). Cross-machine a6 collision
 * (two peers minting the same id, p ≈ 36⁻¹² per pair) and a6-vs-local-key
 * collision (p ≈ 36⁻⁶ per adoption) are accepted at P2 machine counts — the
 * registry replaces last-write-wins, same ruling as spec §3.1's m4 collision
 * roughness.
 *
 * ## Import direction (frozen): mesh-federate → {mesh-link, mesh-gateway,
 * ## roster, targets} — NEVER the reverse. mesh-link emits machine lifecycle
 * ## events (`onMeshFederationEvent`: federated / degraded / defederated);
 * ## this module subscribes at wiring time ({@link startMeshFederation},
 * ## called once from gateway.ts apply). mesh-rpc's DELETE path announces
 * ## removals through mesh-link's {@link emitMachineRemoved} — no route-module
 * ## federation logic anywhere.
 *
 * ## Gateway memo — one `RemoteGateway` per (m4, a6), built by the wiring's
 * ## factory, keyed by a6. Reused across probe events (identity-stable: a
 * ## reprobe does not rebuild a live gateway); rebuilt when the peer facts
 * ## change (origin moved, remote runtime key re-minted); disposed and
 * ## forgotten on defederate. The cookie is NOT memoized — the gateway reads
 * ## it per call through `cookieOf(m4, home)` (jar-fronted), so a re-minted
 * ## cookie is picked up by the NEXT call with zero rebuilds.
 *
 * ## Degrade semantics (spec §6.3): a failed probe KEEPS the machine's rows
 * ## and flips `ready` false — visible but not servable. Defederate (machine
 * ## removal) and stale-convergence (an agent vanished from the peer's
 * ## roster) are the only row-removing paths.
 */
import { createRemoteGateway, type RemoteGateway, type MuxClientSocket } from './mesh-gateway.js'
import { cookieOf, onMeshFederationEvent } from './mesh-link.js'
import type { MeshFederationEvent } from './mesh-link.js'
import { registerAgent, unregisterAgent, listAgents, setReady } from './roster.js'
import { registerForeignTarget, unregisterForeignTarget, getTarget, type GatewayFace } from './targets.js'

/** One remote agent as adopted from a probe — mesh-link's `ProbeAgent` shape
 *  (kept structural so callers and tests can pass plain objects). */
export interface FederatedAgent {
  /** The remote-owner-minted a6 — the LOCAL registration key. */
  id: string
  /** The remote RUNTIME key (`codex`, `omp`, …) — the peer's `?agent=` demux
   *  key on the wire; `'native'` selects the NATIVE face (peer ctx0 `/api`, no
   *  demux key) in the wiring's gateway factory. An EMPTY key cannot address
   *  anything at the peer; {@link gatewayFor} falls back to the a6 there
   *  (T3-M1) rather than shipping `?agent=` on the wire. */
  key: string

  label: string
  ready: boolean
  failed: boolean
}

/** The machine half of a federation fact (m4 + display name for label suffixes). */
export interface FederatedMachine {
  id: string
  name: string
}

/** Wiring deps: the hub home (cookie row fallback) + test seams for the wire. */
export interface FederationWireDeps {
  home: string
  fetchImpl?: typeof fetch
  wsFactory?: (url: string, headers: Record<string, string>) => MuxClientSocket
}

/** One memoized wire gateway + the peer facts it was built against. */
interface GatewayMemo {
  gateway: RemoteGateway
  machineId: string
  origin: string
  agentKey: string
  face: 'foreign' | 'native'
}

const gatewayMemo = new Map<string, GatewayMemo>()

/** Roster rows of one machine (its a6s), from the live registry. */
function rowsOf(m4: string): ReturnType<typeof listAgents> {
  return listAgents().filter((e) => (e.machine ?? 'local') === m4)
}

/** Unregister one federated a6 from both registries + drop its memo gateway. */
function dropA6(a6: string): void {
  if (listAgents().some((e) => e.key === a6)) unregisterAgent(a6) // guard: unregister no-ops still emit roster churn
  unregisterForeignTarget(a6)
  const memo = gatewayMemo.get(a6)
  if (memo !== undefined) {
    gatewayMemo.delete(a6)
    memo.gateway.dispose()
  }
}

/**
 * Register one machine's probed agents — IDEMPOTENT replace per a6: a row
 * whose key/label/machine/ready/failed all match the live registry is left
 * untouched (zero roster churn on repeated probes); a changed row is
 * unregistered then re-registered (`registerAgent` throws on duplicate keys —
 * federate always unregisters first, so repeated probes never throw).
 * Agents with an empty id (unkeyable) are skipped; EVERY keyed row
 * federates — the peer's native row included (its `key:'native'` selects the
 * native gateway face; see {@link gatewayFor}).
 * @param machine - the peer's identity (m4 + name; the name lands in every label suffix).
 * @param agents - the probe's agent snapshot (a6 `id`, remote `key`, label, ready, failed).
 * @param gatewayOf - gateway factory receiving the FULL agent row (the wiring
 * derives the face from `agent.key`; tests inject fakes) — called once per
 * (re)registration and once per converged-row target re-arm.
 */
export function federateAgents(machine: FederatedMachine, agents: FederatedAgent[], gatewayOf: (agent: FederatedAgent) => GatewayFace): void {
  for (const agent of agents) {
    if (agent.id === '') continue
    const desired = {
      key: agent.id,
      label: `${agent.label} · ${machine.name}`,
      machine: machine.id,
      ready: agent.ready === true,
      failed: agent.failed === true,
    }
    const existing = listAgents().find((e) => e.key === agent.id)
    if (
      existing !== undefined
      && existing.label === desired.label
      && existing.ready === desired.ready
      && (existing.failed ?? false) === desired.failed
      && (existing.machine ?? 'local') === machine.id
    ) {
      // Converged — but never trust a half-state: the roster row may survive
      // a target that something else dropped. Re-arm the registration only.
      if (getTarget(agent.id) === undefined) registerForeignTarget({ key: agent.id, gateway: gatewayOf(agent) })
      continue
    }
    if (existing !== undefined) unregisterAgent(agent.id) // defeats registerAgent's duplicate-key throw
    unregisterForeignTarget(agent.id) // explicit replace, not map-overwrite
    registerForeignTarget({ key: agent.id, gateway: gatewayOf(agent) })
    registerAgent(desired)
  }
}

/**
 * Drop EVERY federated row of one machine (mesh-rpc DELETE / unpair): roster
 * rows, target registrations, and the memoized wire gateways (disposed —
 * in-flight streams fail `gateway/disposed` per Task 2's contract).
 */
export function defederateMachine(m4: string): void {
  for (const row of rowsOf(m4)) dropA6(row.key)
  // Belt: memo entries whose roster rows vanished independently still die with the machine.
  for (const [a6, memo] of [...gatewayMemo]) {
    if (memo.machineId === m4) dropA6(a6)
  }
}

/**
 * Roster convergence: unregister the machine's rows whose a6s are ABSENT from
 * the peer's latest probe (the agent was removed/renamed remotely) — live
 * agents are left to {@link federateAgents}.
 * @param m4 - the machine id.
 * @param liveA6s - the a6 set of the latest successful probe.
 */
export function defederateStaleMachine(m4: string, liveA6s: ReadonlySet<string>): void {
  for (const row of rowsOf(m4)) {
    if (!liveA6s.has(row.key)) dropA6(row.key)
  }
}

/**
 * Degrade one machine's rows after a failed probe (unreachable peer or
 * auth-expired cookie): rows are KEPT, `ready` flipped false, `failed`
 * untouched — visible but not servable (spec §6.3; the orchestra downgrade).
 * Rows already degraded are left alone (no roster churn); local rows are
 * never touched.
 */
export function degradeMachine(m4: string): void {
  for (const row of rowsOf(m4)) {
    if (row.ready !== false) setReady(row.key, false)
  }
}

/**
 * The federated gateway of one a6 — the `/hub` demux's federation-table step
 * (exact a6 match; the same pair `federateAgents` registers into the shared
 * target registry, so the two sources never disagree). Undefined for local
 * labels and unknown/defederated a6s.
 */
export function federatedGatewayOf(a6: string): GatewayFace | undefined {
  return gatewayMemo.get(a6)?.gateway
}

/** The wiring's gateway factory: memoized per a6, rebuilt on peer-fact
 * change (origin, remote runtime key, or face flip). The FACE is selected
 * from the agent ROW — `key === 'native'` → the peer's ctx0 `/api` surface,
 * anything else → the `/hub` family with the runtime-key demux. */
function gatewayFor(event: Extract<MeshFederationEvent, { type: 'federated' }>, agent: FederatedAgent, deps: FederationWireDeps): RemoteGateway {
  const a6 = agent.id
  const face: 'foreign' | 'native' = agent.key === 'native' ? 'native' : 'foreign'
  // T3-M1: an empty remote key must not ride the wire as `?agent=` (the
  // nullish class miss — '' is not nullish); fall back to the a6 so the
  // registration stays addressable and the wrong key fails LOUDLY at the
  // peer (its demux 404s the unknown key) instead of silently here.
  const agentKey = agent.key !== '' ? agent.key : agent.id

  const memo = gatewayMemo.get(a6)
  if (memo !== undefined && memo.machineId === event.machineId && memo.origin === event.origin && memo.agentKey === agentKey && memo.face === face) {
    return memo.gateway
  }
  if (memo !== undefined) {
    gatewayMemo.delete(a6)
    memo.gateway.dispose()
  }
  const gateway = createRemoteGateway({
    origin: event.origin,
    agentKey,
    face,
    cookie: () => cookieOf(event.machineId, deps.home),
    fetchImpl: deps.fetchImpl,
    wsFactory: deps.wsFactory,
  })
  gatewayMemo.set(a6, { gateway, machineId: event.machineId, origin: event.origin, agentKey, face })
  return gateway
}

/**
 * Wire the registrar to mesh-link's machine lifecycle events (called ONCE at
 * plugin activation — gateway.ts apply):
 *
 *  - `federated` → {@link federateAgents} (converge onto the probe snapshot)
 *    + {@link defederateStaleMachine} (drop vanished agents);
 *  - `degraded` → {@link degradeMachine} (rows kept, ready=false);
 *  - `defederated` → {@link defederateMachine} (mesh-rpc DELETE).
 *
 * Re-probing a machine after a hub restart rebuilds its federation from the
 * probe alone — the events are the single rebuild path.
 * @returns the disposer (unsubscribes; registered rows are left as-is).
 */
export function startMeshFederation(deps: FederationWireDeps): () => void {
  return onMeshFederationEvent((event) => {
    if (event.type === 'federated') {
      federateAgents(
        { id: event.machineId, name: event.machineName },
        event.agents,
        (agent) => gatewayFor(event, agent, deps),
      )
      defederateStaleMachine(event.machineId, new Set(event.agents.map((a) => a.id)))
    } else if (event.type === 'degraded') {
      degradeMachine(event.machineId)
    } else {
      defederateMachine(event.machineId)
    }
  })
}
