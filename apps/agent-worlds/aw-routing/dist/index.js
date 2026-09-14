/**
 * @pgmi-builds/multi-agent-routing — host half public surface.
 *
 * The app-level runtime selector + the Runtime Routing Gateway for the
 * multi-context route. One value, one authority (2026-09-10 selector-purity
 * ruling): the UI data plane is a pure projection of the currently selected
 * runtime. The default export mounts BESIDE the upstream typert-gateway
 * (row stays enabled — its client half must stay in the browser module
 * table) and wraps the live typertGateway service's TWO methods
 * (dispatchRpc + openWireStream): selector = native → upstream instance;
 * selector = foreign → the target context's typertGateway INSTANCE via the
 * same two methods (in-process delegation — both the Cordis ctx addressing
 * and the JS instance state land on the right world by construction).
 */
export { readSelector, writeSelector } from './selector.js';
export { registerSelectorRpc, AGENT_RUNTIME_RPC_PATH, registryTargets } from './rpc.js';
export { registerForeignTarget, unregisterForeignTarget, getTarget } from './targets.js';
export { default } from './gateway.js';
