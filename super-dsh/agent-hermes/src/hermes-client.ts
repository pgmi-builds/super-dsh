/**
 * HermesGatewayClient — the reusable TUI-gateway client seam (AW-H Task 3).
 *
 * One client = one gateway child bound to one gateway session. Transports:
 * `stdio` (legacy default) spawns `python -m tui_gateway.entry` (owns the
 * Hermes home); `attach` (SUPERD_HERMES_TRANSPORT=attach) spawns the
 * WS-attach bridge — same stdio ndjson JSON-RPC contract, frames relayed to
 * the profile's canonical gateway WebSocket. Spawn/env/ready patterns
 * follow the upstream reference client `ui-tui/src/gatewayClient.ts` and the
 * Task 1 spike (`src/spike.ts`, live-pinned protocol facts):
 *
 *   req   -> {"id":"r<n>","jsonrpc":"2.0","method":...,"params":{...}}\n
 *   resp  <- {"jsonrpc":"2.0","id":"r<n>","result":...}|{"error":{code,message}}
 *   event <- {"jsonrpc":"2.0","method":"event","params":{"type",…,"session_id"?,"payload"?}}
 *
 * Event frames are demultiplexed (this session's frames only — the ~60s
 * `sessions.changed` poller carries `session_id:""` and never matches), fed
 * through the PURE Task 2 projector `projectGatewayEvent` with a CLIENT-OWNED
 * read-only `ProjectionCtx`, and streamed to `on()` listeners in the omp wire
 * vocabulary — so Task 7's agent.ts port compiles against this client the way
 * it compiles against the codex one (setCodexFactory-style injection seam
 * included: {@link setGatewayFactory}).
 *
 * Client-owned accumulation the purity contract delegates here (Task 2 §5):
 *   - ctx transitions: message.start→{turnOpen,openAssistant}; healed
 *     message.delta→openAssistant; message.complete terminal→both false;
 *     error event→turnOpen=false.
 *   - orphan tool.complete: gateway emission gates differ between start and
 *     complete (server.py _on_tool_start ~8138 vs _on_tool_complete ~8185),
 *     so a tool.complete may arrive without its tool.start — synthesize the
 *     missing `tool_execution_start` from the complete payload (seen-id set
 *     lives HERE, the projector stays pure).
 *   - thinking accumulation: thinking.delta/reasoning.delta text is buffered;
 *     at message.complete the buffer is injected into the payload copy handed
 *     to the projector when the gateway did NOT re-attach `reasoning` (live
 *     fixture fact) — gateway `reasoning` always wins when present.
 *
 * Turn boundary (Task 1 §9.2, controller ruling): `prompt(text)` resolves on
 * the settled pair — `message.complete` followed by `session.info` with
 * `payload.running === false` — or rejects on a gateway `error` event, child
 * exit/failure, an RPC error on the submit (4090/5072 … — refused BEFORE any
 * turn), or a non-streaming ack. REQUEST_TIMEOUT_MS (120s, TUI parity) guards
 * the submit ACK only; the turn itself is governed by the pair. `prompt`
 * REJECTS while a turn is in flight (busy guard — the agent layer owns
 * queueing; the gateway's default busy policy is interrupt, so the client
 * must never deliver prompt.submit into a busy gateway).
 *
 * Approval bridge: `approval.request` events (payload per server.py:3036
 * `_approval_request_payload` over tools/approval.py pending_data — request_id
 * uuid-hex, redacted command, description, pattern_key(s), choices) go to the
 * FIRST registered `onApproval` listener; its answer ("once"|"always"|"deny")
 * is sent via `approval.respond {session_id, choice, request_id?}`. Missing
 * listener / throw / void answer / 30s timeout → `deny` (fail closed).
 *
 * Resume replay suppression: events for our session arriving BEFORE the
 * `session.resume` response are dropped (replay — the DSH log is the replay
 * authority). `defer_history` is deliberately NOT passed; the pre-response
 * drop window is the only mechanism.
 *
 * Env: full `{...process.env}` pass-through (+`PYTHONPATH` root prepend,
 * +`HERMES_PYTHON_SRC_ROOT` — both spike-proven required when the child cwd
 * is not the hermes root); `HERMES_HOME` is NEVER set and always stripped,
 * as are `HERMES_CWD`/`HERMES_TUI_GATEWAY_URL`/`HERMES_TUI_SIDECAR_URL`
 * (keep the spawned stdio transport the only transport).
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ForeignHubBinding } from "@pgmi-builds/superd-hub/foreign-hub";
import { prepareHermesNativePlugin } from "@pgmi-builds/superd-hub/foreign-native";
import { createInterface } from "node:readline";
import { projectGatewayEvent, type ProjectionCtx, type WireEvent } from "./hermes-events.js";

const READY_TIMEOUT_MS = 15_000; // TUI parity (STARTUP_TIMEOUT_MS)
const REQUEST_TIMEOUT_MS = 120_000; // per-RPC cap (upstream REQUEST_TIMEOUT_MS)
const APPROVAL_TIMEOUT_MS = 30_000; // approval listener deadline → deny
const KILL_GRACE_MS = 3_000; // SIGTERM → SIGKILL fallback
const STDERR_RING = 200; // child stderr ring buffer for failure messages

function parseSpawnGrace(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 600_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 600_000;
}

/**
 * Idle-PROBE reaper grace (env `HERMES_SPAWN_GRACE_MS`, default 10 min).
 * Exported because the catalog probe opts in explicitly via
 * `spawn({spawnGraceMs})`; AGENT-HELD clients never arm the reaper
 * (2026-09-17 ruling 4: a view-time eager resume may sit unprompted far
 * longer than the grace — reaping it stamps a terminal failure on a
 * registered agent and wedges every later prompt). `0` disables.
 */
export const HERMES_SPAWN_GRACE_MS = parseSpawnGrace(process.env.HERMES_SPAWN_GRACE_MS);

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Approval decisions the bridge can carry (Dash bridge surface; the gateway
 *  also accepts "session", which this client deliberately does not offer). */
export type GatewayApprovalChoice = "once" | "always" | "deny";

/** Client-safe view of one pending gateway approval (approval.request). */
export interface GatewayApprovalRequest {
  requestId: string;
  title: string;
  command?: string;
  raw?: unknown;
}

/** session.create / session.resume result (Task 1 §3⑤ — duck-typed, superset-safe). */
export interface GatewaySessionInfo {
  session_id: string;
  stored_session_id?: string;
  message_count?: number;
  messages?: unknown[];
  info?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * spawn() options; the *TimeoutMs fields exist for tests (defaults are the
 * production constants — 15s ready, 120s RPC, 30s approval).
 */
export interface HermesClientSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  hub?: ForeignHubBinding;
  /** Native plugin delivery seam, replaced by fixtures without changing HOME. */
  prepareHub?: (binding: ForeignHubBinding) => Promise<string | undefined>;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  approvalTimeoutMs?: number;
  /**
   * Arm the idle-probe reaper with this grace (ms). DEFAULT 0 = OFF: the
   * reaper exists for the self-closing catalog-probe client only. Agent-held
   * clients keep their child until the agent's own lifecycle disposes them
   * (2026-09-17 ruling 4).
   */
  spawnGraceMs?: number;
  /**
   * DEFER the python child until the first `ensureStarted()` (2026-09-18
   * full-lazy ruling: viewing a session spawns NOTHING — the child exists
   * only from the first prompt until the agent's idle-exit disposes it).
   * Default false keeps the eager behavior for the catalog probe.
   */
  lazy?: boolean;
}

/** Total spawn attempts for the pre-ready retry (2026-09-18 user ruling: ~3). */
export const HERMES_SPAWN_ATTEMPTS = 3;

/** RPC error frame surfaced as a rejected promise (code 4090/5072/4001/…). */
export class GatewayRpcError extends Error {
  readonly code: number | undefined;
  readonly method: string;

  constructor(method: string, message: string, code?: number) {
    super(`${method}: ${message}${code !== undefined ? ` (code ${code})` : ""}`);
    this.name = "GatewayRpcError";
    this.method = method;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Process factory seam (setCodexFactory pattern — tests inject a fake child)
// ---------------------------------------------------------------------------

/** Minimal structural shape of the spawned gateway child (duck-typed). */
export interface GatewayProcessLike {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly exitCode: number | null;
  readonly killed: boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): void;
}

/** Everything the factory needs to spawn the gateway child. */
export interface GatewaySpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

export type GatewayProcessFactory = (options: GatewaySpawnOptions) => GatewayProcessLike;

const defaultGatewayFactory: GatewayProcessFactory = (options) =>
  spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as GatewayProcessLike;

let gatewayFactory: GatewayProcessFactory = defaultGatewayFactory;

/** Replace the process spawner (tests inject a fake child). `null` restores default. */
export function setGatewayFactory(factory: GatewayProcessFactory | null): void {
  gatewayFactory = factory ?? defaultGatewayFactory;
}

/** Brief-pinned order: SUPERD_HERMES_PYTHON → <root>/venv/bin/python → <root>/.venv/bin/python → PATH python3. */
export function resolveHermesPython(root: string): string {
  const configured = process.env.SUPERD_HERMES_PYTHON?.trim();
  if (configured) return configured;
  for (const p of [resolve(root, "venv/bin/python"), resolve(root, ".venv/bin/python")]) {
    if (existsSync(p)) return p;
  }
  return "python3";
}

/** Hermes root: SUPERD_HERMES_ROOT → ~/.hermes/hermes-agent (native home — never redirected). */
export function resolveHermesRoot(): string {
  return process.env.SUPERD_HERMES_ROOT?.trim() || resolve(homedir(), ".hermes/hermes-agent");
}

/** Parse one `.env` body into entries: `#` comments, optional `export ` prefix,
 *  optional single/double quotes, `KEY=VALUE` on one line each. Unparsable
 *  lines are skipped (best effort — the gateway tolerates partial envs). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** The native home's `.env` (`~/.hermes/.env`), parsed once per call. The omp
 *  and pi runtimes load their own native `.env` on startup; the hermes gateway
 *  child does NOT (and the harness env deliberately carries no provider
 *  keys), so without this the spawned gateway sees zero provider credentials
 *  — every provider request dies as quota/auth regardless of model. */
export function loadHermesDotEnv(): Record<string, string> {
  const path = resolve(resolveHermesRoot(), "..", ".env");
  if (!existsSync(path)) return {};
  try {
    return parseDotEnv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** Gateway child transport. `stdio` = the legacy in-child `tui_gateway.entry`
 *  server (owns the Hermes home exclusively). `attach` = the WS-attach bridge
 *  (`bridge/hermes-ws-bridge.py`): frames ride the profile's canonical gateway
 *  WebSocket via `hermes_cli.gateway_client.connect_gateway`, which attaches
 *  to the running owner or starts an idle-exit one — REQUIRED whenever the
 *  user's native Hermes gateway already owns `~/.hermes` (2026-11-02: every
 *  stdio spawn died with `[gateway-exit] refused: ... owned by a running
 *  gateway`, and the reserved-turn failure window corrupted session logs).
 *  Selection: `SUPERD_HERMES_TRANSPORT` process env wins, then the native
 *  `~/.hermes/.env` key (hot-editable without touching the host process),
 *  else `stdio`. Unknown values fall back to `stdio`. */
export function resolveHermesTransport(dotEnv: Record<string, string> = {}): "stdio" | "attach" {
  const raw = process.env.SUPERD_HERMES_TRANSPORT?.trim() || dotEnv.SUPERD_HERMES_TRANSPORT?.trim() || "stdio";
  return raw === "attach" ? "attach" : "stdio";
}

/** The WS-attach bridge script, shipped at the package root (`bridge/`). */
export function hermesBridgeScriptPath(): string {
  const path = fileURLToPath(new URL("../bridge/hermes-ws-bridge.py", import.meta.url));
  if (!existsSync(path)) throw new Error(`hermes ws-attach bridge missing: ${path}`);
  return path;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class HermesGatewayClient {
  #child: GatewayProcessLike | null = null;
  readonly #listeners = new Set<(event: WireEvent) => void>();
  readonly #approvalListeners = new Set<(req: GatewayApprovalRequest) => Promise<GatewayApprovalChoice | void> | void>();
  readonly #failureListeners = new Set<(error: Error) => void>();
  readonly #adoptedListeners = new Set<(info: GatewaySessionInfo) => void>();
  readonly #pending = new Map<string, PendingRpc>();
  readonly #seenToolIds = new Set<string>();
  readonly #stderrLines: string[] = [];
  readonly #requestTimeoutMs: number;
  readonly #approvalTimeoutMs: number;
  #reqSeq = 0;
  #readyResolve!: () => void;
  #readyReject!: (error: Error) => void;
  #readyPromise: Promise<void> | null = null;
  #lazy = false;
  #readySettled = false;
  /** Pre-ready respawn attempts (full-lazy ruling: bounded at SPAWN_ATTEMPTS). */
  #spawnAttempts = 0;
  #readyTimer: ReturnType<typeof setTimeout> | null = null;
  #killTimer: ReturnType<typeof setTimeout> | null = null;
  #failure: Error | null = null;
  #closed = false;
  #sessionId: string | null = null;
  /** Durable state.db key from session.create/resume (`stored_session_id`). */
  #storedSessionId: string | null = null;
  #ctx: ProjectionCtx = { turnOpen: false, openAssistant: false };
  #thinking = "";
  #turnInFlight = false;
  #turnCompleteSeen = false;
  #turnSettledInfoSeen = false;
  #turnWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  #replayDrop = false;
  /** Last non-empty session.info `system_prompt` (fixture-verified capture). */
  #systemPrompt = "";
  /** Last non-empty session.info `title` (client-side capture). */
  #title = "";
  /**
   * Idle-PROBE reaper (opt-in via spawnGraceMs): fires when no gateway session
   * materialized within the grace. Agent-held clients never arm it (ruling 4).
   */
  #spawnGraceTimer: ReturnType<typeof setTimeout> | null = null;
  #hubPreparation: Promise<void> | undefined;
  #hubSession: string | undefined;

  private constructor(opts: HermesClientSpawnOptions) {
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#approvalTimeoutMs = opts.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.#lazy = opts.lazy === true;
    this.#spawnOpts = opts;
    if (!this.#lazy) {
      if (opts.hub === undefined) this.#materializeChild();
      else void this.ensureStarted().catch(() => {});
    }
  }

  /** Captured spawn options for deferred materialization (lazy clients). */
  readonly #spawnOpts: HermesClientSpawnOptions;

  /** Start the python child + wire its streams and ready gate. Idempotent-ish:
   *  called once, either from the constructor (eager) or the first
   *  `ensureStarted()` (lazy). */
  #materializeChild(): void {
    const opts = this.#spawnOpts;
    this.#spawnAttempts += 1;
    const attempt = this.#spawnAttempts;
    const root = resolveHermesRoot();
    const python = resolveHermesPython(root);
    const dotEnv = loadHermesDotEnv();
    const transport = resolveHermesTransport(dotEnv);
    const env: Record<string, string> = { ...(opts.env ?? process.env) } as Record<string, string>;
    if (this.#hubSession !== undefined) env.SUPERD_HUB_SESSION = this.#hubSession;
    else delete env.SUPERD_HUB_SESSION;
    // Native `.env` fill (dotenv convention: existing env WINS). The omp and
    // pi runtimes load their own native `.env`; the hermes gateway child does
    // not, and the harness env carries no provider keys — without this fill
    // every provider request dies as quota/auth regardless of model.
    for (const [dotKey, dotValue] of Object.entries(dotEnv)) {
      if (env[dotKey] === undefined || env[dotKey] === "") env[dotKey] = dotValue;
    }
    const prevPath = env.PYTHONPATH?.trim();
    env.PYTHONPATH = prevPath ? `${root}${delimiter}${prevPath}` : root;
    env.HERMES_PYTHON_SRC_ROOT = root;
    // Never set HERMES_HOME (native home stays native); strip every transport
    // selector that would divert from the spawned stdio child (spike constraint).
    delete env.HERMES_HOME;
    delete env.HERMES_CWD;
    delete env.HERMES_TUI_GATEWAY_URL;
    delete env.HERMES_TUI_SIDECAR_URL;

    const childSpec = transport === "attach"
      ? { command: python, args: [hermesBridgeScriptPath()], cwd: opts.cwd ?? root, env }
      : { command: python, args: ["-m", "tui_gateway.entry"], cwd: opts.cwd ?? root, env };
    this.#trace(`spawn transport=${transport} cmd=${childSpec.command} args=${JSON.stringify(childSpec.args)}`);
    this.#child = gatewayFactory(childSpec);

    // The ready gate is created ONCE and survives every pre-ready respawn —
    // replacing it would orphan callers awaiting the earlier object.
    if (this.#readyPromise === null) {
      this.#readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
        this.#readyResolve = resolvePromise;
        this.#readyReject = rejectPromise;
      });
      // Mark handled eagerly: a caller that never awaits ensureStarted() must not
      // surface an unhandledRejection when this gate rejects (timeout/close).
      this.#readyPromise.catch(() => { });
    }
    // attach: gateway discovery (5s) or an idle-exit daemon start (ensure
    // timeout 30s) can exceed the stdio boot budget before gateway.ready.
    const readyTimeoutMs = opts.readyTimeoutMs ?? (transport === "attach" ? 45_000 : READY_TIMEOUT_MS);
    this.#readyTimer = setTimeout(() => {
      this.#preReadyFailure(new Error(
        `timed out waiting for gateway.ready after ${readyTimeoutMs}ms (spawn attempt ${attempt}/${HERMES_SPAWN_ATTEMPTS}); stderr tail:\n${this.#stderrTail()}`,
      ));
    }, readyTimeoutMs);
    // Timers represent pending client work and hold the event loop (upstream TUI
    // parity — no unref; a drained loop with a pending RPC is a real hang to surface).

    if (this.#child.stdout !== null) {
      createInterface({ input: this.#child.stdout }).on("line", (raw) => this.#onStdoutLine(raw));
    }
    if (this.#child.stderr !== null) {
      createInterface({ input: this.#child.stderr }).on("line", (raw) => this.#pushStderr(raw));
    }
    this.#child.on("error", (error) => this.#preReadyFailure(new Error(`gateway child error: ${error.message}`)));
    this.#child.on("exit", (code) => {
      if (this.#killTimer !== null) {
        clearTimeout(this.#killTimer);
        this.#killTimer = null;
      }
      this.#preReadyFailure(new Error(`gateway child exited (code=${code ?? "null"}); stderr tail:\n${this.#stderrTail()}`));
    });
    // Idle-probe reaper (I3 ruling, rescoped 2026-09-17): ONLY the self-closing
    // catalog-probe client arms it (explicit spawnGraceMs). A client held by an
    // agent stays alive until the agent's own lifecycle disposes it — its
    // gateway session materializes at the FIRST prompt, which may legitimately
    // sit far beyond any grace (view-time eager resume).
    const spawnGraceMs = opts.spawnGraceMs ?? 0;
    if (spawnGraceMs > 0) {
      this.#spawnGraceTimer = setTimeout(() => {
        this.#spawnGraceTimer = null;
        if (this.#sessionId === null && this.#failure === null && !this.#closed) {
          this.#trace(`spawn grace expired (${spawnGraceMs}ms) without a gateway session — closing idle probe child`);
          this.close();
        }
      }, spawnGraceMs);
      this.#spawnGraceTimer.unref?.();
    }
  }

  /** Spawn the gateway child. Requests made before gateway.ready are queued
   *  behind `ensureStarted()` — nothing is written to stdin before ready. */
  static spawn(opts: HermesClientSpawnOptions = {}): HermesGatewayClient {
    return new HermesGatewayClient(opts);
  }

  // -- listener surfaces -----------------------------------------------------

  /** Register a wire-event listener (omp vocabulary); returns the unsubscriber. */
  on(listener: (event: WireEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Register an approval listener (async, first-registered wins); returns the unsubscriber. */
  onApproval(listener: (req: GatewayApprovalRequest) => Promise<GatewayApprovalChoice | void> | void): () => void {
    this.#approvalListeners.add(listener);
    return () => {
      this.#approvalListeners.delete(listener);
    };
  }

  /**
   * Register an adoption listener: fired ONCE when session.create/resume
   * adopts a gateway session, with the raw response — the surface that makes
   * a reminted `stored_session_id` visible so the provider's identity map can
   * follow the drift (2026-09-17 ruling). Returns the unsubscriber.
   */
  onAdopted(listener: (info: GatewaySessionInfo) => void): () => void {
    this.#adoptedListeners.add(listener);
    return () => {
      this.#adoptedListeners.delete(listener);
    };
  }

  /** Register a failure listener (child exit/error, ready timeout, close); returns the unsubscriber. */
  onFailure(listener: (error: Error) => void): () => void {
    this.#failureListeners.add(listener);
    return () => {
      this.#failureListeners.delete(listener);
    };
  }

  /** The bound live gateway session id (null until createSession/resumeSession). */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  /**
   * The durable gateway session key (`stored_session_id` from session.create /
   * session.resume) — the state.db key that survives a gateway restart.
   * `null` until a session materializes.
   */
  get storedSessionId(): string | null {
    return this.#storedSessionId;
  }

  /**
   * The last non-empty `system_prompt` captured from a `session.info` payload
   * (fixture-verified: the gateway attaches it to the settled session.info,
   * empty before the first turn). Task 7's agent stamps it as the
   * `system/message` surface node once non-empty. Empty until the gateway
   * reports one.
   */
  get systemPrompt(): string {
    return this.#systemPrompt;
  }

  /**
   * The last non-empty `title` captured from a `session.info` payload
   * (client-side capture: feeds session.create's title and tracing; the
   * gateway's dedicated `session.title` events mirror through the agent).
   */
  get title(): string {
    return this.#title;
  }

  /** The first terminal failure stamped on this client (child exit/error,
   *  ready timeout, close), or null while the client is still usable. */
  get failure(): Error | null {
    return this.#failure;
  }

  /** True once close() has run. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Whether the client can still serve RPCs: no terminal failure, not closed.
   *  Every request path refuses a client this getter reports as false — the
   *  agent's failure path uses it to distinguish client-terminal failures
   *  (self-heal: full dispose so the host re-resumes fresh) from ordinary
   *  per-turn errors. */
  get usable(): boolean {
    return this.#failure === null && !this.#closed;
  }

  // -- lifecycle --------------------------------------------------------------

  /** Resolve once gateway.ready arrived (15s timeout → reject + onFailure).
   *  A lazy client materializes its python child HERE (full-lazy ruling:
   *  view-time resume spawns nothing). */
  ensureStarted(): Promise<void> {
    const hub = this.#spawnOpts.hub;
    if (hub !== undefined) {
      if (this.#hubPreparation === undefined) {
        this.#hubPreparation = (async () => {
          if (this.#closed) throw new Error('hermes gateway client closed');
          const prepare = this.#spawnOpts.prepareHub ?? prepareHermesHub;
          this.#hubSession = await prepare(hub);
          if (this.#closed) throw new Error('hermes gateway client closed');
        })().catch(error => { this.#fail(error instanceof Error ? error : new Error(String(error))); throw error; });
      }
      return this.#hubPreparation.then(() => this.#startPrepared());
    }
    return this.#startPrepared();
  }

  #startPrepared(): Promise<void> {
    if (this.#readyPromise === null) {
      if (this.#closed || this.#failure !== null) {
        return Promise.reject(this.#failure ?? new Error("hermes gateway client closed"));
      }
      this.#materializeChild();
    }
    return this.#readyPromise as Promise<void>;
  }

  /** Create the bound session (single-session client — one create OR one resume). */
  async createSession(opts: { cwd: string; title?: string; model?: string; provider?: string }): Promise<GatewaySessionInfo> {
    this.#ensureUsable();
    if (this.#sessionId !== null) throw new Error("single-session client: a session is already bound");
    const params: Record<string, unknown> = { cwd: opts.cwd, cols: 120 };
    if (opts.title !== undefined) params.title = opts.title;
    if (opts.model !== undefined) params.model = opts.model;
    if (opts.provider !== undefined) params.provider = opts.provider;
    const info = this.#adoptSession(await this.#request("session.create", params));
    return info;
  }

  /** Resume a stored session. Events for our session arriving BEFORE the
   *  response are dropped (replay suppression — no defer_history passed).
   *  4001/4006 RPC errors reject (fail closed — the session is gone). */
  async resumeSession(sessionId: string): Promise<GatewaySessionInfo> {
    this.#ensureUsable();
    if (this.#sessionId !== null) throw new Error("single-session client: a session is already bound");
    if (typeof sessionId !== "string" || sessionId.trim() === "") throw new Error("session id is required to resume");
    this.#replayDrop = true;
    try {
      const info = this.#adoptSession(await this.#request("session.resume", { session_id: sessionId, cols: 120 }));
      return info;
    } finally {
      this.#replayDrop = false;
    }
  }

  /** Submit a prompt turn. Resolves on the settled pair (message.complete →
   *  session.info running=false); rejects on gateway error event, child
   *  exit/failure, submit RPC error (pre-turn), non-streaming ack, or close.
   *  REJECTS while a turn is in flight (busy guard — REJECT policy, the agent
   *  layer owns queueing; the gateway default busy policy is interrupt). */
  async prompt(text: string): Promise<void> {
    this.#ensureUsable();
    this.#ensureSession();
    if (this.#turnInFlight || this.#ctx.turnOpen) {
      throw new Error("hermes gateway busy: a turn is already in flight (prompt rejected — the agent layer owns queueing)");
    }
    this.#turnInFlight = true;
    this.#turnCompleteSeen = false;
    this.#turnSettledInfoSeen = false;
    const turn = new Promise<void>((resolvePromise, rejectPromise) => {
      this.#turnWaiter = { resolve: resolvePromise, reject: rejectPromise };
    });
    try {
      const ack = asRecord(await this.#request("prompt.submit", { session_id: this.#sessionId, text }));
      if (ack === null || ack.status !== "streaming") {
        throw new Error(`unexpected prompt.submit ack: ${JSON.stringify(ack)}`);
      }
    } catch (error) {
      // Turn never started — release the guard and surface the submit failure.
      // #fail (child exit/error, close mid-submit) may ALREADY have rejected
      // this local `turn` via the waiter while the ACK was pending; this path
      // throws instead of returning it, so mark that rejection handled — an
      // orphaned rejected promise would otherwise surface as a process-level
      // unhandledRejection (review fix r1; regression-tested).
      turn.catch(() => { });
      this.#turnWaiter = null;
      this.#turnInFlight = false;
      this.#turnCompleteSeen = false;
      this.#turnSettledInfoSeen = false;
      throw error instanceof Error ? error : new Error(String(error));
    }
    // A gateway `error` event may already have settled the waiter mid-ACK —
    // returning the turn promise propagates either outcome.
    return turn;
  }

  /** Steer the in-flight turn (session.steer). A "rejected" ack throws. */
  async steer(text: string): Promise<void> {
    const result = asRecord(await this.#sessionRpc("session.steer", { text }));
    if (result?.status === "rejected") throw new Error(`steer rejected by gateway: ${JSON.stringify(result)}`);
  }

  /** Interrupt the current turn (session.interrupt). */
  interrupt(): Promise<void> {
    return this.#sessionRpcVoid("session.interrupt");
  }

  /** Compress the session context (session.compress). */
  compress(): Promise<void> {
    return this.#sessionRpcVoid("session.compress");
  }

  /** session.history — resume seed / durable transcript rows. */
  history(): Promise<unknown> {
    return this.#sessionRpc("session.history");
  }

  /** session.usage — superset of {calls,input,output,total}. */
  usage(): Promise<unknown> {
    return this.#sessionRpc("session.usage");
  }

  /** session.status — rendered text blob, display-only (Task 1 bonus fact). */
  status(): Promise<unknown> {
    return this.#sessionRpc("session.status");
  }

  /** model.options — the Task 5 catalog source. */
  modelOptions(): Promise<unknown> {
    this.#ensureUsable();
    return this.#request("model.options", {});
  }

  /** Direct approval answer (agent-layer escape hatch alongside the listener bridge). */
  async respondApproval(requestId: string, choice: GatewayApprovalChoice): Promise<void> {
    if (choice !== "once" && choice !== "always" && choice !== "deny") {
      throw new Error(`invalid approval choice: ${String(choice)}`);
    }
    const params: Record<string, unknown> = { choice };
    if (requestId) params.request_id = requestId;
    await this.#sessionRpc("approval.respond", params);
  }

  /** Best-effort session.close write + kill the child (SIGTERM → 3s → SIGKILL).
   *  Rejects everything pending and fires onFailure (codex close parity). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#spawnOpts.hub?.dispose();
    this.#clearSpawnGrace();
    // Fire-and-forget best effort: write the request directly (the RPC path
    // would refuse under #closed and nothing will read the response anyway).
    if (this.#sessionId !== null && this.#failure === null) {
      this.#write({
        jsonrpc: "2.0",
        id: `r${++this.#reqSeq}`,
        method: "session.close",
        params: { session_id: this.#sessionId },
      });
    }
    this.#fail(new Error("hermes gateway client closed"));
    this.#killChild();
  }

  // -- internals: transport ---------------------------------------------------

  #write(frame: Record<string, unknown>): void {
    try {
      this.#child?.stdin?.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      this.#trace(`stdin write failed: ${String(error)}`);
    }
  }

  /** Queue behind gateway.ready (nothing is written before it), then one
   *  id-correlated request with the per-RPC timeout. */
  async #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted(); // queued pre-ready; rejects on failure
    this.#ensureUsable();
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const id = `r${++this.#reqSeq}`;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectPromise(new Error(`timeout: ${method}`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, method });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async #sessionRpc(method: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    this.#ensureUsable();
    this.#ensureSession();
    return this.#request(method, { session_id: this.#sessionId, ...extra });
  }

  async #sessionRpcVoid(method: string): Promise<void> {
    await this.#sessionRpc(method);
  }

  #onStdoutLine(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.#trace(`malformed stdout: ${raw.slice(0, 240)}`);
      return;
    }
    const record = asRecord(frame);
    if (record === null) {
      this.#trace(`non-record stdout frame: ${raw.slice(0, 240)}`);
      return;
    }
    const rawId = record.id;
    const id = typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : undefined;
    if (id !== undefined) {
      const pending = this.#pending.get(id);
      if (pending === undefined) {
        this.#trace(`response for unknown id ${id} ignored`);
        return;
      }
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (record.error !== undefined) {
        const err = asRecord(record.error);
        pending.reject(
          new GatewayRpcError(pending.method, asText(err?.message) || "gateway rpc error", typeof err?.code === "number" ? err.code : undefined),
        );
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (record.method === "event") {
      const params = asRecord(record.params);
      if (params === null) {
        this.#trace("event frame without params ignored");
        return;
      }
      this.#handleEvent(params);
      return;
    }
    this.#trace(`unroutable frame ignored: ${raw.slice(0, 240)}`);
  }

  // -- internals: event demux + projection ------------------------------------

  #handleEvent(params: Record<string, unknown>): void {
    const type = asText(params.type);
    if (type === "") {
      this.#trace("event frame without type ignored");
      return;
    }
    if (type === "gateway.ready") {
      if (!this.#readySettled) {
        this.#readySettled = true;
        if (this.#readyTimer !== null) clearTimeout(this.#readyTimer);
        this.#readyResolve();
      }
      return;
    }
    // Session demux: session-less frames (the ~60s sessions.changed poller
    // carries session_id:"") and foreign sessions are trace-dropped.
    const sid = asText(params.session_id);
    if (sid === "") {
      this.#trace(`session-less event ${type} dropped`);
      return;
    }
    if (this.#sessionId === null || sid !== this.#sessionId) {
      this.#trace(`event ${type} for foreign session ${sid} dropped`);
      return;
    }
    // Review Minor #2b: currently shadowed by the session-demux drop above
    // (resume only runs with no session bound → #sessionId === null), but kept
    // as the EXPLICIT replay-window contract guard should resume ever rebind.
    if (this.#replayDrop) {
      this.#trace(`event ${type} dropped inside resume replay window`);
      return;
    }

    const payload = params.payload;

    if (type === "approval.request") {
      void this.#bridgeApproval(payload);
      return;
    }
    if (type === "session.info") {
      // Half of the settled pair — the client's turn-boundary signal, never wire.
      const info = asRecord(payload);
      if (info !== null) {
        // Lazy system-prompt / title capture (Task 7 ruling 4): the gateway
        // attaches `system_prompt` (empty before the first turn) and `title` to
        // session.info. The agent stamps the prompt as `system/message` once
        // non-empty; the title feeds session.create + tracing (dedicated
        // `session.title` events mirror as `session/title` through the agent).
        const prompt = asText(info["system_prompt"]);
        if (prompt !== "") this.#systemPrompt = prompt;
        const title = asText(info["title"]);
        if (title !== "") this.#title = title;
      }
      if (info?.running === false) {
        this.#turnSettledInfoSeen = true;
        this.#maybeSettleTurn();
      }
      return;
    }
    if (type === "thinking.delta" || type === "reasoning.delta") {
      // Live display is this accumulation; the durable block rides
      // message.complete.reasoning (injected below when the gateway omits it).
      const text = asRecord(payload)?.text;
      if (typeof text === "string") this.#thinking += text;
      return;
    }

    if (type === "message.start") {
      // New turn bracket: reset the settle flags and the thinking buffer.
      this.#turnCompleteSeen = false;
      this.#turnSettledInfoSeen = false;
      this.#thinking = "";
    }
    if (type === "tool.start") {
      const p = asRecord(payload);
      const toolId = asText(p?.tool_id);
      if (toolId !== "") this.#seenToolIds.add(toolId);
    }
    if (type === "tool.complete") {
      // Orphan synthesis (Task 2 §5 seam): emission gates differ between
      // start/complete, so an end can arrive without its start — build the
      // missing tool_execution_start from the complete payload via the
      // projector (the seen-id state lives here, the projector stays pure).
      const p = asRecord(payload);
      const toolId = asText(p?.tool_id);
      if (toolId !== "" && !this.#seenToolIds.has(toolId)) {
        this.#seenToolIds.add(toolId);
        const syntheticStart = projectGatewayEvent("tool.start", p, this.#ctx);
        if (syntheticStart !== null) {
          for (const event of Array.isArray(syntheticStart) ? syntheticStart : [syntheticStart]) this.#emitWire(event);
        }
      }
    }

    const payloadForProjection = type === "message.complete" ? this.#injectThinking(payload) : payload;
    const out = projectGatewayEvent(type, payloadForProjection, this.#ctx);
    if (out !== null) {
      for (const event of Array.isArray(out) ? out : [out]) this.#emitWire(event);
    }

    // ctx transitions AFTER projecting (Task 2 contract).
    if (type === "message.start" && out !== null) {
      this.#ctx.turnOpen = true;
      this.#ctx.openAssistant = true;
    } else if (type === "message.delta" && out !== null) {
      this.#ctx.openAssistant = true; // covers the healed (window-closed) case
    } else if (type === "message.complete") {
      this.#turnCompleteSeen = true; // protocol fact, projection-independent
      this.#ctx.turnOpen = false;
      this.#ctx.openAssistant = false;
      this.#thinking = "";
      this.#maybeSettleTurn();
    } else if (type === "error") {
      this.#ctx.turnOpen = false;
      const message = asText(asRecord(payload)?.message);
      // Abnormal finish: settle any in-flight turn as a rejection — even when
      // the projector saw no open turn (e.g. "agent init failed" BEFORE
      // message.start: server.py:3624) the client knows its turn is in flight.
      this.#settleTurn(new Error(message !== "" ? message : "hermes gateway error event"));
    }
  }

  /** Clone the message.complete payload and inject the accumulated thinking
   *  when the gateway did not re-attach `reasoning` (live fixture fact);
   *  a gateway-provided non-empty reasoning always wins. */
  #injectThinking(payload: unknown): unknown {
    const p = asRecord(payload);
    if (p === null) return payload;
    const reasoning = asText(p.reasoning);
    if (reasoning !== "" || this.#thinking === "") return payload;
    return { ...p, reasoning: this.#thinking };
  }

  #maybeSettleTurn(): void {
    if (this.#turnCompleteSeen && this.#turnSettledInfoSeen) this.#settleTurn();
  }

  #settleTurn(error?: Error): void {
    this.#turnCompleteSeen = false;
    this.#turnSettledInfoSeen = false;
    if (!this.#turnInFlight) return;
    this.#turnInFlight = false;
    const waiter = this.#turnWaiter;
    this.#turnWaiter = null;
    if (waiter !== null) {
      if (error !== undefined) waiter.reject(error);
      else waiter.resolve();
    }
  }

  #emitWire(event: WireEvent): void {
    if (this.#closed) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.#trace(`listener error: ${String(error)}`);
      }
    }
  }

  // -- internals: approval bridge ----------------------------------------------

  async #bridgeApproval(payload: unknown): Promise<void> {
    const p = asRecord(payload) ?? {};
    const request: GatewayApprovalRequest = {
      requestId: asText(p.request_id),
      title: asText(p.description),
      ...(typeof p.command === "string" ? { command: p.command } : {}),
      raw: p,
    };
    const listener = [...this.#approvalListeners][0];
    let answer: unknown = null;
    if (listener !== undefined) {
      // Race the listener against the deadline — and CLEAR the timer when the
      // listener settles (a Promise.race loser keeps running; an armed 30s
      // ref'd timer would leak per approval and hold the host loop).
      answer = await new Promise<unknown>((resolvePromise) => {
        const timer = setTimeout(() => {
          this.#trace(`approval listener timed out after ${this.#approvalTimeoutMs}ms`);
          resolvePromise(null);
        }, this.#approvalTimeoutMs);
        void (async () => {
          try {
            resolvePromise(await listener(request));
          } catch (error) {
            this.#trace(`approval listener threw: ${String(error)}`);
            resolvePromise(null);
          } finally {
            clearTimeout(timer);
          }
        })();
      });
    }
    // Fail closed: missing listener / throw / void / invalid / timeout → deny.
    const choice: GatewayApprovalChoice =
      answer === "once" || answer === "always" || answer === "deny" ? answer : "deny";
    const params: Record<string, unknown> = { session_id: this.#sessionId, choice };
    if (request.requestId !== "") params.request_id = request.requestId;
    try {
      await this.#request("approval.respond", params);
    } catch (error) {
      this.#trace(`approval.respond failed (deny already applied): ${String(error)}`);
    }
  }

  // -- internals: session + failure --------------------------------------------

  #adoptSession(result: unknown): GatewaySessionInfo {
    this.#clearSpawnGrace();
    const info = asRecord(result);
    if (info === null) {
      throw new Error(`session response missing session_id: ${JSON.stringify(result)}`);
    }
    const liveId = asText(info.session_id);
    const storedId = asText(info.stored_session_id);
    if (liveId === "" && storedId === "") {
      throw new Error(`session response missing session_id: ${JSON.stringify(result)}`);
    }
    // Events are demultiplexed on the LIVE runtime id (resume remints a NEW
    // ephemeral id). Defensive: when the live id is absent, fall back to the
    // durable stored key so the session filter still follows.
    this.#sessionId = liveId !== "" ? liveId : storedId;
    this.#storedSessionId = storedId !== "" ? storedId : null;
    // Adoption is the materialization moment: tell the provider so its
    // identity map can follow a reminted stored_session_id (drift upsert).
    for (const listener of [...this.#adoptedListeners]) {
      try {
        listener(info as GatewaySessionInfo);
      } catch (error) {
        this.#trace(`adopted listener threw: ${String(error)}`);
      }
    }
    return info as GatewaySessionInfo;
  }

  /** Clear the idle-probe reaper (session materialized, or the client closed). */
  #clearSpawnGrace(): void {
    if (this.#spawnGraceTimer !== null) {
      clearTimeout(this.#spawnGraceTimer);
      this.#spawnGraceTimer = null;
    }
  }

  #ensureSession(): void {
    if (this.#sessionId === null) {
      throw new Error("no session bound — call createSession/resumeSession first");
    }
  }

  #ensureUsable(): void {
    if (this.#failure !== null) throw this.#failure;
    if (this.#closed) throw new Error("hermes gateway client is closed");
  }

  /**
   * Failure BEFORE gateway.ready (spawn/ready phase): retry with a fresh
   * python child — bounded at HERMES_SPAWN_ATTEMPTS — WITHOUT stamping the
   * terminal failure or firing onFailure (the caller's `ensureStarted()`
   * promise stays pending across retries; the client object never changes, so
   * every holder's closures stay valid). After ready (or out of attempts)
   * this is the legacy terminal `#fail`.
   */
  #preReadyFailure(error: Error): void {
    if (this.#readySettled || this.#closed || this.#failure !== null) {
      this.#fail(error);
      return;
    }
    if (this.#spawnAttempts < HERMES_SPAWN_ATTEMPTS) {
      this.#trace(`pre-ready failure on spawn attempt ${this.#spawnAttempts}/${HERMES_SPAWN_ATTEMPTS} — respawning: ${error.message.slice(0, 200)}`);
      this.#discardChildQuietly();
      this.#materializeChild();
      return;
    }
    this.#fail(error);
  }

  /** Tear down the current child without any terminal bookkeeping (pre-ready
   *  retry path: timers cleared, child killed best-effort, no #fail, no
   *  onFailure, ready promise stays pending). */
  #discardChildQuietly(): void {
    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
    if (this.#killTimer !== null) {
      clearTimeout(this.#killTimer);
      this.#killTimer = null;
    }
    const child = this.#child;
    this.#child = null;
    if (child === null || child.exitCode !== null || child.killed) return;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  #fail(error: Error): void {
    if (this.#failure !== null) return; // first failure wins; onFailure fires once
    this.#failure = error;
    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
    if (!this.#readySettled && this.#readyPromise !== null) {
      this.#readySettled = true;
      this.#readyReject(error);
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#settleTurn(error);
    for (const listener of [...this.#failureListeners]) {
      try {
        listener(error);
      } catch (listenerError) {
        this.#trace(`failure listener threw: ${String(listenerError)}`);
      }
    }
    // A failed client must not leave the child running (ready-timeout path);
    // killChild is guarded against the already-exited exit path.
    this.#killChild();
  }

  #killChild(): void {
    if (this.#child === null) return;
    if (this.#child.exitCode !== null || this.#child.killed) return;
    // Arm the SIGKILL fallback BEFORE kill(): a synchronous 'exit' (fake
    // child, or an already-dying real one) clears the timer via the exit
    // handler — arming after would leak a 3s timer past the exit.
    this.#killTimer = setTimeout(() => {
      this.#killTimer = null;
      if (this.#child === null || this.#child.exitCode !== null) return;
      try {
        this.#child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
    try {
      this.#child.kill("SIGTERM");
    } catch (error) {
      this.#trace(`SIGTERM failed: ${String(error)}`);
    }
  }

  #pushStderr(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    this.#stderrLines.push(trimmed.length > 4096 ? `${trimmed.slice(0, 4096)}… [truncated]` : trimmed);
    if (this.#stderrLines.length > STDERR_RING) this.#stderrLines.shift();
    this.#trace(`stderr: ${trimmed.slice(0, 240)}`);
  }

  #stderrTail(): string {
    return this.#stderrLines.slice(-20).join("\n");
  }

  #trace(line: string): void {
    if (process.env.SUPERD_HERMES_TRACE === "1") {
      process.stderr.write(`[hermes-client] ${line}\n`);
    }
  }
}

async function prepareHermesHub(binding: ForeignHubBinding): Promise<string | undefined> {
  const root = resolveHermesRoot();
  const python = resolveHermesPython(root);
  return prepareHermesNativePlugin(binding, join(homedir(), '.hermes'), async key => {
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: root };
    delete env.HERMES_HOME;
    await promisify(execFile)(python, ['-m', 'hermes_cli.main', 'plugins', 'enable', key], { cwd: root, env, timeout: 30_000 });
  });
}
