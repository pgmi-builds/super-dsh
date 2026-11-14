/**
 * agent-claude provider — Claude Code provider plugin for DeepSeek Harness
 * (Super D, standalone SDK line).
 *
 * Replaces the built-in agent loop with an `AgentFactory` that drives one
 * `ClaudeSdkClient` (a per-session Claude Agent SDK bridge) and bridges the
 * projected wire stream into the Dash Agent/Session contracts. Mirrors
 * `@deepseek-ai/dsh-agent-loop`'s creation transaction (prepare → owned
 * storage handle → setup → publish) so the session + agent publish as one
 * ordered lifecycle AND the DSH session log is written through the upstream
 * `sessionPersistence` service — list/read/replay/workspace grouping are then
 * ordinary DSH services over that log.
 *
 * Session identity (route A, "mapping only"): the Claude session id is derived
 * deterministically from the DSH id's UUID tail (`claudeSessionIdFromDsh`), so
 * the id itself survives restarts with no map. The effective Claude permission
 * mode cannot round-trip through the event log (extra tiers are skipped by
 * `presetFromEvents`), so it is persisted at the world DSH-home root alongside
 * the `claudeSessionId` (`<worldHome>/dsh-sessions.json`, see session-map.ts)
 * and re-applied on resume via `client.setPermissionMode(mode)`.
 */
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from "@deepseek-ai/dsh-agent";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import {
  SessionLogOffset,
  SessionPreparation,
  interruptedTurnClosers,
  type Session,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import type { SessionHandle, SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { ClaudeSdkClient, probeClaudeModels } from "./claude-client.js";
// Type-only: pulls the `ctx.sessionProjections` Context augmentation into this unit.
import type { } from "@deepseek-ai/dsh-session-projection";
import { ClaudeAgent, type ClaudeAgentRuntimeInfo } from "./agent.js";
import { ClaudeLlmAdapter, CLAUDE_PROVIDER_ID, routeIds } from "./adapter.js";
import { resolveClaudeHome } from "./claude-home.js";
import { bindForeignHub } from "../../superd-hub/dist/foreign-hub.js";
import { resetProjectionState } from "./claude-events.js";
import { claudeSessionIdFromDsh } from "./session-id.js";
import {
  claudePermissionMode,
  defaultPermissionPreset,
  modeChangePatch,
  presetFromEvents,
  type ClaudePermissionMode,
} from "./permission.js";
import { sessionRecord, upsertSession } from "./session-map.js";
import type { CanUseTool, ClaudeClientFactory } from "./claude-client.js";
import {
  makeCanUseTool,
  answerAskUserQuestion,
  askPlanReview,
  type ApprovalLike,
  type UserQuestionsLike,
  type PermissionDecision,
} from "./interaction.js";
import { modelEntryFromSdk, readModelCatalog, setModelCatalog, CLAUDE_DEFAULT_MODEL } from "./models.js";
import { registerClaudePreset } from "./agent-preset-claude.js";
import { claudeLaunchFor, type ClaudeLaunchSpec } from "./claude-launch.js";
import { routeSeed } from "./claude-route.js";
import { endpointKey, readProviderStore, type ClaudeProviderEntry, type ClaudeProviderStore } from "./claude-providers.js";
import { ClaudeProvidersGateway, syncFromNative } from "./claude-provider-gateway.js";
import { readNativeModel, readNativeProviders } from "./claude-native-config.js";
import { resolveClaudeBinary } from "./sdk-runtime.js";

const CLAUDE_MODES: readonly string[] = ["default", "acceptEdits", "bypassPermissions", "plan", "auto", "dontAsk"];

/** Narrow an untrusted value to a persisted Claude permission mode. */
function isClaudeMode(raw: unknown): raw is ClaudePermissionMode {
  return typeof raw === "string" && CLAUDE_MODES.includes(raw);
}

/** Realpath of a recorded cwd, accepted only when it names an existing directory. */
function validatedCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  try {
    const canonical = realpathSync(cwd);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/** Diagnostic trace (CLAUDE_TRACE=1 on the dsh process enables stderr tracing). */
const trace = (...parts: unknown[]): void => {
  if (process.env.CLAUDE_TRACE === "1") process.stderr.write(`[claude-provider ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

/**
 * How often the canonical store is reconciled with the user's `settings.json`
 * env (2026-10-04 user ruling: startup + every ten minutes). The file is the
 * user's own and edited with their own tools, so the sync is a poll rather
 * than an event subscription — ten minutes is the granularity the ruling
 * asked for.
 */
const SYNC_INTERVAL_MS = 600_000;

/**
 * Resume identity guard (exported for unit testing): fail closed when no Claude
 * session is recorded for the DSH session id. Route B (a mapping file) is V1+
 * work, so a missing/empty id is a genuine unknown, never a silent new session.
 */
export function resumeGuard(record: { dshSessionId: string; claudeSessionId: string | null | undefined }): void {
  if (typeof record.claudeSessionId !== "string" || record.claudeSessionId === "") {
    throw new Error(`cannot resume session "${record.dshSessionId}": no Claude session is recorded for this Dash session id`);
  }
}

/**
 * The host-side `canUseTool` dispatcher the provider injects into the SDK
 * options. Claude Code routes every human permission decision through exactly
 * three channels — the `AskUserQuestion` tool, `ExitPlanMode` (plan review),
 * and every other tool's permission gate — and this dispatcher fans each onto
 * the DSH native seams. A missing seam fails CLOSED (deny), never silently
 * lets the CLI decide. Approvals are wrapped in the agent's `runApproval` so
 * the idle-TTL gate protects a session waiting on a human.
 */
export function makeClaudeCanUseTool(deps: {
  approval: ApprovalLike | undefined;
  questions: UserQuestionsLike | undefined;
  getAgent: () => ClaudeAgent | undefined;
}): CanUseTool {
  return async (toolName, input, options) => {
    const agent = deps.getAgent();
    const approval = deps.approval;
    const questions = deps.questions;
    const run = <T>(task: () => Promise<T>): Promise<T> => (agent === undefined ? task() : agent.runApproval(task));
    const deny = (message: string): PermissionDecision => ({ behavior: "deny", message });
    if (toolName === "AskUserQuestion") {
      if (questions === undefined) return deny("Claude Code AskUserQuestion denied (no user-questions seam)");
      return run(() => answerAskUserQuestion({ questions, agent }, input, options.signal));
    }
    if (toolName === "ExitPlanMode") {
      if (questions === undefined) return deny("Claude Code ExitPlanMode denied (no user-questions seam)");
      const plan = input !== null && typeof input === "object"
        ? (input as { plan?: unknown }).plan
        : undefined;
      if (typeof plan !== "string" || plan.trim() === "") {
        // Fail CLOSED on malformed input: dereferencing a null plan here used
        // to reject, which the SDK reads as a denial but reports as noise.
        return deny("Claude Code ExitPlanMode denied (malformed input: no plan)");
      }
      const approved = await run(async () => askPlanReview({ questions, agent }, plan, options.signal));
      return approved ? { behavior: "allow" } : deny("Claude Code ExitPlanMode denied (plan not approved)");
    }
    if (approval === undefined) return deny("Claude Code tool call denied (no approval seam)");
    return run(() => makeCanUseTool({ approval, agent })(toolName, input, {
      toolUseID: options.toolUseID,
      signal: options.signal,
      ...(options.decisionReason === undefined ? {} : { decisionReason: options.decisionReason }),
    }));
  };
}


/** An owned write handle plus the count of events already stored through it. */
interface StoredSession {
  readonly handle: SessionHandle;
  storedCount: number;
}

export class ClaudeProvider extends Service implements AgentFactory {
  static inject: string[] = ["agents", "sessions", "llm", "agentDefaultModel", "settings"];

  /** Plain holder — prevents Cordis re-tracing the factory's ctx through a caller shadow. */
  private readonly runtime: { ctx: Context };
  /** The world's DSH home — from the world's own `dshHomePath`, never ambient env inside plugins. Anchors adapter-owned DSH state (the session map) only; the Claude app home is the CLI's native `~/.claude` (2026-09-17 ruling). */
  private readonly home: string;
  /** Echo/staleness guard for the app-wide default-model push. */
  private defaultModelKey = "";
  /** Epoch ms of the last reconcile with the user's `settings.json` env. */
  private syncedAt: number | undefined;
  /** The live `ctx.llm` registration for the claude routes, when one exists.
   *  Its `replace()` is how the route SET follows the store (codex twin). */
  private routes: { replace(providers: string[]): void } | undefined;
  constructor(ctx: Context) {
    super(ctx, "claudeProvider");
    this.runtime = { ctx };
    this.home = this.#resolveHome();
    // Native-home ruling (2026-09-17): no CLAUDE_CONFIG_DIR injection — the CLI
    // keeps its native home; this.home only anchors the DSH-side session map.
    trace(`home: worldHome=${this.home} claudeHome=${resolveClaudeHome()}`);
    ctx.effect(() => ctx.agents.setFactory(this), "claudeProvider.setFactory()");
    this.#registerModelCatalog();
    // The store is canonical and the native settings.json env is a source
    // (2026-10-04). Reconcile once at startup, then keep reconciling on a
    // timer; the sync is idempotent and write-only-when-moved, so a world
    // with no providers configured pays nothing but a no-op read.
    this.syncNow();
    const timer = setInterval(() => this.syncNow(), SYNC_INTERVAL_MS);
    timer.unref?.();
    // Fiber-scoped cleanup (super-dsh/AGENTS unload contract): the timer must
    // never outlive this row — HMR row unload disposes the fiber, which runs
    // this effect's disposer.
    ctx.effect(() => () => clearInterval(timer), "claudeProvider.syncTimer()");
    // The roster must be visible to the API gateway's root-level remote
    // enumeration; nesting it under a child fiber via ctx.plugin hides its
    // @Remote routes from the gateway and every agentPresets/* call 404s (the
    // omp/pi registration lesson). Register it on this plugin's own
    // (top-level) fiber instead — next to setFactory, never under ctx.plugin.
    // 0.1.7: roster/selection/document RPC + the `agentPreset` session
    // projection all live in the host AgentPresetRegistry (mounted by the
    // dsh-web-app bundle's `agent-preset-registry` row; the adapter patch
    // pins its `default` to the Claude preset). The adapter only registers
    // its one fixed preset into the registry.
    registerClaudePreset(ctx);
    this.#registerDefaultModel();
    this.#probeBootModels();
    // The Hub settings panel's data plane (2026-10-04 multi-provider ruling):
    // an adapter-owned Typert Remote (`claudeProviders/get|save|remove`) on
    // this world's context. The hub's carrier forwards `envelope.method`
    // verbatim, so the panel reaches it through the existing
    // `/hub/api?agent=claude` family — no new hub route, and no provider
    // knowledge leaks out of the adapter (dev-rules §12). Cordis keeps the
    // instance alive as this context's `claudeProviders` service. There is no
    // `select`: which provider a session runs on is DSH's per-session
    // `model/selection`.
    //
    // `resolveClaudeHome` is passed as a THUNK on purpose (the codex twin's
    // rule): the native home is re-resolved per call, so a test's
    // `CLAUDE_CONFIG_DIR` and an operator's override are both honored.
    //
    // A panel save/remove re-points the route SET (one route per provider, plus
    // the fixed `claude` route) through routes.replace — the codex twin's
    // mechanism, wired exactly.
    new ClaudeProvidersGateway(ctx, this.home, () => resolveClaudeHome(), () => this.refreshRoutes());
  }

  /**
   * Reconcile the canonical provider store with the user's `settings.json`
   * env (2026-10-04 user ruling) and stamp the last-reconcile epoch.
   *
   * Called once at startup and every {@link SYNC_INTERVAL_MS}. Mirrors the
   * codex twin's semantics exactly — idempotent, silent, and
   * write-only-when-moved (claude-providers.ts guarantees the store rewrite
   * happens only when something actually changed) — minus codex's
   * `#applyRoutes` step: claude serves every provider under the ONE fixed
   * `claude` route registered at boot, so there is no route set to re-point.
   * Never throws: a provider list is not worth a boot.
   */
  syncNow(): void {
    try {
      const { store, added, updated } = syncFromNative(this.home, resolveClaudeHome());
      trace(`provider sync: added=${added.join(",") || "none"} updated=${updated.join(",") || "none"}`);
      if (added.length > 0 || updated.length > 0) {
        this.runtime.ctx.logger.info(`claude-provider: settings.json sync — added ${added.join(", ") || "none"}, refreshed ${updated.join(", ") || "none"}`);
      }
      this.syncedAt = Date.now();
      this.#applyRoutes(store);
    } catch (error) {
      this.runtime.ctx.logger.warn(`claude-provider: provider sync failed: ${String(error)}`);
    }
  }

  /**
   * RC-3 boot model probe: ONE ephemeral SDK query asks the CLI's
   * `supportedModels()` right after the adapter registration, and the answer
   * OVERWRITES the sonnet-only boot catalog (setModelCatalog semantics).
   * Fire-and-forget: a slow/failing probe never delays boot and never
   * touches the boot catalog — `sonnet` (a real CLI alias) stays the
   * probe-failure fallback, and a live session re-observes anyway.
   */
  #probeBootModels(): void {
    void probeClaudeModels({ worldHome: this.home })
      .then((models) => {
        const entries = models.flatMap((model) => modelEntryFromSdk(model));
        if (entries.length === 0) {
          trace("boot model probe: the CLI reported no models — boot catalog (sonnet) kept");
          return;
        }
        setModelCatalog(entries, CLAUDE_DEFAULT_MODEL);
        this.runtime.ctx.logger.info(`claude-provider: boot model probe ← ${entries.length} CLI model(s), default ${CLAUDE_DEFAULT_MODEL}`);
      })
      .catch((error) => {
        trace(`boot model probe failed (${String(error)}) — boot catalog (sonnet) kept`);
      });
  }

  /** The world's DSH home: boot-provided dshHomePath first, env last. */
  #resolveHome(): string {
    const fromBoot = this.runtime.ctx.get("dshHomePath");
    if (typeof fromBoot === "string" && fromBoot !== "") return fromBoot;
    if (typeof fromBoot === "function") {
      const resolved = (fromBoot as () => string)();
      if (typeof resolved === "string" && resolved !== "") return resolved;
    }
    return process.env.DSH_HOME ?? join(process.cwd(), ".tests", "superd");
  }

  /**
   * The write path is mandatory (2026-09-16): this factory owns the DSH
   * session log through the upstream persistence service — a session created
   * or resumed without a backend would persist nothing.
   */
  private requirePersistence(op: "create" | "resume"): SessionPersistence {
    const persistence = this.runtime.ctx.get("sessionPersistence") as SessionPersistence | undefined;
    if (persistence === undefined) {
      throw new Error(`cannot ${op} a Claude session: session persistence is not configured`);
    }
    return persistence;
  }

  private async createStoredSession(
    persistence: SessionPersistence,
    session: Session,
    signal?: AbortSignal,
  ): Promise<StoredSession> {
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...(signal === undefined ? {} : { signal }),
    });
    return { handle, storedCount: 0 };
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.sessionId;
    const meta = options.meta ?? {};
    const cwd = meta.cwd;

    // Fork is rejected in V1 (the SDK has `forkSession`, but it is not wired).
    if (meta.parentSession !== undefined) {
      throw new Error(`cannot fork session "${meta.parentSession}": fork is not wired in V1`);
    }

    // Route A: derive the Claude session id before anything is spawned.
    const claudeSessionId = claudeSessionIdFromDsh(String(id));
    if (claudeSessionId === undefined) {
      trace(`create ${id}: DSH id carries no UUID and no mapping exists — route B is not wired in V1`);
      throw new Error(`cannot create session "${id}": the Dash session id carries no UUID and route B is not wired in V1`);
    }

    const persistence = this.requirePersistence("create");

    // Single-source permission resolution: one preset → one Claude mode, which
    // is persisted in the session record AND handed to the agent (so the
    // `permission/preset` stamp and the `setPermissionMode` call never diverge).
    const preset = defaultPermissionPreset(loopCtx);
    const claudeMode = claudePermissionMode(preset);
    const spawnCwd = validatedCwd(cwd) ?? process.cwd();
    trace(`create id=${id} claudeSessionId=${claudeSessionId} preset=${preset ?? "none"} claudeMode=${claudeMode} spawnCwd=${spawnCwd}`);

    // Lazy, zero-IO client construction (the CLI spawns on the first prompt).
    // The host-side permission gate is injected now, closing over the injected
    // approval/questions seams plus a lazy agent holder (set in setupAndPublish).
    const agentRef: { current: ClaudeAgent | undefined } = { current: undefined };
    const canUseTool = makeClaudeCanUseTool({
      approval: loopCtx.get("approval") as ApprovalLike | undefined,
      questions: loopCtx.get("userQuestions") as UserQuestionsLike | undefined,
      getAgent: () => agentRef.current,
    });
    // One factory per session: the shared wiring (canUseTool, worldHome, cwd,
    // permission posture) plus per-instance overrides. The agent swaps the whole
    // client through it when a provider move needs a different child.
    const clientFactory: ClaudeClientFactory = (overrides = {}) => new ClaudeSdkClient({
      cwd: spawnCwd,
      worldHome: this.home,
      canUseTool,
      hub: bindForeignHub("claude", String(id), this.home, () => agentRef.current as never),
      allowDangerouslySkipPermissions: claudeMode === "bypassPermissions",
      ...overrides,
    });
    const client = clientFactory({ claudeSessionId });
    const preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(meta === undefined ? {} : { meta }),
      ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
    }));

    let stored: StoredSession | undefined;
    let handedOff = false;
    try {
      stored = await this.createStoredSession(persistence, preparation.session, options.signal);
      // Identity + permission record BEFORE publication: resume resolves it.
      upsertSession(this.home, String(id), {
        claudeSessionId,
        claudeMode,
        cwd: spawnCwd,
        createdAt: Date.now(),
        preset: preset ?? null,
      });
      handedOff = true;
      return await setupAndPublish(
        loopCtx,
        ownerCtx,
        id,
        this.sessionAgentOptions(options.agentOptions),
        options.setup,
        preparation.session,
        client,
        "startup",
        { enterSession: true, preparation },
        stored,
        {
          preset,
          claudeMode,
          onModeChange: (mode) => {
            // Upsert {claudeMode, preset} TOGETHER (RC-5): a skeleton mode
            // names its preset via the inverse table; an extra tier
            // (plan/auto/dontAsk) leaves the recorded preset alone.
            upsertSession(this.home, String(id), modeChangePatch(mode));
            trace(`persisted claudeMode ${mode} for ${id}`);
          },
          onNotResumable: () => {
            // 2026-09-18 ruling: a conversation-not-found failure is terminal
            // for the pairing — mark the record dead; later resumes fail fast.
            upsertSession(this.home, String(id), { resumable: false });
            trace(`marked ${id} not resumable (conversation never materialized)`);
          },
          launchFor: (providerId, model) => this.agentLaunchFor(providerId, model),
          contextWindowFor: (providerId, model) => this.agentContextWindowFor(providerId, model),
        },
        agentRef,
        clientFactory,
      );
    } catch (error) {
      trace(`create ${id} THREW: ${String(error)}`);
      client.close();
      if (!handedOff) await stored?.handle.close().catch(() => { });
      throw error;
    } finally {
      if (!handedOff) preparation[Symbol.dispose]();
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.resumeSessionId;

    // Identity (2026-09-16 "mapping only"): the DSH session id resolves
    // through the adapter-owned record. A missing record (or a missing/empty
    // Claude session id) is a genuine unknown: fail closed with the DSH id.
    const record = sessionRecord(this.home, String(id));
    trace(`resume id=${id} record=${record === undefined ? "MISSING" : record.claudeSessionId}`);
    resumeGuard({ dshSessionId: String(id), claudeSessionId: record === undefined ? undefined : record.claudeSessionId });
    if (record === undefined) {
      // Unreachable (resumeGuard threw above) — narrows `record` for TS.
      throw new Error(`cannot resume session "${id}": no Claude session is recorded for this Dash session id`);
    }
    if (record.resumable === false) {
      // 2026-09-18 ruling: the CLI never materialized a conversation under the
      // derived id (e.g. the first turn failed). The session is dead — fail
      // fast with the stable code; never resurrect, never re-wrap content.
      const error = new Error(
        `cannot resume session "${id}": its Claude conversation never materialized (the first exchange failed before the CLI persisted one) — start a new session`,
      ) as Error & { code?: string };
      error.code = "CONVERSATION_NOT_FOUND";
      throw error;
    }
    const claudeSessionId = record.claudeSessionId as string;

    // Spawn cwd comes from the recorded pairing — re-realpath and re-verify so
    // a moved/removed directory cannot aim a resume outside a live path.
    const spawnCwd = validatedCwd(record.cwd);
    if (spawnCwd === undefined) {
      throw new Error(`cannot resume session "${id}": its recorded working directory no longer exists`);
    }

    const persistence = this.requirePersistence("resume");

    // Permission re-mount (RC-5): the LOG FOLD is the preset authority —
    // resolved from the cold events once they are read below. The map's
    // `claudeMode` remains ONLY the mode cache for `setPermissionMode` (extra
    // tiers cannot round-trip through the log); a missing/unknown cache falls
    // back to the default preset's mode until the fold is read — traced,
    // never silent.
    let claudeMode: ClaudePermissionMode;
    if (isClaudeMode(record.claudeMode)) {
      claudeMode = record.claudeMode;
    } else {
      claudeMode = claudePermissionMode(defaultPermissionPreset(loopCtx));
      trace(`resume ${id}: no usable claudeMode recorded (${String(record.claudeMode)}) — falling back to ${claudeMode} until the log fold is read`);
    }
    trace(`resume id=${id} spawnCwd=${spawnCwd} claudeMode=${claudeMode} (preset resolved from the log fold below)`);

    // Re-attach to the Claude session by its id (lazy: the CLI resumes on the
    // first prompt). Re-apply the persisted permission mode up front (buffered
    // until the query exists), and re-inject the host-side permission gate.
    const agentRef: { current: ClaudeAgent | undefined } = { current: undefined };
    const canUseTool = makeClaudeCanUseTool({
      approval: loopCtx.get("approval") as ApprovalLike | undefined,
      questions: loopCtx.get("userQuestions") as UserQuestionsLike | undefined,
      getAgent: () => agentRef.current,
    });
    const clientFactory: ClaudeClientFactory = (overrides = {}) => new ClaudeSdkClient({
      cwd: spawnCwd,
      worldHome: this.home,
      canUseTool,
      hub: bindForeignHub("claude", String(id), this.home, () => agentRef.current as never),
      allowDangerouslySkipPermissions: claudeMode === "bypassPermissions",
      ...overrides,
    });
    const client = clientFactory({ resumeSessionId: claudeSessionId });
    void client.setPermissionMode(claudeMode).catch(() => { });

    let handle: SessionHandle | undefined;
    let stored: StoredSession | undefined;
    let preparation: SessionPreparation | undefined;
    let handedOff = false;
    try {
      // Taking write ownership FIRST excludes a concurrent resume of the same id.
      handle = await persistence.open(id, "write", options.signal === undefined ? {} : { signal: options.signal });
      const cold = await handle.read(0, undefined, options.signal === undefined ? {} : { signal: options.signal });
      const closers = interruptedTurnClosers(cold.events);
      if (closers.length > 0) await handle.append(closers);
      preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
        seed: [...cold.events, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: cold.eventState,
      }));
      stored = { handle, storedCount: cold.events.length + closers.length };
      trace(`resume id=${id} seeded ${cold.events.length} events (+${closers.length} closers)`);
      handle = undefined; // ownership passes to setupAndPublish
      handedOff = true;
      // RC-5: the log fold decides the preset at resume — the map's stale
      // `preset` must never overwrite a blank-window choice already folded
      // into the log. The mode cache stays authoritative for the wire unless
      // it was unusable, in which case the folded preset derives the mode and
      // it is re-applied now that the fold is read.
      const foldedPreset = presetFromEvents(cold.events) ?? defaultPermissionPreset(loopCtx);
      if (!isClaudeMode(record.claudeMode)) {
        claudeMode = claudePermissionMode(foldedPreset);
        void client.setPermissionMode(claudeMode).catch(() => { });
        trace(`resume ${id}: mode cache unusable — log fold preset=${foldedPreset ?? "none"} → claudeMode ${claudeMode} (re-applied)`);
      }
      trace(`resume id=${id} fold preset=${foldedPreset ?? "none"} claudeMode=${claudeMode}`);
      return await setupAndPublish(
        loopCtx,
        ownerCtx,
        id,
        this.sessionAgentOptions(options.agentOptions),
        options.setup,
        preparation.session,
        client,
        "resume",
        { enterSession: true, preparation },
        stored,
        {
          // RC-5: the log fold decides the preset at resume — the map's stale
          // `preset` must never overwrite a blank-window choice already folded
          // into the log. The mode cache stays authoritative for the wire
          // unless it was unusable, in which case the folded preset derives it.
          preset: foldedPreset,
          claudeMode,
          onModeChange: (mode) => {
            // Upsert {claudeMode, preset} TOGETHER (RC-5): a skeleton mode
            // names its preset via the inverse table; an extra tier
            // (plan/auto/dontAsk) leaves the recorded preset alone.
            upsertSession(this.home, String(id), modeChangePatch(mode));
            trace(`persisted claudeMode ${mode} for ${id}`);
          },
          onNotResumable: () => {
            // 2026-09-18 ruling: a conversation-not-found failure is terminal
            // for the pairing — mark the record dead; later resumes fail fast.
            upsertSession(this.home, String(id), { resumable: false });
            trace(`marked ${id} not resumable (conversation never materialized)`);
          },
          launchFor: (providerId, model) => this.agentLaunchFor(providerId, model),
          contextWindowFor: (providerId, model) => this.agentContextWindowFor(providerId, model),
        },
        agentRef,
        clientFactory,
      );
    } catch (error) {
      trace(`resume ${id} THREW: ${String(error)} | stack=${error instanceof Error ? error.stack?.slice(0, 400) : "n/a"}`);
      client.close();
      if (!handedOff) await handle?.close().catch(() => { });
      throw error;
    } finally {
      if (!handedOff) preparation?.[Symbol.dispose]();
    }
  }

  #registerModelCatalog(): void {
    this.#applyRoutes(readProviderStore(this.home));
  }

  /** Re-register the `ctx.llm` routes from the current store (panel mutation path). */
  refreshRoutes(): void {
    try {
      this.#applyRoutes(readProviderStore(this.home));
    } catch (error) {
      this.runtime.ctx.logger.warn(`claude-provider: route refresh failed: ${String(error)}`);
    }
  }

  /** Register or atomically re-point the claude routes at the given store
   *  (the fixed `claude` route + one route per provider with models). */
  #applyRoutes(store: ClaudeProviderStore): void {
    const llm = this.runtime.ctx.get("llm") as LlmRuntime | undefined;
    if (llm === undefined) return;
    const ids = routeIds(store);
    if (this.routes === undefined) {
      this.routes = llm.registerAdapter([...ids], new ClaudeLlmAdapter(this.home));
      trace(`routes registered: ${ids.join(", ")}`);
      return;
    }
    // `replace` validates the whole candidate set before swapping; a throw here
    // must not take the caller (a timer, or a panel save) down with it.
    this.routes.replace([...ids]);
    trace(`routes replaced: ${ids.join(", ") || "none"}`);
  }

  /**
   * The factory owns its sessions' route (user directive 2026-09-15): the
   * ambient `agentDefaultModel` selection is NOT authoritative here — a session
   * created by this factory starts from the reconciled pair below unless the
   * caller asked for a route this world serves (the native `claude` route or a
   * curated provider route).
   */
  private sessionAgentOptions(requested: AgentOptions | undefined): AgentOptions {
    // 1. A caller-requested route wins when it names a pair this world serves:
    //    the fixed native `claude` route (any raw id — launch native, inject
    //    nothing) or a curated provider route whose models include the id.
    const wanted = requested?.provider !== undefined && typeof requested.model === "string" && requested.model !== ""
      ? requested
      : undefined;
    const served = wanted !== undefined && (
      (wanted.provider as string) === CLAUDE_PROVIDER_ID
      || this.providerEntry(wanted.provider as string)?.models.some((model) => model.id === wanted.model) === true
    );
    if (wanted !== undefined && served) return { ...wanted, provider: wanted.provider, model: wanted.model };
    // 2. Native fold model (the user's own settings.json env).
    const nativeProvider = this.nativeProviderId();
    const nativeModel = readNativeModel(resolveClaudeHome());
    if (nativeProvider !== undefined && nativeModel !== undefined && nativeModel !== "") {
      return { ...(requested ?? {}), provider: nativeProvider, model: nativeModel };
    }
    // 3. First provider's first model.
    for (const entry of readProviderStore(this.home).providers) {
      const model = entry.models[0]?.id;
      if (model !== undefined) return { ...(requested ?? {}), provider: entry.id, model };
    }
    // 4. Legacy boot default (claude/sonnet → NATIVE_LAUNCH).
    return { ...(requested ?? {}), provider: CLAUDE_PROVIDER_ID, model: CLAUDE_DEFAULT_MODEL };
  }

  /** The store entry a provider id names, or `undefined`. */
  private providerEntry(providerId: string): ClaudeProviderEntry | undefined {
    return readProviderStore(this.home).providers.find((entry) => entry.id === providerId);
  }

  /** The provider id the user's own settings.json env folds to, or `undefined`. */
  private nativeProviderId(): string | undefined {
    const table = readNativeProviders(resolveClaudeHome())[0];
    if (table?.baseUrl === undefined) return undefined;
    const key = endpointKey(table.baseUrl);
    return readProviderStore(this.home).providers.find((entry) => endpointKey(entry.baseUrl) === key)?.id;
  }

  /** The launch that pins one provider for a freshly spawned client. */
  private agentLaunchFor(providerId: string, model: string): ClaudeLaunchSpec | undefined {
    const entry = this.providerEntry(providerId);
    if (entry === undefined) return undefined;
    return claudeLaunchFor({ provider: providerId, model }, entry, resolveClaudeBinary());
  }

  /** The provider's own context window for one of its models, when known. */
  private agentContextWindowFor(providerId: string, model: string): number | undefined {
    const entry = this.providerEntry(providerId);
    return entry?.models.find((candidate) => candidate.id === model)?.contextWindow;
  }

  /** The app-wide default selection (DSH-side `claude/<composite-or-boot>`). */
  private defaultModelSelection(): { provider: string; model: string } {
    const nativeProvider = this.nativeProviderId();
    const nativeModel = readNativeModel(resolveClaudeHome());
    if (nativeProvider !== undefined && nativeModel !== undefined && nativeModel !== "") {
      return { provider: nativeProvider, model: nativeModel };
    }
    for (const entry of readProviderStore(this.home).providers) {
      const model = entry.models[0]?.id;
      if (model !== undefined) return { provider: entry.id, model };
    }
    return { provider: CLAUDE_PROVIDER_ID, model: CLAUDE_DEFAULT_MODEL };
  }

  /**
   * App-wide default-model push (mirrors `agent-codex` `#registerDefaultModel`
   * faithfully): the harness owns the "default for new sessions" selection in
   * `agentDefaultModel` (mounted by dsh-base with a hard-coded
   * `deepseek-official/deepseek-flash`), and this bridge is the only thing that
   * feeds it a claude-routed default. Without the inject the context cannot
   * resolve the service at apply time and the push never fires. The write goes
   * through `settings.replace` AND `saveSelection` (the double path that avoids
   * the upstream silent no-op) with an echo-guarded `defaultModelKey`.
   */
  #registerDefaultModel(): void {
    this.runtime.ctx.inject(["agentDefaultModel", "settings"], (mCtx) => {
      const service = mCtx.get("agentDefaultModel") as
        | {
          currentSelection?: () => { provider: string; model: string };
          saveSelection?: (selection: { provider: string; model: string }) => Promise<unknown>;
        }
        | undefined;
      if (service === undefined) return;
      const target = this.defaultModelSelection();
      const targetKey = `${target.provider}/${target.model}`;
      const current = service.currentSelection?.();
      const currentKey = current === undefined ? undefined : `${current.provider}/${current.model}`;
      if (currentKey === targetKey || currentKey === this.defaultModelKey) return;
      trace(`default model: ${currentKey ?? "none"} → ${targetKey}`);
      const settings = mCtx.get("settings") as
        | { replace?: (namespace: string, value: unknown) => Promise<unknown> }
        | undefined;
      void Promise.resolve(settings?.replace?.("agent-default-model", target))
        .then(() => service.saveSelection?.(target))
        .then(() => {
          this.defaultModelKey = targetKey;
          this.runtime.ctx.logger.info(`claude-provider: default model ← claude catalog: ${targetKey}`);
        })
        .catch((error) => {
          this.runtime.ctx.logger.warn(`claude-provider: default model save failed: ${String(error)}`);
        });
    });
  }
}

/**
 * Durable flush of the session's pre-publication suffix. Constructor seed
 * markers and setup-window events never re-emit through `session/event`, so
 * publication must push them through the handle before live events start
 * routing into it.
 */
async function appendUnstoredSuffix(stored: StoredSession, session: Session): Promise<void> {
  const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount));
  if (suffix.length > 0) await stored.handle.append(suffix);
  stored.storedCount += suffix.length;
}

/**
 * Shared creation/resume transaction: build the agent over the prepared
 * session, run unpublished setup, flush the unstored suffix, and publish both
 * in order; the owned storage handle is drained (closed) on teardown. Kept as
 * a module-level function (not a private method) because Cordis exposes the
 * provider through a tracing proxy, which breaks hard-private receivers.
 */
async function setupAndPublish(
  loopCtx: Context,
  ownerCtx: Context,
  id: SessionId,
  agentOptions: AgentOptions,
  setup: AgentSetup | undefined,
  session: Session,
  client: ClaudeSdkClient,
  source: "startup" | "resume",
  opts: { enterSession: boolean; preparation?: SessionPreparation },
  stored: StoredSession,
  runtimeInfo: ClaudeAgentRuntimeInfo,
  agentRef: { current: ClaudeAgent | undefined },
  clientFactory: ClaudeClientFactory,
): Promise<AgentHandle> {
  let detachSession: (() => void) | undefined;
  let detachAgent: (() => void) | undefined;
  let agent: ClaudeAgent | undefined;
  let idleExit: (() => void) | undefined;
  try {
    // Session-start projection reset lives in the agent constructor; this
    // module-level reset is belt-and-suspenders for a re-entry before the
    // agent exists (e.g. a throwing setup that re-publishes).
    resetProjectionState();
    agent = new ClaudeAgent(loopCtx, id, agentOptions, session, client, () => idleExit?.(), runtimeInfo, clientFactory);
    agentRef.current = agent;

    // Seed THIS session's route only when its log has none (mirrors codex): the
    // harness's `model/selection` is the durable per-session route, so an
    // existing one is the authority and only a session that never named a route
    // gets the boot default. Log-only — the agent resolves it each turn.
    try {
      const events = session.snapshotEvents() as readonly { type: string }[];
      const alreadyRouted = events.some((event) => event.type === "model/selection");
      const seed = routeSeed(agentOptions as { provider: string; model: string });
      if (!alreadyRouted && seed !== undefined) {
        const selection = { provider: seed.provider, model: seed.model };
        (session.append as (type: string, data: unknown) => unknown)("model/selection", selection);
        trace(`session route seeded: ${selection.provider}/${selection.model}`);
      }
    } catch (error) {
      trace(`session route seeding failed: ${String(error)}`);
    }

    // Composition-only setup on the unpublished agent scope.
    const commit = await setup?.(agent.ctx, agent);

    // Publish: flush the unstored suffix, enter + announce in order.
    commit?.commit();
    await appendUnstoredSuffix(stored, session);

    if (opts.enterSession) {
      detachSession = agent.ctx.sessions.enter(session);
      agent.ctx.sessions.announce(session);
    }
    detachAgent = loopCtx.agents.enter(agent);
    // 0.1.6: announce(agent, source) is required, async, and emits agent/created
    // itself — the manual agent/session-start emission is gone upstream.
    await loopCtx.agents.announce(agent, source);

    let disposed = false;
    let unfollowOwner: (() => void) | undefined;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      trace(`dispose() called for agent ${id} (source=${source})`);
      unfollowOwner?.();
      await agent?.dispose();
      detachAgent?.();
      detachSession?.();
      await stored.handle.close();
    };
    idleExit = () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`claude-provider: teardown of ${id} failed: ${String(error)}`);
      });
    };

    unfollowOwner = ownerCtx.effect(() => () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`claude-provider: owner-unload teardown of ${id} failed: ${String(error)}`);
      });
    }, `claudeProvider.lifecycle(${id})`);

    return { agent, dispose };
  } catch (error) {
    trace(`setupAndPublish ${id} FAILED: ${String(error)}`);
    detachAgent?.();
    detachSession?.();
    void agent?.dispose().catch(() => { });
    client.close();
    throw error;
  } finally {
    opts.preparation?.[Symbol.dispose]();
  }
}

export default ClaudeProvider;
