import { readSelector, writeSelector } from './selector.js';
import { listRuntimeKeys } from './targets.js';
/** The shared-channel Fetch route path this RPC face owns. */
export const AGENT_RUNTIME_RPC_PATH = '/api/agent-runtime';
/** The live registry view: native plus every registered foreign context. */
export const registryTargets = {
    listRuntimes: listRuntimeKeys,
};
function json(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}
async function handle(request, source) {
    const available = source.listRuntimes();
    if (request.method === 'GET') {
        return json(200, { runtime: readSelector(), available });
    }
    // POST: app-level switch — one value for the whole world.
    let payload;
    try {
        payload = JSON.parse(await request.text());
    }
    catch {
        return json(400, { error: 'body must be valid JSON' });
    }
    const { runtime } = (payload ?? {});
    if (typeof runtime !== 'string' || runtime === '')
        return json(400, { error: 'runtime (string) is required' });
    if (!available.includes(runtime)) {
        return json(400, { error: `unknown runtime "${runtime}"`, available });
    }
    writeSelector(runtime);
    return json(200, { runtime, available });
}
/**
 * Register the selector RPC face on the shared `/api` connection channel
 * (behind the standard browser-trust + auth fence). No-op when the
 * `connection` service is absent (e.g. fake-ctx unit tests).
 */
export function registerSelectorRpc(ctx, source) {
    ctx.inject(['connection'], (connCtx) => {
        const fetchFace = Reflect.get(connCtx, 'connection')?.fetch;
        if (fetchFace === undefined)
            return; // connection not actually present (test ctx)
        connCtx.effect(() => fetchFace.register({
            path: AGENT_RUNTIME_RPC_PATH,
            methods: ['GET', 'POST'],
            requestBody: 'buffered',
            fetch: (request) => handle(request, source),
        }), 'multi-agent-routing: /api/agent-runtime route');
    });
}
