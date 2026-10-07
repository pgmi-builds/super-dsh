/**
 * Node-side client for the omp-sdk bun sidecar.
 *
 * The sidecar is NOT shipped as a runtime: this package declares no `bun` and
 * no coding-agent dependency. `start()` is therefore the ONE place the lazy
 * runtime bootstrap is awaited ({@link ensureSdkRuntime}) — it downloads bun +
 * the pinned coding-agent package into `<worldHome>/sdk-runtime/` and copies
 * this package's `sidecar/main.ts` + compiled `dist/protocol.js` there, then
 * the child is spawned with `<runtime>/bin/bun run <runtime>/sidecar/main.ts`.
 *
 * Because `start()` is only reached from the first real dispatch (via
 * `LazyOmpRpc#ensure`), construction — and every passive path — stays at zero
 * network, zero download and zero process.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkRuntimeDeps, ensureSdkRuntime, sdkRuntimeLayout, type SdkRuntimeRecord } from "./sdk-runtime.js";
import {
  PROTOCOL_VERSION,
  type EventFrame,
  type RequestFrame,
  type ResponseFrame,
} from "./protocol.js";

/** This package's root (`sidecar/`, `dist/`, `package.json` live here). */
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Lazily produce the runtime for a world home and return its layout. Injected
 * so tests can pin the spawn path with zero download and zero real bun.
 */
export type SidecarRuntimeFetch = (worldHome: string) => Promise<SdkRuntimeRecord>;

/**
 * Spawn the sidecar process. Injected so tests can prove the spawn arguments
 * without a real bun binary on the machine.
 */
export type SidecarSpawn = (command: string, args: string[], options: {
  cwd: string;
  env: Record<string, string>;
}) => ChildProcess;

/** The default fetcher: the real bun download + `bun add` install + smoke. */
const defaultRuntimeFetch: SidecarRuntimeFetch = (worldHome) =>
  ensureSdkRuntime(worldHome, createSdkRuntimeDeps(pkgDir));

/** The default child spawn: the fetched `bin/bun run <runtime>/sidecar/main.ts`. */
const defaultSpawn: SidecarSpawn = (command, args, options) =>
  spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });

export interface SidecarOptions {
  /**
   * The DSH world home (`<dshHome>/agents/omp-sdk`). The durable runtime lands
   * in `<worldHome>/sdk-runtime/` — never in this package (read-only in a real
   * consumer install) and never in a prod home.
   */
  worldHome: string;
  /** Working directory for the sidecar process (default: the runtime dir). */
  cwd?: string;
  /** extra env for the sidecar process */
  env?: Record<string, string>;
  /**
   * Override the runtime bootstrap (tests inject a fake so no bun is fetched
   * and no network is touched). Defaults to {@link ensureSdkRuntime} with the
   * package's real deps.
   */
  runtimeFetch?: SidecarRuntimeFetch;
  /**
   * How long `start()` waits for the sidecar's `ready` frame (default 60 s).
   * Overridable so a test can fail fast instead of holding a child for a
   * minute.
   */
  readyTimeoutMs?: number;
  /**
   * Override the actual child-process spawn (tests drive the bootstrap with a
   * fake process object, so no bun binary is ever required).
   */
  spawnProcess?: SidecarSpawn;
}

export class OmpSdkSidecar {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Set<(frame: EventFrame) => void>();
  private readyPromise: Promise<{ protocol: number }> | null = null;
  private buffer = "";
  private startError: string | null = null;

  constructor(private options: SidecarOptions) { }

  get started(): boolean {
    return this.proc !== null;
  }

  onEvent(handler: (frame: EventFrame) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Fetch/reuse the durable runtime and spawn the sidecar on it.
   *
   * This is the FIRST and ONLY place the runtime bootstrap runs — the whole
   * point of the opt-in SDK row is that nothing is downloaded until a real
   * prompt materializes the transport.
   */
  async start(): Promise<{ protocol: number }> {
    if (this.readyPromise) return this.readyPromise;
    const fetchRuntime = this.options.runtimeFetch ?? defaultRuntimeFetch;
    this.readyPromise = (async () => {
      // (1) durable runtime (idempotent: a complete matching one is free).
      const runtime = await fetchRuntime(this.options.worldHome);
      // (2) the sidecar source + compiled protocol live INSIDE the runtime dir,
      // so bun resolves `@oh-my-pi/pi-coding-agent` from the runtime's
      // node_modules and `../dist/protocol.js` from the copy next to it.
      const layout = sdkRuntimeLayout(this.options.worldHome);
      const cwd = this.options.cwd ?? layout.dir;
      return await new Promise<{ protocol: number }>((resolve, reject) => {
        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          ...this.options.env,
        };
        let proc: ChildProcess;
        try {
          proc = (this.options.spawnProcess ?? defaultSpawn)(runtime.bunPath, ["run", layout.sidecarEntry], {
            cwd,
            env,
          });
        } catch (err: any) {
          reject(new Error(`failed to spawn bun sidecar: ${err.message}`));
          return;
        }
        this.proc = proc;

        const readyTimeoutMs = this.options.readyTimeoutMs ?? 60_000;
        const timeout = setTimeout(
          () => reject(new Error(`sidecar ready timeout (${readyTimeoutMs}ms): ${this.startError ?? "no output"}`)),
          readyTimeoutMs,
        );
        const settle = (fn: () => void) => { clearTimeout(timeout); fn(); };
        // A dead sidecar surfaces as EPIPE on stdin writes; keep a permanent
        // no-op error sink so no window exists where the stream throws out of the
        // event loop (per-call degradation is handled by #writeSafe).
        proc.stdin!.on("error", () => { });

        proc.stdout!.setEncoding("utf8");
        proc.stdout!.on("data", (chunk: string) => this.consume(chunk, (r) => settle(() => resolve(r))));
        proc.stderr!.setEncoding("utf8");
        proc.stderr!.on("data", (chunk: string) => {
          this.startError = (this.startError ?? "") + chunk;
          process.stderr.write(`[omp-sdk-sidecar] ${chunk}`);
        });
        proc.on("exit", (code, signal) => {
          settle(() => reject(new Error(`sidecar exited before ready (${code ?? signal}): ${this.startError ?? ""}`)));
          for (const [, p] of this.pending) p.reject(new Error(`sidecar exited (${code ?? signal})`));
          this.pending.clear();
          this.proc = null;
        });
      });
    })();
    return this.readyPromise;
  }

  private consume(chunk: string, onReady?: (r: { protocol: number }) => void) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!raw) continue;
      let frame: any;
      try {
        frame = JSON.parse(raw);
      } catch {
        continue;
      }
      if (frame.event === "ready") {
        onReady?.({ protocol: frame.payload?.protocol ?? PROTOCOL_VERSION });
        continue;
      }
      if (typeof frame.id === "number" && ("ok" in frame)) {
        const p = this.pending.get(frame.id);
        if (p) {
          this.pending.delete(frame.id);
          if (frame.ok) p.resolve(frame.result);
          else p.reject(new Error(frame.error));
        }
        continue;
      }
      if (frame.event) {
        for (const h of this.eventHandlers) h(frame as EventFrame);
      }
    }
  }

  call<T = any>(method: string, params?: unknown): Promise<T> {
    if (!this.proc?.stdin) return Promise.reject(new Error("sidecar not started"));
    const id = this.nextId++;
    const frame: RequestFrame = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#writeSafe(JSON.stringify(frame) + "\n", () => {
        this.pending.delete(id);
        reject(new Error(`sidecar write failed: ${method}`));
      });
    });
  }

  /** Write to the sidecar's stdin without ever throwing EPIPE out of the loop. */
  #writeSafe(chunk: string, onLost: () => void): void {
    const stdin = this.proc?.stdin;
    if (!stdin) return onLost();
    const fail = (err: Error) => {
      // EPIPE/ECONNRESET when the sidecar died between checks — a lost frame
      // must degrade the caller, never crash the host process.
      stdin.removeListener("error", fail);
      try { stdin.destroy(); } catch { /* already gone */ }
      onLost();
    };
    stdin.once("error", fail);
    try {
      stdin.write(chunk, () => stdin.removeListener("error", fail));
    } catch {
      fail(new Error("write threw"));
    }
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc?.stdin) return;
    this.#writeSafe(JSON.stringify({ method, params }) + "\n", () => { });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.stdin!.end();
      setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 3000);
      }, 3000).unref?.();
    });
  }
}
