/**
 * Narrow hand-written types for the codex `app-server` JSONL JSON-RPC wire.
 *
 * DERIVED FROM: the `codex app-server generate-ts --out <dir>` output for the
 * `@openai/codex` version this package pins (0.154.0). That tree is ~617 files;
 * this module is a hand-written, deliberately narrow subset covering exactly
 * the envelopes, requests, notifications and item shapes
 * `src/app-server-client.ts` and `src/app-server-events.ts` consume. Each
 * declaration names the generated file it was transcribed from; where a shape
 * was simplified, the comment says so. Nothing is imported from `@openai/*`.
 *
 * ADVISORY: the app-server wire is EXPERIMENTAL. It is versioned by the CLI
 * release, not by a compatibility promise, so a newer (or older) app-server may
 * add, rename or drop fields without notice. These types describe what the
 * pinned version emits. `InitializeCapabilities`, `Thread` and the JSON-RPC
 * envelopes therefore stay superset-friendly (index signatures / optional
 * members) so extra fields survive a decode untouched.
 *
 * FAIL-SOFT: callers MUST treat this wire as untrusted input. At runtime every
 * field may be missing, null, or of the wrong type; narrow locally (see
 * `src/app-server-events.ts`) instead of trusting a cast, and never let a
 * malformed frame escape as an exception.
 *
 * The only runtime values in this module are the two JSON-RPC type guards and
 * the `SERVER_REQUEST_METHODS` / `SERVER_NOTIFICATION_METHODS` method-name
 * constant objects. Everything else is types only.
 */

/* -------------------------------------------------------------------------- */
/* JSON-RPC envelopes (JSONL framing; app-server root `RequestId.ts`)          */
/* -------------------------------------------------------------------------- */

/** JSON-RPC request/response correlation id (generated root `RequestId`). */
export type JsonRpcId = string | number;

/** JSON-RPC error object carried by a failure response. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A request or notification sent by the client (`id` present when a reply is expected). */
export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

/** A notification sent by either side (no `id`, never answered). */
export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

/** A successful response to a client request. */
export interface JsonRpcSuccess {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result: unknown;
}

/** A failed response to a client request. */
export interface JsonRpcFailure {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  error: JsonRpcError;
}

/** Any decoded JSONL frame — a union suitable for parsing inbound input. */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

/**
 * True when the frame is a RESPONSE to a request we sent (`id` plus `result`
 * or `error`). Accepts `unknown` because callers hold freshly parsed JSON.
 */
export function isJsonRpcResponse(message: unknown): message is JsonRpcSuccess | JsonRpcFailure {
  if (message === null || typeof message !== "object") return false;
  const record = message as { id?: unknown; result?: unknown; error?: unknown };
  if (typeof record.id !== "string" && typeof record.id !== "number") return false;
  return "result" in record || (typeof record.error === "object" && record.error !== null);
}

/**
 * True when the frame is a REQUEST that expects a reply from us — the shape of
 * the server's approval requests (`item/commandExecution/requestApproval`,
 * `item/fileChange/requestApproval`, the legacy `execCommandApproval` /
 * `applyPatchApproval`). Accepts `unknown`.
 */
export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  if (message === null || typeof message !== "object") return false;
  const record = message as { id?: unknown; method?: unknown };
  return (typeof record.id === "string" || typeof record.id === "number") && typeof record.method === "string";
}

/* -------------------------------------------------------------------------- */
/* initialize (generated root `InitializeParams.ts`, `InitializeResponse.ts`)  */
/* -------------------------------------------------------------------------- */

/** Generated root `ClientInfo.ts`. */
export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

/**
 * Client-declared capabilities negotiated during initialize (generated root
 * `InitializeCapabilities.ts`). Superset-friendly: unknown capability flags from
 * a newer app-server pass the index signature through untouched.
 */
export interface InitializeCapabilities {
  /** Opt into receiving experimental API methods and fields. */
  experimentalApi: boolean;
  /** Opt into `attestation/generate` requests for upstream `x-oai-attestation`. */
  requestAttestation: boolean;
  /** Legacy opt-in for the `openai/form` MCP extension. */
  mcpServerOpenaiFormElicitation?: boolean;
  /** Exact notification method names to suppress for this connection. */
  optOutNotificationMethods?: string[] | null;
  /** MCP extension settings declared by the app-server client. */
  extensions?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** Generated root `InitializeParams.ts` (`capabilities` is nullable on the wire). */
export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

/** Generated root `InitializeResponse.ts` (`codexHome` is an absolute path string). */
export interface InitializeResponse {
  userAgent: string;
  /** Absolute path to the server's `$CODEX_HOME` directory. */
  codexHome: string;
  /** Platform family of the running app-server target, e.g. `"unix"`. */
  platformFamily: string;
  /** Operating system of the running app-server target, e.g. `"linux"`. */
  platformOs: string;
}

/* -------------------------------------------------------------------------- */
/* Shared enums (v2 `AskForApproval`, `SandboxMode`, `SandboxPolicy`, ...)     */
/* -------------------------------------------------------------------------- */

/** Generated v2 `AskForApproval.ts`. */
export type AskForApproval =
  | "untrusted"
  | "on-request"
  | { granular: GranularApprovalConfig }
  | "never";

/** Generated v2 `AskForApproval.ts` granular variant. */
export interface GranularApprovalConfig {
  sandbox_approval: boolean;
  rules: boolean;
  skill_approval: boolean;
  request_permissions: boolean;
  mcp_elicitations: boolean;
  [key: string]: unknown;
}

/** Generated v2 `SandboxMode.ts`. */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** Generated v2 `NetworkAccess.ts`. */
export type NetworkAccess = "restricted" | "enabled";

/** Generated v2 `SandboxPolicy.ts` (`writableRoots` are absolute path strings). */
export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "externalSandbox"; networkAccess: NetworkAccess }
  | {
    type: "workspaceWrite";
    writableRoots: string[];
    networkAccess: boolean;
    excludeTmpdirEnvVar: boolean;
    excludeSlashTmp: boolean;
  };

/** Generated v2 `ApprovalsReviewer.ts`. */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

/** Generated root `Personality.ts`. */
export type Personality = "none" | "friendly" | "pragmatic";

/** Generated root `ReasoningEffort.ts` (an open string, not a closed union). */
export type ReasoningEffort = string;

/** Generated root `ReasoningSummary.ts`. */
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

/** Generated v2 `MessagePhase.ts`. */
export type MessagePhase = "commentary" | "final_answer";

/* -------------------------------------------------------------------------- */
/* thread/start + thread/resume (generated v2 `Thread*Params.ts`)              */
/* -------------------------------------------------------------------------- */

/**
 * Generated v2 `ThreadStartParams.ts`. Optional members mirror the generated
 * optional/nullable fields; `config` is narrowed to a plain JSON object and the
 * enum-typed fields keep their real unions.
 */
export interface ThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: Personality | null;
  ephemeral?: boolean | null;
  sessionStartSource?: string | null;
  threadSource?: string | null;
}

/**
 * Generated v2 `ThreadResumeParams.ts` — `threadId` is required; the override
 * block matches `ThreadStartParams` (see that type for the narrowing notes).
 */
export interface ThreadResumeParams {
  threadId: string;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: Personality | null;
  excludeTurns?: boolean | null;
}

/**
 * Narrowed projection of the generated v2 `Thread.ts`: only the fields the
 * client and the roster/model-sync paths read are declared, and the index
 * signature keeps the rest of the (large) server payload reachable without a
 * second decode. `turns` is empty except on resume/read responses.
 */
export interface Thread {
  id: string;
  sessionId?: string;
  preview?: string;
  ephemeral?: boolean;
  modelProvider?: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  createdAt?: number;
  updatedAt?: number;
  status?: ThreadStatus;
  path?: string | null;
  cwd?: string;
  cliVersion?: string;
  name?: string | null;
  turns?: Turn[];
  [key: string]: unknown;
}

/** Generated v2 `ThreadStatus.ts` (`activeFlags` narrowed to strings). */
export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: string[] };

/** Generated v2 `ThreadStartResponse.ts` — only the fields this package uses. */
export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: AskForApproval;
  sandbox: SandboxPolicy;
}

/** Generated v2 `ThreadResumeResponse.ts` — only the fields this package uses. */
export interface ThreadResumeResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: AskForApproval;
  sandbox: SandboxPolicy;
  turnsBackwardsCursor?: string | null;
  itemsBackwardsCursor?: string | null;
}

/* -------------------------------------------------------------------------- */
/* turn/start, turn/steer, turn/interrupt (generated v2 `Turn*`)               */
/* -------------------------------------------------------------------------- */

/** Generated v2 `TurnStatus.ts`. */
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

/**
 * Narrowed projection of the generated v2 `TurnError.ts`; `codexErrorInfo` and
 * `misalignment` stay opaque JSON (the client classifies on `message`).
 */
export interface TurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
  misalignment?: unknown;
}

/** Generated v2 `Turn.ts` — `items`/`itemsView` omitted (paginated surface). */
export interface Turn {
  id: string;
  status: TurnStatus;
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  items?: ThreadItem[];
  [key: string]: unknown;
}

/**
 * Generated v2 `UserInput.ts` (full union; image/audio/skill/mention variants
 * are carried through but not bridged by this adapter).
 */
export type UserInput =
  | { type: "text"; text: string; text_elements: TextElement[] }
  | { type: "image"; detail?: string; url: string }
  | { type: "localImage"; detail?: string; path: string }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

/** Generated v2 `TextElement.ts` (`byteRange` narrowed to its start/end pair). */
export interface TextElement {
  byteRange: { start: number; end: number };
  placeholder: string | null;
}

/** Generated v2 `TurnStartParams.ts` (optional/nullable fields kept verbatim). */
export interface TurnStartParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  turnTrigger?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  sandboxPolicy?: SandboxPolicy | null;
  model?: string | null;
  serviceTier?: string | null;
  serviceTierForTurn?: string | null;
  effort?: ReasoningEffort | null;
  summary?: ReasoningSummary | null;
  personality?: Personality | null;
  outputSchema?: unknown;
}

/** Generated v2 `TurnStartResponse.ts`. */
export interface TurnStartResponse {
  turn: Turn;
}

/** Generated v2 `TurnSteerParams.ts`. */
export interface TurnSteerParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  /** Required active-turn precondition; the request fails when it does not match. */
  expectedTurnId: string;
}

/** Generated v2 `TurnInterruptParams.ts`. */
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

/** Generated v2 `TurnInterruptResponse.ts` (`Record<string, never>`). */
export type TurnInterruptResponse = Record<string, never>;

/* -------------------------------------------------------------------------- */
/* Token usage (generated v2 `TokenUsageBreakdown`, `ThreadTokenUsage`)        */
/* -------------------------------------------------------------------------- */

/** Generated v2 `TokenUsageBreakdown.ts`. */
export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/** Generated v2 `ThreadTokenUsage.ts`. */
export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

/** Generated v2 `ThreadTokenUsageUpdatedNotification.ts`. */
export interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: ThreadTokenUsage;
}

/* -------------------------------------------------------------------------- */
/* model/list (generated v2 `ModelListParams`, `ModelListResponse`, `Model`)   */
/* -------------------------------------------------------------------------- */

/** Generated v2 `ModelListParams.ts`. */
export interface ModelListParams {
  cursor?: string | null;
  limit?: number | null;
  includeHidden?: boolean | null;
}

/**
 * Narrowed projection of the generated v2 `Model.ts` — only the catalog fields
 * this adapter reads. Every other generated field (upgrade info, service tiers,
 * modalities, ...) is intentionally dropped; the entries are advisory picker
 * data, so unknown shapes must be handled fail-soft by the reader.
 */
export interface ModelListEntry {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  defaultReasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: ReasoningEffort; description?: string;[key: string]: unknown }>;
  [key: string]: unknown;
}

/** Generated v2 `ModelListResponse.ts`. */
export interface ModelListResponse {
  data: ModelListEntry[];
  nextCursor: string | null;
}

/* -------------------------------------------------------------------------- */
/* Thread items (generated v2 `ThreadItem.ts` + its member types)              */
/* -------------------------------------------------------------------------- */

/** Generated v2 `FunctionCallOutputBody.ts` (content items kept opaque). */
export type FunctionCallOutputBody = string | Array<Record<string, unknown>>;

/** Generated root `WebSearchItem.ts`, narrowed (`action`/`results` stay opaque). */
export interface WebSearchItem {
  id: string;
  query: string;
  action?: unknown;
  results?: unknown[] | null;
}

/** Generated root `SleepItem.ts`, narrowed. */
export interface SleepItem {
  id: string;
  durationMs: number;
}

/** Generated root `ImageGenerationItem.ts`, narrowed (`failure` stays opaque). */
export interface ImageGenerationItem {
  id: string;
  status: string;
  revisedPrompt: string | null;
  result: string;
  transparentBackground?: boolean;
  failure?: unknown;
  savedPath?: string;
}

/** Generated v2 `HookPromptFragment.ts`, narrowed. */
export interface HookPromptFragment {
  text: string;
  hookRunId: string;
}

/** Generated v2 `PatchChangeKind.ts` — `kind` is a tagged union, not a string. */
export type PatchChangeKind =
  | { type: "add" }
  | { type: "delete" }
  | { type: "update"; move_path: string | null };

/** Generated v2 `FileUpdateChange.ts`. */
export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind | string;
  diff: string;
}

/** Generated v2 `CommandExecutionStatus.ts`. */
export type CommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined";

/** Generated v2 `CommandExecutionSource.ts`. */
export type CommandExecutionSource = "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction";

/** Generated v2 `PatchApplyStatus.ts` (the `fileChange` item's status). */
export type PatchApplyStatus = "inProgress" | "completed" | "failed" | "declined";

/** Generated v2 `McpToolCallStatus.ts`. */
export type McpToolCallStatus = "inProgress" | "completed" | "failed";

/** Generated v2 `McpToolCallResult.ts` (`content` entries are opaque JSON). */
export interface McpToolCallResult {
  content: unknown[];
  structuredContent?: unknown;
  _meta?: unknown;
}

/** Generated v2 `McpToolCallError.ts`. */
export interface McpToolCallError {
  message: string;
}

/** Generated v2 `DynamicToolCallStatus.ts`. */
export type DynamicToolCallStatus = "inProgress" | "completed" | "failed";

/** Generated v2 `DynamicToolCallOutputContentItem.ts`. */
export type DynamicToolCallOutputContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string }
  | { type: "inputAudio"; audioUrl: string };

/** Generated v2 `CollabAgentTool.ts`. */
export type CollabAgentTool =
  | "spawnAgent"
  | "sendInput"
  | "resumeAgent"
  | "wait"
  | "closeAgent"
  | "sendMessage"
  | "followupTask"
  | "interruptAgent"
  | "listAgents";

/** Generated v2 `CollabAgentToolCallStatus.ts`. */
export type CollabAgentToolCallStatus = "inProgress" | "completed" | "failed" | "interrupted";

/** Generated v2 `SubAgentActivityKind.ts`. */
export type SubAgentActivityKind = "started" | "interacted" | "interrupted" | "completed";

/**
 * The generated v2 `ThreadItem.ts` union. All members and their discriminant
 * `type` strings are kept exactly; sub-objects this package does not consume are
 * narrowed projections (each names its generated source above). Every member
 * keeps `id`, and the fields the projector reads are preserved: `agentMessage.text`,
 * `reasoning.summary`/`content`, `commandExecution.command|cwd|status|aggregatedOutput|exitCode|durationMs`,
 * `fileChange.changes|status`, `mcpToolCall.server|tool|status|arguments|result|error`,
 * `dynamicToolCall.tool|namespace|status|arguments|contentItems|success`,
 * `webSearch.*`, `plan.text`, `userMessage.content`.
 */
export type ThreadItem =
  | { type: "userMessage"; id: string; clientId: string | null; content: UserInput[] }
  | { type: "hookPrompt"; id: string; fragments: HookPromptFragment[] }
  | {
    type: "agentMessage";
    id: string;
    text: string;
    phase: MessagePhase | null;
    /** Narrowed: the generated `MemoryCitation` is not consumed here. */
    memoryCitation?: unknown;
    /** Narrowed: the generated `AgentMessageDelivery` is not consumed here. */
    delivery?: unknown;
    /** Narrowed: the generated `AsyncUserInputQuestion` is not consumed here. */
    questions?: unknown[] | null;
  }
  | { type: "functionCallOutput"; id: string; name: string; namespace: string | null; output: FunctionCallOutputBody }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
    type: "commandExecution";
    id: string;
    /** Narrowed: the generated `CommandAction[]` is not consumed here. */
    commandActions?: unknown[];
    command: string;
    cwd: string;
    processId?: string | null;
    source?: CommandExecutionSource;
    status: CommandExecutionStatus;
    aggregatedOutput: string | null;
    exitCode: number | null;
    durationMs: number | null;
    [key: string]: unknown;
  }
  | { type: "fileChange"; id: string; changes: FileUpdateChange[]; status: PatchApplyStatus }
  | {
    type: "mcpToolCall";
    id: string;
    server: string;
    tool: string;
    status: McpToolCallStatus;
    arguments: unknown;
    result: McpToolCallResult | null;
    error: McpToolCallError | null;
    durationMs?: number | null;
    [key: string]: unknown;
  }
  | {
    type: "dynamicToolCall";
    id: string;
    namespace: string | null;
    tool: string;
    arguments: unknown;
    status: DynamicToolCallStatus;
    contentItems: DynamicToolCallOutputContentItem[] | null;
    success: boolean | null;
    durationMs?: number | null;
  }
  | {
    type: "collabAgentToolCall";
    id: string;
    tool: CollabAgentTool | string;
    status: CollabAgentToolCallStatus | string;
    senderThreadId: string;
    receiverThreadIds: string[];
    prompt: string | null;
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    /** Narrowed: the generated `CollabAgentState` map is not consumed here. */
    agentsStates: Record<string, unknown>;
  }
  | { type: "subAgentActivity"; id: string; kind: SubAgentActivityKind; agentThreadId: string; agentPath: string }
  | ({ type: "webSearch" } & WebSearchItem)
  | { type: "imageView"; id: string; path: string }
  | ({ type: "sleep" } & SleepItem)
  | ({ type: "imageGeneration" } & ImageGenerationItem)
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string };

/* -------------------------------------------------------------------------- */
/* Notification params (generated v2 `*Notification.ts`)                       */
/* -------------------------------------------------------------------------- */

/** Generated v2 `ThreadStartedNotification.ts`. */
export interface ThreadStartedNotification {
  thread: Thread;
}

/** Generated v2 `TurnStartedNotification.ts`. */
export interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
}

/** Generated v2 `TurnCompletedNotification.ts`. */
export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

/** Generated v2 `ItemStartedNotification.ts`. */
export interface ItemStartedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
  startedAtMs: number;
}

/** Generated v2 `ItemCompletedNotification.ts`. */
export interface ItemCompletedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
  completedAtMs: number;
}

/** Generated v2 `AgentMessageDeltaNotification.ts`. */
export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

/** Generated v2 `ReasoningTextDeltaNotification.ts`. */
export interface ReasoningTextDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
  contentIndex: number;
}

/** Generated v2 `ReasoningSummaryTextDeltaNotification.ts`. */
export interface ReasoningSummaryTextDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
  summaryIndex: number;
}

/** Generated v2 `ReasoningSummaryPartAddedNotification.ts` (no `delta` field). */
export interface ReasoningSummaryPartAddedNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  summaryIndex: number;
}

/** Generated v2 `TurnPlanStepStatus.ts`. */
export type TurnPlanStepStatus = "pending" | "inProgress" | "completed";

/** Generated v2 `TurnPlanStep.ts`. */
export interface TurnPlanStep {
  step: string;
  status: TurnPlanStepStatus;
}

/** Generated v2 `TurnPlanUpdatedNotification.ts`. */
export interface TurnPlanUpdatedNotification {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: TurnPlanStep[];
}

/** Generated v2 `ErrorNotification.ts`. */
export interface ErrorNotification {
  error: TurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

/** Generated v2 `ThreadStatusChangedNotification.ts`. */
export interface ThreadStatusChangedNotification {
  threadId: string;
  status: ThreadStatus;
}

/* -------------------------------------------------------------------------- */
/* Approval server requests (generated v2 + legacy root)                       */
/* -------------------------------------------------------------------------- */

/** Generated v2 `CommandExecutionApprovalDecision.ts`. */
export type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: unknown } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: unknown } }
  | "decline"
  | "cancel";

/**
 * Narrowed projection of the generated v2
 * `CommandExecutionRequestApprovalParams.ts`: the routing identity plus the
 * display fields the approval bridge reads (`command`/`cwd`/`reason`). Every
 * other generated field (legal command actions, execpolicy/network amendment
 * proposals, approval id, ...) is optional and passes through unread.
 */
export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs?: number;
  approvalId?: string | null;
  kind?: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  environmentId?: string | null;
  [key: string]: unknown;
}

/** Generated v2 `CommandExecutionRequestApprovalResponse.ts`. */
export interface CommandExecutionRequestApprovalResponse {
  decision: CommandExecutionApprovalDecision;
}

/** Generated v2 `FileChangeApprovalDecision.ts`. */
export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

/**
 * Narrowed projection of the generated v2
 * `FileChangeRequestApprovalParams.ts` (identity + `reason`/`grantRoot`).
 */
export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs?: number;
  reason?: string | null;
  grantRoot?: string | null;
  [key: string]: unknown;
}

/** Generated v2 `FileChangeRequestApprovalResponse.ts`. */
export interface FileChangeRequestApprovalResponse {
  decision: FileChangeApprovalDecision;
}

/**
 * Generated legacy root `ReviewDecision.ts` — the decision union of the LEGACY
 * approval requests (`execCommandApproval` / `applyPatchApproval`) that older
 * app-server builds and the CLI TUI still use.
 */
export type ReviewDecision =
  | "approved"
  | { approved_execpolicy_amendment: { proposed_execpolicy_amendment: unknown } }
  | "approved_for_session"
  | "approved_mcp_policy_amendment"
  | { network_policy_amendment: { network_policy_amendment: unknown } }
  | { denied: { rejection: string } }
  | "timed_out"
  | "abort";

/** Generated root `ExecCommandApprovalParams.ts`, narrowed to the fields we bridge. */
export interface ExecCommandApprovalParams {
  conversationId: string;
  callId: string;
  approvalId?: string | null;
  command: string[];
  cwd: string;
  reason?: string | null;
  [key: string]: unknown;
}

/** Generated root `ExecCommandApprovalResponse.ts`. */
export interface ExecCommandApprovalResponse {
  decision: ReviewDecision;
}

/** Generated root `ApplyPatchApprovalParams.ts`, narrowed to the fields we bridge. */
export interface ApplyPatchApprovalParams {
  conversationId: string;
  callId: string;
  fileChanges: Record<string, unknown>;
  reason?: string | null;
  grantRoot?: string | null;
  [key: string]: unknown;
}

/** Generated root `ApplyPatchApprovalResponse.ts`. */
export interface ApplyPatchApprovalResponse {
  decision: ReviewDecision;
}

/* -------------------------------------------------------------------------- */
/* Method names (generated root `ClientRequest.ts` / `ClientNotification.ts` / */
/* `ServerRequest.ts` / `ServerNotification.ts`)                               */
/* -------------------------------------------------------------------------- */

/**
 * Exact method strings the client sends (requests plus the `initialized`
 * notification) and the server sends back as REQUESTS. `initialized` is a
 * notification (generated root `ClientNotification.ts`), listed here because it
 * belongs to the same handshake sequence.
 */
export const SERVER_REQUEST_METHODS = {
  initialize: "initialize",
  initialized: "initialized",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  turnInterrupt: "turn/interrupt",
  modelList: "model/list",
  commandExecutionRequestApproval: "item/commandExecution/requestApproval",
  fileChangeRequestApproval: "item/fileChange/requestApproval",
  execCommandApproval: "execCommandApproval",
  applyPatchApproval: "applyPatchApproval",
} as const;

/** Union of the client/server request method strings above. */
export type ServerRequestMethod = (typeof SERVER_REQUEST_METHODS)[keyof typeof SERVER_REQUEST_METHODS];

/**
 * Exact method strings of the SERVER NOTIFICATIONS this adapter maps (see the
 * projection table in `src/app-server-events.ts`). The remaining generated
 * notifications are ignorable by design.
 */
export const SERVER_NOTIFICATION_METHODS = {
  threadStarted: "thread/started",
  threadStatusChanged: "thread/status/changed",
  threadTokenUsageUpdated: "thread/tokenUsage/updated",
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  turnPlanUpdated: "turn/plan/updated",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  agentMessageDelta: "item/agentMessage/delta",
  reasoningTextDelta: "item/reasoning/textDelta",
  reasoningSummaryTextDelta: "item/reasoning/summaryTextDelta",
  reasoningSummaryPartAdded: "item/reasoning/summaryPartAdded",
  error: "error",
} as const;

/** Union of the mapped server notification method strings above. */
export type ServerNotificationMethod = (typeof SERVER_NOTIFICATION_METHODS)[keyof typeof SERVER_NOTIFICATION_METHODS];
