/**
 * agent-agy provider — Google Antigravity provider plugin for DeepSeek Harness
 * (Super D, consumer-first line, 2026-09-18).
 *
 * An `AgentFactory` that drives an `AgyCliClient` — the user's OWN Antigravity
 * CLI in headless stream-json mode. 2026-10-02 ruling 「拥抱用户自己的使用环境」:
 * the adapter shares the user's real `~/.gemini` (native settings.json), their
 * ADC (`~/.config/gcloud`), and their keyring, instead of isolating a HOME the
 * CLI never had. The SDK/bridge transport lives in its own opt-in package,
 * `@pgmi-builds/agent-agy-sdk`.
 *
 * Session identity ("mapping only"): the DSH session id is the authority,
 * supplied by the harness. The CLI conversation id materializes after the
 * first turn, so the pairing is persisted in `<worldHome>/dsh-sessions.json`
 * (agy-sessions.ts). Resume resolves that record and fails CLOSED
 * (CONVERSATION_NOT_FOUND) when no conversation is recorded. The DSH session
 * log is the transcript authority, written through the upstream
 * `sessionPersistence` service (hermes create/resume transaction shape).
 */

import { realpathSync, statSync } from "node:fs";
import { bindForeignHub, type ForeignHubBinding } from "@pgmi-builds/superd-hub/foreign-hub";
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
import { AgyCliClient } from "./agy-cli-client.js";
import { hasSigninCredential, resolveAuthMode, type AgyAuthAvailability, type AgyAuthMode } from "./agy-auth.js";
import { AgyAuthGateway } from "./agy-auth-gateway.js";
import { registerAntigravityPreset } from "./agent-preset-agy.js";
import type { LiveAgyClient } from "./agent.js";
import { readAdapterState, writeAdapterState, readNativeDefaultModel, hasAdcEvidence } from "./agy-store.js";
import { AgyLlmAdapter, AGY_PROVIDER_ID } from "./adapter.js";
import { AgyAgent, type AgyAgentRuntimeInfo } from "./agent.js";
import { sessionRecord, upsertSession } from "./agy-sessions.js";
import { AGY_MODEL_CATALOG, CLI_DEFAULT_MODEL, parseModelId, resolveEffort, toModelSlug } from "./models.js";

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
  if (process.env.AGY_TRACE === "1") process.stderr.write(`[agy-provider ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

/** An owned write handle plus the count of events already stored through it. */
interface StoredSession {
  readonly handle: SessionHandle;
  storedCount: number;
}

/** Test/override knobs for the bridge child (prod: all unset). */
export interface AgyProviderOptions {
  spawnAttempts?: number;
  /** Native home override for tests (prod: ~/.gemini, read-only). */
  nativeHome?: string;
  /** danger-full-access → CLI --dangerously-skip-permissions (default: true, patch default preset). */
  skipPermissions?: boolean;
  /** agy binary override (CLI path tests). */
  agyBin?: string;
  /** Forward proxy for the geo-fenced Gemini API (CLI path; dev3 gost). */
  proxy?: string;
  /**
   * The USER's real home (default `$HOME`). The CLI always runs against it —
   * 2026-10-02 ruling: the adapter shares the user's own Antigravity
   * configuration (settings.json, ADC, keyring) instead of isolating it. The
   * old isolated-HOME knob was removed with that ruling: it both hid the
   * settings.json we maintain and silently destroyed ADC + the keyring.
   */
  realHome?: string;
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
    // The Hub settings panel's data plane (P3): an adapter-owned Typert Remote
    // (`agyAuth/get` | `agyAuth/set`) on this world's context. The hub's
    // carrier forwards `envelope.method` verbatim, so the panel reaches it
    // through the existing `/hub/api?agent=agy` family — no new hub route, and
    // no config knowledge leaks out of the adapter (dev-rules §12). Cordis
    // keeps the instance alive as this context's `agyAuth` service.
    new AgyAuthGateway(
      ctx,
      this.home,
      () => this.opts.realHome ?? process.env.HOME ?? "",
      () => this.authAvailability(),
    );
  }

  /** Which auth forms are present on this machine right now (probe, not choice). */
  private authAvailability(): AgyAuthAvailability {
    return {
      apiKey: this.resolveApiKey() !== undefined,
      // The CLI's OWN Google sign-in (Agent Platform) — measured 2026-10-02 as
      // the plane headless actually uses, and the one that WORKS on this
      // machine. Hardcoding it to `false` (the old "OAuth is a placeholder"
      // note) forced the ladder onto ADC, whose project has cloudcode-pa
      // disabled, so no turn could start.
      oauth: hasSigninCredential(this.opts.realHome ?? process.env.HOME ?? ""),
      adc: hasAdcEvidence(process.env, process.env.HOME ?? ""),
    };
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
    if (hasSigninCredential(this.opts.realHome ?? process.env.HOME ?? "")) return true;
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
   *  so cliOptions can forward slug+thinkingLevel to the CLI child. */
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
      this.runtime.ctx.logger.warn(`agy-provider: failed to persist the conversation id for ${String(id)}: ${String(error)}`);
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
          this.runtime.ctx.logger.info(`agy-provider: default model ← static catalog / native settings: ${targetKey}`);
        })
        .catch((error) => {
          this.runtime.ctx.logger.warn(`agy-provider: default model save failed: ${String(error)}`);
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
    const agentRef: { current?: AgyAgent } = {};
    const client = this.createLiveClient(spawnCwd, agentOptionsModel(options.agentOptions), options.agentOptions?.reasoningEffort,
      bindForeignHub("agy", id, this.home, () => agentRef.current as never));

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
        agentRef,
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

    const agentRef: { current?: AgyAgent } = {};
    const client = this.createLiveClient(spawnCwd, agentOptionsModel(options.agentOptions), options.agentOptions?.reasoningEffort,
      bindForeignHub("agy", id, this.home, () => agentRef.current as never), blank ? undefined : record!.conversationId!);

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
        agentRef,
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
   * Live transport: CLI-ONLY (2026-10-02 user ruling).
   *
   * The SDK/bridge route moved to its own package
   * (`@pgmi-builds/agent-agy-sdk`, delivered disabled by default): the product
   * case is that the user ALREADY runs Antigravity, so the CLI reuses that
   * environment for free while the SDK is an opt-in extra. Auth-form selection
   * still rides the agy-auth ladder.
   */
  private createLiveClient(cwd: string, modelId?: string, reasoningEffort?: string, hubBinding?: ForeignHubBinding, conversationId?: string): LiveAgyClient {
    return new AgyCliClient({ ...this.cliOptions(cwd, modelId, reasoningEffort), conversationId, hubBinding, hubStagingDirectory: join(this.home, "hub-native-agy") });
  }

  /**
   * The auth form this machine should use: an explicitly selected, actually
   * available form wins; otherwise the ladder Gemini API key → OAuth → ADC
   * (user ruling 2026-10-02). OAuth is a placeholder this round — no eligible
   * account exists to characterise which native fields a real sign-in stores —
   * so nothing reports it present and it can never win. Falls back to `apiKey`
   * so an unconfigured machine still reaches the §17 onboarding path.
   */
  private effectiveAuthMode(): AgyAuthMode {
    const selected = readAdapterState(this.home).authMode;
    return resolveAuthMode(this.authAvailability(), selected) ?? "apiKey";
  }

  /**
   * The effective permission preset this provider was mounted with. The
   * cordis.patch.yml default is danger-full-access; a patch-level override
   * would surface through the permission service config, which we read
   * best-effort (fail → the patch default).
   */
  private currentPermissionPreset(): string {
    try {
      const permission = this.runtime.ctx.get("permission") as
        | { config?: { defaultPreset?: string } }
        | undefined;
      return permission?.config?.defaultPreset ?? "danger-full-access";
    } catch {
      return "danger-full-access";
    }
  }

  /** CLI transport options: key-first default is the cheapest live pair. */
  private cliOptions(cwd: string, modelId?: string, reasoningEffort?: string): ConstructorParameters<typeof AgyCliClient>[0] {
    const parsed = parseModelId(modelId ?? this.resolveDefaultModelId());
    const slug = parsed?.slug ?? CLI_DEFAULT_MODEL.slug;
    // Effort precedence: explicit session reasoningEffort (WebUI Effort
    // selector → AgentOptions.reasoningEffort) > legacy `slug@level` id suffix >
    // THIS model's own declared default.
    //
    // The last arm used to read CLI_DEFAULT_MODEL.thinkingLevel, which is the
    // 3.6-flash cheap-pair constant ("low") — so every model inherited it and
    // the CLI got `--effort low` while the UI showed the model's own default
    // (observed 2026-10-02: 3.7 Flash + UI "medium" → `--effort "low"`).
    // defaultEffortFor() is the per-model answer and existed unused.
    const level = resolveEffort(slug, reasoningEffort, parsed?.thinkingLevel);
    // The ID ENCODING IS PLANE-DEPENDENT (measured 2026-10-02):
    //   OAuth / Agent Platform — `agy models` lists ONLY effort-suffixed ids
    //     (`gemini-3.7-flash-medium`) and the bare id is not a model at all:
    //     `--model gemini-3.7-flash --effort medium` → "--effort is not
    //     supported for model …". The suffixed id starts a turn, and a
    //     redundant `--effort` alongside it is tolerated.
    //   apiKey — the bare slug PLUS `--effort` (dev3); the suffixed id is not a
    //     model on that plane.
    // The UI catalog therefore stays four base models with an effort slot (no
    // list explosion) and the transport folds the level into the id when the
    // active plane wants it that way.
    const mode = this.effectiveAuthMode();
    const model = mode === "oauth" && level !== undefined ? `${slug}-${level}` : slug;
    return {
      apiKey: () => this.resolveApiKey(),
      model,
      ...(level === undefined ? {} : { effort: level }),
      cwd,
      proxy: this.opts.proxy ?? process.env.AGY_PROXY,
      // Preset → permission mapping (cordis.patch.yml default
      // danger-full-access): headless has no interactive approval, so the
      // full-access preset maps to --dangerously-skip-permissions; the
      // tighter presets keep the CLI's request-review (soft-deny, honest).
      skipPermissions: (this.opts.skipPermissions ?? (this.currentPermissionPreset() === "danger-full-access")),
      agyBin: this.opts.agyBin,
      authMode: mode,
      // The USER's real home — hard-coded relative to the current user, as the
      // 2026-10-02 ruling requires: the CLI, `~/.config/gcloud` (ADC), the
      // keyring, and the native settings we maintain all resolve against it, so
      // the adapter and the user's own TUI share one configuration.
      realHome: this.opts.realHome ?? process.env.HOME ?? "",
      spawnAttempts: this.opts.spawnAttempts,
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
  agentRef: { current?: AgyAgent },
): Promise<AgentHandle> {
  const runtime: AgyAgentRuntimeInfo = { ...runtimeInfo, onTurnDone };
  let detachSession: (() => void) | undefined;
  let detachAgent: (() => void) | undefined;
  let agent: AgyAgent | undefined;
  let idleExit: (() => void) | undefined;
  try {
    agent = new AgyAgent(loopCtx, id, agentOptions, session, client, () => idleExit?.(), runtime);
    agentRef.current = agent;

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
        loopCtx.logger.warn(`agy-provider: teardown of ${id} failed: ${String(error)}`);
      });
    };

    unfollowOwner = ownerCtx.effect(() => () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`agy-provider: owner-unload teardown of ${id} failed: ${String(error)}`);
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
