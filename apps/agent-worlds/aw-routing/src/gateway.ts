/**
 * Runtime Routing Gateway (V5) — instance delegation at the ONE node.
 *
 * Cartography (2026-09-10, source-mapped): the whole typed data plane runs
 * through ONE node — the typertGateway service — exposing exactly TWO
 * methods: `dispatchRpc` (every unary RPC) and `openWireStream` (every live
 * stream, including the `$events` Remote-event subscription). Its entire
 * upstream coupling is its owning Cordis context (`this.ctx.typert`,
 * `this.ctx.reflect`, discovery by the `typertRemote` marker — no hardcoded
 * service names) plus instance state (`this.remoteEvents`, registered by the
 * same tree's api-remotes). Zero business imports.
 *
 * Therefore the switch is: the selector picks WHICH context's gateway
 * INSTANCE a call lands on. Native → the upstream instance this plugin
 * mounts beside (original behavior, zero translation). Foreign → the target
 * context's instance via the same two methods — its ctx addressing AND its
 * instance state are correct by construction. No wire, no envelopes, no
 * protocol words, no endpoint names: this file must never grow any.
 *
 * Out-of-process targets (future: subprocess app runtimes, remote machines)
 * implement GatewayFace over the wire and plug into the same map.
 */
import type { Context } from '@deepseek-ai/cordis'
import { readSelector } from './selector.js'
import { registerSelectorRpc, registryTargets } from './rpc.js'
import { getTarget, type GatewayFace } from './targets.js'

type DispatchFace = GatewayFace['dispatchRpc']
type StreamFace = GatewayFace['openWireStream']

/** Temporary ground-truth logger: which world answered what (remove after V5 diagnosis). */
function logRouting(kind: string, selector: string, endpoint: string): void {
  const line = `[routing] ${kind} ${endpoint} selector=${selector} -> ${selector === 'native' ? 'CTX0' : 'CTX1'}\n`
  process.stderr.write(line)
}

/** Marker guarding against double-wrap across inject re-runs. */
const WRAPPED = Symbol.for('superd.multi-agent-routing.wrapped')

/** Stable Cordis plugin name. */
export const name = 'multi-agent-routing'

/** Resolve the gateway instance a call belongs to; undefined = misrouted. */
function resolveTarget(key: string): GatewayFace | undefined {
  if (key === 'native') return undefined // handled by the caller (upstream)
  return getTarget(key)?.gateway
}

export function apply(ctx: Context): void {
  // The selector control plane: always answered by CTX0 locally, never
  // delegated (it IS the switch, not the data).
  registerSelectorRpc(ctx, registryTargets)
  // Wrap the mounted gateway's two methods. inject re-runs if the gateway
  // service reloads; the marker prevents stacking.
  ctx.inject(['typertGateway'], (gwCtx) => {
    const service = (Reflect.get(gwCtx, 'typertGateway') ?? gwCtx.get('typertGateway')) as
      | (GatewayFace & { [WRAPPED]?: boolean })
      | undefined
    if (service === undefined || typeof service.dispatchRpc !== 'function' || typeof service.openWireStream !== 'function') {
      throw new Error('multi-agent-routing: typertGateway service exposes no dispatchRpc/openWireStream — alignment round required')
    }
    if (service[WRAPPED] === true) return
    const upstreamDispatch: DispatchFace = service.dispatchRpc.bind(service)
    const upstreamStream: StreamFace = service.openWireStream.bind(service)
    ;(service as { dispatchRpc?: DispatchFace }).dispatchRpc = async (endpoint, payload, signal) => {
      const key = readSelector()
      logRouting('rpc', key, endpoint)
      if (key === 'native') return upstreamDispatch(endpoint, payload, signal)
      const gateway = resolveTarget(key)
      if (gateway === undefined) {
        return {
          ok: false as const,
          error: {
            code: 'gateway/routing-target-unavailable',
            message: `multi-agent-routing: selector points at runtime ${JSON.stringify(key)} but no target is registered`,
            details: { runtime: key },
          },
        }
      }
      return gateway.dispatchRpc(endpoint, payload, signal)
    }
    ;(service as { openWireStream?: StreamFace }).openWireStream = (endpoint, payload, signal) => {
      const key = readSelector()
      logRouting('stream', key, endpoint)
      if (key === 'native') return upstreamStream(endpoint, payload, signal)
      const gateway = resolveTarget(key)
      if (gateway === undefined) {
        // A stream cannot return an error envelope; die loudly instead of
        // ever streaming the wrong world's events (purity over availability).
        return (async function* routingFailure(): AsyncIterable<unknown> {
          throw new Error(`multi-agent-routing: selector points at runtime ${JSON.stringify(key)} but no target is registered`)
        })()
      }
      return gateway.openWireStream(endpoint, payload, signal)
    }
    service[WRAPPED] = true
  })
}

/** The plugin form (row contract): applied when the row mounts. */
export default apply
