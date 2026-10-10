import { registerRemoteFileRpc } from './remote-file-rpc.js'
import { installHubRemoteTransport } from './remote-row.js'
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
 *
 * Mesh P2 Task 3 adds the federation wiring: mesh-link's machine lifecycle
 * events drive mesh-federate's registrar (pair/reprobe success → converge the
 * remote roster into the registries, probe failure → degrade, removal →
 * defederate), and the `/hub` family's demux gains the federation table ahead
 * of the local target registry (spec §3.2 dual-key: a6 canonical, label
 * aliases compatible).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { registerSelectorRpc, registryTargets } from './rpc.js'
import { registerMeshRpc } from './mesh-rpc.js'
import { registerPairingAuth } from './pairing-auth.js'
import { startReprobeSweep } from './mesh-link.js'
import { federatedGatewayOf, startMeshFederation } from './mesh-federate.js'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { agentRosterRow } from './agent-roster.js'
import { getTarget } from './targets.js'
import { registerHubRoute } from './hub-route.js'
import { WorldWebServer, type RealWebServerFace } from './world-web-server.js'
import { registerPtyExecutor } from './exec-pty-rpc.js'
import { consoleA2aLog } from './a2a-log.js'
import type { CarrierGatewayFace } from './carrier.js'

/** Stable Cordis plugin name. */
export const name = 'superd-hub'

/** Row config schema (mesh P3 Task 5a): the periodic reprobe sweep's knob —
 *  seconds between sweeps, default the user mandate's 5 minutes, floored at
 *  60 by the schema AND clamped again in `startReprobeSweep` (a bare-library
 *  caller cannot bypass the floor). Patch rows restate the whole config
 *  object; schema defaults fill the un-configured one. */
export const Config = z.object({
  reprobeIntervalSec: z.number().min(60).default(300),
})

/** The row config's TypeScript face (the schema-declared knob). */
export interface HubConfig {
  reprobeIntervalSec?: number
}

/**
 * The plugin form (row contract): applied when the row mounts.
 *
 * CTX0-owned contributions, none carrying any selection value:
 *   - the world inventory control plane (read-only);
 *   - the agent roster row baked into ctx0's own index, so the selector lists
 *     every mount path the hub currently serves;
 *   - the `/hub` route family (native UI fusion Task 2): the single foreign
 *     seam on ctx0's listener, registered once the listening stack is up.
 *     World trees compose this same row, but their `webServer` is the VIRTUAL
 *     per-world translation surface — the `/hub` family belongs to ctx0's
 *     real listener only (one family per process, demuxed by `?agent=`).
 *   - the mesh federation wiring (mesh P2 Task 3): home resolved HERE at
 *     registration time (mesh-rpc stays a pure route module; tests inject a
 *     tmpdir home instead); the one-way seam is mesh-link's federation event
 *     bus — mesh-federate subscribes, mesh-link never imports it.
 *   - the periodic reprobe sweep (mesh P3 Task 5a I1-a, user mandate
 *     "状态更新走单向 API + 5 分钟周期轮询"): every `reprobeIntervalSec`
 *     (default 300, floor 60) one sweep re-probes every ENABLED remote —
 *     success converges federation, failure degrades (both via the existing
 *     mesh-link hooks). CTX0-ONLY, gated by the same WorldWebServer check as
 *     the `/hub` family: world trees compose this row too (world-mount.ts
 *     WORLD_HUB_ROW) and must never start their own sweep against the shared
 *     machines registry.
 * @param ctx - host plugin context.
 * @param config - the row config (`reprobeIntervalSec`; schema defaults
 *   apply when the row is composed without one).
 */
export function apply(ctx: Context, config?: HubConfig): void {
  registerSelectorRpc(ctx, registryTargets)
  const home = resolveDshHome()
  registerMeshRpc(ctx, { home })
  ctx.effect(() => startMeshFederation({ home }), 'superd-hub: mesh federation wiring')
  const on = (ctx as unknown as { on?: (event: string, listener: (table: IndexInjection[]) => void) => void }).on
  on?.call(ctx, 'webserver/index-inject', (table) => { table.push(agentRosterRow()) })
  ctx.inject(['webServer', 'connection'], (host) => {
    const real = host.get('webServer')
    if (real instanceof WorldWebServer) return
    installHubRemoteTransport(host, { home })
    registerPairingAuth(host)
    const connection = host.get('connection') as {
      authorizeIndex(req: unknown, res: unknown): boolean
      requestRejection(req: unknown): number | undefined
    }
    // The gate is ctx0's authorize source (connection.authorizeIndex); the
    // addressed world resolves per request through the live foreign-target
    // table — never a shared selection. The requestRejection face is the
    // ctx0 browser-trust fence: auth first, then Host/Origin — the family is
    // never weaker than the neighbors carrying identical traffic.
    //
    // Demux (mesh P2 Task 3, spec §3.2 dual-key): the mesh FEDERATION table
    // first — an exact a6 match is the canonical spelling and beats label
    // aliases — then the shared local target registry (local runtime keys;
    // federated a6s are registered there too, so the fallback re-arms a
    // registration whose memo was cleared independently). Local label aliases
    // and `?agent=<a6>` therefore both demux; under the astronomically rare
    // a6↔local-key collision the federation wins deterministically (documented
    // in mesh-federate's header) instead of last-write-wins in the registry.
    // I1(a) periodic reprobe sweep — CTX0-ONLY by the same gate as the
    // `/hub` family below (world trees see a WorldWebServer and returned
    // early): the machines registry is ctx0-owned, and a per-world timer
    // would multiply probes against every paired remote. The effect's
    // disposer IS the sweep disposer — the timer dies with the row
    // (unref'd, overlap-skipping, per-machine errors swallowed; mesh-link).
    host.effect(
      () => startReprobeSweep({ home, intervalSec: config?.reprobeIntervalSec, immediate: true }),
      'superd-hub: mesh reprobe sweep',
    )
    host.effect(() => registerHubRoute({
      real: real as RealWebServerFace,
      authorize: (req, res) => connection.authorizeIndex(req, res),
      requestRejection: (req) => connection.requestRejection(req),
      gatewayOf: (label) => (federatedGatewayOf(label) ?? getTarget(label)?.gateway) as CarrierGatewayFace | undefined,
    }), 'superd-hub: /hub route family')
    // P4 §8.2: the PTY executor's upgrade route — same gate as the /hub family
    // (authorizeIndex cookie auth first, then the browser-trust fence). The
    // dumb pump lives in exec-pty-rpc.ts; remote-provider owns the shared initiator implementation.
    // The async effect belongs to this Connection injection: disposal waits
    // for setup and releases its route even when setup finishes during unload.
    host.effect(() => registerRemoteFileRpc(real as RealWebServerFace, {
      authorize: (req, res) => connection.authorizeIndex(req, res),
      requestRejection: req => connection.requestRejection(req),
    }), 'superd-hub: binary file upgrade route')
    host.effect(async () => {
      try {
        return await registerPtyExecutor(real as RealWebServerFace, {
          authorize: (req, res) => connection.authorizeIndex(req, res),
          requestRejection: (req) => connection.requestRejection(req),
          log: consoleA2aLog(),
        })
      } catch {
        return () => { /* ws unavailable in this env — route not offered */ }
      }
    }, 'superd-hub: PTY executor upgrade route')
  })
}
export default apply
