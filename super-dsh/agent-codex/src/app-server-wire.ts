/**
 * Codex app-server stdio transport (2026-10-03, app-server line).
 *
 * One `codex app-server` child process, newline-delimited JSON-RPC 2.0 with the
 * `jsonrpc` header OMITTED on the wire (official README + live probe
 * 2026-10-03: every frame is `{"id":…,"method":…,"params":…}` or
 * `{"id":…,"result":…}` / `{"id":…,"error":{…}}`).
 *
 * This module owns exactly four things and nothing else:
 *   1. executable resolution (pin-faithful: the package's own `@openai/codex`),
 *   2. process spawn + line framing + per-id request/response correlation,
 *   3. dispatch of server-initiated notifications and server-requests,
 *   4. teardown (process GROUP kill — the app-server may spawn stdio MCP
 *      children that `setsid` away; see the Hermes research §5.8).
 *
 * It carries NO codex semantics: no thread, no turn, no projection. Callers
 * (`app-server-client.ts`) own all of that. Never throws into the event loop:
 * every callback is invoked defensively.
 *
 * Lazy-spawn discipline (agent-adapter-dev-rules §14-i): constructing a
 * transport touches nothing; `start()` is the ONLY thing that creates a
 * process, and the client calls it on first real work.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

/** One server-initiated notification (`{method, params}`, no id). */
export interface WireNotification {
  readonly method: string;
  readonly params: unknown;
}

/** One server-initiated request (`{id, method, params}`) that needs an answer. */
export interface WireServerRequest {
  readonly method: string;
  readonly params: unknown;
}

/** The answer written back for a server-initiated request. */
export type ServerRequestOutcome = { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string } };

/** Per-request protocol error surfaced by the server (JSON-RPC `error` object). */
export class CodexWireError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`codex app-server ${method} failed (${code}): ${message}`);
    this.name = "CodexWireError";
    this.code = code;
    this.data = data;
  }
}

/** Server overload: the documented retryable backpressure code. */
export const SERVER_OVERLOADED_CODE = -32001;

export interface CodexAppServerTransportOptions {
  /** Explicit codex entry script; defaults to the pinned `@openai/codex`. */
  readonly command?: string;
  /** Args after the command; defaults to `["app-server"]`. */
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Per-request timeout; `0` disables. Default 60s. */
  readonly requestTimeoutMs?: number;
  readonly onNotification?: (notification: WireNotification) => void;
  readonly onServerRequest?: (request: WireServerRequest) => ServerRequestOutcome | Promise<ServerRequestOutcome>;
  readonly onExit?: (info: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void;
  /** Diagnostic passthrough: child stderr, and non-JSON stdout lines (fail-soft). */
  readonly onStderr?: (chunk: string) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** The codex entry script this package pins (`@openai/codex/bin/codex.js`). */
export function resolveCodexCommand(): string {
  const override = process.env.CODEX_BIN;
  if (override !== undefined && override.trim() !== "") return override;
  const require = createRequire(import.meta.url);
  try {
    // Pin-faithful: the SAME `@openai/codex` this package depends on, so the
    // wire protocol and the binary version can never drift apart. Set
    // CODEX_BIN to override (tests).
    return require.resolve("@openai/codex/bin/codex.js");
  } catch (error) {
    throw new Error(
      "cannot locate the pinned codex CLI (@openai/codex/bin/codex.js): "
      + `${error instanceof Error ? error.message : String(error)}. Install the package or set CODEX_BIN.`,
    );
  }
}

/** True for a plain JSON object (never arrays/null). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export class CodexAppServerTransport {
  readonly #options: CodexAppServerTransportOptions;
  #child: ChildProcess | undefined;
  #stdout = "";
  #stderr = "";
  #nextId = 1;
  #closed = false;
  readonly #pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();

  constructor(options: CodexAppServerTransportOptions = {}) {
    this.#options = options;
  }

  /** Whether a child process currently exists. */
  get alive(): boolean {
    return this.#child !== undefined && this.#child.exitCode === null && !this.#child.killed;
  }

  /** The child pid, when spawned. */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** Number of in-flight requests (observability / tests). */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Spawn the child exactly once. Idempotent.
   * @throws when the child cannot be spawned at all (bad executable).
   */
  start(): void {
    if (this.#child !== undefined) return;
    const command = this.#options.command ?? resolveCodexCommand();
    const args = [...(this.#options.args ?? ["app-server"])];
    // `detached` gives the child its own process group so teardown can kill
    // the whole tree (stdio MCP descendants included), not just the root.
    const child = spawn(process.execPath, [command, ...args], {
      cwd: this.#options.cwd,
      env: this.#options.env ?? { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.#child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onStdout(chunk));
    child.stderr?.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-8_192);
      this.#options.onStderr?.(chunk);
    });
    child.on("error", (error) => this.#onExit(null, null, error));
    child.on("exit", (code, signal) => this.#onExit(code, signal));
  }

  /** Send a request and await its result. Rejects on protocol error, timeout, or EOF. */
  request(method: string, params: unknown, options: { readonly timeoutMs?: number } = {}): Promise<unknown> {
    if (this.#closed || this.#child === undefined) {
      return Promise.reject(new Error("codex app-server transport is not running"));
    }
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const entry: { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout } = { method, resolve, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`codex app-server ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.#pending.set(id, entry);
      this.#write({ id, method, params: params ?? null });
    });
  }

  /** Send a notification (no id, no answer). */
  notify(method: string, params?: unknown): void {
    this.#write(params === undefined ? { method } : { method, params });
  }

  /** Write the answer for one server-initiated request. */
  respond(id: unknown, outcome: ServerRequestOutcome): void {
    if (typeof id !== "number" && typeof id !== "string") return;
    this.#write({ id, ...outcome });
  }

  /**
   * Stop the child: `SIGTERM` to its process group, then `SIGKILL` after a
   * short grace period, plus a direct `child.kill()` fallback. Idempotent and
   * safe to call before `start()`.
   */
  close(graceMs = 500): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error("codex app-server transport closed"));
    const child = this.#child;
    if (child === undefined) return;
    const pid = child.pid;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        // Group already gone (or the child never became a group leader).
      }
      try {
        child.kill(signal);
      } catch {
        // Already dead.
      }
    };
    killGroup("SIGTERM");
    const timer = setTimeout(() => killGroup("SIGKILL"), Math.max(0, graceMs));
    timer.unref?.();
    child.once("exit", () => clearTimeout(timer));
    // Detach our pipes so a wedged child cannot keep this process alive.
    child.stdin?.end();
  }

  #write(message: Record<string, unknown>): void {
    const stdin = this.#child?.stdin ?? null;
    if (stdin === null || stdin.destroyed || !stdin.writable) return;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.#options.onStderr?.(`codex app-server write failed: ${String(error)}\n`);
    }
  }

  /** Split stdout into lines; non-JSON lines are diagnostics, never protocol. */
  #onStdout(chunk: string): void {
    this.#stdout += chunk;
    for (; ;) {
      const index = this.#stdout.indexOf("\n");
      if (index < 0) break;
      const line = this.#stdout.slice(0, index).trim();
      this.#stdout = this.#stdout.slice(index + 1);
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.#options.onStderr?.(`codex app-server non-JSON stdout: ${line.slice(0, 400)}\n`);
        continue;
      }
      this.#dispatch(message);
    }
  }

  /** Route one decoded frame to its pending slot, a notification, or a server-request. */
  #dispatch(message: unknown): void {
    const record = asRecord(message);
    if (record === null) return;
    const id = record["id"];
    const method = record["method"];
    const hasResult = "result" in record || "error" in record;

    if ((typeof id === "number" || typeof id === "string") && typeof method !== "string" && hasResult) {
      this.#settle(id, record);
      return;
    }
    if (typeof method === "string") {
      const params = record["params"];
      if (typeof id === "number" || typeof id === "string") {
        this.#handleServerRequest(id, method, params);
        return;
      }
      try {
        this.#options.onNotification?.({ method, params });
      } catch (error) {
        this.#options.onStderr?.(`codex app-server notification handler threw: ${String(error)}\n`);
      }
    }
  }

  #settle(id: number | string, record: Record<string, unknown>): void {
    const entry = typeof id === "number" ? this.#pending.get(id) : undefined;
    if (entry === undefined) return;
    if (typeof id === "number") this.#pending.delete(id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    const error = asRecord(record["error"]);
    if (error !== null) {
      const code = typeof error["code"] === "number" ? error["code"] : -32603;
      const message = typeof error["message"] === "string" ? error["message"] : "unknown protocol error";
      entry.reject(new CodexWireError(entry.method, code, message, error["data"]));
      return;
    }
    entry.resolve(record["result"]);
  }

  #handleServerRequest(id: number | string, method: string, params: unknown): void {
    const handler = this.#options.onServerRequest;
    if (handler === undefined) {
      this.respond(id, { error: { code: -32601, message: `no handler for ${method}` } });
      return;
    }
    void (async () => {
      try {
        const outcome = await handler({ method, params });
        this.respond(id, outcome);
      } catch (error) {
        this.respond(id, { error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
      }
    })();
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.#child === undefined) {
      // Spawn failure: `error` fires without `exit`.
      this.#failAll(error ?? new Error("codex app-server failed to start"));
      this.#options.onExit?.({ code, signal });
      return;
    }
    if (this.#closed && this.#pending.size === 0 && code === null && signal === null && error === undefined) return;
    const reason =
      error !== undefined
        ? `codex app-server failed: ${error.message}`
        : `codex app-server exited (code=${String(code)} signal=${String(signal)})`;
    this.#failAll(new Error(reason));
    if (error !== undefined) this.#options.onStderr?.(`${reason}\n`);
    this.#options.onExit?.({ code, signal });
  }

  #failAll(error: Error): void {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}
