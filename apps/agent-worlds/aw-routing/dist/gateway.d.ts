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
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "multi-agent-routing";
export declare function apply(ctx: Context): void;
/** The plugin form (row contract): applied when the row mounts. */
export default apply;
