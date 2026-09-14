import { readSelector } from './selector.js';
import { registerSelectorRpc, registryTargets } from './rpc.js';
import { getTarget } from './targets.js';
/** Temporary ground-truth logger: which world answered what (remove after V5 diagnosis). */
function logRouting(kind, selector, endpoint) {
    const line = `[routing] ${kind} ${endpoint} selector=${selector} -> ${selector === 'native' ? 'CTX0' : 'CTX1'}\n`;
    process.stderr.write(line);
}
/** Marker guarding against double-wrap across inject re-runs. */
const WRAPPED = Symbol.for('superd.multi-agent-routing.wrapped');
/** Stable Cordis plugin name. */
export const name = 'multi-agent-routing';
/** Resolve the gateway instance a call belongs to; undefined = misrouted. */
function resolveTarget(key) {
    if (key === 'native')
        return undefined; // handled by the caller (upstream)
    return getTarget(key)?.gateway;
}
export function apply(ctx) {
    // The selector control plane: always answered by CTX0 locally, never
    // delegated (it IS the switch, not the data).
    registerSelectorRpc(ctx, registryTargets);
    // Wrap the mounted gateway's two methods. inject re-runs if the gateway
    // service reloads; the marker prevents stacking.
    ctx.inject(['typertGateway'], (gwCtx) => {
        const service = (Reflect.get(gwCtx, 'typertGateway') ?? gwCtx.get('typertGateway'));
        if (service === undefined || typeof service.dispatchRpc !== 'function' || typeof service.openWireStream !== 'function') {
            throw new Error('multi-agent-routing: typertGateway service exposes no dispatchRpc/openWireStream — alignment round required');
        }
        if (service[WRAPPED] === true)
            return;
        const upstreamDispatch = service.dispatchRpc.bind(service);
        const upstreamStream = service.openWireStream.bind(service);
        service.dispatchRpc = async (endpoint, payload, signal) => {
            const key = readSelector();
            logRouting('rpc', key, endpoint);
            if (key === 'native')
                return upstreamDispatch(endpoint, payload, signal);
            const gateway = resolveTarget(key);
            if (gateway === undefined) {
                return {
                    ok: false,
                    error: {
                        code: 'gateway/routing-target-unavailable',
                        message: `multi-agent-routing: selector points at runtime ${JSON.stringify(key)} but no target is registered`,
                        details: { runtime: key },
                    },
                };
            }
            return gateway.dispatchRpc(endpoint, payload, signal);
        };
        service.openWireStream = (endpoint, payload, signal) => {
            const key = readSelector();
            logRouting('stream', key, endpoint);
            if (key === 'native')
                return upstreamStream(endpoint, payload, signal);
            const gateway = resolveTarget(key);
            if (gateway === undefined) {
                // A stream cannot return an error envelope; die loudly instead of
                // ever streaming the wrong world's events (purity over availability).
                return (async function* routingFailure() {
                    throw new Error(`multi-agent-routing: selector points at runtime ${JSON.stringify(key)} but no target is registered`);
                })();
            }
            return gateway.openWireStream(endpoint, payload, signal);
        };
        service[WRAPPED] = true;
    });
}
/** The plugin form (row contract): applied when the row mounts. */
export default apply;
