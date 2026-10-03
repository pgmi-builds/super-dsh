/**
 * ClaudeSdkClient — the lazy, host-binary-driven Claude Agent SDK bridge client.
 *
 * The Claude Agent SDK is a *bridge*: `query()` spawns a real Claude Code CLI
 * subprocess and speaks the stream-json control protocol to it. This client owns
 * that bridge's lifecycle for the adapter. It hands `query()` a streaming-input
 * iterable (an {@link InputQueue}, which is what makes the `Query` control
 * methods exist at all), drives the bridge lazily per session, and fans every
 * message out through `projectClaudeEvent` (claude-events.ts).
 *
 * ## The SDK is runtime-self-fetched, not imported
 *
 * The SDK is not a static dependency of this package: the default factory
 * resolves it at the first real prompt via `loadClaudeQuery(worldHome)`
 * (sdk-runtime.ts), which fetches the pinned tree into the agent world's
 * home. `ClaudeFactory` stays SYNCHRONOUS — the await lives in factory
 * RESOLUTION, never between query construction and the `this.query`
 * assignment (see `ensureStarted`).
 *
 * ## The two hard deviations from the codex precedent
 *
 * 1. **No shared singleton.** `agent-codex` multiplexes all clients through one
 *    module-level refcounted SDK instance. That is impossible here: the Claude
 *    SDK's `Query` owns its own CLI subprocess AND its own streaming-input
 *    iterator, so one `Query` cannot serve multiple sessions. Each
 *    `ClaudeSdkClient` instance therefore owns its own `Query`. The module-level
 *    `claudeClientRefCount()` still tracks how many instances are live (it goes
 *    1 -> 0 across construction and `close()`), but it never shares a query
 *    between instances.
 *
 * 2. **`Options.env` REPLACES the subprocess environment.** Verified verbatim
 *    from `sdk.d.ts`: "When set, this value REPLACES the subprocess environment
 *    entirely — it is not merged with `process.env`. Spread `process.env`
 *    yourself if the subprocess still needs inherited variables like `PATH`,
 *    `HOME`, or `ANTHROPIC_API_KEY`." So the options built here are always
 *    `env: { ...process.env }`. A bare partial env would strip PATH/HOME/the
 *    API key and the CLI would fail with an opaque startup error far from the
 *    cause. NO `CLAUDE_CONFIG_DIR` is injected: the CLI resolves its own
 *    native `~/.claude` (2026-09-17 home ruling; tests redirect via the
 *    ambient env).
 *
 * ## Design decisions the brief left open (each pinned by a test)
 *
 * - **Zero-IO construction**: the injectable factory is never called until the
 *   first `prompt()` runs `ensureStarted()`.
 * - **Pending control calls** (`setModel` / `setPermissionMode` / `interrupt`)
 *   made before the query exists are *buffered and replayed in order* inside
 *   `ensureStarted()` — never silently dropped. They do NOT spawn the CLI on
 *   their own (a control call is not a turn).
 * - **Reader loop**: consumes the query's async iterator, projects each message,
 *   and delivers the wire events to listeners. On normal iterator end it emits
 *   `{ type: "agent_end" }`; on a throw it emits
 *   `{ type: "agent_end", isError: true, error }` and records the failure. The
 *   loop catches its own errors, so a stream that ends never leaves a dangling
 *   or unhandled promise.
 * - **`close()`** is idempotent and safe before `ensureStarted()`; it closes the
 *   input queue (if any), closes the query (if any), and decrements the refcount
 *   exactly once.
 * - **Post-close pushes**: the client guards with a clear
 *   `"agent-claude: client is closed"` error *before* reaching the input queue,
 *   rather than surfacing the queue's lower-level "input queue is closed".
 * - **`followUp`** is surface parity with `prompt` — in streaming-input mode
 *   every push is queued in order and there is no separate follow-up channel.
 *   `steer` differs by pushing with `priority: "now"`.
 */
import { loadClaudeQuery, resolveClaudeBinary } from "./sdk-runtime.js";
import { InputQueue, type ClaudeInputContent } from "./input-queue.js";
import { projectClaudeEvent, type WireEvent } from "./claude-events.js";

// ---------------------------------------------------------------------------
// Structural seams (duck-typed so tests inject plain fakes)
// ---------------------------------------------------------------------------

/** Minimal structural shape of the SDK `Query` object (control methods + iterator). */
export interface ClaudeQueryLike {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  /** Advertise the models the CLI serves (control-plane query; absent on early fakes). */
  supportedModels?(): Promise<unknown[]>;
  /** Advertise the slash commands the CLI serves (same control plane; absent on early fakes). */
  supportedCommands?(): Promise<unknown[]>;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

/** What the factory receives: the streaming input + the built SDK options. */
export interface ClaudeQueryOptions {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}

export type ClaudeFactory = (options: ClaudeQueryOptions) => ClaudeQueryLike;

/** The default executable resolution: Task 1's `resolveClaudeBinary` —
 * `$CLAUDE_EXECUTABLE` (only while it exists) > `claude` on PATH >
 * `~/.local/bin/claude` > `/usr/local/bin/claude`. `undefined` means "no
 * local binary": `pathToClaudeCodeExecutable` is left unset and the SDK's
 * bundled platform payload is the CLI (bundled-payload mode). */
const defaultExecutableResolver = () => resolveClaudeBinary();

let factory: ClaudeFactory | undefined; // test injection only
let executableResolver: () => string | undefined = defaultExecutableResolver;
let refcount = 0;

/** The factory to construct queries with: a test-injected one wins (the sync
 * seam); otherwise the SDK is self-fetched into `worldHome`'s durable runtime
 * on first use (sdk-runtime.ts). */
async function resolveFactory(worldHome: string | undefined): Promise<ClaudeFactory> {
  if (factory) return factory;
  if (worldHome === undefined) {
    throw new Error(
      "agent-claude: client needs worldHome to fetch its SDK runtime (the provider passes dshHomePath)",
    );
  }
  const sdkQuery = await loadClaudeQuery(worldHome);
  return (o) => sdkQuery({ prompt: o.prompt, options: o.options }) as ClaudeQueryLike;
}

/** Replace the SDK entry point (tests inject a fake query). */
export function setClaudeFactory(next: ClaudeFactory): void {
  factory = next;
}


/** Replace the pathToClaudeCodeExecutable resolution. */
export function setClaudeExecutableResolver(next: () => string | undefined): void {
  executableResolver = next;
}

/** Test/observability hook: current live-instance refcount (0 = none alive). */
export function claudeClientRefCount(): number {
  return refcount;
}

/** Restore module-level seams and refcount (test isolation only). */
export function resetClaudeClientState(): void {
  refcount = 0;
  factory = undefined;
  executableResolver = defaultExecutableResolver;
}

/**
 * Boot model probe (RC-3): spawn ONE ephemeral SDK query — a streaming-input
 * queue with NO user prompt — ask its `supportedModels()`, and close (the
 * hermes probe-client-then-close precedent). Runs through the module factory,
 * so tests inject a fake query. `persistSession: false` keeps the probe from
 * leaving a session in the CLI's native home. Failure (including the timeout
 * race, which guards against a wedged startup pinning a subprocess forever)
 * is the caller's to trace; the boot catalog stays as-is.
 */
export async function probeClaudeModels(config: { cwd?: string; worldHome?: string; timeoutMs?: number } = {}): Promise<unknown[]> {
  const queryFactory = await resolveFactory(config.worldHome);
  const executable = executableResolver();
  const queue = new InputQueue();
  const query = queryFactory({
    prompt: queue,
    options: {
      cwd: config.cwd ?? process.cwd(),
      env: { ...process.env },
      ...(executable !== undefined ? { pathToClaudeCodeExecutable: executable } : {}),
      persistSession: false,
    },
  });
  const timeoutMs = config.timeoutMs ?? 20_000;
  try {
    const ask = typeof query.supportedModels === "function"
      ? query.supportedModels()
      : Promise.resolve([]);
    const models = await Promise.race([
      ask,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`boot model probe timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return Array.isArray(models) ? models : [];
  } finally {
    queue.close();
    query.close();
  }
}

// ---------------------------------------------------------------------------
/** Structural stand-in for the SDK's `CanUseTool` permission gate (the SDK is
 * no longer imported for types). The shape is interaction.ts's dispatcher —
 * the options fields it actually reads (toolUseID / signal / decisionReason) —
 * plus `requestId`, a required member of the SDK's own callback options so
 * the SDK-typed producer in index.ts stays assignable here; the SDK may also
 * resolve null ("no control_response"), which is never a grant. */
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID: string; signal: AbortSignal; decisionReason?: string; requestId: string },
) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string } | null>;

export interface ClaudeClientConfig {
  cwd?: string;
  /** The agent world's DSH home — where the SDK runtime is self-fetched on
   * first use (sdk-runtime.ts). Required on the production path (the provider
   * passes dshHomePath); a test-injected factory bypasses the gate. */
  worldHome?: string;
  claudeSessionId?: string;
  resumeSessionId?: string;
  /** Host-side tool-permission gate (the interaction bridge's dispatcher). */
  canUseTool?: CanUseTool;
  /** Required by the SDK for `bypassPermissions` mode; set only for that mode. */
  allowDangerouslySkipPermissions?: boolean;
}

export class ClaudeSdkClient {
  private readonly cwdPath: string;
  private readonly worldHome: string | undefined;
  private readonly claudeSessionId: string | undefined;
  private readonly resumeSessionId: string | undefined;
  private readonly canUseTool: CanUseTool | undefined;
  private readonly allowDangerouslySkipPermissions: boolean | undefined;
  /** True while a user turn is in flight (set on push, cleared on `turn_end`/`agent_end`). */
  private turnActive = false;

  private queue: InputQueue | undefined;
  private query: ClaudeQueryLike | undefined;
  private pendingControls: Array<() => unknown> = [];
  private readonly listeners = new Set<(event: WireEvent) => void>();
  private threadIdValue: string | null = null;
  private closed = false;
  private terminated = false;
  private failure: Error | null = null;

  constructor(config: ClaudeClientConfig) {
    if (config.claudeSessionId !== undefined && config.resumeSessionId !== undefined) {
      throw new Error("agent-claude: claudeSessionId and resumeSessionId are mutually exclusive");
    }
    this.cwdPath = config.cwd ?? process.cwd();
    this.worldHome = config.worldHome;
    this.claudeSessionId = config.claudeSessionId;
    this.resumeSessionId = config.resumeSessionId;
    this.canUseTool = config.canUseTool;
    this.allowDangerouslySkipPermissions = config.allowDangerouslySkipPermissions;
    refcount += 1;
  }

/**
 * Whether the query has been constructed yet (lazy spawn). This reports
 * "the query was constructed", not "the session is alive": `close()` does
 * not clear it.
 */
  get spawned(): boolean {
    return this.query !== undefined;
  }

  /** The cwd the CLI will be spawned in (constructor fact, read by the agent). */
  get cwd(): string {
    return this.cwdPath;
  }

  /** The SDK session id, filled from the session-init message when it arrives. */
  get threadId(): string | null {
    return this.threadIdValue;
  }

  /** The client's own running/streaming attestation (idle-TTL revalidation gate). */
  async getState(): Promise<{ isStreaming: boolean }> {
    return { isStreaming: this.turnActive };
  }

  /** Advertise the CLI's supported models; empty before the query exists. */
  async supportedModels(): Promise<unknown[]> {
    if (this.query === undefined) return [];
    if (this.query.supportedModels === undefined) return [];
    return this.query.supportedModels();
  }

  /**
   * Advertise the CLI's slash commands (name + description + argument hint);
   * empty before the query exists, and empty on a CLI/fake without the control.
   * The SDK returns its latest pushed snapshot; nothing here re-fetches the
   * CLI mid-session, so a command the runtime learns about after `session_init`
   * (unless the `inject` re-run reports it) never appears. That is a known
   * limitation, not a freshness guarantee.
   */
  async supportedCommands(): Promise<unknown[]> {
    if (this.query === undefined) return [];
    if (this.query.supportedCommands === undefined) return [];
    return this.query.supportedCommands();
  }

  /** Register a wire event listener; returns the unsubscriber. */
  on(listener: (event: WireEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Lazily construct the query (zero-IO until this runs). The factory is
   * resolved first — an await (a test-injected seam, or the world-home SDK
   * self-fetch) — and a caller that loses the race during that await reuses
   * the winner's query at the re-check. From the construct line through the
   * `this.query = query` assignment everything is synchronous (zero awaits),
   * so concurrent first prompts can never build two queries. The single-query
   * invariant therefore still depends on the `ClaudeFactory` contract staying
   * synchronous (it must return the `Query` without awaiting). The reader loop
   * is started fire-and-forget before any pending control call is replayed, so
   * a throwing control can never leave the CLI undrained.
   */
  async ensureStarted(): Promise<void> {
    if (this.query !== undefined) return;
    const f = await resolveFactory(this.worldHome); // await BEFORE the sync section
    if (this.query !== undefined) return; // lost the race to a concurrent first prompt — reuse its query
    const queue = new InputQueue();
    const query = f({ prompt: queue, options: this.buildOptions() });
    this.queue = queue;
    this.query = query; // sync section: zero awaits before this assignment (invariant)
    void this.runReader(query);
    const controls = this.pendingControls;
    this.pendingControls = [];
    for (const control of controls) {
      await control();
    }
  }

  /**
   * Queue a user turn (plain priority). Accepts plain text OR transcoded
   * Anthropic blocks; the block array is handed through unchanged.
   */
  async prompt(content: ClaudeInputContent): Promise<void> {
    this.ensureUsable();
    await this.ensureStarted();
    this.push(content, undefined);
  }

  /** Surface parity with prompt: a plain queued user turn. */
  async followUp(content: ClaudeInputContent): Promise<void> {
    this.ensureUsable();
    await this.ensureStarted();
    this.push(content, undefined);
  }

  /** Steer the in-flight turn: a user message with priority "now". */
  async steer(content: ClaudeInputContent): Promise<void> {
    this.ensureUsable();
    await this.ensureStarted();
    this.push(content, "now");
  }

  /** Select the active model (buffered until the query exists, then replayed). */
  async setModel(model?: string): Promise<void> {
    this.ensureUsable();
    if (this.query === undefined) {
      this.pendingControls.push(() => this.query?.setModel(model));
      return;
    }
    await this.query.setModel(model);
  }

  /** Change the permission mode (buffered until the query exists, then replayed). */
  async setPermissionMode(mode: string): Promise<void> {
    this.ensureUsable();
    if (this.query === undefined) {
      this.pendingControls.push(() => this.query?.setPermissionMode(mode));
      return;
    }
    await this.query.setPermissionMode(mode);
  }

  /** Interrupt the current turn (buffered until the query exists, then replayed). */
  async interrupt(): Promise<unknown> {
    this.ensureUsable();
    if (this.query === undefined) {
      this.pendingControls.push(() => this.query?.interrupt());
      return undefined;
    }
    return this.query.interrupt();
  }

  /** Close the queue, close the query, and release the refcount (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue?.close();
    this.query?.close();
    refcount = Math.max(0, refcount - 1);
  }

  // --- internals ------------------------------------------------------------

  private buildOptions(): Record<string, unknown> {
    const executable = executableResolver();
    return {
      cwd: this.cwdPath,
      env: { ...process.env },
      // undefined (no local binary) leaves the key unset — bundled-payload
      // mode lets the SDK spawn its own platform payload as the CLI.
      ...(executable !== undefined ? { pathToClaudeCodeExecutable: executable } : {}),
      persistSession: true,
      ...(this.claudeSessionId !== undefined ? { sessionId: this.claudeSessionId } : {}),
      ...(this.resumeSessionId !== undefined ? { resume: this.resumeSessionId } : {}),
      ...(this.canUseTool !== undefined ? { canUseTool: this.canUseTool } : {}),
      ...(this.allowDangerouslySkipPermissions !== undefined ? { allowDangerouslySkipPermissions: this.allowDangerouslySkipPermissions } : {}),
    };
  }

  /**
   * Push one turn through the queue. A plain string keeps the historical
   * single-text-block normalization; a block array is handed through AS-IS so
   * the transcoder's one-block-per-input-block shape reaches the SDK unchanged.
   */
  private push(content: ClaudeInputContent, priority: "now" | undefined): void {
    this.turnActive = true;
    this.queue!.pushContent(content, {
      parent_tool_use_id: null,
      ...(this.claudeSessionId !== undefined ? { session_id: this.claudeSessionId } : {}),
      ...(priority !== undefined ? { priority } : {}),
    });
  }

  private ensureUsable(): void {
    if (this.closed) throw new Error("agent-claude: client is closed");
    if (this.failure !== null) throw this.failure;
    if (this.terminated) throw new Error("agent-claude: session has ended");
  }

  private async runReader(query: ClaudeQueryLike): Promise<void> {
    try {
      for await (const message of query) {
        const wire = projectClaudeEvent(message);
        if (wire === null) continue;
        const events = Array.isArray(wire) ? wire : [wire];
        for (const event of events) {
          if (event.type === "session_init" && typeof event.sessionId === "string") {
            this.threadIdValue = event.sessionId;
          }
          if (event.type === "turn_end") this.turnActive = false;
          this.emit(event);
        }
      }
      this.terminated = true;
      this.turnActive = false;
      this.emit({ type: "agent_end" });
    } catch (error) {
      this.terminated = true;
      this.failure = error instanceof Error ? error : new Error(String(error));
      process.stderr.write(`agent-claude: query stream error: ${String(error)}\n`);
      this.turnActive = false;
      this.emit({ type: "agent_end", isError: true, error: this.failure.message });
    }
  }

  private emit(event: WireEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        process.stderr.write(`agent-claude: listener error: ${String(error)}\n`);
      }
    }
  }
}
