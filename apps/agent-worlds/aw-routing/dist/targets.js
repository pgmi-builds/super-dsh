/**
 * Foreign target registry: which runtime key maps to which context's
 * typertGateway SERVICE INSTANCE.
 *
 * The instance is the whole target: its two methods (dispatchRpc /
 * openWireStream) address their upstream through their own owning context
 * (ctx.typert, ctx.reflect) and their own instance state (remoteEvents,
 * registered by that tree's api-remotes). Delegating a call to the instance
 * therefore delegates BOTH address spaces at once — Cordis ctx and JS this.
 * An out-of-process target (subprocess app / remote machine) implements the
 * same GatewayFace over the wire (ADR 0007 loopback relay) — the caller
 * cannot tell the difference.
 */
const targets = new Map();
/** Register (or replace) the target for a runtime key. */
export function registerForeignTarget(target) {
    targets.set(target.key, target);
}
/** Drop a target (context disposed). */
export function unregisterForeignTarget(key) {
    targets.delete(key);
}
/** Live runtime keys: the native world plus every registered foreign key. */
export function listRuntimeKeys() {
    return ['native', ...targets.keys()];
}
/** Test/introspection hook. */
export function getTarget(key) {
    return targets.get(key);
}
