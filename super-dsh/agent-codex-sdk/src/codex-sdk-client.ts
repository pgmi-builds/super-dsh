/**
 * CodexSdkClient — the SDK-line client seam (AW-E Task 3).
 *
 * Public surface mirrors `OmpSdkClient` (agent-omp/src/sdk-client.ts) exactly —
 * `spawn` / `on` / `onFailure` / `sendRaw` / `send` / `getState` / `getMessages`
 * / `getSessionStats` / `getSubagents` / `prompt` / `followUp` / `steer` /
 * `setModel` / `abort` / `newSession` / `close` / `ensureStarted` / `spawned` —
 * so the Task 7 agent.ts/index.ts port compiles against this client the way it
 * compiles against the omp one. Instead of one `omp --mode rpc` sidecar per
 * session, ALL clients multiplex ONE module-level refcounted `Codex` instance
 * (same acquire()/release() pattern as the omp sidecar; the SDK spawns its own
 * per-turn codex process, so dropping the shared instance needs no stop call).
 *
 * Codex home: the shared instance is constructed with `{ env: { ...process.env } }`
 * (SDK env is REPLACE semantics — Task 1 spike fact, so the spread is
 * mandatory) and carries NO `CODEX_HOME`: the CLI resolves its own native
 * `~/.codex` (user ruling 2026-09-17 — never redirect the native app home at
 * spawn; tests redirect via `process.env.CODEX_HOME`).
 *
 * 2026-10-04 user ruling: this package declares NO SDK dependency — the whole
 * runtime is fetched into the world home on the first real prompt
 * (sdk-runtime.ts). The default factory therefore returns a zero-IO
 * {@link DeferredCodex} that materializes the real SDK inside `ensureStarted()`
 * (and, defensively, on the first `runStreamed`): constructing a client — which
 * the provider does at session-create time — touches no disk and no network,
 * and a session that never gets a prompt never fetches anything.
 * {@link setCodexFactory} replaces that construction wholesale, so the unit
 * suite stays green with the SDK absent.
 *
 * Wire events flow through `projectThreadEvent` (codex-events.ts) before
 * reaching listeners, so Task 7's agent.ts switch is unchanged from omp.
 */
import { loadCodexSdk } from "./sdk-runtime.js";
import { NATIVE_SDK_LAUNCH, type CodexSdkLaunch } from "./codex-sdk-launch.js";
import { projectThreadEvent, type WireContentBlock, type WireEvent, type WireMessage } from "./codex-sdk-events.js";

// ---------------------------------------------------------------------------
// Structural seams (duck-typed so fakes inject plain objects)
// ---------------------------------------------------------------------------

/** Minimal structural shape of the SDK `Codex` entry object. */
export interface CodexLike {
  startThread(options?: CodexThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: CodexThreadOptions): CodexThreadLike;
}

/** Minimal structural shape of an SDK `Thread`. */
export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(input: string, turnOptions?: CodexTurnOptions): Promise<CodexStreamedTurnLike>;
}

export interface CodexTurnOptions {
  signal?: AbortSignal;
}

export interface CodexStreamedTurnLike {
  events: AsyncIterable<unknown>;
}

/** The ThreadOptions subset this client passes (approval policy via the launch-only preset mapping). */
export interface CodexThreadOptions {
  model?: string;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  approvalPolicy?: string;
}

/** Options handed to the SDK constructor (env spread is REPLACE semantics). */
export interface CodexFactoryOptions {
  env: Record<string, string>;
  /**
   * The provider's `--config` overrides, already shaped for the SDK. Absent for
   * the native route, where the user's own `config.toml` decides — the SDK then
   * gets no `config` member at all rather than an empty object, so the two cases
   * stay distinguishable in a constructor spy.
   */
  config?: Readonly<Record<string, unknown>>;
}

/**
 * Build one SDK entry object. Called once per PROVIDER KEY (the refcounted
 * registry below) with the world home the runtime must be fetched into and the
 * launch that pins that provider; the default returns a {@link DeferredCodex},
 * so the call itself does no IO.
 */
export type CodexFactory = (
  options: CodexFactoryOptions,
  worldHome: string,
  launch: CodexSdkLaunch,
) => CodexLike;

/**
 * The production handle: a stand-in that constructs the REAL SDK entry on first
 * materialization. Deferring is what keeps session-create at zero IO while
 * still letting the fetch happen exactly once, from `ensureStarted()`.
 */
class DeferredCodex implements CodexLike {
  readonly #build: () => Promise<CodexLike>;
  #real: Promise<CodexLike> | null = null;

  constructor(build: () => Promise<CodexLike>) {
    this.#build = build;
  }

  /** Fetch (first time) + construct the real instance; resolves when usable. */
  warm(): Promise<void> {
    return this.#realCodex().then(() => undefined);
  }

  startThread(options?: CodexThreadOptions): CodexThreadLike {
    return new DeferredThread(() => this.#realCodex().then((real) => real.startThread(options)));
  }

  resumeThread(id: string, options?: CodexThreadOptions): CodexThreadLike {
    return new DeferredThread(() => this.#realCodex().then((real) => real.resumeThread(id, options)));
  }

  #realCodex(): Promise<CodexLike> {
    if (this.#real === null) {
      // A rejected bootstrap must not be cached: the runtime fetch heals on the
      // next call (a failure leaves no marker), so a retried prompt can succeed.
      this.#real = this.#build().catch((error: unknown) => {
        this.#real = null;
        throw error;
      });
    }
    return this.#real;
  }
}

/** The thread half of {@link DeferredCodex}: materializes on first `runStreamed`. */
class DeferredThread implements CodexThreadLike {
  readonly #build: () => Promise<CodexThreadLike>;
  #target: CodexThreadLike | null = null;
  #materialize: Promise<CodexThreadLike> | null = null;

  constructor(build: () => Promise<CodexThreadLike>) {
    this.#build = build;
  }

  get id(): string | null {
    return this.#target?.id ?? null;
  }

  async runStreamed(input: string, turnOptions?: CodexTurnOptions): Promise<CodexStreamedTurnLike> {
    // Local narrowing: the materializer resolves inside a callback, so TS
    // cannot see the field become non-null across the await.
    let target = this.#target;
    if (target === null) {
      this.#materialize ??= this.#build()
        .then((resolved) => {
          this.#target = resolved;
          return resolved;
        })
        .catch((error: unknown) => {
          this.#materialize = null;
          throw error;
        });
      target = await this.#materialize;
    }
    return target.runStreamed(input, turnOptions);
  }
}

/**
 * The default factory: the deferred handle wired to the durable runtime. A
 * world home is mandatory on this path — deriving one from ambient env inside
 * the client is the prod-home trap the adapter rules forbid (the provider owns
 * the resolution and passes it in).
 */
const defaultCodexFactory: CodexFactory = (options, worldHome) => {
  if (worldHome === "") {
    throw new Error("codex-sdk: the client needs the world home to fetch its SDK runtime into (the provider passes dshHomePath)");
  }
  return new DeferredCodex(async () => {
    const sdk = await loadCodexSdk(worldHome);
    // `options` already carries the provider's config overrides (when it has
    // any) and the env the caller composed — the SDK is constructed exactly as
    // the pinning launch asked, on first materialization.
    return new sdk.Codex(options) as unknown as CodexLike;
  });
};

let codexFactory: CodexFactory = defaultCodexFactory;
/** Replace the SDK construction (tests inject a fake: zero fetch, zero disk). */
export function setCodexFactory(factory: CodexFactory): void {
  codexFactory = factory;
}

// ---------------------------------------------------------------------------
// Shared Codex instances (module-level, refcounted PER PROVIDER — omp sidecar
// pattern, 2026-10-04 multi-provider rework)
// ---------------------------------------------------------------------------

/**
 * Registry key for "let the native `config.toml` decide". Also the key every
 * client starts on: the route is not known until the first turn resolves it.
 */
const NATIVE_KEY = "native";

interface SharedCodex {
  readonly codex: CodexLike;
  refs: number;
}

/**
 * One entry per PROVIDER, not one for the process: a provider is a property of
 * the config object the SDK is constructed with, so clients on different
 * providers must not share an instance. Clients on the same provider still do —
 * that is what keeps a many-session world at one SDK handle per provider.
 */
const sharedCodex = new Map<string, SharedCodex>();
let refcount = 0;

/**
 * Refcount one provider's handle, constructing it on first use. The construction
 * is cheap by contract: the default factory returns a {@link DeferredCodex}
 * (zero disk, zero network) and a test factory returns a plain fake. The REAL
 * instance — and therefore the runtime fetch — is materialized later, from
 * `ensureStarted()`.
 *
 * The first launch for a key wins. That is sound because the key IS the
 * provider: two launches on one key carry the same provider table, the same
 * catalog path and the same synthetic key name, so the handle they would build
 * is the same handle.
 */
function acquire(key: string, worldHome: string, launch: CodexSdkLaunch): CodexLike {
  let entry = sharedCodex.get(key);
  if (entry === undefined) {
    entry = {
      codex: codexFactory({ env: { ...process.env } as Record<string, string>, ...(Object.keys(launch.config).length === 0 ? {} : { config: launch.config }) }, worldHome, launch),
      refs: 0,
    };
    sharedCodex.set(key, entry);
  }
  entry.refs += 1;
  refcount += 1;
  return entry.codex;
}

function release(key: string): void {
  const entry = sharedCodex.get(key);
  if (entry === undefined) return;
  entry.refs -= 1;
  refcount = Math.max(0, refcount - 1);
  if (entry.refs <= 0) sharedCodex.delete(key);
}

/** Test/observability hook: current handle refcount across providers (0 = none alive). */
export function codexClientRefCount(): number {
  return refcount;
}

// ---------------------------------------------------------------------------
// Wire response/state shapes (RpcResponse / OmpState ports, codex-internal names)
// ---------------------------------------------------------------------------

/** Response-shape shim so RpcResponse-typed call sites keep compiling (Task 7). */
export interface WireResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** The `get_state`-shaped payload (omp OmpState port, codex-internal name). */
export interface WireState {
  isStreaming: boolean;
}

function ok(command: string): WireResponse {
  return { type: "response", command, success: true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Parse the omp-style spawn args. `--approval-mode <v>` is accepted and
 * applied verbatim as the thread's launch `approvalPolicy` — the 3-preset
 * mapping resolves the VALUE provider-side (Task 7's permission.ts) and the
 * thread carries it on every construction (start, resume, setModel rebuild).
 * `--resume-thread <id>` constructs the client on `codex.resumeThread(id, …)`
 * — the thread-identity resume (plan Task 7), strictly distinct from the
 * rejected omp-style `--resume <file>`, which keeps failing loudly exactly
 * like unknown args.
 */
function parseSpawnArgs(args: string[]): { approvalMode?: string; resumeThreadId?: string } {
  const out: { approvalMode?: string; resumeThreadId?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--approval-mode" && args[i + 1] !== undefined) {
      out.approvalMode = args[++i];
    } else if (args[i] === "--resume-thread" && args[i + 1] !== undefined) {
      out.resumeThreadId = args[++i];
    } else {
      throw new Error(`CodexSdkClient: unsupported spawn arg "${String(args[i])}" (SDK line)`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export class CodexSdkClient {
  /** The handle in force; swapped when the route moves to another provider. */
  #codex: CodexLike;
  /**
   * The world home the SDK runtime is fetched into. Held (not just borrowed at
   * spawn) because a provider switch constructs the NEXT handle from it.
   */
  readonly #worldHome: string;
  /**
   * The launch the next turn must run under, and the registry key it maps to.
   * `applyLaunch` is the only writer; both start native, because the route is
   * not known until the first turn resolves it.
   */
  #launch: CodexSdkLaunch = NATIVE_SDK_LAUNCH;
  #launchKey: string = NATIVE_KEY;
  /** The key `#codex` is currently a handle of (what `close()` must release). */
  #appliedProvider: string = NATIVE_KEY;
  readonly #listeners = new Set<(event: WireEvent) => void>();
  readonly #failureListeners = new Set<(error: Error) => void>();
  readonly #threadOptions: CodexThreadOptions;
  readonly #messages: WireMessage[] = [];
  readonly #queue: string[] = [];
  #approvalMode: string | undefined;
  #thread: CodexThreadLike;
  #closed = false;
  #failure: Error | null = null;
  #inFlight = false;
  #currentAbort: AbortController | null = null;
  #currentRun: Promise<void> | null = null;
  #pendingModel: string | null = null;
  #appliedModel: string | null = null;
  #lastUsage: Record<string, unknown> | null = null;
  /** Bumped by newSession()/close() to orphan runs started on an earlier thread. */
  #sessionEpoch = 0;
  /** One-shot latch for `ensureStarted()` — the runtime fetch happens there. */
  #startPromise: Promise<void> | null = null;

  private constructor(codex: CodexLike, cwd: string | undefined, approvalMode?: string, resumeThreadId?: string, worldHome = "") {
    this.#codex = codex;
    this.#worldHome = worldHome;
    this.#approvalMode = approvalMode;
    // skipGitRepoCheck: adapters spawn from arbitrary test/worktree cwds (Task 1 spike precedent).
    // Launch-only approval mapping (Task 7): present only when the provider
    // resolved a preset, so plain spawns keep the bare ThreadOptions shape.
    this.#threadOptions = {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      ...(approvalMode === undefined ? {} : { approvalPolicy: approvalMode }),
    };
    // `--resume-thread <id>` re-attaches to the existing Codex thread (the
    // model context lives in Codex's rollout); plain spawn starts a fresh one.
    this.#thread =
      resumeThreadId === undefined ? codex.startThread(this.#threadOptions) : codex.resumeThread(resumeThreadId, this.#threadOptions);
  }

  /**
   * Construct a client on the shared handle. ZERO IO by contract: the default
   * factory hands back a deferred SDK stand-in, so neither the runtime fetch
   * nor the real SDK construction happens here — `ensureStarted()` owns both.
   * A session that is created and never prompted therefore fetches nothing.
   * Mirrors `OmpSdkClient.spawn(args, cwd)`.
   */
  static async spawn(args: string[] = [], cwd?: string, worldHome?: string): Promise<CodexSdkClient> {
    const { approvalMode, resumeThreadId } = parseSpawnArgs(args);
    // Born on the native key: the route is not known until the first turn
    // resolves it, and `applyLaunch` moves this client onto the provider it
    // names. The handle is deferred either way, so nothing is constructed,
    // fetched or even decided by this call.
    const home = worldHome ?? "";
    const codex = acquire(NATIVE_KEY, home, NATIVE_SDK_LAUNCH);
    try {
      return new CodexSdkClient(codex, cwd, approvalMode, resumeThreadId, home);
    } catch (error) {
      release(NATIVE_KEY);
      throw error;
    }
  }

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
   * Raw-command escape hatch. The SDK line has no stdio command channel, so
   * RPC-specific records (e.g. `extension_ui_response` approval answers) are
   * accepted and logged under CODEX_TRACE=1 — approval flows route through
   * SDK-side approval work (Task 7 parity item).
   */
  sendRaw(command: Record<string, unknown>): void {
    if (this.#failure !== null || this.#closed) return;
    if (process.env.CODEX_TRACE === "1") {
      process.stderr.write(`[codex-sdk] sendRaw (no-op on SDK line): ${JSON.stringify(command).slice(0, 160)}\n`);
    }
  }

  /** Generic command sender mapping the omp command table onto client methods. */
  async send(command: Record<string, unknown>): Promise<WireResponse> {
    switch (command.type) {
      case "prompt":
        await this.prompt(String(command.message));
        return ok("prompt");
      case "steer":
        await this.steer(String(command.message));
        return ok("steer");
      case "follow_up":
        await this.followUp(String(command.message));
        return ok("follow_up");
      case "abort":
        await this.abort();
        return ok("abort");
      case "set_model":
        await this.setModel(String(command.provider), String(command.modelId));
        return ok("set_model");
      case "new_session":
        await this.newSession();
        return ok("new_session");
      case "get_state":
        return { type: "response", command: "get_state", success: true, data: await this.getState() };
      case "get_messages":
        return { type: "response", command: "get_messages", success: true, data: { messages: await this.getMessages() } };
      default:
        throw new Error(`CodexSdkClient.send: unsupported command "${String(command.type)}" (SDK line)`);
    }
  }

  /** Query session state; returns the `get_state`-shaped payload. */
  async getState(): Promise<WireState> {
    this.#ensureUsable();
    return { isStreaming: this.#inFlight };
  }

  /**
   * Best-effort conversation mirror accumulated from the wire (user echoes at
   * acceptance, assistant message_end, toolResult). The authoritative
   * transcript comes from the rollout scan (codex-store.ts); reasoning-only
   * messages are not mirrored. Fail-soft: [] when nothing accumulated.
   */
  async getMessages(): Promise<WireMessage[]> {
    try {
      return [...this.#messages];
    } catch {
      return [];
    }
  }

  /** Live token accounting from the last turn_end usage (fail-soft {}). */
  async getSessionStats(): Promise<Record<string, unknown>> {
    try {
      const usage = this.#lastUsage;
      if (usage === null) return {};
      const tokens: Record<string, number> = {};
      const map: Array<[string, string]> = [
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

  /** Codex has no subagent registry (fail-soft constant, omp surface parity). */
  async getSubagents(): Promise<unknown[]> {
    return [];
  }

  /** Start a turn with a user prompt (fire-and-forget acceptance). */
  async prompt(message: string): Promise<WireResponse> {
    this.#ensureUsable();
    this.#enqueueOrRun(message);
    return ok("prompt");
  }

  /** Queue a follow-up on a busy session (runs immediately when idle). */
  async followUp(message: string): Promise<WireResponse> {
    this.#ensureUsable();
    this.#enqueueOrRun(message);
    return ok("follow_up");
  }

  /**
   * Steer an in-flight turn — 2026-09-10 gap table: the SDK line has no steer,
   * so this is the queued-followUp approximation (plan Global Constraints:
   * "无 steer（→ followUp 队列近似）"); while idle it degrades to a plain
   * prompt, while in flight the message runs right after the current turn
   * settles.
   */
  async steer(message: string): Promise<WireResponse> {
    this.#ensureUsable();
    if (this.#inFlight && process.env.CODEX_TRACE === "1") {
      process.stderr.write("[codex-sdk] steer approximated as queued followUp (SDK gap)\n");
    }
    this.#enqueueOrRun(message);
    return ok("steer");
  }

  /**
   * Select the active model. SDK has no live setModel (2026-09-10 gap table):
   * the id is stored and applied as the `model` ThreadOption on the NEXT run —
   * via resumeThread when the thread already has an id, so conversation
   * context survives the model switch. `provider` is accepted for surface
   * parity; codex resolves models from its own catalog.
   */
  async setModel(provider: string, modelId: string): Promise<WireResponse> {
    this.#ensureUsable();
    void provider;
    this.#pendingModel = this.#modelOverride(modelId);
    return ok("set_model");
  }

  /** Abort the current streaming run (AbortController per run, turn-level signal). */
  async abort(): Promise<WireResponse> {
    this.#currentAbort?.abort();
    const run = this.#currentRun;
    if (run !== null) await run; // settle first so state is deterministically idle
    return ok("abort");
  }

  /** Discard the current thread and message mirror; start fresh. */
  async newSession(): Promise<WireResponse> {
    this.#ensureUsable();
    // Invalidate THIS run's queue-drain before aborting it: its finally must
    // not start a queued message on the thread we are about to discard.
    this.#sessionEpoch += 1;
    this.#currentAbort?.abort();
    const run = this.#currentRun;
    if (run !== null) await run;
    this.#queue.length = 0;
    this.#messages.length = 0;
    this.#thread = this.#codex.startThread(this.#threadOptions);
    this.#appliedModel = null; // a pending model still applies at the next run
    return ok("new_session");
  }

  /**
   * Materialize the durable SDK runtime (fetch on first call, then free) and
   * the real SDK instance behind it. This is the ONLY place the production path
   * may touch the network — `create()`/`spawn()` stay zero-IO.
   *
   * A failure is NOT memoized: the runtime bootstrap leaves no marker and heals
   * on the next call, so a later prompt in the same session retries instead of
   * being permanently bricked.
   */
  async ensureStarted(): Promise<void> {
    if (this.#startPromise === null) {
      this.#startPromise = (async () => {
        const warm = (this.#codex as { warm?: () => Promise<void> }).warm;
        if (typeof warm === "function") await warm.call(this.#codex);
      })().catch((error: unknown) => {
        this.#startPromise = null;
        throw error;
      });
    }
    return this.#startPromise;
  }

  /**
   * The current Codex thread id, exactly as the SDK thread exposes it (null
   * until the thread materializes one). The provider keeps the
   * threadId ↔ Dash-session-id index from this (Task 7).
   */
  get threadId(): string | null {
    return this.#thread.id;
  }

  /**
   * Lazy-surface parity: a real client is born live (see OmpAgentRpc.spawned).
   * Kept `true` on the deferred path on purpose: the client's whole surface is
   * usable from construction, and `ensureStarted()` only warms the runtime —
   * this flag was never the "has the fetch happened" bit.
   */
  get spawned(): boolean {
    return true;
  }

  /** Release the shared-instance refcount and fail all future operations. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#sessionEpoch += 1; // a settled run must not drain the queue after close
    this.#currentAbort?.abort();
    release(this.#appliedProvider);
    this.#fail(new Error("codex sdk client closed"));
  }

  // -------------------------------------------------------------------------

  #ensureUsable(): void {
    if (this.#failure !== null) throw this.#failure;
    if (this.#closed) throw new Error("codex sdk client is closed");
  }

  /** Queue behind the in-flight turn, or start a run now. */
  #enqueueOrRun(message: string): void {
    if (this.#inFlight) {
      this.#queue.push(message);
      return;
    }
    this.#startRun(message);
  }

  #startRun(message: string): void {
    this.#messages.push({ role: "user", content: [{ type: "text", text: message }] });
    const run = this.#runTurn(message);
    this.#currentRun = run;
  }

  /**
   * One streamed turn: runStreamed on the thread, pump raw SDK events through
   * projectThreadEvent, mirror the conversation, settle to agent_end. Mirrors
   * the real SDK abort contract: an aborted turn just ENDS the stream (Task 1
   * spike — no throw guarantee), so it settles like a normal end; thrown errors
   * and the fatal top-level `error` event go to onFailure.
   */
  async #runTurn(message: string): Promise<void> {
    // Session epoch: bumped by newSession()/close() so a run that started on
    // the previous thread never drains the queue onto the new one.
    const epoch = this.#sessionEpoch;
    this.#inFlight = true;
    const controller = new AbortController();
    this.#currentAbort = controller;
    try {
      this.#reconcileRoute();
      const streamed = await this.#thread.runStreamed(message, { signal: controller.signal });
      for await (const raw of streamed.events) {
        const record = asRecord(raw);
        if (record !== null && record.type === "error") {
          // Fatal stream error: SDK contract surfaces it here, not as a throw.
          this.#fail(new Error(typeof record.message === "string" ? record.message : "codex stream error"));
          return;
        }
        const wire = projectThreadEvent(raw);
        if (wire !== null) {
          const events = Array.isArray(wire) ? wire : [wire];
          for (const event of events) {
            this.#emit(event);
            this.#mirror(event);
          }
        }
      }
      this.#emit({ type: "agent_end" });
    } catch (error) {
      if (controller.signal.aborted) {
        // Real SDK: the stream ends behind an abort — settle, stay idle.
        this.#emit({ type: "agent_end" });
      } else {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.#inFlight = false;
      this.#currentAbort = null;
      this.#currentRun = null;
      const next = this.#queue.shift();
      if (next !== undefined && epoch === this.#sessionEpoch && this.#failure === null && !this.#closed) {
        this.#startRun(next);
      }
    }
  }

  /**
   * Put the resolved route in force for the next run: swap the handle if the
   * PROVIDER moved, then rebuild the thread object against it.
   *
   * Cheaper than the app-server line's equivalent by construction. There, a
   * provider is an argv-level property of a LONG-LIVED child, so a switch means
   * killing it and re-attaching the thread to a new one (`reattach`). Here the
   * SDK spawns `codex exec` (or `codex exec resume <id>`) PER RUN, so the
   * provider is a property of the handle we are about to ask for a run — the
   * switch is just "use the other handle from now on", and the thread keeps its
   * identity because the id is a rollout on disk that both handles read.
   *
   * That also means a mid-turn switch lands on the next turn for free, exactly
   * as the app-server line promises: the user message already dispatched keeps
   * the handle it started with, and the next `#runTurn` re-reads the route.
   */
  #reconcileRoute(): void {
    const key = this.#launchKey;
    const providerMoved = key !== this.#appliedProvider;
    if (!providerMoved && this.#pendingModel === this.#appliedModel) return;
    if (providerMoved) {
      this.#codex = acquire(key, this.#worldHome, this.#launch);
      release(this.#appliedProvider);
      this.#appliedProvider = key;
    }
    const model = this.#pendingModel;
    const options: CodexThreadOptions =
      model === null ? { ...this.#threadOptions } : { ...this.#threadOptions, model };
    // Resume by id whenever the thread has one: that is what carries the
    // conversation across BOTH a model change and a provider change.
    const currentId = this.#thread.id;
    this.#thread =
      currentId !== null ? this.#codex.resumeThread(currentId, options) : this.#codex.startThread(options);
    this.#appliedModel = model;
  }

  /**
   * Pin the provider the NEXT run must use (2026-10-04 multi-provider rework).
   *
   * Called by the agent at turn open with the launch it resolved, so the client
   * never has to know what a provider IS — it is handed a config and an env and
   * runs on them. `providerId` is `null` for "let the native `config.toml`
   * decide", which is what a session pinned to the retired single `codex` route
   * resolves to.
   */
  applyRoute(launch: CodexSdkLaunch, providerId: string | null, model: string): void {
    this.#launch = launch;
    this.#launchKey = providerId ?? NATIVE_KEY;
    this.#pendingModel = this.#modelOverride(model);
  }

  /**
   * An empty model id means "pin no model", not "pin the empty model": the
   * native `config.toml` then decides, which is what a route the adapter cannot
   * resolve falls back to. Letting `model=""` through would emit
   * `--config model=""` and codex would reject every turn.
   */
  #modelOverride(model: string): string | null {
    return model === "" ? null : model;
  }

  /** Mirror wire events into the getMessages accumulator (best effort). */
  #mirror(wire: WireEvent): void {
    if (wire.type === "message_end") {
      const message = asRecord(wire.message);
      if (message !== null && message.role === "assistant") {
        // Reasoning-only messages are not mirrored (see getMessages doc).
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
      return;
    }
    if (wire.type === "turn_end") {
      const data = asRecord(wire.data);
      const usage = asRecord(data?.usage);
      if (usage !== null) this.#lastUsage = usage;
    }
  }

  #emit(event: WireEvent): void {
    if (this.#closed) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        process.stderr.write(`codex sdk listener error: ${String(error)}\n`);
      }
    }
  }

  #fail(error: Error): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    for (const listener of [...this.#failureListeners]) {
      try {
        listener(error);
      } catch (listenerError) {
        process.stderr.write(`codex sdk failure listener error: ${String(listenerError)}\n`);
      }
    }
  }
}
