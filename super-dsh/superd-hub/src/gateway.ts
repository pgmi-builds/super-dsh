/**
 * @pgmi-builds/superd-hub — plugin entry (host half).
 *
 * DL7 (2026-09-16): there is NO server-side selected state. The module-level
 * selector and the instance-delegation wrapper that consumed it were removed;
 * world ownership is per-request and travels on the mount path:
 *
 *   /<label>/...              → that world's web surface (carrier.ts, AW-B)
 *   /api/...                  → ctx0/native, untouched (upstream route owner)
 *
 * This file therefore only mounts the CTX0-owned control plane today. The
 * per-world mount registers through `carrier.ts` (AW-B tasks 2-9), which calls
 * the addressed world's own `typertGateway` instance directly — again without
 * any shared selection value.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { registerSelectorRpc, registryTargets } from './rpc.js'
import { agentRosterRow } from './agent-roster.js'
import { getTarget } from './targets.js'
import { registerHubRoute } from './hub-route.js'
import { WorldWebServer, type RealWebServerFace } from './world-web-server.js'
import type { CarrierGatewayFace } from './carrier.js'

/** Stable Cordis plugin name. */
export const name = 'superd-hub'

/**
 * The plugin form (row contract): applied when the row mounts.
 *
 * Three CTX0-owned contributions, none carrying any selection value:
 *   - the world inventory control plane (read-only);
 *   - the agent roster row baked into ctx0's own index, so the selector lists
 *     every mount path the hub currently serves;
 *   - the `/hub` route family (native UI fusion Task 2): the single foreign
 *     seam on ctx0's listener, registered once the listening stack is up.
 *     World trees compose this same row, but their `webServer` is the VIRTUAL
 *     per-world translation surface — the `/hub` family belongs to ctx0's
 *     real listener only (one family per process, demuxed by `?agent=`).
 */
export function apply(ctx: Context): void {
  registerSelectorRpc(ctx, registryTargets)
  const on = (ctx as unknown as { on?: (event: string, listener: (table: IndexInjection[]) => void) => void }).on
  on?.call(ctx, 'webserver/index-inject', (table) => { table.push(agentRosterRow()) })
  ctx.inject(['webServer', 'connection'], (host) => {
    const real = host.get('webServer')
    if (real instanceof WorldWebServer) return
    const connection = host.get('connection') as {
      authorizeIndex(req: unknown, res: unknown): boolean
      requestRejection(req: unknown): number | undefined
    }
    // The gate is the SAME ctx0 authorize source the world mounts use
    // (connection.authorizeIndex); the addressed world resolves per request
    // through the live foreign-target table — never a shared selection. The
    // requestRejection face is the SAME ctx0 browser-trust fence world-join
    // wires into the sibling /<label> mounts: auth first, then Host/Origin —
    // the family is never weaker than the neighbors carrying identical traffic.
    const dispose = registerHubRoute({
      real: real as RealWebServerFace,
      authorize: (req, res) => connection.authorizeIndex(req, res),
      requestRejection: (req) => connection.requestRejection(req),
      gatewayOf: (label) => getTarget(label)?.gateway as CarrierGatewayFace | undefined,
    })
    ctx.effect(() => dispose, 'superd-hub: /hub route family')
  })
}
export default apply
