/**
 * agy-hub-client.ts — the agy CLI's SECOND live path: `agy --hub`.
 *
 * Why a second transport exists at all: measured 2026-10-03, the *same*
 * `/home/u1/.local/bin/agy` binary (1.2.15, engine banner "Antigravity
 * server 2.19.1") serves the product's own UI and its whole agent API on
 * `--hub-port`, over the Connect service
 * `exa.language_server_pb.LanguageServerService` (237 methods). That is the
 * surface Google's own clients use: the official VS Code extension spawns
 * this exact argv —
 *
 *   AGY_ENABLE_HUB=1 ANTIGRAVITY_VSCODE_HOST=1 ANTIGRAVITY_AUTH_SUCCESS_APP=vscode
 *   agy --hub --hub-port=<p> --app_data_dir=antigravity --csrf_token=<uuid>
 *
 * and loads the SPA in an iframe. The `--input-format=stream-json` path this
 * package already ships stays the documented floor; this file is the richer
 * (and undocumented) ceiling.
 *
 * ── Measured contract, do not "fix" these three ────────────────────────────
 *
 * 1. `items` takes ONLY `[{text}]`. Any other shape is silently dropped —
 *    protojson is configured to discard unknown fields, so `{userMessage:
 *    {text}}` / `{prompt}` / `{cascadeInput:{...}}` all come back HTTP 200
 *    with `{}` and leave a `USER_INPUT` step whose items are `[{}]`. The
 *    failure then surfaces two steps later as a bogus "plan model not
 *    specified", because the message never arrived. Building the item body
 *    anywhere but `userInputItems()` is how that misdiagnosis starts.
 *
 * 2. `plannerConfig.planModel` (enum, e.g. MODEL_GOOGLE_GEMINI_2_5_FLASH) and
 *    `plannerConfig.modelName` (catalog key, e.g. gemini-3.8-flash-medium)
 *    must BOTH be present. Either one alone → "plan model not specified; you
 *    must specify a valid model". `cascadeConfig()` enforces the pair, and
 *    `resolveModel()` derives the enum from the live catalog instead of
 *    hard-coding it (the enum names do not track the display names: the key
 *    `gemini-2.5-flash` maps to enum MODEL_GOOGLE_GEMINI_2_5_FLASH but
 *    displays as "Gemini 3.5 Flash Lite").
 *
 * 3. Non-blocking sends return `{}` unconditionally — success and garbage are
 *    indistinguishable. `blocking: true` is what makes the engine validate,
 *    so it is hard-coded into the turn path with no opt-out.
 *
 * Error shape: Connect returns `{code, message}` with a matching HTTP status
 * (400 invalid_argument, 401 unauthenticated, 404 unknown method as plain
 * text). `rpc()` normalises both into AgyHubError.
 *
 * Risk note (2026-10-03): `--hub` is an UNDOCUMENTED flag. It is absent from
 * `agy --help` and from every other binary in the family (the desktop app's
 * bundled `language_server` REJECTS `--hub` — it is driven with
 * `--https_server_port/--csrf_token/--app_data_dir/...` instead). The product
 * now ships five shapes (2.0 / IDE / CLI / Extensions / SDK) and the CLI's
 * hub face may be folded away. Callers must therefore keep the stream-json
 * transport as a fallback and treat hub availability as probed, not assumed.
 */

const SERVICE = "/exa.language_server_pb.LanguageServerService";

/** Trajectory/source enums that mean "an external program is driving". */
export const AGENT_API_SOURCE = "CORTEX_TRAJECTORY_SOURCE_AGENT_API";
export const CASCADE_TRAJECTORY_TYPE = "TRAJECTORY_TYPE_CASCADE";

export interface AgyHubEndpoint {
  /** Origin only, e.g. `http://127.0.0.1:5395`. */
  baseUrl: string;
  /** `x-codeium-csrf-token`; every RPC but `/healthz` is fenced by it. */
  csrfToken: string;
  instanceId?: string;
  /** Protocol version from the discovery file (all builds report 1.11.0). */
  lsVersion?: string;
}

export class AgyHubError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "AgyHubError";
    this.code = code;
    this.status = status;
  }
}

export function agyHubBaseUrl(port: number, host = "127.0.0.1"): string {
  return `http://${host}:${port}`;
}

/** `file://` URI the engine expects in `workspaceUris`. Absolute paths only. */
export function workspaceUri(path: string): string {
  if (!path.startsWith("/")) {
    throw new AgyHubError("invalid_argument", `workspace path must be absolute: ${path}`);
  }
  return `file://${path}`;
}

/** The ONLY user-input item shape that survives (gotcha 1). */
export interface AgyHubUserInputItem {
  text: string;
}

export function userInputItems(text: string): AgyHubUserInputItem[] {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new AgyHubError("invalid_argument", "user message must not be empty");
  }
  return [{ text: trimmed }];
}

export interface AgyHubPlannerConfig {
  planModel: string;
  modelName: string;
}

export interface AgyHubCascadeConfig {
  plannerConfig: AgyHubPlannerConfig;
}

/** Enforces the mandatory pair (gotcha 2). */
export function cascadeConfig(planModel: string, modelName: string): AgyHubCascadeConfig {
  if (!planModel?.trim() || !modelName?.trim()) {
    throw new AgyHubError(
      "invalid_argument",
      `cascadeConfig needs both planModel (enum) and modelName (catalog key); got planModel=${JSON.stringify(planModel)} modelName=${JSON.stringify(modelName)}`,
    );
  }
  return { plannerConfig: { planModel: planModel.trim(), modelName: modelName.trim() } };
}

export interface AgyHubStartCascadeOptions {
  /** Absolute paths; converted with `workspaceUri()`. */
  workspaces?: string[];
  source?: string;
  trajectoryType?: string;
  cascadeId?: string;
}

export function buildStartCascadeRequest(
  options: AgyHubStartCascadeOptions = {},
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    source: options.source ?? AGENT_API_SOURCE,
    trajectoryType: options.trajectoryType ?? CASCADE_TRAJECTORY_TYPE,
  };
  if (options.cascadeId) request.cascadeId = options.cascadeId;
  const uris = (options.workspaces ?? []).map(workspaceUri);
  if (uris.length > 0) request.workspaceUris = uris;
  return request;
}

export interface AgyHubSendMessageOptions {
  cascadeId: string;
  text: string;
  planModel: string;
  modelName: string;
}

export function buildSendMessageRequest(
  options: AgyHubSendMessageOptions,
): Record<string, unknown> {
  if (!options.cascadeId?.trim()) {
    throw new AgyHubError("invalid_argument", "sendMessage needs a cascadeId");
  }
  return {
    cascadeId: options.cascadeId.trim(),
    items: userInputItems(options.text),
    cascadeConfig: cascadeConfig(options.planModel, options.modelName),
    // gotcha 3: the only mode that validates. Not configurable on purpose.
    blocking: true,
  };
}

export interface AgyHubStep {
  type: string;
  status?: string;
  metadata?: Record<string, unknown>;
  [payload: string]: unknown;
}

const STEP_PAYLOADS = new Set(["type", "status", "metadata", "internalMetadata"]);

/** Payload key of a step, e.g. "plannerResponse" — undefined when empty. */
export function stepKind(step: AgyHubStep): string | undefined {
  return Object.keys(step).find((key) => !STEP_PAYLOADS.has(key));
}

/** Last assistant text in the trajectory, if the turn produced one. */
export function assistantText(steps: readonly AgyHubStep[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (stepKind(step) !== "plannerResponse") continue;
    const payload = step.plannerResponse as Record<string, unknown> | undefined;
    const text = payload?.modifiedResponse ?? payload?.response ?? payload?.text;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return undefined;
}

/** Engine-side failure text — this is where a bad payload finally shows up. */
export function errorText(steps: readonly AgyHubStep[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const payload = steps[i].errorMessage as Record<string, unknown> | undefined;
    const error = payload?.error as Record<string, unknown> | undefined;
    const text = error?.modelErrorMessage ?? error?.shortError ?? error?.userErrorMessage;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return undefined;
}

export interface AgyHubModel {
  /** Catalog key — this is what `modelName` wants. */
  name: string;
  /** Enum — this is what `planModel` wants. */
  planModel: string;
  displayName?: string;
  apiProvider?: string;
  remainingFraction?: number;
}

interface RawModelEntry {
  displayName?: string;
  model?: string;
  apiProvider?: string;
  quotaInfo?: { remainingFraction?: number };
}

export function parseAvailableModels(payload: unknown): AgyHubModel[] {
  const models = (payload as { response?: { models?: Record<string, RawModelEntry> } })?.response
    ?.models;
  if (!models || typeof models !== "object") {
    throw new AgyHubError("unknown", "GetAvailableModels returned no response.models map");
  }
  return Object.entries(models)
    .map(([name, entry]) => ({
      name,
      planModel: entry?.model ?? "",
      displayName: entry?.displayName,
      apiProvider: entry?.apiProvider,
      remainingFraction: entry?.quotaInfo?.remainingFraction,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveModel(models: readonly AgyHubModel[], name: string): AgyHubModel {
  const wanted = name.trim();
  const found = models.find((model) => model.name === wanted);
  if (!found) {
    const available = models.map((model) => model.name).join(", ");
    throw new AgyHubError(
      "invalid_argument",
      `unknown model ${JSON.stringify(name)}; the live catalog offers: ${available}`,
    );
  }
  if (!found.planModel) {
    throw new AgyHubError(
      "unknown",
      `catalog entry ${JSON.stringify(wanted)} carries no planModel enum — the engine cannot be given it`,
    );
  }
  return found;
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface AgyHubTurnResult {
  cascadeId: string;
  text?: string;
  error?: string;
  steps: AgyHubStep[];
}

export class AgyHubClient {
  constructor(
    private readonly endpoint: AgyHubEndpoint,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) { }

  private url(method: string): string {
    return `${this.endpoint.baseUrl.replace(/\/+$/, "")}${SERVICE}/${method}`;
  }

  /** Unauthenticated liveness probe; also carries the instance id. */
  async healthz(): Promise<{ instanceId: string; status: string }> {
    const response = await this.fetchImpl(`${this.endpoint.baseUrl.replace(/\/+$/, "")}/healthz`);
    const body = await response.text();
    if (!response.ok) {
      throw new AgyHubError("unavailable", `hub healthz failed: ${body}`, response.status);
    }
    return JSON.parse(body) as { instanceId: string; status: string };
  }

  async rpc<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await this.fetchImpl(this.url(method), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codeium-csrf-token": this.endpoint.csrfToken,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // 404 = unknown method, served as plain text by the Connect mux.
      throw new AgyHubError("unimplemented", `${method}: ${text.slice(0, 200)}`, response.status);
    }
    const failure = parsed as { code?: string; message?: string };
    if (failure?.code && failure?.message) {
      throw new AgyHubError(failure.code, failure.message, response.status);
    }
    if (!response.ok) {
      throw new AgyHubError("unknown", `${method} failed with HTTP ${response.status}`, response.status);
    }
    return parsed as T;
  }

  async getAvailableModels(): Promise<AgyHubModel[]> {
    return parseAvailableModels(await this.rpc<unknown>("GetAvailableModels"));
  }

  /** Creates the conversation container; returns its cascadeId. */
  async startCascade(options: AgyHubStartCascadeOptions = {}): Promise<string> {
    const result = await this.rpc<{ cascadeId?: string }>(
      "StartCascade",
      buildStartCascadeRequest(options),
    );
    if (!result?.cascadeId) {
      throw new AgyHubError("unknown", "StartCascade returned no cascadeId");
    }
    return result.cascadeId;
  }

  /**
   * Sends one user turn and blocks until the engine finishes it. Set the
   * plan model from the live catalog — see `resolveModel()`.
   */
  async sendUserMessage(options: AgyHubSendMessageOptions): Promise<void> {
    await this.rpc("SendUserCascadeMessage", buildSendMessageRequest(options));
  }

  async getSteps(cascadeId: string): Promise<AgyHubStep[]> {
    const result = await this.rpc<{ steps?: AgyHubStep[] }>("GetCascadeTrajectorySteps", {
      cascadeId,
    });
    return result?.steps ?? [];
  }

  /** start → send (blocking) → read. The shape a session needs. */
  async runTurn(
    options: Omit<AgyHubSendMessageOptions, "cascadeId"> & AgyHubStartCascadeOptions,
  ): Promise<AgyHubTurnResult> {
    const cascadeId =
      options.cascadeId ?? (await this.startCascade({ workspaces: options.workspaces }));
    await this.sendUserMessage({
      cascadeId,
      text: options.text,
      planModel: options.planModel,
      modelName: options.modelName,
    });
    const steps = await this.getSteps(cascadeId);
    return { cascadeId, steps, text: assistantText(steps), error: errorText(steps) };
  }
}
