/**
 * agent-agy-sdk provider — Google Antigravity provider plugin for DeepSeek
 * Harness (Super D, opt-in SDK line, 2026-10-02 split).
 *
 * The SDK half of the Antigravity split. An `AgentFactory` that drives an
 * `AgyBridgeClient` (the Python google-antigravity SDK bridge child —
 * localharness materializes inside it on the FIRST prompt, so create/resume
 * spawn nothing). Auth is consumer-first: a Gemini API key persisted in the
 * adapter's world-home state, or ADC via the environment (the SDK picks it up;
 * this package NEVER invokes the agy CLI — dev-rules §16a). The CLI transport
 * is the sibling package `@pgmi-builds/agent-agy`.
 *
 * Session identity ("mapping only"): the DSH session id is the authority,
 * supplied by the harness. The SDK conversation id materializes after the
 * first turn, so the pairing is persisted in `<worldHome>/dsh-sessions.json`
 * (agy-sessions.ts). Resume resolves that record and fails CLOSED
 * (CONVERSATION_NOT_FOUND) when no conversation is recorded. The DSH session
 * log is the transcript authority, written through the upstream
 * `sessionPersistence` service (hermes create/resume transaction shape).
 *
 * Deployment (2026-10-02 user ruling): the composite ships this row DISABLED
 * and the package declares NO Python dependency and no postinstall — the
 * durable venv under the world home is fetched lazily on first real use
 * (sdk-venv.ts).
 */

import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  CreateAgentOptions,
  ResumeAgentOptions,
  AgentSetup,
} from "@deepseek-ai/dsh-agent";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import {
  SessionLogOffset,
  SessionPreparation,
  interruptedTurnClosers,
  type Session,
  type SessionEvent,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import type { SessionHandle, SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { AgyBridgeClient } from "./agy-client.js";
import { registerAntigravityPreset } from "./agent-preset-agy.js";
import type { LiveAgyClient } from "./agent.js";
import { readAdapterState, writeAdapterState, readNativeDefaultModel, hasAdcEvidence, readGcloudProject } from "./agy-store.js";
import { AgyLlmAdapter, AGY_PROVIDER_ID } from "./adapter.js";
import { AgyAgent, type AgyAgentRuntimeInfo } from "./agent.js";
import { sessionRecord, upsertSession } from "./agy-sessions.js";
import { AGY_MODEL_CATALOG, parseModelId, toModelSlug } from "./models.js";

/** Realpath of a recorded cwd, accepted only when it names an existing directory. */
/** Extract the session-selected model id (string form) from agent options. */
function agentOptionsModel(agentOptions: AgentOptions | undefined): string | undefined {
  const m = agentOptions?.model;
  return typeof m === "string" && m !== "" ? m : undefined;
}

function validatedCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  try {
    const canonical = realpathSync(cwd);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/** Diagnostic trace (AGY_TRACE=1 on the dsh process enables stderr tracing). */
const trace = (...parts: unknown[]): void => {
  if (process.env.AGY_TRACE === "1") process.stderr.write(`[agy-sdk-provider ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

/** An owned write handle plus the count of events already stored through it. */
interface StoredSession {
  readonly handle: SessionHandle;
  storedCount: number;
}

/** Test/override knobs for the bridge child (prod: all unset). */
export interface AgyProviderOptions {
  bridgePath?: string;
  pythonBin?: string;
  spawnAttempts?: number;
  /** Native home override for tests (prod: ~/.gemini, read-only). */
  nativeHome?: string;
  /** Vertex project/location override (ADC mode). Default: gcloud CLI config. */
  project?: string;
  location?: string;
  /** Tool-approval posture surfaced to every session's bridge start frame. */
  approvalMode?: "allow" | "ask";
}

/** Blank-session doctrine (§14 i): conversation content = turns actually ran. */
function hasConversationContent(events: readonly SessionEvent[]): boolean {
  return events.some((event) => {
    if (event.type === "turn/start" || event.type === "assistant/message") return true;
    if (event.type === "user/message") {
      const data = event.data as { source?: { kind?: unknown } } | undefined;
      return data?.source?.kind === "user";
    }
    return false;
  });
}

/** Open a read handle, pull the complete stored log, close. */
async function readStoredEvents(
  persistence: SessionPersistence,
  id: SessionId,
  signal?: AbortSignal,
): Promise<readonly SessionEvent[]> {
  const handle = await persistence.open(id, "read", signal === undefined ? {} : { signal });
  try {
    return (await handle.read(0, undefined, signal === undefined ? {} : { signal })).events;
  } finally {
    await handle.close();
  }
}

export class AgyProvider extends Service implements AgentFactory {
  static inject: string[] = ["agents", "sessions", "llm", "agentDefaultModel", "settings"];

  /** Plain holder — prevents Cordis re-tracing the factory's ctx through a caller shadow. */
  private readonly runtime: { ctx: Context };
  /** The world's DSH home — anchors adapter-owned state (session map, api-key state). */
  private readonly home: string;
  private readonly opts: AgyProviderOptions;
  private defaultModelKey = "";

  constructor(ctx: Context, opts: AgyProviderOptions = {}) {
    super(ctx, "agyProvider");
    this.runtime = { ctx };
    this.opts = opts;
    this.home = this.resolveHome();
    trace(`home: worldHome=${this.home}`);
    ctx.effect(() => ctx.agents.setFactory(this), "agyProvider.setFactory()");
    // The roster must be visible to the API gateway's root-level remote
    // enumeration; register it on this plugin's own (top-level) fiber.
    // 0.1.7: roster/selection/document RPC + the `agentPreset` session
    // projection all live in the host AgentPresetRegistry (mounted by the
    // dsh-web-app bundle's `agent-preset-registry` row; the adapter patch
    // pins its `default` to the Antigravity preset). The adapter only registers
    // its one fixed preset into the registry.
    registerAntigravityPreset(ctx);
    this.registerModelCatalog();
    this.registerDefaultModel();
  }

  /** The world's DSH home: boot-provided dshHomePath first, env last. */
  private resolveHome(): string {
    const fromBoot = this.runtime.ctx.get("dshHomePath");
    if (typeof fromBoot === "string" && fromBoot !== "") return fromBoot;
    if (typeof fromBoot === "function") {
      const resolved = (fromBoot as () => string)();
      if (typeof resolved === "string" && resolved !== "") return resolved;
    }
    return process.env.DSH_HOME ?? join(process.cwd(), ".tests", "superd");
  }

  /** Effective Gemini API key: adapter state first, then the environment. */
  private resolveApiKey(): string | undefined {
    const state = readAdapterState(this.home);
    if (typeof state.apiKey === "string" && state.apiKey !== "") return state.apiKey;
    const env = process.env.GEMINI_API_KEY;
    return typeof env === "string" && env !== "" ? env : undefined;
  }

  /**
   * Auth evidence for the §17 onboarding gate: an API key (state or env) OR
   * ADC evidence is enough — the SDK consumes either transparently, so a user
   * with gcloud ADC must NOT be pushed into key onboarding.
   */
  private hasAuthEvidence(): boolean {
    if (this.resolveApiKey() !== undefined) return true;
    return hasAdcEvidence(process.env, process.env.HOME ?? "");
  }

  /** Default model id: adapter state → native TUI default (slug-normalized) → catalog head. */
  private resolveDefaultModelId(): string {
    const state = readAdapterState(this.home);
    if (typeof state.defaultModel === "string" && parseModelId(state.defaultModel) !== undefined) return state.defaultModel;
    const native = readNativeDefaultModel(this.opts.nativeHome ?? join(process.env.HOME ?? "", ".gemini"));
    const slug = toModelSlug(native);
    if (slug !== undefined) return slug;
    return AGY_MODEL_CATALOG[0].slug;
  }

  /** Legacy slug-only default (default-model push keeps slug form). */
  private resolveDefaultModel(): string {
    const state = readAdapterState(this.home);
    if (typeof state.defaultModel === "string" && state.defaultModel !== "") return state.defaultModel;
    const native = readNativeDefaultModel(this.opts.nativeHome ?? join(process.env.HOME ?? "", ".gemini"));
    const slug = toModelSlug(native);
    if (slug !== undefined) return slug;
    return AGY_MODEL_CATALOG[0].slug;
  }

  /** Static route: provider `agy` + the resolved default (or the explicit ask).
   *  The selected model id (`slug` or `slug@level`) rides in `options.model`
   *  so clientOptions can forward slug+thinkingLevel to the bridge start frame. */
  private sessionAgentOptions(requested: AgentOptions | undefined): AgentOptions {
    const requestedModel = typeof requested?.model === "string" ? requested.model : undefined;
    const explicit = requestedModel !== undefined && parseModelId(requestedModel) !== undefined
      ? requestedModel
      : undefined;
    const model = explicit ?? this.resolveDefaultModelId();
    return { ...(requested ?? {}), provider: AGY_PROVIDER_ID, model };
  }

  private requirePersistence(op: "create" | "resume"): SessionPersistence {
    const persistence = this.runtime.ctx.get("sessionPersistence") as SessionPersistence | undefined;
    if (persistence === undefined) {
      throw new Error(`cannot ${op} an Agy session: session persistence is not configured`);
    }
    return persistence;
  }

  private agentRuntime(cwd: string): AgyAgentRuntimeInfo {
    const provider = this;
    return {
      session: { cwd },
      awaitingKey: !provider.hasAuthEvidence(),
      onSaveApiKey: (key: string) => {
        writeAdapterState(provider.home, { ...readAdapterState(provider.home), apiKey: key });
        trace("onboarding: api key persisted to adapter state (world home)");
      },
      onTurnDone: undefined, // replaced per-session by followConversationId below
    };
  }

  /** Persist the Dash↔conversation pairing once the first turn materializes it. */
  private readonly followConversationId = (id: SessionId, client: LiveAgyClient): void => {
    const cid = client.conversationId;
    if (cid === "") return;
    try {
      upsertSession(this.home, String(id), { conversationId: cid });
      trace(`conversation id recorded for ${String(id)}: ${cid}`);
    } catch (error) {
      this.runtime.ctx.logger.warn(`agy-sdk-provider: failed to persist the conversation id for ${String(id)}: ${String(error)}`);
    }
  };

  private registerModelCatalog(): void {
    const llm = this.runtime.ctx.get("llm") as LlmRuntime | undefined;
    if (llm === undefined) return;
    llm.registerAdapter([AGY_PROVIDER_ID], new AgyLlmAdapter());
  }

  /** Push the resolved default model into the world's `agentDefaultModel`. */
  private registerDefaultModel(): void {
    this.runtime.ctx.inject(["agentDefaultModel", "settings"], (mCtx) => {
      const service = mCtx.get("agentDefaultModel") as
        | {
          currentSelection?: () => { provider: string; model: string };
          saveSelection?: (selection: { provider: string; model: string }) => Promise<unknown>;
        }
        | undefined;
      if (service === undefined) return;
      const target = { provider: AGY_PROVIDER_ID, model: this.resolveDefaultModel() };
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
          this.runtime.ctx.logger.info(`agy-sdk-provider: default model ← static catalog / native settings: ${targetKey}`);
        })
        .catch((error) => {
          this.runtime.ctx.logger.warn(`agy-sdk-provider: default model save failed: ${String(error)}`);
        });
    });
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.sessionId;
    const meta = options.meta ?? {};
    const cwd = meta.cwd;

    if (meta.parentSession !== undefined) {
      throw new Error(`cannot fork session "${meta.parentSession}" onto the Agy provider: Antigravity has no native session fork`);
    }

    const persistence = this.requirePersistence("create");
    const spawnCwd = validatedCwd(cwd) ?? process.cwd();
    trace(`create id=${id} spawnCwd=${spawnCwd}`);

    // Full-lazy (§14-i): construct the client (spawns NOTHING); the bridge
    // child materializes on the first real prompt.
    const client = this.createLiveClient(spawnCwd, agentOptionsModel(options.agentOptions), options.agentOptions?.reasoningEffort);

    const preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(meta === undefined ? {} : { meta }),
      ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
    }));
    let stored: StoredSession | undefined;
    let handedOff = false;
    try {
      stored = await this.createStoredSession(persistence, preparation.session, options.signal);
      upsertSession(this.home, String(id), { conversationId: null, cwd: spawnCwd, createdAt: Date.now(), preset: null });
      handedOff = true;
      const agentOptions = await this.sessionAgentOptions(options.agentOptions);
      return await setupAndPublish(
        loopCtx,
        ownerCtx,
        id,
        agentOptions,
        options.setup,
        preparation.session,
        client,
        options.parentAgent,
        "startup",
        { enterSession: true, preparation },
        stored,
        this.agentRuntime(spawnCwd),
        () => this.followConversationId(id, client),
      );
    } catch (error) {
      trace(`create ${id} THREW: ${String(error)}`);
      void client.close();
      if (!handedOff) await stored?.handle.close().catch(() => { });
      throw error;
    } finally {
      if (!handedOff) preparation[Symbol.dispose]();
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.resumeSessionId;

    // Identity ("mapping only") with BLANK-SESSION TOLERANCE (2026-09-18,
    // dev-rules §14 i — pi doctrine mirror): the Dash host eagerly resumes on
    // view/model-change, so a never-materialized session (no record, or a
    // record whose native conversation never produced a turn) resumes AS
    // FRESH — zero processes until the first prompt. A MISSING record with
    // conversation-bearing DSH log content stays a genuine orphan → fail loud.
    const record = sessionRecord(this.home, String(id));
    const blank = record === undefined || record.conversationId === null || record.conversationId === "";
    trace(`resume id=${id} record=${record === undefined ? "MISSING" : record.conversationId ?? "NO-CONVERSATION"}${blank ? " (blank-tolerant)" : ""}`);

    const persistence = this.requirePersistence("resume");

    let orphanCheck: readonly SessionEvent[] | undefined;
    if (record === undefined) {
      orphanCheck = await readStoredEvents(persistence, id, options.signal);
      if (hasConversationContent(orphanCheck)) {
        const error = new Error(`cannot resume session "${id}": no Antigravity conversation is recorded for this Dash session id — start a new session`);
        (error as Error & { code?: string }).code = "CONVERSATION_NOT_FOUND";
        throw error;
      }
    }

    const spawnCwd = blank
      ? (record !== undefined ? validatedCwd(record.cwd) ?? process.cwd() : process.cwd())
      : (() => {
          const verified = validatedCwd(record!.cwd);
          if (verified === undefined) {
            throw new Error(`cannot resume session "${id}": its recorded working directory no longer exists`);
          }
          return verified;
        })();

    const client = this.createLiveClient(spawnCwd, agentOptionsModel(options.agentOptions), options.agentOptions?.reasoningEffort);

    let handle: SessionHandle | undefined;
    let stored: StoredSession | undefined;
    let preparation: SessionPreparation | undefined;
    let handedOff = false;
    try {
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
      handle = undefined;
      handedOff = true;
      const agentOptions = await this.sessionAgentOptions(options.agentOptions);
      return await setupAndPublish(
        loopCtx,
        ownerCtx,
        id,
        agentOptions,
        options.setup,
        preparation.session,
        client,
        options.parentAgent,
        "resume",
        { enterSession: true, preparation },
        stored,
        this.agentRuntime(spawnCwd),
        () => this.followConversationId(id, client),
      );
    } catch (error) {
      trace(`resume ${id} THREW: ${String(error)}`);
      void client.close();
      if (!handedOff) await handle?.close().catch(() => { });
      throw error;
    } finally {
      if (!handedOff) preparation?.[Symbol.dispose]();
    }
  }

/**
   * Live transport: SDK-ONLY (2026-10-02 user ruling).
   *
   * This package is the opt-in SDK half of the Antigravity split: it drives the
   * Python google-antigravity SDK through the JSONL bridge and NEVER invokes the
   * user's `agy` CLI (that transport is `@pgmi-builds/agent-agy`).
   * Auth (§16a transparency): a key from adapter state / `GEMINI_API_KEY` rides
   * the start frame; without one the SDK falls back to ADC (Vertex, project read
   * from the gcloud default). Neither ⇒ the §17 onboarding branch answers the
   * first turn locally, before anything spawns.
   */
  private createLiveClient(cwd: string, modelId?: string, reasoningEffort?: string): LiveAgyClient {
    return new AgyBridgeClient(this.clientOptions(cwd, modelId, reasoningEffort));
  }


  /** Bridge child options: world cwd + overrides; the api key rides the start config. */
  private clientOptions(cwd: string, modelId?: string, reasoningEffort?: string): ConstructorParameters<typeof AgyBridgeClient>[0] {
    // Auth plane (§16a): API key when present; otherwise the SDK's Vertex
    // endpoint over ADC — which needs an explicit project, read from the
    // gcloud CLI default. Without either, sessions gate into §17 onboarding.
    const apiKey = this.resolveApiKey();
    let project = this.opts.project;
    let location = this.opts.location;
    if (apiKey === undefined && project === undefined && hasAdcEvidence(process.env, process.env.HOME ?? "")) {
      project = readGcloudProject(process.env.HOME ?? "");
      location = location ?? "global";
    }
    // Session-selected model id wins over the provider default (previously a
    // split-brain: the session showed one model, the bridge started another).
    // `slug@level` decodes into model + thinking_level for the start frame.
    const parsed = parseModelId(modelId ?? this.resolveDefaultModelId());
    return {
      apiKey,
      project,
      location,
      model: parsed?.slug ?? this.resolveDefaultModelId(),
      // TUI parity: the native default ships (Medium); without an explicit
      // level the bridge sends none and thinking blocks rarely stream.
      thinkingLevel: parsed?.thinkingLevel ?? "medium",
      approvalMode: this.opts.approvalMode ?? "allow",
      workspaces: [cwd],
      bridgePath: this.opts.bridgePath,
      pythonBin: this.opts.pythonBin,
      spawnAttempts: this.opts.spawnAttempts,
      // Anchors the durable SDK venv: per-world, writable, survives restarts.
      worldHome: this.home,
    };
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
}

/** Durable flush of the session's pre-publication suffix. */
async function appendUnstoredSuffix(stored: StoredSession, session: Session): Promise<void> {
  const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount));
  if (suffix.length > 0) await stored.handle.append(suffix);
  stored.storedCount += suffix.length;
}

/** Shared create/resume transaction (module-level: Cordis tracing proxy). */
async function setupAndPublish(
  loopCtx: Context,
  ownerCtx: Context,
  id: SessionId,
  agentOptions: AgentOptions,
  setup: AgentSetup | undefined,
  session: Session,
  client: LiveAgyClient,
  parentAgent: Agent | undefined,
  source: "startup" | "resume",
  opts: { enterSession: boolean; preparation?: SessionPreparation },
  stored: StoredSession,
  runtimeInfo: AgyAgentRuntimeInfo,
  onTurnDone: () => void,
): Promise<AgentHandle> {
  const runtime: AgyAgentRuntimeInfo = { ...runtimeInfo, onTurnDone };
  let detachSession: (() => void) | undefined;
  let detachAgent: (() => void) | undefined;
  let agent: AgyAgent | undefined;
  let idleExit: (() => void) | undefined;
  try {
    agent = new AgyAgent(loopCtx, id, agentOptions, session, client, () => idleExit?.(), runtime);

    // Pin THIS session to the agy route (static resolution — synchronous).
    try {
      const selection = { provider: agentOptions.provider ?? "agy", model: agentOptions.model ?? "" };
      if (selection.model !== "") {
        // 0.2.2: installModelSelection dropped its injected-ref parameter — the
        // durable face (`agent.model`, the same mechanism session/selectModel
        // uses) carries the pin: select() appends the typed, deduped
        // `model/selection` event.
        agent.model.select(selection);
        trace(`session route pinned: ${selection.provider}/${selection.model}`);
      }
    } catch (error) {
      trace(`session route pin failed: ${String(error)}`);
    }

    const commit = await setup?.(agent.ctx, agent);

    commit?.commit();
    await appendUnstoredSuffix(stored, session);

    if (opts.enterSession) {
      detachSession = agent.ctx.sessions.enter(session);
      agent.ctx.sessions.announce(session);
    }
    detachAgent = loopCtx.agents.enter(agent, parentAgent);
    // 0.1.6: announce(agent, source) is required, async, and emits agent/created
    // itself — the manual agent/session-start emission is gone upstream.
    await loopCtx.agents.announce(agent, source);

    let disposed = false;
    let unfollowOwner: (() => void) | undefined;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      unfollowOwner?.();
      await agent?.dispose();
      detachAgent?.();
      detachSession?.();
      await stored.handle.close();
    };
    idleExit = () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`agy-sdk-provider: teardown of ${id} failed: ${String(error)}`);
      });
    };

    unfollowOwner = ownerCtx.effect(() => () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`agy-sdk-provider: owner-unload teardown of ${id} failed: ${String(error)}`);
      });
    }, `agyProvider.lifecycle(${id})`);

    return { agent, dispose };
  } catch (error) {
    trace(`setupAndPublish ${id} FAILED: ${String(error)}`);
    detachAgent?.();
    detachSession?.();
    void agent?.dispose().catch(() => { });
    void client.close();
    throw error;
  } finally {
    opts.preparation?.[Symbol.dispose]();
  }
}

export default AgyProvider;
