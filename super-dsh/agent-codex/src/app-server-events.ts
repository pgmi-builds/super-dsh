/**
 * Codex app-server notification → DSH wire vocabulary projection.
 *
 * The wire vocabulary is ported from `src/codex-events.ts` (the retired
 * `@openai/codex-sdk` projector) and kept NAMES- AND SHAPES-IDENTICAL, because
 * `src/agent.ts` consumes these events through the same switch it consumed on
 * the SDK line — the event `type` STRINGS stay verbatim (`turn_start` /
 * `message_start` / `message_update` / `message_end` / `tool_execution_start` /
 * `tool_execution_end` / `todo_write` / `turn_end` / `text_delta` /
 * `thinking_delta`).
 *
 * Projection mapping (as implemented; `agent_end` is NOT produced here — the
 * client emits it when a run stream settles, mirroring the SDK sidecar):
 *
 *   turn/started                          → turn_start
 *   item/started  userMessage             → message_start (user, text inputs)
 *   item/completed userMessage            → null (the agent already appended or
 *                                            bridged the user message)
 *   item/started  agentMessage            → message_start (assistant, [])
 *                                            + message_update(text_delta) when
 *                                            the start already carries text
 *   item/agentMessage/delta               → message_update(text_delta)
 *   item/completed agentMessage           → message_end (assistant, [text])
 *   item/started  reasoning               → message_start (assistant, [thinking])
 *   item/reasoning/{textDelta,summaryTextDelta,summaryPartAdded}
 *                                         → message_update(thinking_delta)
 *   item/completed reasoning              → message_end (assistant, [thinking])
 *   item/started  commandExecution | fileChange | mcpToolCall |
 *                 dynamicToolCall | webSearch | plan
 *                                         → tool_execution_start
 *   item/completed (same set)             → tool_execution_end (+ the start
 *                                            first when the matching
 *                                            item/started never fired)
 *   item/completed plan                   → ALSO todo_write after the tool pair
 *   turn/plan/updated                     → tool_execution_start(update_plan)
 *                                            + todo_write (no end event)
 *   turn/completed                        → turn_end, data = { turn }
 *   thread/*, error, anything unrecognized or malformed → null
 *                                            (usage is the CLIENT's job: it
 *                                            records `error` and synthesizes
 *                                            the terminal assistant error, and
 *                                            it converts token usage)
 *
 * DESIGN CHOICE — thinking deltas: the SDK projector folded reasoning updates
 * to `null` because the SDK only ever sent full-text snapshots. The app-server
 * sends honest incremental deltas, and `agent.ts`'s `#handleUpdate` ignores
 * unknown `assistantMessageEvent.type` values, so emitting `thinking_delta`
 * frames is strictly more informative and stays wire-compatible. `delta` is
 * OMITTED when the notification carries no string delta (e.g.
 * `summaryPartAdded`): the vocabulary types the field as `delta?: string`, so a
 * literal `null` would not type-check, and an absent key is equivalent for the
 * consumer (`typeof delta.delta === "string"`). See `streamDelta` below.
 *
 * DESIGN CHOICE — tool item dedup: the app-server emits `item/started` when a
 * tool call is dispatched and `item/completed` when it settles, but minimal or
 * replayed chains can skip the start. A started-items watermark makes the start
 * fire exactly once per item id: completed-after-started → end only;
 * completed-without-started → full start+end pair. `agent.ts` appends one
 * tool/call per start and one tool/result per end, so this keeps the DSH
 * transcript free of duplicates.
 *
 * DESIGN CHOICE — no text watermark: unlike the SDK, whose `item.updated`
 * snapshotted the FULL agent-message text (forcing the SDK projector to diff
 * against a watermark), the app-server delivers explicit
 * `item/agentMessage/delta` frames. A watermark would therefore be dead weight,
 * so only `startedTools` is tracked.
 *
 * Never throws: any internal failure collapses to `null` (fail-soft), and the
 * local helpers are equally defensive about malformed item shapes.
 */
import { SERVER_NOTIFICATION_METHODS } from "./app-server-protocol.js";

/** One wire event record streamed to client listeners (omp RpcEvent shape). */
export interface WireEvent {
  type: string;
  [key: string]: unknown;
}

/** One content block inside a wire message — text | thinking | toolCall (omp OmpContentBlock shape). */
export interface WireContentBlock {
  type: string;
  [key: string]: unknown;
}

/** A wire message (user | assistant | toolResult) (omp OmpMessage shape). */
export interface WireMessage {
  role: "user" | "assistant" | "toolResult";
  content?: WireContentBlock[];
  [key: string]: unknown;
}

/** The assistantMessageEvent delta carried by a message_update event (omp OmpAssistantMessageEvent shape). */
export interface WireAssistantMessageEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: unknown;
  toolCall?: unknown;
}

/** Items whose tool_execution_start already fired (item id → true). */
const startedTools = new Set<string>();

/** Reset the projection watermarks (test / new-session hygiene). */
export function resetProjectionState(): void {
  startedTools.clear();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * One `message_update` frame carrying an assistantMessageEvent delta. `delta`
 * is set only when it is a string (see the header note on `thinking_delta`).
 */
function streamDelta(type: "text_delta" | "thinking_delta", delta: unknown): WireEvent {
  const assistantMessageEvent: WireAssistantMessageEvent = { type, contentIndex: 0 };
  if (typeof delta === "string") assistantMessageEvent.delta = delta;
  return { type: "message_update", assistantMessageEvent };
}

/** Render a `PatchChangeKind` (tagged union) as a display string, defensively. */
function changeKindLabel(kind: unknown): string {
  if (typeof kind === "string") return kind;
  const record = asRecord(kind);
  return record === null ? "" : asText(record.type);
}

/** All text inputs of a userMessage item, one block each (non-text inputs are dropped, as convertContent does). */
function userTextBlocks(content: unknown): WireContentBlock[] {
  const blocks: WireContentBlock[] = [];
  for (const entry of asArray(content)) {
    const record = asRecord(entry);
    if (record === null || record.type !== "text") continue;
    if (typeof record.text !== "string") continue;
    blocks.push({ type: "text", text: record.text });
  }
  return blocks;
}

/**
 * The final reasoning text of a completed `reasoning` item: the summary parts
 * first, then the content parts, non-empty parts only, joined with newlines
 * (upstream renders the summary as the readable trace).
 */
function reasoningText(summary: unknown, content: unknown): string {
  const parts: string[] = [];
  for (const value of asArray(summary)) {
    const text = asText(value);
    if (text !== "") parts.push(text);
  }
  for (const value of asArray(content)) {
    const text = asText(value);
    if (text !== "") parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Identity of an app-server tool item on the wire's tool_execution_* events:
 * the display `args` object (omp parity) plus `argumentsJson` — the RAW JSON
 * string the model produced, which is what the DSH `tool/call` payload wants.
 * `mcpToolCall`/`dynamicToolCall` hand `arguments` over as unparsed JSON, so
 * that rides through verbatim when it is a string; the other item shapes expose
 * discrete fields, so their string is the faithful JSON rendering of exactly
 * those fields.
 */
function toolIdentity(item: Record<string, unknown>): { toolName: string; args: Record<string, unknown>; argsJson: string } {
  switch (item.type) {
    case "commandExecution": {
      const args: Record<string, unknown> = { command: asText(item.command) };
      const cwd = asText(item.cwd);
      if (cwd !== "") args.cwd = cwd;
      return { toolName: "command_execution", args, argsJson: JSON.stringify(args) };
    }
    case "fileChange": {
      const args = { changes: asArray(item.changes) };
      return { toolName: "file_change", args, argsJson: JSON.stringify(args) };
    }
    case "mcpToolCall": {
      const args = asRecord(item.arguments) ?? {};
      return {
        toolName: asText(item.tool) || "mcp_tool_call",
        args,
        argsJson: typeof item.arguments === "string" ? item.arguments : JSON.stringify(args),
      };
    }
    case "dynamicToolCall": {
      const args = asRecord(item.arguments) ?? {};
      return {
        toolName: asText(item.tool) || "dynamic_tool_call",
        args,
        argsJson: typeof item.arguments === "string" ? item.arguments : JSON.stringify(args),
      };
    }
    case "webSearch": {
      const args = { query: asText(item.query) };
      return { toolName: "web_search", args, argsJson: JSON.stringify(args) };
    }
    case "plan": {
      const args = { text: asText(item.text) };
      return { toolName: "update_plan", args, argsJson: JSON.stringify(args) };
    }
    default:
      return { toolName: asText(item.type) || "tool", args: {}, argsJson: "{}" };
  }
}

/** Render a tool item's outcome as wire tool_execution_end result blocks. */
function toolResult(item: Record<string, unknown>): { content: WireContentBlock[]; isError: boolean } {
  switch (item.type) {
    case "commandExecution": {
      return {
        content: [{ type: "text", text: asText(item.aggregatedOutput) }],
        isError: item.status === "failed",
      };
    }
    case "mcpToolCall": {
      const result = asRecord(item.result);
      const content: WireContentBlock[] = [];
      const rawContent = result !== null ? asArray(result.content) : [];
      for (const block of rawContent) {
        const record = asRecord(block);
        // Only MCP text blocks bridge (omp parity: images/unknown are dropped).
        if (record !== null && record.type === "text" && typeof record.text === "string") {
          content.push({ type: "text", text: record.text });
        }
      }
      if (content.length === 0) {
        const error = asRecord(item.error);
        if (error !== null && typeof error.message === "string") content.push({ type: "text", text: error.message });
      }
      return { content, isError: item.status === "failed" };
    }
    case "dynamicToolCall": {
      const content: WireContentBlock[] = [];
      for (const entry of asArray(item.contentItems)) {
        const record = asRecord(entry);
        // The generated discriminant is `inputText`; accept a bare `text` too, defensively.
        if (record === null) continue;
        if ((record.type === "inputText" || record.type === "text") && typeof record.text === "string") {
          content.push({ type: "text", text: record.text });
        }
      }
      return { content, isError: item.success === false };
    }
    case "fileChange": {
      const lines: string[] = [];
      for (const change of asArray(item.changes)) {
        const record = asRecord(change);
        if (record !== null) lines.push(`${changeKindLabel(record.kind) || "update"} ${asText(record.path)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], isError: item.status === "failed" };
    }
    case "webSearch":
      return { content: [{ type: "text", text: asText(item.query) }], isError: false };
    case "plan":
      return { content: [{ type: "text", text: asText(item.text) }], isError: false };
    default:
      return { content: [], isError: false };
  }
}

/**
 * `turn/plan/updated` steps → the DSH `todo/write` whole-list snapshot payload
 * (`TodoItem { content, status }`; upstream packages/todo/tool-todo). The whole
 * list is replaced on every write (latest-wins); a codex plan step is
 * `"completed"` only when its status says so — `inProgress` and anything
 * unrecognized map to `"pending"`. Blank steps are dropped, mirroring the SDK
 * projector's todo snapshot.
 */
function planTodos(plan: unknown): Array<{ content: string; status: "pending" | "completed" }> {
  const todos: Array<{ content: string; status: "pending" | "completed" }> = [];
  for (const entry of asArray(plan)) {
    const record = asRecord(entry);
    if (record === null) continue;
    const content = asText(record.step);
    if (content === "") continue;
    todos.push({ content, status: record.status === "completed" ? "completed" : "pending" });
  }
  return todos;
}

function toolStart(item: Record<string, unknown>): WireEvent {
  const { toolName, args, argsJson } = toolIdentity(item);
  const start: WireEvent = {
    type: "tool_execution_start",
    toolCallId: asText(item.id),
    toolName,
    args,
    argumentsJson: argsJson,
  };
  if (item.type === "mcpToolCall") start.server = asText(item.server);
  return start;
}

/**
 * Terminal tool event for a completed tool item. Emits the start first when
 * this item's start was never projected (replayed/minimal chains), keeping the
 * wire's start/end pairing intact without duplicate starts.
 */
function toolEnd(item: Record<string, unknown>): WireEvent | WireEvent[] {
  const id = asText(item.id);
  const { toolName } = toolIdentity(item);
  const result = toolResult(item);
  const end: WireEvent = { type: "tool_execution_end", toolCallId: id, toolName, result, isError: result.isError };
  if (item.type === "commandExecution") {
    end.command = asText(item.command);
    if (typeof item.exitCode === "number") end.exit_code = item.exitCode;
  }
  if (!startedTools.has(id)) {
    // start never fired for this id (replayed/minimal chain): emit the pair.
    startedTools.add(id);
    return [toolStart(item), end];
  }
  return end;
}

type ItemPhase = "started" | "completed";

/** Tool item types that project as a tool_execution_start/end pair. */
const TOOL_ITEM_TYPES = new Set<string>([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "plan",
]);

function projectItem(item: unknown, phase: ItemPhase): WireEvent | WireEvent[] | null {
  const record = asRecord(item);
  if (record === null) return null;
  const id = asText(record.id);
  const type = asText(record.type);
  if (type === "") return null;

  if (type === "userMessage") {
    // The completed twin is dropped: the agent already appended the local user
    // message or bridged the remote one when the start arrived.
    if (phase === "completed") return null;
    const message: WireMessage = { role: "user", content: userTextBlocks(record.content) };
    return { type: "message_start", message };
  }

  if (type === "agentMessage") {
    const text = asText(record.text);
    if (phase === "started") {
      const start: WireEvent = { type: "message_start", message: { role: "assistant", content: [] } };
      return text === "" ? start : [start, streamDelta("text_delta", text)];
    }
    return {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    };
  }

  if (type === "reasoning") {
    if (phase === "started") {
      return {
        type: "message_start",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
      };
    }
    return {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "thinking", thinking: reasoningText(record.summary, record.content) }] },
    };
  }

  if (!TOOL_ITEM_TYPES.has(type)) return null;

  if (phase === "started") {
    startedTools.add(id);
    return toolStart(record);
  }
  const events = toolEnd(record);
  if (type !== "plan") return events;
  // `item.plan` ALSO projects the DSH `todo/write` whole-list snapshot (log-only,
  // latest-wins) after the tool pair — the tool pair stays. A plan item carries
  // free text rather than steps, so it writes a single pending todo; an empty
  // text would only clear the list, so nothing is written then.
  const text = asText(record.text);
  if (text === "") return events;
  const pair = Array.isArray(events) ? events : [events];
  return [...pair, { type: "todo_write", todos: [{ content: text, status: "pending" }] }];
}

/**
 * `turn/plan/updated` → a tool_execution_start (no end: the update is a
 * snapshot, not a completion) plus the todo snapshot, in that order.
 */
function projectPlanUpdate(params: Record<string, unknown>): WireEvent[] {
  const args: Record<string, unknown> = { steps: asArray(params.plan) };
  const start: WireEvent = {
    type: "tool_execution_start",
    toolCallId: asText(params.turnId),
    toolName: "update_plan",
    args,
    argumentsJson: JSON.stringify(args),
  };
  return [start, { type: "todo_write", todos: planTodos(params.plan) }];
}

/**
 * Project ONE app-server notification ({ method, params }) onto the wire
 * vocabulary. Returns one event, an ordered array, or null for
 * ignorable/malformed input. Never throws.
 */
export function projectAppServerNotification(method: unknown, params: unknown): WireEvent | WireEvent[] | null {
  try {
    if (typeof method !== "string") return null;
    const payload: Record<string, unknown> = asRecord(params) ?? {};
    switch (method) {
      case SERVER_NOTIFICATION_METHODS.turnStarted:
        return { type: "turn_start" };

      case SERVER_NOTIFICATION_METHODS.itemStarted:
        return projectItem(payload.item, "started");

      case SERVER_NOTIFICATION_METHODS.itemCompleted:
        return projectItem(payload.item, "completed");

      case SERVER_NOTIFICATION_METHODS.agentMessageDelta:
        return streamDelta("text_delta", payload.delta);

      case SERVER_NOTIFICATION_METHODS.reasoningTextDelta:
      case SERVER_NOTIFICATION_METHODS.reasoningSummaryTextDelta:
      case SERVER_NOTIFICATION_METHODS.reasoningSummaryPartAdded:
        // `summaryPartAdded` carries no delta; streamDelta drops the key then.
        return streamDelta("thinking_delta", payload.delta);

      case SERVER_NOTIFICATION_METHODS.turnPlanUpdated:
        return projectPlanUpdate(payload);

      case SERVER_NOTIFICATION_METHODS.turnCompleted:
        // The client reads `data.turn.status` / `data.turn.error` and owns
        // `agent_end`; only the turn_end frame is projected here. A malformed
        // payload (no turn object at all) is ignorable input, not an empty turn.
        return asRecord(payload.turn) === null ? null : { type: "turn_end", data: { turn: payload.turn } };

      case SERVER_NOTIFICATION_METHODS.error:
        // The client records the error and synthesizes the terminal assistant
        // error message; the wire stream stays silent (fail-soft invariant).
        return null;

      case SERVER_NOTIFICATION_METHODS.threadStarted:
      case SERVER_NOTIFICATION_METHODS.threadStatusChanged:
      case SERVER_NOTIFICATION_METHODS.threadTokenUsageUpdated:
        // Thread lifecycle and token usage are the CLIENT's business: usage is
        // converted from codex's snake_case shape by the client and attached to
        // the next turn_end. Nothing is projected.
        return null;

      default:
        return null;
    }
  } catch {
    return null;
  }
}
