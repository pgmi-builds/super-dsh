/**
 * CodexAppServerClient — the app-server-line client seam (2026-10-03).
 *
 * One DSH session ↔ one `codex app-server` child process ↔ one Codex thread.
 * The public surface deliberately mirrors the retired `CodexSdkClient`
 * (`on` / `onFailure` / `getState` / `getMessages` / `getSessionStats` /
 * `getSubagents` / `prompt` / `followUp` / `steer` / `setModel` / `abort` /
 * `newSession` / `close` / `ensureStarted` / `spawned` / `threadId`) so
 * `agent.ts`'s event switch is untouched, while three of those methods now do
 * the REAL thing instead of an approximation:
 *
 *   steer      → `turn/steer` (injects into the live turn) — the SDK line had
 *                no steer at all and queued a follow-up instead;
 *   abort      → `turn/interrupt`;
 *   setModel   → per-turn `model` override — live from the NEXT turn, no thread
 *                rebuild (the SDK line had to `resumeThread` with a new option).
 *
 * Plus two app-server-only inputs the agent feeds per turn:
 *   `setTurnPolicy({approvalPolicy, sandboxPolicy})` — the runtime permission
 *   switch (folded from the DSH session log by `permission.ts`);
 *   `setServerRequestHandler(handler)` — the approval bridge
 *   (`app-server-approvals.ts`).
 *
 * LAZY SPAWN (agent-adapter-dev-rules §14-i, hard gate): `create()` performs
 * NO I/O and spawns NOTHING. `ensureStarted()` is the only path that creates a
 * process, and the agent calls it from the first real prompt. Viewing,
 * creating, or resuming a session therefore costs zero native processes.
 *
 * Native home (rules §5): the child inherits `process.env` verbatim. This
 * client NEVER sets `CODEX_HOME` — tests redirect the runtime home through the
 * ambient env, exactly like the retired SDK line did.
 *
 * Wire events are projected by `projectAppServerNotification` (app-server-events.ts)
 * onto the same omp-derived vocabulary the SDK line used, so every consumer
 * downstream sees an unchanged shape.
 */
import { CodexAppServerTransport, type ServerRequestOutcome, type WireNotification, type WireServerRequest } from "./app-server-wire.js";
import { projectAppServerNotification, type WireContentBlock, type WireEvent, type WireMessage } from "./app-server-events.js";
import { failClosedResponse } from "./app-server-approvals.js";

// ---------------------------------------------------------------------------
// Shapes (ported from the retired SDK client so call sites keep compiling)
// ---------------------------------------------------------------------------

/** Response-shape shim so `RpcResponse`-typed call sites keep compiling. */
export interface WireResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** The `get_state`-shaped payload. */
export interface WireState {
  isStreaming: boolean;
}

/** Structured sandbox policy for `turn/start` (v2 wire shape; every field is required). */
export type SandboxPolicy =
  | { readonly type: "dangerFullAccess" }
  | { readonly type: "readOnly"; readonly networkAccess: boolean }
  | {
    readonly type: "workspaceWrite";
    readonly writableRoots: readonly string[];
    readonly networkAccess: boolean;
    readonly excludeTmpdirEnvVar: boolean;
    readonly excludeSlashTmp: boolean;
  };

/** The thread-level sandbox selector (`SandboxMode`, a plain string). */
export type SandboxModeName = "read-only" | "workspace-write" | "danger-full-access";

/** AskForApproval values this adapter can produce. */
export type ApprovalPolicy = "never" | "on-request" | "untrusted";

export interface CodexAppServerOptions {
  /** Session working directory (the user's workspace — never a home, rules §5). */
  readonly cwd?: string;
  /** Existing Codex thread to re-attach, when resuming. */
  readonly resumeThreadId?: string;
  /** Initial model override (the factory's pinned catalog default). */
  readonly model?: string;
  /** Launch approval policy; overridable per turn via {@link CodexAppServerClient.setTurnPolicy}. */
  readonly approvalPolicy?: ApprovalPolicy;
  /** Launch sandbox mode for the thread; the structured per-turn policy rides {@link CodexAppServerClient.setTurnPolicy}. */
  readonly sandboxMode?: SandboxModeName;
  /** Per-request protocol timeout; `0` disables. */
  readonly requestTimeoutMs?: number;
}

/** Per-turn policy override folded from the DSH session log. */
export interface TurnPolicy {
  readonly approvalPolicy?: ApprovalPolicy;
  readonly sandbox?: SandboxPolicy;
}

export type ServerRequestHandler = (request: WireServerRequest) => ServerRequestOutcome | Promise<ServerRequestOutcome>;

/** Build the transport (tests inject a fake). */
export type AppServerTransportFactory = (options: ConstructorParameters<typeof CodexAppServerTransport>[0]) => CodexAppServerTransport;

let transportFactory: AppServerTransportFactory = (options) => new CodexAppServerTransport(options);
/** Replace the transport constructor (tests inject a fake). */
export function setAppServerTransportFactory(factory: AppServerTransportFactory): void {
  transportFactory = factory;
}

const ok = (command: string): WireResponse => ({ type: "response", command, success: true });

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** One text input block in the v2 `UserInput` shape. */
function textInput(text: string): { type: "text"; text: string; text_elements: never[] } {
  return { type: "text", text, text_elements: [] };
}

/**
 * Convert the app-server's `TokenUsageBreakdown` into the codex snake_case
 * usage shape `agent.ts`'s `convertUsage` already consumes verbatim, so the
 * Dash-side fold is unchanged by this migration.
 */
export function convertTokenUsage(value: unknown): Record<string, number> | null {
  const record = asRecord(value);
  if (record === null) return null;
  const out: Record<string, number> = {};
  const map: ReadonlyArray<readonly [string, string]> = [
    ["inputTokens", "input_tokens"],
    ["outputTokens", "output_tokens"],
    ["cachedInputTokens", "cached_input_tokens"],
    ["cacheWriteInputTokens", "cache_write_input_tokens"],
    ["reasoningOutputTokens", "reasoning_output_tokens"],
  ];
  for (const [from, to] of map) {
    const raw = record[from];
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) out[to] = raw;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** A single-shot deferred used for turn-id/`turn/completed` rendezvous. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => { };
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------

export class CodexAppServerClient {
  readonly #options: CodexAppServerOptions;
  readonly #listeners = new Set<(event: WireEvent) => void>();
  readonly #failureListeners = new Set<(error: Error) => void>();
  readonly #threadListeners = new Set<(threadId: string) => void>();
  readonly #messages: WireMessage[] = [];
  readonly #queue: string[] = [];
  #transport: CodexAppServerTransport | undefined;
  #starting: Promise<void> | undefined;
  #threadId: string | null = null;
  #pendingResumeId: string | null;
  #activeTurnId: string | null = null;
  #inFlight = false;
  #closed = false;
  #failure: Error | null = null;
  #pendingModel: string | null;
  #appliedModel: string | null = null;
  #turnPolicy: TurnPolicy = {};
  #lastUsage: Record<string, number> | null = null;
  #terminalError: string | null = null;
  #serverRequestHandler: ServerRequestHandler | undefined;
  /** Bumped by newSession()/close() to orphan in-flight work on a discarded thread. */
  #sessionEpoch = 0;
  #turnStarted = deferred<string>();
  #turnSettled = deferred<void>();

  private constructor(options: CodexAppServerOptions) {
    this.#options = options;
    this.#pendingResumeId = options.resumeThreadId ?? null;
    this.#pendingModel = options.model ?? null;
  }

  /**
   * Construct a client. Performs ZERO I/O: no process, no socket, no config
   * read — the app-server child is created by {@link ensureStarted}, which the
   * agent only reaches on the first real prompt (lazy-spawn gate).
   */
  static create(options: CodexAppServerOptions = {}): CodexAppServerClient {
    return new CodexAppServerClient(options);
  }

  // ── surface parity with the retired SDK client ─────────────────────────────

  /** Register a wire event listener; returns the unsubscriber. */
  on(listener: (event: WireEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Register a failure listener; returns the unsubscriber. */
  onFailure(listener: (error: Error) => void): () => void {
    this.#failureListeners.add(listener);
    return () => {
      this.#failureListeners.delete(listener);
    };
  }

  /**
   * Observe thread attachment (the moment the Dash↔Codex pairing becomes
   * persistable). Fires for the first attach and for every later one
   * (`newSession()` re-attaches), which is exactly the re-arming observer the
   * provider's `dsh-sessions.json` map needs.
   */
  onThreadAttached(listener: (threadId: string) => void): () => void {
    this.#threadListeners.add(listener);
    if (this.#threadId !== null) listener(this.#threadId);
    return () => {
      this.#threadListeners.delete(listener);
    };
  }

  /** Install the approval bridge (server-request handler). */
  setServerRequestHandler(handler: ServerRequestHandler | undefined): void {
    this.#serverRequestHandler = handler;
  }

  /** Set the per-turn permission override (approval policy + sandbox). */
  setTurnPolicy(policy: TurnPolicy): void {
    this.#turnPolicy = policy;
  }

  /** The current Codex thread id (null until the thread attaches). */
  get threadId(): string | null {
    return this.#threadId;
  }

  /** Whether a native process currently exists (lazy-spawn observability). */
  get spawned(): boolean {
    return this.#transport?.alive === true;
  }

  /** The id of the turn currently in flight, when one is. */
  get activeTurnId(): string | null {
    return this.#activeTurnId;
  }

  /**
   * Materialize the native side on first use: spawn → `initialize` →
   * `initialized` → `thread/start` (or `thread/resume`). Single-flight and
   * idempotent; concurrent callers share one attempt.
   */
  async ensureStarted(): Promise<void> {
    this.#ensureUsable();
    if (this.#transport !== undefined && this.#threadId !== null) return;
    if (this.#starting === undefined) {
      const epoch = this.#sessionEpoch;
      this.#starting = this.#start(epoch).finally(() => {
        this.#starting = undefined;
      });
    }
    return this.#starting;
  }

  /** Query session state; returns the `get_state`-shaped payload. */
  async getState(): Promise<WireState> {
    this.#ensureUsable();
    return { isStreaming: this.#inFlight };
  }

  /** Best-effort conversation mirror accumulated from the wire. */
  async getMessages(): Promise<WireMessage[]> {
    return [...this.#messages];
  }

  /** Live token accounting from the latest `thread/tokenUsage/updated`. */
  async getSessionStats(): Promise<Record<string, unknown>> {
    try {
      const usage = this.#lastUsage;
      if (usage === null) return {};
      const tokens: Record<string, number> = {};
      const map: ReadonlyArray<readonly [string, string]> = [
        ["input", "input_tokens"],
        ["output", "output_tokens"],
        ["cacheRead", "cached_input_tokens"],
        ["cacheWrite", "cache_write_input_tokens"],
      ];
      for (const [wireKey, codexKey] of map) {
        const value = usage[codexKey];
        if (typeof value === "number") tokens[wireKey] = value;
      }
      return { tokens };
    } catch {
      return {};
    }
  }

  /** Codex subagent/collab items are not projected in this version. */
  async getSubagents(): Promise<unknown[]> {
    return [];
  }

  /** Start a turn with a user prompt. */
  async prompt(message: string): Promise<WireResponse> {
    this.#ensureUsable();
    await this.ensureStarted();
    await this.#startTurn(message);
    return ok("prompt");
  }

  /** Queue a follow-up turn: runs immediately when idle, else after the live turn. */
  async followUp(message: string): Promise<WireResponse> {
    this.#ensureUsable();
    await this.ensureStarted();
    if (this.#inFlight) {
      this.#queue.push(message);
      return ok("follow_up");
    }
    await this.#startTurn(message);
    return ok("follow_up");
  }

  /**
   * Steer the live turn (`turn/steer`). Idle → starts a turn. In flight but the
   * server has not named the turn yet → wait briefly for `turn/started`, then
   * fall back to the client queue (never two concurrent turns).
   */
  async steer(message: string): Promise<WireResponse> {
    this.#ensureUsable();
    await this.ensureStarted();
    if (!this.#inFlight) {
      await this.#startTurn(message);
      return ok("steer");
    }
    const turnId = this.#activeTurnId ?? (await this.#awaitActiveTurn(5_000));
    const transport = this.#transport;
    const threadId = this.#threadId;
    if (turnId === null || transport === undefined || threadId === null) {
      this.#queue.push(message);
      return ok("steer");
    }
    try {
      await transport.request("turn/steer", { threadId, input: [textInput(message)], expectedTurnId: turnId });
    } catch (error) {
      // A rejected steer must not lose the message: queue it as the next turn.
      this.#trace(`steer rejected (${String(error)}); queued as the next turn`);
      this.#queue.push(message);
    }
    return ok("steer");
  }

  /** Select the active model; applied as the next turn's `model` override. */
  async setModel(provider: string, modelId: string): Promise<WireResponse> {
    this.#ensureUsable();
    void provider;
    this.#pendingModel = modelId;
    return ok("set_model");
  }

  /** Interrupt the live turn (`turn/interrupt`) and wait for it to settle. */
  async abort(): Promise<WireResponse> {
    const transport = this.#transport;
    const threadId = this.#threadId;
    const turnId = this.#activeTurnId;
    if (transport === undefined || threadId === null || turnId === null || !this.#inFlight) {
      return ok("abort");
    }
    const settled = this.#turnSettled.promise;
    try {
      await transport.request("turn/interrupt", { threadId, turnId });
    } catch (error) {
      this.#trace(`turn/interrupt failed: ${String(error)}`);
      return ok("abort");
    }
    // Bounded wait so a lost `turn/completed` cannot wedge the caller.
    await Promise.race([settled, new Promise<void>((resolve) => setTimeout(resolve, 15_000).unref?.())]);
    return ok("abort");
  }

  /**
   * Discard the current thread and start a fresh one on the next turn. The
   * child process is kept (only the thread is discarded), so a new session
   * costs one `thread/start` rather than a respawn.
   */
  async newSession(): Promise<WireResponse> {
    this.#ensureUsable();
    this.#sessionEpoch += 1;
    await this.abort();
    this.#queue.length = 0;
    this.#messages.length = 0;
    this.#threadId = null;
    this.#pendingResumeId = null;
    this.#activeTurnId = null;
    this.#inFlight = false;
    this.#appliedModel = null;
    this.#lastUsage = null;
    this.#terminalError = null;
    return ok("new_session");
  }

  /** Stop the child and fail all future operations. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#sessionEpoch += 1;
    this.#transport?.close();
    this.#transport = undefined;
    this.#inFlight = false;
    this.#activeTurnId = null;
    this.#turnSettled.resolve();
    this.#turnStarted.resolve("");
    this.#fail(new Error("codex app server client closed"));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #ensureUsable(): void {
    if (this.#failure !== null) throw this.#failure;
    if (this.#closed) throw new Error("codex app server client is closed");
  }

  #trace(message: string): void {
    if (process.env.CODEX_TRACE === "1") process.stderr.write(`[codex-appserver] ${message}\n`);
  }

  /** Spawn + handshake + thread attach. Runs at most once per thread. */
  async #start(epoch: number): Promise<void> {
    const transport =
      this.#transport ??
      transportFactory({
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        ...(this.#options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.#options.requestTimeoutMs }),
        onNotification: (notification) => this.#onNotification(notification),
        onServerRequest: (request) => this.#onServerRequest(request),
        onExit: (info) => this.#onExit(info),
      });
    const first = this.#transport === undefined;
    this.#transport = transport;
    if (first) {
      transport.start();
      const info = asRecord(
        await transport.request("initialize", {
          clientInfo: { name: "superd-agent-codex", title: "Super D agent-codex", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }),
      );
      transport.notify("initialized");
      this.#trace(`initialized codexHome=${String(info?.["codexHome"] ?? "?")} platform=${String(info?.["platformOs"] ?? "?")}`);
    }
    if (this.#threadId !== null) return;

    const resumeId = this.#pendingResumeId;
    const shared = {
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      personality: "none" as const,
      serviceName: "superd-agent-codex",
      ...(this.#pendingModel === null ? {} : { model: this.#pendingModel }),
      ...(this.#options.approvalPolicy === undefined && this.#turnPolicy.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: this.#turnPolicy.approvalPolicy ?? this.#options.approvalPolicy }),
      ...(this.#options.sandboxMode === undefined ? {} : { sandbox: this.#options.sandboxMode }),
    };
    const response = asRecord(
      resumeId === null
        ? await transport.request("thread/start", shared)
        : await transport.request("thread/resume", { threadId: resumeId, ...shared }),
    );
    const thread = asRecord(response?.["thread"]);
    const threadId = asString(thread?.["id"]) ?? resumeId;
    if (threadId === null) throw new Error("codex app-server did not return a thread id");
    if (epoch !== this.#sessionEpoch) {
      // A newSession() landed while the thread was attaching: keep the process,
      // discard this thread, and let the next turn start a fresh one.
      this.#pendingResumeId = null;
      return;
    }
    this.#pendingResumeId = null;
    this.#attachThread(threadId);
  }

  #attachThread(threadId: string): void {
    this.#threadId = threadId;
    this.#trace(`thread attached ${threadId}`);
    for (const listener of [...this.#threadListeners]) {
      try {
        listener(threadId);
      } catch (error) {
        this.#trace(`thread listener error: ${String(error)}`);
      }
    }
  }

  /** One turn: apply the per-turn model/policy overrides, then `turn/start`. */
  async #startTurn(message: string): Promise<void> {
    await this.ensureStarted();
    const transport = this.#transport;
    const threadId = this.#threadId;
    if (transport === undefined || threadId === null) throw new Error("codex app-server thread is unavailable");
    this.#messages.push({ role: "user", content: [{ type: "text", text: message }] });
    this.#inFlight = true;
    this.#activeTurnId = null;
    this.#terminalError = null;
    this.#turnStarted = deferred<string>();
    this.#turnSettled = deferred<void>();
    const model = this.#pendingModel ?? this.#options.model ?? null;
    const policy = this.#turnPolicy;
    try {
      const response = asRecord(
        await transport.request("turn/start", {
          threadId,
          input: [textInput(message)],
          ...(model === null ? {} : { model }),
          ...(policy.approvalPolicy === undefined ? {} : { approvalPolicy: policy.approvalPolicy }),
          ...(policy.sandbox === undefined ? {} : { sandboxPolicy: policy.sandbox }),
        }),
      );
      this.#appliedModel = model;
      const turn = asRecord(response?.["turn"]);
      const turnId = asString(turn?.["id"]);
      if (turnId !== undefined && this.#activeTurnId === null) this.#activeTurnId = turnId;
    } catch (error) {
      this.#inFlight = false;
      this.#turnSettled.resolve();
      this.#turnStarted.resolve("");
      throw error;
    }
  }

  /** Wait for `turn/started` to name the active turn (bounded). */
  async #awaitActiveTurn(timeoutMs: number): Promise<string | null> {
    if (this.#activeTurnId !== null) return this.#activeTurnId;
    const started = this.#turnStarted.promise;
    await Promise.race([started, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.())]);
    return this.#activeTurnId;
  }

  #onNotification(notification: WireNotification): void {
    const method = notification.method;
    const params = asRecord(notification.params) ?? {};
    try {
      switch (method) {
        case "turn/started": {
          const turn = asRecord(params["turn"]);
          const turnId = asString(turn?.["id"]);
          if (turnId !== undefined) {
            this.#activeTurnId = turnId;
            this.#turnStarted.resolve(turnId);
          }
          this.#inFlight = true;
          // `agent_start` opens the Dash activity; it must precede `turn_start`
          // (the agent flushes parked deliveries on it).
          this.#emit({ type: "agent_start" });
          break;
        }
        case "turn/completed": {
          this.#settleTurn(params);
          return;
        }
        case "thread/tokenUsage/updated": {
          const usage = convertTokenUsage(params["tokenUsage"] && asRecord(params["tokenUsage"])?.["last"]);
          if (usage !== null) this.#lastUsage = usage;
          return;
        }
        case "error": {
          const error = asRecord(params["error"]);
          const willRetry = params["willRetry"] === true;
          if (!willRetry) {
            this.#terminalError = asString(error?.["message"]) ?? this.#terminalError;
            this.#trace(`terminal error notification: ${this.#terminalError ?? "?"}`);
          }
          return;
        }
        case "thread/started":
        case "thread/status/changed":
        case "mcpServer/startupStatus/updated":
        case "remoteControl/status/changed":
        case "warning":
          return;
        default:
          break;
      }
      if (this.#isItemNotification(method) && !this.#acceptsItem(params)) return;
      const projected = projectAppServerNotification(method, notification.params);
      if (projected === null) return;
      for (const event of Array.isArray(projected) ? projected : [projected]) {
        this.#emit(event);
        this.#mirror(event);
      }
    } catch (error) {
      this.#trace(`notification handler failed for ${method}: ${String(error)}`);
    }
  }

  /** Item-scoped notifications carry a `turnId`; stale ones must not reopen a closed turn. */
  #isItemNotification(method: string): boolean {
    return method === "item/started" || method === "item/completed" || method.startsWith("item/") || method === "turn/plan/updated";
  }

  #acceptsItem(params: Record<string, unknown>): boolean {
    if (this.#activeTurnId === null) return false;
    const turnId = asString(params["turnId"]);
    return turnId === undefined || turnId === this.#activeTurnId;
  }

  /** Close the Dash turn: terminal error + `turn_end` (+ usage) + `agent_end`. */
  #settleTurn(params: Record<string, unknown>): void {
    const turn = asRecord(params["turn"]) ?? {};
    const status = asString(turn["status"]) ?? "completed";
    const epoch = this.#sessionEpoch;
    this.#inFlight = false;
    this.#activeTurnId = null;
    this.#turnSettled.resolve();
    if (status === "failed") {
      const error = asRecord(turn["error"]);
      const message = asString(error?.["message"]) ?? this.#terminalError ?? "codex turn failed";
      this.#emit({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: message },
      });
    }
    const usage = this.#lastUsage;
    this.#emit({ type: "turn_end", data: { turn, ...(usage === null ? {} : { usage }) } });
    this.#emit({ type: "agent_end" });
    this.#terminalError = null;
    if (epoch !== this.#sessionEpoch || this.#closed) return;
    const next = this.#queue.shift();
    if (next === undefined) return;
    // Deliver the queued follow-up as its own turn; the agent's echo bridge
    // closes the just-finished Dash turn and opens a fresh one.
    void this.#startTurn(next).catch((error) => this.#fail(error));
  }

  #onServerRequest(request: WireServerRequest): ServerRequestOutcome | Promise<ServerRequestOutcome> {
    const handler = this.#serverRequestHandler;
    if (handler === undefined) return failClosedResponse(request.method);
    try {
      return handler(request);
    } catch (error) {
      this.#trace(`server-request handler threw for ${request.method}: ${String(error)}`);
      return failClosedResponse(request.method);
    }
  }

  #onExit(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.#closed) return;
    this.#fail(new Error(`codex app-server exited (code=${String(info.code)} signal=${String(info.signal)})`));
  }

  /** Mirror wire events into the `getMessages` accumulator (best effort). */
  #mirror(wire: WireEvent): void {
    if (wire.type === "message_end") {
      const message = asRecord(wire.message);
      if (message !== null && message.role === "assistant" && typeof message.stopReason !== "string") {
        const blocks = Array.isArray(message.content) ? (message.content as WireContentBlock[]) : [];
        const reasoningOnly = blocks.length > 0 && blocks.every((block) => block.type === "thinking");
        if (!reasoningOnly) this.#messages.push(message as unknown as WireMessage);
      }
      return;
    }
    if (wire.type === "tool_execution_end") {
      const result = asRecord(wire.result);
      this.#messages.push({
        role: "toolResult",
        toolCallId: wire.toolCallId,
        content: Array.isArray(result?.content) ? (result.content as WireContentBlock[]) : [],
        isError: wire.isError === true,
      });
    }
  }

  #emit(event: WireEvent): void {
    if (this.#closed && event.type !== "agent_end") return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        process.stderr.write(`codex app server listener error: ${String(error)}\n`);
      }
    }
  }

  #fail(error: Error): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    this.#inFlight = false;
    this.#activeTurnId = null;
    this.#turnSettled.resolve();
    this.#turnStarted.resolve("");
    for (const listener of [...this.#failureListeners]) {
      try {
        listener(error);
      } catch (listenerError) {
        process.stderr.write(`codex app server failure listener error: ${String(listenerError)}\n`);
      }
    }
  }
}
