/**
 * @pgmi-builds/aw-routing — host half public surface (Agent Worlds line).
 *
 * The app-level runtime selector + the Runtime Routing Gateway + the foreign
 * agent roster + world spawner. One selector value, one authority: the UI
 * data plane is a pure projection of the currently selected world (S1).
 * The default export mounts BESIDE the upstream typert-gateway
 * (row stays enabled — its client half must stay in the browser module
 * table) and wraps the live typertGateway service's TWO methods
 * (dispatchRpc + openWireStream): selector = native → upstream instance;
 * selector = foreign → the target context's typertGateway INSTANCE via the
 * same two methods (in-process delegation — both the Cordis ctx addressing
 * and the JS instance state land on the right world by construction; S4).
 */
export { readSelector, writeSelector } from './selector.js';
export { registerSelectorRpc, AGENT_RUNTIME_RPC_PATH, registryTargets } from './rpc.js';
export { registerForeignTarget, unregisterForeignTarget, getTarget, listRuntimeKeys } from './targets.js';
export { registerAgent, unregisterAgent, setReady, listAgents, onRosterChanged } from './roster.js';
export { spawnWorld } from './spawn-world.js';
export { default } from './gateway.js';
