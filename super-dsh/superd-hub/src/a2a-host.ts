/**
 * A2A host assembly (mesh P3 Task 3): wires Task 2's pure conversation
 * service to the hub's live surfaces — the gatewayFor resolution over the
 * P2 federation table and the local target registry, plus the LOCAL
 * machine's initiator identity.
 *
 * Resolution order (the carrier precedent, gateway.ts:87 —
 * `federatedGatewayOf(label) ?? getTarget(label)`):
 *   1. FEDERATED rows: the P2 mesh-federate memo table by a6
 *      (`federatedGatewayOf`) — remote machines' agents, owner-minted a6
 *      adopted verbatim.
 *   2. FEDERATED a6s in the SHARED target registry — `federateAgents`
 *      registers the same pair (same gateway instance) into both stores, so
 *      a cold memo still resolves; locals are keyed by runtime key, never by
 *      a6, so this step never hits a local row.
 *   3. LOCAL rows: the a6 id store (`agent-ids.json`, roster key → a6)
 *      inverted to the world's runtime key, then `getTarget(key)` — the
 *      world's typertGateway service instance. The LOCAL 'native' row has no
 *      registry target ('native' is the implicit first key of
 *      `listRuntimeKeys` and the `/hub` family is foreign-only): its
 *      session-plane face is the hub process's own in-process gateway,
 *      INJECTED here by the plugin wiring.
 *
 * The initiator identity is the REAL machine/agent ids: machine = the
 * owner-minted self m4 (`machines.json`), agent = the roster a6 of the
 * world whose DSH session made the tool call (T4 supplies the live session
 * id from the tool call's agent context; T3 only builds the envelope).
 */
import { agentIdMap, ensureAgentId } from './agent-ids.js'
import { ensureSelf, listRemotes } from './machines.js'
import { agentLinks } from './agent-roster.js'
import { federatedGatewayOf } from './mesh-federate.js'
import { getTarget } from './targets.js'
import { createA2aService } from './a2a-service.js'
import { A2aAddressError } from './a2a-service.js'
import type { A2aAddress, A2aGateway, A2aInitiator, A2aService } from './a2a-service.js'
/** Host wiring inputs: the hub home plus the local native session-plane face. */
export interface A2aHostOptions {
  /** Hub home (a6 id store + machines registry live under `<home>/superd/`). */
  home: string
  /**
   * ctx0's own RAW in-process typertGateway instance — serves the LOCAL
   * 'native' row (its a6); injected by the plugin wiring, undefined before
   * the hub process has its own face. Bridged to T2's face by the resolver
   * ({@link bridgeTypertGateway}).
   */
  nativeGateway?: RawTypertGatewayFace
  /**
   * LAZY provider of ctx0's owner browser Peer (connection.browserPeer) —
   * 0.2.1 gateways read peer.signal/principal on every invocation. A
   * provider, not a value: typertGateway mounts before connection, so a
   * wiring-time read would capture undefined forever; resolution happens
   * per call, when connection is long live.
   */
  nativePeer?: () => unknown
}

/**
 * The roster key (world runtime key) owning one a6 in the LOCAL id store —
 * read-only (never mints): resolution must observe, not mutate.
 */
function localKeyOfA6(home: string, a6: string): string | undefined {
  for (const [key, id] of Object.entries(agentIdMap(home))) {
    if (id === a6) return key
  }
  return undefined
}

/**
 * The RAW typertGateway service face — upstream canonical stream order
 * `openWireStream(endpoint, payload, uplink, peer, signal, control)`
 * (dsh-api-gateway/src/index.ts:434; the 0.1.3-j positional-misbind lesson).
 * LOCAL worlds and ctx0's own row hand out RAW instances (world-join.ts
 * registers `ctxW.get('typertGateway')` verbatim); FEDERATED rows hand out
 * mesh-gateway wire adapters (dual-face, 3rd-argument dispatch).
 */
export interface RawTypertGatewayFace {
  dispatchRpc(endpoint: string, payload: unknown, signal: AbortSignal, peer: unknown): Promise<unknown>
  openWireStream(
    endpoint: string,
    payload: unknown,
    uplink: undefined,
    peer: unknown,
    signal: AbortSignal,
    control: AbortController,
  ): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>
}

/**
 * Bridge one RAW typertGateway instance to Task 2's 3-arg `A2aGateway` face
 * (fix round 1, 2026-09-28 review: the positional mismatch stranded completion
 * streams). `uplink: undefined` is the canonical NO-LANE spelling upstream —
 * the gateway substitutes `EMPTY_ASYNC_ITERABLE` itself
 * (dsh-api-gateway/src/index.ts:712) — and `dispatchRpc` passes through as-is.
 *
 * FEDERATED WIRE ADAPTERS MUST NOT BE WRAPPED: mesh-gateway's dual-face
 * dispatch reads the THIRD argument (`isUplinkLane(undefined)` → false), so a
 * canonical 6-arg call would take its 3-arg branch and read the abort signal
 * from position 3 (undefined) — silently losing cancellation. The resolver
 * therefore passes federated rows through untouched.
 * @param real - a raw in-process typertGateway instance (ctx0's own or a local world's).
 * @returns the gateway Task 2's service consumes.
 */
export function bridgeTypertGateway(real: RawTypertGatewayFace, peer?: unknown): A2aGateway {
  return {
    dispatchRpc: (endpoint, payload, signal) => real.dispatchRpc(endpoint, payload, signal, peer),
    openWireStream: (endpoint, payload, signal) =>
      real.openWireStream(endpoint, payload, undefined, peer, signal, new AbortController()),
  }
}

/**
 * Build the gatewayFor resolver Task 2's service consumes: federated table
 * first, shared target registry second, local id-map inversion third,
 * injected native face last. LOCAL rows (runtime-key targets + the native
 * seam) are RAW instances and get {@link bridgeTypertGateway}; FEDERATED rows
 * (federation memo + a6-keyed registry entries) are wire adapters and pass
 * through UNTOWRAPPED (see the bridge's JSDoc for why wrapping them loses
 * the abort signal).
 *
 * A MISS THROWS the typed {@link A2aAddressError} (D7): a roster-known a6 whose
 * plane is down → 'unreachable'; an a6 no store has ever seen → 'unknown-agent'
 * when the addressed machine is self or paired, else 'unknown-machine' — the
 * WHY survives the resolver boundary for future consumers (P4 exec, P5
 * injection) to branch on.
 * @param options - hub home + optional raw in-process native gateway.
 * @returns the resolver (a gateway, or it throws A2aAddressError).
 */
export function resolveA2aGatewayFor(options: A2aHostOptions): (addr: A2aAddress) => A2aGateway {
  return (addr) => {
    const federated = federatedGatewayOf(addr.id)
    if (federated !== undefined) return federated
    const registered = getTarget(addr.id)?.gateway
    if (registered !== undefined) return registered
    const key = localKeyOfA6(options.home, addr.id)
    if (key !== undefined) {
      if (key === 'native') {
        if (options.nativeGateway === undefined) throw new A2aAddressError('unreachable', addr)
        return bridgeTypertGateway(options.nativeGateway, options.nativePeer?.())
      }
      // The registry's declared GatewayFace (targets.ts) types the stream
      // face as the 3-arg subset, but a LOCAL row's runtime object is the RAW
      // typertGateway instance (world-join.ts registers it verbatim) — re-cast
      // to RawTypertGatewayFace so the bridge above binds the canonical 6-arg
      // positional order instead of the declared subset.
      const target = getTarget(key)
      if (target?.gateway === undefined) throw new A2aAddressError('unreachable', addr)
      return bridgeTypertGateway(target.gateway as unknown as RawTypertGatewayFace, target.peer)
    }
    // The a6 resolves nowhere — classify the miss (D7): a roster row exists →
    // its plane is down; else the machine decides agent-vs-machine blame.
    if (agentLinks(options.home).some((l) => l.id === addr.id)) throw new A2aAddressError('unreachable', addr)
    const self = ensureSelf(options.home, 'local')
    if (addr.machine === self.id || listRemotes(options.home).some((r) => r.id === addr.machine)) {
      throw new A2aAddressError('unknown-agent', addr)
    }
    throw new A2aAddressError('unknown-machine', addr)
  }
}

/**
 * Build the LOCAL machine's initiator identity from the calling world's
 * roster key and the live DSH session driving the tool call.
 * @param home - hub home (self m4 + a6 id store).
 * @param agentKey - roster key of the calling world ('native' for ctx0's own agent).
 * @param sessionId - the live DSH session id making the call (T4: the tool call's agent context).
 * @returns the initiator envelope Task 2's service teaches the peer.
 */
export function localA2aInitiator(home: string, agentKey: string, sessionId: string): A2aInitiator {
  return {
    machine: ensureSelf(home, 'local').id,
    agent: ensureAgentId(home, agentKey),
    sessionId,
  }
}

/**
 * Assemble the full A2A service on the hub's live surfaces: Task 2's pure
 * core with the host gatewayFor resolution (delivery glue is per-conversation
 * — T4's tool wires `wireCompletionToDelivery` after each send).
 * @param options - hub home + optional in-process native gateway.
 * @returns the A2A conversation service.
 */
export function createA2aHost(options: A2aHostOptions): A2aService {
  return createA2aService({ home: options.home, gatewayFor: resolveA2aGatewayFor(options) })
}
