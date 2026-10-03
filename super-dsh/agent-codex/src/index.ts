/**
 * agent-codex provider — Codex provider plugin for DeepSeek Harness
 * (Super D, app-server line).
 *
 * Replaces the built-in agent loop with an `AgentFactory` that drives
 * `codex app-server` threads (one `CodexAppServerClient` per session) and bridges
 * the projected wire stream into the Dash Agent/Session contracts. Mirrors
 * `@deepseek-ai/dsh-agent-loop`'s creation transaction (prepare → owned
 * storage handle → setup → publish) so the session + agent publish as one
 * ordered lifecycle AND the DSH session log is written through the upstream
 * `sessionPersistence` service — list/read/replay/workspace grouping are then
 * ordinary DSH services over that log.
 *
 * Session identity (2026-09-16, "mapping only"): the DSH session id is the
 * authority — supplied by the harness at create (`options.sessionId`) and
 * resume (`options.resumeSessionId`). Codex's thread id only materializes
 * after the first turn, so the pairing is persisted in the adapter's app home
 * (`<codexHome>/dsh-sessions.json`, see session-map.ts). Resume resolves that
 * record and fails closed when the thread is unknown. The rollout scan, the
 * adapter-owned session list and the transcript replay are gone.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
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
  type SessionEvent,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import type { SessionHandle, SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { CodexAppServerClient, type ApprovalPolicy } from "./app-server-client.js";
import { CodexAgent, type CodexAgentRuntimeInfo } from "./agent.js";
import { CODEX_PROVIDER_ID, CodexLlmAdapter, routeIds } from "./adapter.js";
import { registerCodexPreset } from "./agent-preset-codex.js";
import { readRolloutHead, resolveCodexHome } from "./codex-store.js";
import { CodexProvidersGateway, syncFromNative } from "./codex-provider-gateway.js";
import { readProviderStore, type CodexProviderEntry } from "./codex-providers.js";
import { readNativeSelection } from "./codex-native-config.js";
import { providerLaunch } from "./codex-launch.js";
import { CodexResumeError, sessionRecord, upsertSession, type CodexSessionRecord } from "./session-map.js";
import { codexApprovalMode, defaultPermissionPreset, envApprovalMode, presetFromEvents, sandboxModeForPreset } from "./permission.js";

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

/** Diagnostic trace (CODEX_TRACE=1 on the dsh process enables stderr tracing). */
const trace = (...parts: unknown[]): void => {
  if (process.env.CODEX_TRACE === "1") process.stderr.write(`[codex-provider ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

/**
 * How often the canonical store is reconciled with the user's `config.toml`
 * (2026-10-04 user ruling: startup + every ten minutes). The file is the user's
 * own and edits it with their own tools, so the sync is a poll rather than an
 * event subscription — ten minutes is the granularity the ruling asked for.
 */
const SYNC_INTERVAL_MS = 600_000;
/** An owned write handle plus the count of events already stored through it. */
interface StoredSession {
  readonly handle: SessionHandle;
  storedCount: number;
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

export class CodexProvider extends Service implements AgentFactory {
  /**
   * `agentDefaultModel` and `settings` are load-bearing, not decorative (OMP
   * twin, same boot-order trap): the harness owns the "default for new sessions"
   * selection there (`@deepseek-ai/dsh-agent-default-model`, mounted by dsh-base
   * with a hard-coded `deepseek-official/deepseek-flash`), and this bridge is the
   * only thing that feeds it the codex config's real default. Without the inject
   * the context cannot resolve the service at apply time and the push in
   * #registerDefaultModel never fires — the picker keeps advertising a model no
   * adapter in this world serves.
   */
  static inject: string[] = ["agents", "sessions", "llm", "agentDefaultModel", "settings"];

  /** Plain holder — prevents Cordis re-tracing the factory's ctx through a caller shadow. */
  private readonly runtime: { ctx: Context };
  /**
   * The world's DSH home — captured once from the world's own `dshHomePath`
   * (never ambient env inside plugins). It anchors adapter-owned DSH state
   * (the session map) only; the codex app home is the CLI's native `~/.codex`
   * (2026-09-17 ruling), resolved on demand via resolveCodexHome().
   */
  private readonly home: string;
  /** Echo/staleness guard for the app-wide default-model push. */
  private defaultModelKey = "";
  /**
   * The live `ctx.llm` registration for the codex routes, when one exists.
   * Its `replace()` is how the route SET follows the store: a provider gaining
   * or losing its first model changes which routes exist, which re-registration
   * alone can express.
   */
  private routes: { replace(providers: string[]): void } | undefined;
  /** Epoch ms of the last reconcile with the user's `config.toml`. */
  private syncedAt: number | undefined;

  constructor(ctx: Context) {
    super(ctx, "codexProvider");
    this.runtime = { ctx };
    // Native-home ruling (2026-09-17): the Codex CLI keeps its own native home
    // (~/.codex; $CODEX_HOME overrides in tests) — the adapter never redirects
    // it and never seeds config into it. this.home is only the world's DSH
    // home, anchoring adapter-owned DSH state (the session map).
    this.home = this.#resolveHome();
    const codexHome = resolveCodexHome();
    trace(`home: worldHome=${this.home} codexHome=${codexHome} configExists=${existsSync(join(codexHome, "config.toml"))}`);
    ctx.effect(() => ctx.agents.setFactory(this), "codexProvider.setFactory()");
    // The store is canonical and the native file is a source (2026-10-04).
    // Register the routes the store already implies FIRST, so a malformed
    // config.toml costs the world a reconcile, never its provider list; then
    // reconcile, then keep reconciling on a timer.
    this.#registerModelCatalog();
    this.syncNow();
    const timer = setInterval(() => this.syncNow(), SYNC_INTERVAL_MS);
    timer.unref?.();
    ctx.effect(() => () => clearInterval(timer), "codexProvider.syncTimer()");
    this.#registerDefaultModel();
    // The roster must be visible to the API gateway's root-level remote
    // enumeration (dsh-host-apiproxy read it from the root service table);
    // nesting it under a child fiber via ctx.plugin hides its @Remote routes
    // from the gateway and every agentPresets/* call 404s. Register it on
    // this plugin's own (top-level) fiber instead — its Service constructor
    // ties teardown to this fiber via reflect.provide.
    // 0.1.7: roster/selection/document RPC + the `agentPreset` session
    // projection all live in the host AgentPresetRegistry (mounted by the
    // dsh-web-app bundle's `agent-preset-registry` row; the adapter patch
    // pins its `default` to the Codex preset). The adapter only registers
    // its one fixed preset into the registry.
    registerCodexPreset(ctx);
    // The Hub settings panel's data plane (2026-10-03 multi-provider ruling): an
    // adapter-owned Typert Remote (`codexProviders/get|save|remove`) on this
    // world's context. The hub's carrier forwards `envelope.method` verbatim,
    // so the panel reaches it through the existing `/hub/api?agent=codex`
    // family — no new hub route, and no provider knowledge leaks out of the
    // adapter (dev-rules §12). Cordis keeps the instance alive as this
    // context's `codexProviders` service. There is no `select`: which provider a
    // session runs on is DSH's per-session `model/selection`.
    //
    // `resolveCodexHome` is passed as a THUNK on purpose: the native home is
    // re-resolved per call (so a test's `CODEX_HOME` and an operator's override
    // are both honored) and construction stays read-free — the panel's first
    // `get` is what touches disk.
    new CodexProvidersGateway(ctx, this.home, () => resolveCodexHome(), () => this.refreshRoutes());
  }

  /**
   * Reconcile the canonical provider store with the user's `config.toml` and
   * re-register the `ctx.llm` routes if either moved.
   *
   * Called once at startup and every {@link SYNC_INTERVAL_MS} (2026-10-04 user
   * ruling), plus after every panel mutation through the gateway's `onChange`.
   * Never throws: a provider list is not worth a boot.
   */
  syncNow(): void {
    try {
      const { store, added, updated } = syncFromNative(this.home, resolveCodexHome());
      if (added.length > 0 || updated.length > 0) {
        this.runtime.ctx.logger.info(`codex-provider: config.toml sync — added ${added.join(", ") || "none"}, refreshed ${updated.join(", ") || "none"}`);
      }
      this.syncedAt = Date.now();
      this.#applyRoutes(store.providers);
    } catch (error) {
      this.runtime.ctx.logger.warn(`codex-provider: provider sync failed: ${String(error)}`);
    }
  }

  /** Re-register the `ctx.llm` routes from the current store (panel mutation path). */
  refreshRoutes(): void {
    try {
      this.#applyRoutes(readProviderStore(this.home).providers);
    } catch (error) {
      this.runtime.ctx.logger.warn(`codex-provider: route refresh failed: ${String(error)}`);
    }
  }

  /**
   * The provider id the user's own `config.toml` names, mapped into the store.
   * It is the app-wide default's provider and the fallback for a session whose
   * logged selection predates the multi-provider rework. `undefined` when the
   * native file names nothing this world can serve.
   */
  private nativeProviderId(): string | undefined {
    const native = readNativeSelection(resolveCodexHome());
    const wanted = native.providerId;
    if (wanted === undefined) return undefined;
    const providers = readProviderStore(this.home).providers;
    return providers.find((entry) => entry.id === wanted)?.id ?? undefined;
  }

  /** The store entry a DSH route id names. */
  private providerEntry(providerId: string): CodexProviderEntry | undefined {
    return readProviderStore(this.home).providers.find((entry) => entry.id === providerId);
  }

  /**
   * The factory's session-level route fallback.
   *
   * The ambient `agentDefaultModel` selection is not authoritative here (user
   * directive 2026-09-15), and neither is a global "active" provider any more:
   * the session's OWN `model/selection` is what decides, and it is resolved by
   * the agent at each turn. These options are what a session with no selection
   * of its own starts from — the provider the user's `config.toml` names, with
   * the model it runs.
   */
  private sessionAgentOptions(requested: AgentOptions | undefined): AgentOptions {
    const native = readNativeSelection(resolveCodexHome());
    const provider = this.nativeProviderId();
    const served = requested?.provider !== undefined && this.providerEntry(requested.provider) !== undefined
      ? requested
      : undefined;
    const model = served?.model
      ?? (native.model !== undefined && native.model !== "" ? native.model : undefined);
    return {
      ...(requested ?? {}),
      ...(provider === undefined && served === undefined ? {} : { provider: served?.provider ?? provider }),
      ...(model === undefined ? {} : { model }),
    };
  }

  /**
   * The write path is mandatory now (2026-09-16): this factory owns the DSH
   * session log through the upstream persistence service — a session created
   * or resumed without a backend would persist nothing.
   */
  private requirePersistence(op: "create" | "resume"): SessionPersistence {
    const persistence = this.runtime.ctx.get("sessionPersistence") as SessionPersistence | undefined;
    if (persistence === undefined) {
      throw new Error(`cannot ${op} a Codex session: session persistence is not configured`);
    }
    return persistence;
  }

  /**
   * Take a fresh session's write ownership. Nothing is appended here: the
   * constructor seed (which never re-emits through `session/event`) is stored
   * by `appendUnstoredSuffix` at the publication commit point, so a failed or
   * cancelled setup closes an unmaterialized handle and leaves no residue.
   */
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

  /**
   * Runtime facts the agent stamps into the log and needs to launch a child:
   * Codex's own system prompt (rollout HEAD `base_instructions`, readable once
   * the thread exists), the launch that pins a provider, and the provider's own
   * context window for one of its models.
   */
  private agentRuntime(client: CodexAppServerClient, id: SessionId, cwd: string): CodexAgentRuntimeInfo {
    const codexHome = resolveCodexHome();
    return {
      systemPrompt: (): string | undefined => {
        const threadId = client.threadId;
        if (threadId === null) return undefined;
        return readRolloutHead(codexHome, threadId)?.baseInstructions;
      },
      // The whole on-the-fly mechanism in one call: the agent asks for the
      // argv/env that pin a provider, and gets them without a single write to
      // the user's home (the per-provider model catalog is ours).
      launchFor: (providerId: string) => {
        const entry = this.providerEntry(providerId);
        return entry === undefined ? undefined : providerLaunch(this.home, codexHome, entry);
      },
      nativeProviderId: () => this.nativeProviderId(),
      contextWindowFor: (providerId: string, model: string) => {
        const entry = this.providerEntry(providerId);
        const found = entry?.models.find((candidate) => candidate.id === model);
        return found?.contextWindow;
      },
      // RC-4: turn-time native rejections mark the map so the next resume
      // fails fast (CodexResumeError NATIVE_REJECTED) instead of burning
      // another turn on a dead thread.
      // The session workspace: the per-turn permission fold needs it for
      // `workspaceWrite.writableRoots` (never a home — the user's workspace).
      cwd: (): string | undefined => cwd,
      markNotResumable: (): void => {
        try {
          upsertSession(this.home, String(id), { resumable: false });
          this.runtime.ctx.logger.warn(`codex-provider: session ${String(id)} marked not resumable after a native rejection`);
        } catch (error) {
          this.runtime.ctx.logger.warn(`codex-provider: failed to mark ${String(id)} not resumable: ${String(error)}`);
        }
      },
    };
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
   * App-wide wiring the adapter owns (user 2026-09-15): the SDK has no
   * default-model concept, so the bridge publishes the codex config.toml
   * default into the world's `agentDefaultModel`. One-directional on purpose —
   * the config is read-only for us (S7 single-direction valve), which makes the
   * codex world's default sticky. Echo-guarded by the saved key.
   *
   * Why the write goes through `settings.replace` and not through
   * `agentDefaultModel.saveSelection`: the harness service installs its section
   * from an `inject(["settings"], …)` callback but then writes through
   * `this.ctx.get("settings")?.replace(…)` on its UNSCOPED context, where
   * `settings` is not injected — the optional chain swallows the lookup and the
   * call is a silent no-op (the settings file is never touched, and the picker
   * keeps showing the base default). Same defect and same fix as the OMP twin
   * (`#saveDefaultSelection`): write the installed section directly through our
   * own injected `settings` service, which the harness folds back via
   * `installSection`, so every other consumer sees the new default.
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
      // The default is whatever the user's own codex config runs, expressed in
      // the store's own route id so the harness can resolve it. A config naming
      // a provider this world has no route for is not a default we can push.
      const native = readNativeSelection(resolveCodexHome());
      const provider = this.nativeProviderId();
      const model = native.model;
      if (provider === undefined || model === undefined || model === "") {
        trace("default model push skipped: config.toml names no servable provider/model");
        return;
      }
      const target = { provider, model };
      const targetKey = `${target.provider}/${target.model}`;
      const current = service.currentSelection?.();
      const currentKey = current === undefined ? undefined : `${current.provider}/${current.model}`;
      if (currentKey === targetKey || currentKey === this.defaultModelKey) return;
      trace(`default model: ${currentKey ?? "none"} → ${targetKey}`);
      const settings = mCtx.get("settings") as
        | { replace?: (namespace: string, value: unknown) => Promise<unknown> }
        | undefined;
      void Promise.resolve(settings?.replace?.("agent-default-model", target))
        // Best-effort second path: harmless when upstream's no-op swallows it,
        // and it keeps the in-memory selection fresh on builds where it works.
        .then(() => service.saveSelection?.(target))
        .then(() => {
          this.defaultModelKey = targetKey;
          this.runtime.ctx.logger.info(`codex-provider: default model ← codex config: ${targetKey}`);
        })
        .catch((error) => {
          this.runtime.ctx.logger.warn(`codex-provider: default model save failed: ${String(error)}`);
        });
    });
  }

  /**
   * Register the codex routes on `ctx.llm` — ONE ROUTE PER PROVIDER with
   * models (2026-10-04 rework).
   *
   * The harness's model selector is provider-grouped, and its per-session
   * choice is durable (`model/selection` + the `modelSelection` projection), so
   * expressing the Codex provider list as real routes is what makes the whole
   * feature DSH-native: nothing in Super D has to model "the active provider" or
   * remember which route a session last used.
   *
   * A provider with no models yet registers no route — codex itself cannot run
   * it until the user says which model to ask for, and an empty group in the
   * picker would be noise.
   */
  #registerModelCatalog(): void {
    this.#applyRoutes(readProviderStore(this.home).providers);
  }

  /** Register or atomically re-point the codex routes at the given providers. */
  #applyRoutes(providers: readonly CodexProviderEntry[]): void {
    const llm = this.runtime.ctx.get("llm") as LlmRuntime | undefined;
    if (llm === undefined) return;
    const ids = routeIds({ version: 1, providers });
    if (this.routes === undefined) {
      if (ids.length === 0) {
        // `registerAdapter` refuses an empty initial set, and there is nothing
        // to serve yet; the next sync or panel save will register the routes.
        trace("route registration deferred: no provider with models yet");
        return;
      }
      this.routes = llm.registerAdapter([...ids], new CodexLlmAdapter(this.home));
      trace(`routes registered: ${ids.join(", ")}`);
      return;
    }
    // `replace` validates the whole candidate set before swapping, so a bad id
    // cannot leave the registry half-updated — but a throw here must not take
    // the caller (a timer, or a panel save) down with it.
    this.routes.replace([...ids]);
    trace(`routes replaced: ${ids.join(", ") || "none"}`);
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.sessionId;
    const meta = options.meta ?? {};
    const cwd = meta.cwd;

    // Fork (the apiproxy's `session.fork`) seeds a copied-turn prefix but
    // Codex has no native fork: fail the fork cleanly at the factory boundary.
    // `parentSession` in create metadata is set only by the fork path
    // (subagents go through `ctx.subagents` instead).
    if (meta.parentSession !== undefined) {
      throw new Error(
        `cannot fork session "${meta.parentSession}" onto the Codex provider: Codex has no native session fork`,
      );
    }

    // The DSH session log is this factory's write path (2026-09-16): without
    // the upstream persistence service a created session would persist
    // nothing, so require it up front.
    const persistence = this.requirePersistence("create");

    // App-server line (2026-10-03): the thread's LAUNCH posture still needs a
    // decision here — the Dash session does not exist yet (it is prepared +
    // announced, which is what stamps `permission/preset` via
    // pinInitialPermission, only inside setupAndPublish AFTER this call) — so
    // the env override (CODEX_APPROVAL_MODE, headless runs) wins, else the
    // permission service's default. From the first turn on, `agent.ts` folds
    // the LIVE session log per turn (`turnPolicyFromEvents`) and overrides both
    // fields on every `turn/start`, which is what makes `/permission` real.
    const preset = envApprovalMode() ?? defaultPermissionPreset(loopCtx);
    const approvalPolicy = codexApprovalMode(preset) as ApprovalPolicy;
    const sandboxMode = sandboxModeForPreset(preset);
    const spawnCwd = validatedCwd(cwd) ?? process.cwd();
    trace(`create id=${id} preset=${preset ?? "none"} approval=${approvalPolicy} sandbox=${sandboxMode} spawnCwd=${spawnCwd}${envApprovalMode() === undefined ? "" : " (env override)"}`);

    // Backend takes ZERO part in the UI's browser-local new-session draft: the
    // app-server child is NOT spawned here (lazy-spawn gate, rules §14-i) —
    // create() is pure construction, and the process materializes on the first
    // real prompt.
    const client = CodexAppServerClient.create({ cwd: spawnCwd, approvalPolicy, sandboxMode });
    // The session's route is NOT pinned here any more (2026-10-04): the agent
    // resolves it per turn from DSH's own model-selection state, and a launch
    // costs nothing until the first real prompt. `setupAndPublish` still seeds a
    // `model/selection` for a session that has none, so the transcript can name
    // its route from turn one.


    const preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(meta === undefined ? {} : { meta }),
      ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
    }));
    let stored: StoredSession | undefined;
    let handedOff = false;
    try {
      stored = await this.createStoredSession(persistence, preparation.session, options.signal);
      // Identity record BEFORE publication: the DSH id → Codex thread pairing
      // (threadId null until the first turn) is what resume resolves.
      upsertSession(this.home, String(id), {
        threadId: client.threadId,
        cwd: spawnCwd,
        createdAt: Date.now(),
        preset: preset ?? null,
      });
      this.followThreadId(id, client);
      handedOff = true;
      return await setupAndPublish(
        loopCtx,
        ownerCtx,
        id,
        this.sessionAgentOptions(options.agentOptions),
        options.setup,
        preparation.session,
        client,
        options.parentAgent,
        "startup",
        { enterSession: true, preparation },
        stored,
        this.agentRuntime(client, id, spawnCwd),
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

    // Identity (2026-09-16 "mapping only", reaffirmed 2026-09-18): the DSH
    // session id resolves through the adapter-owned map — the thread id is
    // recorded when Codex materializes it. The adapter NEVER scans the native
    // ~/.codex session storage to recover pairings (2026-09-18 user ruling:
    // the discovery tier violated the design — DSH log is the transcript
    // authority; the native home contributes config/settings only). Every
    // miss fails closed with a stable code (CodexResumeError).
    const persistence = this.requirePersistence("resume");
    const record = sessionRecord(this.home, String(id));
    trace(`resume id=${id} record=${record === undefined ? "MISSING" : record.threadId ?? "NO-THREAD"}${record?.resumable === false ? " (marked not resumable)" : ""}`);
    if (record === undefined) {
      throw new CodexResumeError(
        "SESSION_MAP_MISS",
        `cannot resume session "${id}": no Codex thread is recorded for this Dash session id`,
      );
    }
    if (record.threadId === null) {
      // C2: never auto-start a fresh thread — the session's history is in the
      // (missing) native thread, not in a blank one.
      throw new CodexResumeError(
        "NATIVE_THREAD_NEVER_STARTED",
        `cannot resume session "${id}": its Codex thread was never started (no thread id recorded)`,
      );
    }
    if (record.resumable === false) {
      // A previous native resume was rejected at turn time (plan RC-4): fail
      // fast with the clear refusal instead of burning another turn.
      throw new CodexResumeError(
        "NATIVE_REJECTED",
        `cannot resume session "${id}": its Codex thread ${record.threadId} was rejected by the native runtime in an earlier attempt`,
      );
    }
    // Pre-validation (plan RC-4): the rollout must exist in the CURRENT codex
    // home BEFORE spawning — covers rollouts stranded under the abandoned
    // `<worldHome>/.codex` home (never migrated) and pruned rollouts alike.
    // Without this gate the failure would surface only at the first turn
    // (resumeThread is zero-IO).
    if (readRolloutHead(resolveCodexHome(), record.threadId) === undefined) {
      throw new CodexResumeError(
        "ROLLOUT_MISSING",
        `cannot resume session "${id}": no rollout for Codex thread ${record.threadId} exists in the current Codex home (${resolveCodexHome()})`,
      );
    }

    // Spawn cwd comes from the recorded pairing — re-realpath and re-verify so
    // a moved/removed directory cannot aim a resume outside a live path.
    const spawnCwd = validatedCwd(record.cwd);
    if (spawnCwd === undefined) {
      throw new Error(`cannot resume session "${id}": its recorded working directory no longer exists`);
    }


    // Approval policy / sandbox mode for the re-attached thread: the LAUNCH
    // posture, decided from the recorded preset, else the persisted session log,
    // else the permission service's default. CODEX_APPROVAL_MODE (headless
    // runs) overrides. The per-turn fold in agent.ts takes over from turn one.
    const envMode = envApprovalMode();
    const preset =
      envMode !== undefined
        ? envMode
        : record.preset ??
        presetFromEvents(await readStoredEvents(persistence, id, options.signal)) ??
        defaultPermissionPreset(loopCtx);
    const approvalPolicy = codexApprovalMode(preset) as ApprovalPolicy;
    const sandboxMode = sandboxModeForPreset(preset);
    trace(`resume id=${id} spawnCwd=${spawnCwd} preset=${preset ?? "none"} approval=${approvalPolicy} sandbox=${sandboxMode}`);

    // Re-attach to the Codex thread by its id on the first real prompt (Codex
    // owns the live agent context and restores the model context from its
    // rollout). No process is spawned here — lazy-spawn gate, rules §14-i.
    const client = CodexAppServerClient.create({
      cwd: spawnCwd,
      resumeThreadId: record.threadId,
      approvalPolicy,
      sandboxMode,
    });

    let handle: SessionHandle | undefined;
    let stored: StoredSession | undefined;
    let preparation: SessionPreparation | undefined;
    let handedOff = false;
    try {
      // Taking write ownership FIRST excludes a concurrent resume of the same
      // id (a live agent's handle holds the claim in this process).
      handle = await persistence.open(id, "write", options.signal === undefined ? {} : { signal: options.signal });
      // Crash repair belongs to the agent layer: an interrupted final turn
      // receives synthetic closers appended through the same handle.
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
      this.followThreadId(id, client);
      handedOff = true;
      return await setupAndPublish(
        loopCtx,
        ownerCtx,
        id,
        this.sessionAgentOptions(options.agentOptions),
        options.setup,
        preparation.session,
        client,
        options.parentAgent,
        "resume",
        { enterSession: true, preparation },
        stored,
        this.agentRuntime(client, id, spawnCwd),
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

  /**
   * Watch the client for its first materialized thread id and persist the
   * Dash↔thread pairing once (the record is the resume authority; the
   * create-time entry starts with `threadId: null`).
   * Arrow FIELD (not a `#` method and not a true-private field): the provider
   * is exposed through a Cordis tracing proxy, and hard-private members fail
   * their brand check on the proxy receiver (the same reason setupAndPublish
   * is module-level). A persistence failure here is logged, never thrown into
   * the client's event stream.
   */
  private readonly followThreadId = (id: SessionId, client: CodexAppServerClient): void => {
    // RE-ARMING observer: newSession() swaps threads mid-session, so the pairing
    // must be re-upserted whenever the client ATTACHES a new thread, not just
    // once. Unsubscribing after the first capture would leave the map pointing
    // at the discarded thread, and the next resume would re-attach to a thread
    // the session no longer runs on.
    let lastRecorded: string | null = client.threadId;
    const observe = (threadId: string): void => {
      if (threadId === lastRecorded) return;
      lastRecorded = threadId;
      try {
        upsertSession(this.home, String(id), { threadId });
        trace(`thread id recorded for ${String(id)}: ${threadId}`);
      } catch (error) {
        this.runtime.ctx.logger.warn(`codex-provider: failed to persist the Codex thread id for ${String(id)}: ${String(error)}`);
      }
    };
    // App-server line: the thread attaches lazily (first prompt), and
    // `onThreadAttached` fires synchronously when one already exists.
    client.onThreadAttached(observe);
  };
}

/**
 * Durable flush of the session's pre-publication suffix. Constructor seed
 * markers and setup-window events never re-emit through `session/event`, so
 * publication must push them through the handle before live events start
 * routing into it. Advances by what was stored (an event appended during the
 * await stays unstored for the next flush).
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
 * provider through a tracing proxy, which breaks hard-private (`#`) receivers.
 */
async function setupAndPublish(
  loopCtx: Context,
  ownerCtx: Context,
  id: SessionId,
  agentOptions: AgentOptions,
  setup: AgentSetup | undefined,
  session: Session,
  client: CodexAppServerClient,
  parentAgent: Agent | undefined,
  source: "startup" | "resume",
  opts: { enterSession: boolean; preparation?: SessionPreparation },
  stored: StoredSession,
  runtimeInfo: CodexAgentRuntimeInfo,
): Promise<AgentHandle> {
  let detachSession: (() => void) | undefined;
  let detachAgent: (() => void) | undefined;
  let agent: CodexAgent | undefined;
  // Late-bound teardown the agent triggers itself after its idle window
  // expires (see CodexAgent's idle exit) — defined only after publication.
  let idleExit: (() => void) | undefined;
  try {
    // Build the agent shim over the session and the live client.
    agent = new CodexAgent(loopCtx, id, agentOptions, session, client, () => idleExit?.(), runtimeInfo);

    // Seed THIS session's route only when its log has none (2026-10-04).
    //
    // The pin used to run on every create AND resume, which would now stomp a
    // choice the user made in the model selector: `model/selection` IS the
    // session's durable route, so an existing one is the authority and only a
    // session that has never named a route gets the boot default. The append is
    // log-only — the agent resolves it at each turn (`#resolveRoute`).
    try {
      // A narrow local cast for the same reason the append below uses one:
      // `model/selection` is declared by the session-controller package's
      // `SessionEventMap` augmentation, which this adapter deliberately does not
      // depend on. The event name is the contract; its payload is not read here.
      const events = session.snapshotEvents() as readonly { type: string }[];
      const alreadyRouted = events.some((event) => event.type === "model/selection");
      const provider = runtimeInfo?.nativeProviderId?.();
      const model = agentOptions.model;
      if (!alreadyRouted && provider !== undefined && model !== undefined && model !== "") {
        const selection = { provider, model };
        // `model/selection` is contributed to `SessionEventMap` by the upstream
        // session-controller package (declaration merging); this adapter does
        // not depend on it, so the append goes through a narrow local cast.
        (session.append as (type: string, data: unknown) => unknown)("model/selection", selection);
        trace(`session route seeded: ${provider}/${model}`);
      }
    } catch (error) {
      // Fail-soft: the boot-time default-model push remains the fallback.
      trace(`session route seed failed: ${String(error)}`);
    }

    // Session identity (the preset stamp) and the Codex system prompt commit
    // on the first turn via CodexAgent's #bootstrapSessionIdentity /
    // #emitSystemMessage: a freshly created session announces completely
    // blank, so the backend takes zero part in the UI's new-session draft.

    // Composition-only setup on the unpublished agent scope.
    const commit = await setup?.(agent.ctx, agent);

    // Publish: flush the unstored suffix (seed + setup-window events) through
    // the owned handle, then enter both session and agent, announce in order,
    // and signal session-start. The commit runs immediately before
    // publication.
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
      trace(`dispose() called for agent ${id} (source=${source})`);
      unfollowOwner?.();
      await agent?.dispose();
      detachAgent?.();
      detachSession?.();
      // Drain queued appends; a durability failure surfaces to the caller
      // (the owner-unload and idle-exit paths log it).
      await stored.handle.close();
    };
    idleExit = () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`codex-provider: teardown of ${id} failed: ${String(error)}`);
      });
    };

    // Follow the owner: a caller-fiber unload tears this agent down.
    unfollowOwner = ownerCtx.effect(() => () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`codex-provider: owner-unload teardown of ${id} failed: ${String(error)}`);
      });
    }, `codexProvider.lifecycle(${id})`);

    return { agent, dispose };
  } catch (error) {
    // Unwind the half-published transaction. A failure between `enter` and
    // the announcements (e.g. a persistence listener rejecting the session)
    // must not leave a live-but-dead entry the API resolver would serve.
    trace(`setupAndPublish ${id} FAILED: ${String(error)}`);
    detachAgent?.();
    detachSession?.();
    void agent?.dispose().catch(() => { });
    client.close();
    throw error;
  } finally {
    // Release the preparation's per-id reservation on every path (mirrors
    // the reference loop's unconditional dispose): the session it seeded is
    // already published above, so a same-process re-resume of this id can
    // prepare again instead of colliding with a leaked reservation.
    opts.preparation?.[Symbol.dispose]();
  }
}

export default CodexProvider;
