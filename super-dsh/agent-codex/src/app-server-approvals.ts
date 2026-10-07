/**
 * Codex app-server server-request → Dash approval seam (2026-10-03, app-server line).
 *
 * The app-server line is the FIRST Codex line with real human-in-the-loop
 * approvals: the server issues a request and BLOCKS the tool until the client
 * answers (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
 * plus the two legacy `execCommandApproval` / `applyPatchApproval` names kept by
 * the protocol). The old SDK line had no such channel at all — `sendRaw` was a
 * documented no-op and the approval policy was a launch-only preset.
 *
 * The bridge maps each request onto `ctx.approval.request()` (the DSH service
 * whose Web UI answerer renders the ApprovalPanel) and maps the returned
 * {@link ApprovalOutcome} back onto Codex's decision vocabulary.
 *
 * FAIL-CLOSED EVERYWHERE: an absent answerer, a throw, a timeout, or an
 * unserviceable method all answer DECLINE (or the method's own "no" shape). A
 * request must never be left unanswered — the server would wait for it forever.
 *
 * Everything in this module except {@link makeApprovalHandler} is pure, so the
 * mapping is unit-testable without a Context, an Agent, or a process.
 */
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ServerRequestOutcome, WireServerRequest } from "./app-server-wire.js";

/** The two Codex review kinds this bridge understands. */
export type ApprovalKind = "command" | "fileChange";

/** A recognized approval request, normalized across the modern and legacy names. */
export interface ApprovalAsk {
  readonly kind: ApprovalKind;
  /** The Dash-facing tool name (matches the `tool/call` projection). */
  readonly toolName: string;
  /** The originating item/call id, when the request names one. */
  readonly callId?: string;
  /** Human-facing explanation, when the server supplies one. */
  readonly reason?: string;
}

/** The four server-request method names that carry an approval decision. */
export const APPROVAL_METHODS = {
  command: ["item/commandExecution/requestApproval", "execCommandApproval"],
  fileChange: ["item/fileChange/requestApproval", "applyPatchApproval"],
} as const;

/** Default answer timeout: fail closed (decline) after this long. `0` disables. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

/** Parse `CODEX_APPROVAL_TIMEOUT_MS` (invalid/absent → the default). */
export function parseApprovalTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_APPROVAL_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_APPROVAL_TIMEOUT_MS;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Human-facing command text: the modern single string, or the legacy argv array. */
function commandText(raw: unknown): string | undefined {
  const direct = asString(raw);
  if (direct !== undefined) return direct;
  if (Array.isArray(raw)) {
    const parts = raw.filter((part): part is string => typeof part === "string");
    return parts.length === 0 ? undefined : parts.join(" ");
  }
  return undefined;
}

/**
 * Recognize one approval server-request and normalize it; `null` for every
 * other method (the caller answers those with {@link failClosedResponse}).
 */
export function describeApprovalRequest(method: string, params: unknown): ApprovalAsk | null {
  const record = asRecord(params) ?? {};
  const reason = asString(record["reason"]);
  const itemId = asString(record["itemId"]);
  const callId = itemId ?? asString(record["callId"]);
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval": {
      const command = commandText(record["command"]);
      const description = reason ?? command;
      return {
        kind: "command",
        toolName: "command_execution",
        ...(callId === undefined ? {} : { callId }),
        ...(description === undefined ? {} : { reason: description }),
      };
    }
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      return {
        kind: "fileChange",
        toolName: "file_change",
        ...(callId === undefined ? {} : { callId }),
        ...(reason === undefined ? {} : { reason }),
      };
    default:
      return null;
  }
}

/** Whether a DSH approval outcome grants the action (`allowed-once` is the only grant). */
export function isGrant(outcome: ApprovalOutcome): boolean {
  return outcome === "allowed-once";
}

/**
 * Build the wire answer for one approval request from a DSH outcome.
 * Only an explicit one-shot grant approves; everything else declines.
 */
export function approvalResponse(method: string, outcome: ApprovalOutcome): ServerRequestOutcome {
  const granted = isGrant(outcome);
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: granted ? "accept" : "decline" } };
    case "execCommandApproval":
    case "applyPatchApproval":
      // Legacy `ReviewDecision`: a plain `"approved"`, or a structured denial.
      return { result: { decision: granted ? "approved" : { denied: { rejection: `denied by the user (${outcome})` } } } };
    default:
      return failClosedResponse(method);
  }
}

/**
 * The honest "we cannot service this" answer. Structured declines are used
 * where the protocol defines a no-op shape; everything else gets a JSON-RPC
 * method-not-found so the server resolves the pending request immediately
 * instead of waiting forever.
 */
export function failClosedResponse(method: string): ServerRequestOutcome {
  switch (method) {
    case "item/tool/requestUserInput":
      return { result: { answers: {} } };
    case "mcpServer/elicitation/request":
      return { result: { action: "decline", content: null, _meta: null } };
    default:
      return { error: { code: -32601, message: `Super D does not handle the app-server request "${method}"` } };
  }
}

/** The slice of `ctx.approval` this bridge needs (structurally typed). */
export interface ApprovalAnswerer {
  request(request: {
    agent: Agent;
    toolName: string;
    callId?: unknown;
    reason?: string;
    signal: AbortSignal;
  }): Promise<ApprovalOutcome>;
}

export interface ApprovalBridgeDeps {
  /**
   * Resolve the composed approval service LAZILY, per request. The service is
   * provided by a sibling fiber, so a property read at construction time either
   * throws ("cannot get property … without inject") or yields nothing.
   */
  readonly getApproval: () => ApprovalAnswerer | undefined;
  /** The agent on whose behalf the question is asked (audit + UI routing). */
  readonly agent: Agent;
  /** Answer timeout in ms; `0` waits forever. */
  readonly timeoutMs: number;
  /** Build the branded call id the DSH request expects. */
  readonly asCallId?: (raw: string) => unknown;
  readonly trace?: (message: string) => void;
}
/**
 * Race an approval answer against the timeout. On timeout the signal aborts
 * (withdrawing the question from the UI) and we fail closed as `"cancelled"`.
 */
async function raceApproval(request: Promise<ApprovalOutcome>, controller: AbortController, timeoutMs: number): Promise<ApprovalOutcome> {
  if (timeoutMs <= 0) return request;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<ApprovalOutcome>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve("cancelled");
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the transport-level server-request handler. The returned function never
 * throws: every failure path answers fail-closed.
 */
export function makeApprovalHandler(deps: ApprovalBridgeDeps): (request: WireServerRequest) => Promise<ServerRequestOutcome> {
  return async (request: WireServerRequest): Promise<ServerRequestOutcome> => {
    const ask = describeApprovalRequest(request.method, request.params);
    if (ask === null) {
      deps.trace?.(`approval: unsupported server-request ${request.method} → fail-closed answer`);
      return failClosedResponse(request.method);
    }
    const answerer = deps.getApproval();
    if (answerer === undefined) {
      // Fail closed: without an answerer the tool must not run.
      deps.trace?.(`approval: no approval service mounted → decline ${ask.kind}`);
      return approvalResponse(request.method, "unavailable");
    }
    const controller = new AbortController();
    try {
      const outcome = await raceApproval(
        answerer.request({
          agent: deps.agent,
          toolName: ask.toolName,
          ...(ask.callId === undefined || deps.asCallId === undefined ? {} : { callId: deps.asCallId(ask.callId) }),
          ...(ask.reason === undefined ? {} : { reason: ask.reason }),
          signal: controller.signal,
        }),
        controller,
        deps.timeoutMs,
      );
      deps.trace?.(`approval: ${ask.kind} → ${outcome}`);
      return approvalResponse(request.method, outcome);
    } catch (error) {
      // A synchronous throw (no open turn / audit append failure) still denies
      // rather than hanging Codex.
      deps.trace?.(`approval: request failed (${String(error)}) → decline`);
      return approvalResponse(request.method, "unavailable");
    }
  };
}
