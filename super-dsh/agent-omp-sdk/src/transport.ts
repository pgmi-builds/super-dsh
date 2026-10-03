/**
 * omp-sdk transport — the opt-in SDK face of the OMP adapter.
 *
 * One `createOmpSdkTransport()` = the RPC line's `LazyOmpRpc`/`OmpSdkClient`
 * pair, specialized for the bun-sidecar SDK: sessions multiplex ONE sidecar
 * (shared `authStorage`/`modelRegistry`) instead of one `omp --mode rpc` child
 * per session.
 *
 * The transport is CONSTRUCTION-FREE by contract: creating a wrapper spawns
 * nothing. The sidecar — and with it the lazily fetched SDK runtime
 * (`ensureSdkRuntime`, `sidecar-client.ts#start`) — materializes on the first
 * real dispatch (`prompt`/`followUp`/`steer`/`ensureStarted`). The same zero
 * spawn window the RPC line holds, extended to cover the ~900 MB fetch.
 */
import { LazyOmpRpc } from "./lazy-rpc.js";
import {
  createOmpSdkSidecarPool,
  defaultOmpSdkSidecarPool,
  type OmpSdkSidecarPool,
} from "./sdk-client.js";

/** What a session needs to build its transport wrapper (no side effects). */
export interface OmpSdkTransportSpec {
  /**
   * The session's argv (`--approval-mode <mode>`, optional `--resume <file>`),
   * or a thunk resolved at SPAWN — the new-chat permission pick lands after
   * the wrapper exists, so both lines resolve it at the same moment.
   */
  spawnArgs: string[] | (() => string[]);
  /** The session cwd. */
  cwd?: string;
}

/** One OMP transport instance (the SDK line). */
export interface OmpSdkTransport {
  /**
   * Build the session's wrapper. `LazyOmpRpc` (not the narrowed
   * `OmpAgentRpc`) is the return type because the caller must be able to
   * register the first-spawn adoption hook (`onSpawned`).
   */
  create(spec: OmpSdkTransportSpec): LazyOmpRpc;
  /** The sidecar pool every session of this transport shares. */
  readonly pool: OmpSdkSidecarPool;
}

/**
 * Build the SDK transport.
 *
 * @param options.worldHome - the world home whose `sdk-runtime/` the sidecar
 *   runs from (default: the world plugin's `<dshHome>/agents/omp-sdk`). Passing
 *   it explicitly is what lets a test drive a scratch home.
 * @returns the transport; nothing is fetched or spawned here.
 */
export function createOmpSdkTransport(options: { worldHome?: string } = {}): OmpSdkTransport {
  const pool = options.worldHome === undefined
    ? defaultOmpSdkSidecarPool()
    : createOmpSdkSidecarPool({ worldHome: options.worldHome });
  return {
    pool,
    create(spec: OmpSdkTransportSpec): LazyOmpRpc {
      return new LazyOmpRpc(spec.spawnArgs, spec.cwd, pool);
    },
  };
}
