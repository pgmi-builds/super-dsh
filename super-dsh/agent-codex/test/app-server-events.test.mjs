// src/app-server-events.ts — the codex app-server notification → DSH wire
// projection. Pins the documented projection table: turn/plan/message frames,
// the tool_execution_start/end pairing (with its started-tools watermark), the
// tagged `PatchChangeKind` rendering, and the fail-soft null for everything
// unrecognized or malformed.
import assert from "node:assert/strict";
import test from "node:test";

const { projectAppServerNotification, resetProjectionState } = await import("../dist/app-server-events.js");

const userMessage = (content, id = "u1") => ({ type: "userMessage", id, clientId: null, content });
const agentMessage = (text, id = "a1") => ({ type: "agentMessage", id, text, phase: null });
const reasoning = (summary, content, id = "r1") => ({ type: "reasoning", id, summary, content });

test("turn/started projects to a bare turn_start frame", () => {
  assert.deepEqual(projectAppServerNotification("turn/started", { threadId: "T", turn: { id: "turn-1" } }), {
    type: "turn_start",
  });
  assert.deepEqual(projectAppServerNotification("turn/started", null), { type: "turn_start" });
});

test("userMessage start carries the text blocks; its completed twin is dropped", () => {
  resetProjectionState();
  const item = userMessage([
    { type: "text", text: "hello", text_elements: [] },
    { type: "image", url: "https://example.test/x.png" },
    { type: "text", text: "world", text_elements: [] },
  ]);
  assert.deepEqual(projectAppServerNotification("item/started", { item }), {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] },
  });
  assert.equal(projectAppServerNotification("item/completed", { item }), null);
});

test("agentMessage start emits empty content, plus a text_delta when the start already has text", () => {
  resetProjectionState();
  assert.deepEqual(projectAppServerNotification("item/started", { item: agentMessage("", "a-empty") }), {
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  assert.deepEqual(projectAppServerNotification("item/started", { item: agentMessage("partial", "a-full") }), [
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } },
  ]);
});

test("agentMessage delta and completion project text_delta and the final text", () => {
  assert.deepEqual(projectAppServerNotification("item/agentMessage/delta", { itemId: "a1", delta: "wor" }), {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wor" },
  });
  assert.deepEqual(projectAppServerNotification("item/completed", { item: agentMessage("hello world", "a1") }), {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
  });
});

test("reasoning: start, all three delta notifications, and the joined completion", () => {
  resetProjectionState();
  assert.deepEqual(projectAppServerNotification("item/started", { item: reasoning([], [], "r-start") }), {
    type: "message_start",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
  });

  assert.deepEqual(projectAppServerNotification("item/reasoning/textDelta", { itemId: "r1", delta: "think", contentIndex: 0 }), {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "think" },
  });
  assert.deepEqual(projectAppServerNotification("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "summary", summaryIndex: 0 }), {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "summary" },
  });
  // summaryPartAdded carries no delta: the key is omitted, not null.
  assert.deepEqual(projectAppServerNotification("item/reasoning/summaryPartAdded", { itemId: "r1", summaryIndex: 1 }), {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
  });

  const completed = reasoning(["first summary", "", "second summary"], ["body one", "body two"], "r1");
  assert.deepEqual(projectAppServerNotification("item/completed", { item: completed }), {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "first summary\nsecond summary\nbody one\nbody two" }],
    },
  });
});

test("commandExecution projects the start/end pair with JSON arguments, command and exit_code", () => {
  resetProjectionState();
  const item = {
    type: "commandExecution",
    id: "cmd-ok",
    command: "ls -la",
    cwd: "/tmp/work",
    status: "completed",
    aggregatedOutput: "total 0",
    exitCode: 0,
  };
  const start = projectAppServerNotification("item/started", { item });
  assert.equal(start.type, "tool_execution_start");
  assert.equal(start.toolCallId, "cmd-ok");
  assert.equal(start.toolName, "command_execution");
  assert.deepEqual(start.args, { command: "ls -la", cwd: "/tmp/work" });
  assert.equal(typeof start.argumentsJson, "string");
  assert.deepEqual(JSON.parse(start.argumentsJson), { command: "ls -la", cwd: "/tmp/work" });

  assert.deepEqual(projectAppServerNotification("item/completed", { item }), {
    type: "tool_execution_end",
    toolCallId: "cmd-ok",
    toolName: "command_execution",
    result: { content: [{ type: "text", text: "total 0" }], isError: false },
    isError: false,
    command: "ls -la",
    exit_code: 0,
  });
});

test("commandExecution end: failed status is an error, absent exitCode omits the field", () => {
  resetProjectionState();
  const item = {
    type: "commandExecution",
    id: "cmd-bad",
    command: "boom",
    status: "failed",
    aggregatedOutput: "nope",
    exitCode: null,
  };
  const start = projectAppServerNotification("item/started", { item });
  assert.deepEqual(start.args, { command: "boom" }); // no cwd → no cwd key
  const end = projectAppServerNotification("item/completed", { item });
  assert.equal(end.result.isError, true);
  assert.equal(end.isError, true);
  assert.deepEqual(end.result.content, [{ type: "text", text: "nope" }]);
  assert.equal("exit_code" in end, false);
});

test("tool dedup: completed-without-started emits the pair, completed-after-started only the end", () => {
  resetProjectionState();
  const item = {
    type: "commandExecution",
    id: "dedup-1",
    command: "echo hi",
    status: "completed",
    aggregatedOutput: "hi",
    exitCode: 0,
  };

  const pair = projectAppServerNotification("item/completed", { item });
  assert.ok(Array.isArray(pair));
  assert.deepEqual(pair.map((event) => event.type), ["tool_execution_start", "tool_execution_end"]);
  assert.equal(pair[0].toolCallId, "dedup-1");
  assert.equal(pair[1].toolCallId, "dedup-1");

  resetProjectionState();
  const started = projectAppServerNotification("item/started", { item });
  assert.equal(started.type, "tool_execution_start");
  const onlyEnd = projectAppServerNotification("item/completed", { item });
  assert.equal(Array.isArray(onlyEnd), false);
  assert.equal(onlyEnd.type, "tool_execution_end");
});

test("fileChange renders one `kind path` line per change via the tagged kind union", () => {
  resetProjectionState();
  const changes = [
    { path: "src/a.ts", kind: { type: "add" }, diff: "" },
    { path: "src/b.ts", kind: { type: "update", move_path: null }, diff: "" },
    { path: "src/c.ts", kind: { type: "delete" }, diff: "" },
  ];
  const item = { type: "fileChange", id: "fc-1", status: "completed", changes };

  const start = projectAppServerNotification("item/started", { item });
  assert.equal(start.toolName, "file_change");
  assert.deepEqual(start.args, { changes });
  assert.deepEqual(JSON.parse(start.argumentsJson), { changes });

  const end = projectAppServerNotification("item/completed", { item });
  assert.deepEqual(end.result, {
    content: [{ type: "text", text: "add src/a.ts\nupdate src/b.ts\ndelete src/c.ts" }],
    isError: false,
  });
});

test("mcpToolCall uses item.tool as toolName and carries start.server", () => {
  resetProjectionState();
  const item = {
    type: "mcpToolCall",
    id: "mcp-1",
    server: "files",
    tool: "read_file",
    status: "completed",
    arguments: { path: "/tmp/a" },
    result: { content: [{ type: "text", text: "body" }] },
    error: null,
  };
  const start = projectAppServerNotification("item/started", { item });
  assert.equal(start.toolName, "read_file");
  assert.equal(start.server, "files");
  assert.deepEqual(start.args, { path: "/tmp/a" });
  assert.deepEqual(JSON.parse(start.argumentsJson), { path: "/tmp/a" });

  assert.deepEqual(projectAppServerNotification("item/completed", { item }).result, {
    content: [{ type: "text", text: "body" }],
    isError: false,
  });
});

test("mcpToolCall passes a string arguments payload through verbatim as argumentsJson", () => {
  resetProjectionState();
  const item = {
    type: "mcpToolCall",
    id: "mcp-raw",
    server: "shell",
    tool: "run",
    status: "completed",
    arguments: '{"raw":1}',
    result: { content: [] },
    error: null,
  };
  const start = projectAppServerNotification("item/started", { item });
  assert.equal(start.argumentsJson, '{"raw":1}');
  assert.deepEqual(start.args, {});
});

test("dynamicToolCall uses item.tool and bridges inputText contentItems", () => {
  resetProjectionState();
  const item = {
    type: "dynamicToolCall",
    id: "dyn-1",
    namespace: null,
    tool: "ask_question",
    arguments: { q: "?" },
    status: "completed",
    contentItems: [{ type: "inputText", text: "answer" }],
    success: true,
  };
  const start = projectAppServerNotification("item/started", { item });
  assert.equal(start.toolName, "ask_question");
  assert.deepEqual(start.args, { q: "?" });

  const end = projectAppServerNotification("item/completed", { item });
  assert.deepEqual(end.result, { content: [{ type: "text", text: "answer" }], isError: false });
});

test("webSearch and plan project their tool identities", () => {
  resetProjectionState();
  const search = projectAppServerNotification("item/started", { item: { type: "webSearch", id: "ws-1", query: "codex app-server" } });
  assert.deepEqual(search, {
    type: "tool_execution_start",
    toolCallId: "ws-1",
    toolName: "web_search",
    args: { query: "codex app-server" },
    argumentsJson: '{"query":"codex app-server"}',
  });

  const plan = projectAppServerNotification("item/started", { item: { type: "plan", id: "plan-1", text: "Ship it" } });
  assert.deepEqual(plan, {
    type: "tool_execution_start",
    toolCallId: "plan-1",
    toolName: "update_plan",
    args: { text: "Ship it" },
    argumentsJson: '{"text":"Ship it"}',
  });
});

test("plan completion appends a single pending todo_write after the tool pair", () => {
  resetProjectionState();
  const item = { type: "plan", id: "plan-2", text: "Ship the tests" };
  const events = projectAppServerNotification("item/completed", { item });
  assert.deepEqual(events.map((event) => event.type), ["tool_execution_start", "tool_execution_end", "todo_write"]);
  assert.equal(events[1].toolName, "update_plan");
  assert.deepEqual(events[2], { type: "todo_write", todos: [{ content: "Ship the tests", status: "pending" }] });
});

test("turn/plan/updated projects an update_plan start then a todo snapshot per step", () => {
  const plan = [
    { step: "read the source", status: "completed" },
    { step: "write the tests", status: "inProgress" },
    { step: "run the suite", status: "pending" },
    { step: "", status: "completed" },
  ];
  const events = projectAppServerNotification("turn/plan/updated", { threadId: "T", turnId: "turn-9", explanation: null, plan });
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "tool_execution_start");
  assert.equal(events[0].toolName, "update_plan");
  assert.equal(events[0].toolCallId, "turn-9");
  assert.deepEqual(JSON.parse(events[0].argumentsJson), { steps: plan });
  assert.deepEqual(events[1], {
    type: "todo_write",
    todos: [
      { content: "read the source", status: "completed" },
      { content: "write the tests", status: "pending" },
      { content: "run the suite", status: "pending" },
    ],
  });
});

test("turn/completed projects turn_end carrying the raw turn object by identity", () => {
  const turn = { id: "turn-1", status: "completed", error: null, startedAt: 1 };
  const event = projectAppServerNotification("turn/completed", { threadId: "T", turn });
  assert.deepEqual(event, { type: "turn_end", data: { turn } });
  assert.equal(event.data.turn, turn);
});

test("thread lifecycle, usage, error, unknown methods and malformed params are all null", () => {
  for (const method of ["error", "thread/started", "thread/status/changed", "thread/tokenUsage/updated", "some/unknown/method"]) {
    assert.equal(projectAppServerNotification(method, { anything: true }), null, method);
  }
  for (const params of [null, "garbage", {}]) {
    assert.equal(projectAppServerNotification("item/started", params), null, String(params));
  }
});

test("projecting garbage never throws", () => {
  assert.equal(projectAppServerNotification(undefined, undefined), null);
  assert.equal(projectAppServerNotification(null, null), null);
  assert.equal(projectAppServerNotification("item/started", { item: 42 }), null);
  assert.equal(projectAppServerNotification("item/completed", { item: [] }), null);

  const garbage = [
    { item: { type: 42 } },
    { item: { type: "userMessage", content: "nope" } },
    { item: { type: "agentMessage", text: 7 } },
    { item: { type: "reasoning", summary: "not-an-array", content: null } },
    { item: { type: "commandExecution", id: 9, command: 7 } },
    { item: { type: "fileChange" } },
    { item: { type: "mcpToolCall", arguments: 7, result: 7 } },
  ];
  for (const params of garbage) {
    assert.doesNotThrow(() => projectAppServerNotification("item/started", params));
    assert.doesNotThrow(() => projectAppServerNotification("item/completed", params));
  }
});

test("resetProjectionState clears the started-tools watermark", () => {
  resetProjectionState();
  const item = { type: "commandExecution", id: "reset-1", command: "echo", status: "completed", aggregatedOutput: "x", exitCode: 0 };
  assert.equal(projectAppServerNotification("item/started", { item }).type, "tool_execution_start");
  assert.equal(projectAppServerNotification("item/completed", { item }).type, "tool_execution_end");

  resetProjectionState();
  const again = projectAppServerNotification("item/completed", { item });
  assert.deepEqual(again.map((event) => event.type), ["tool_execution_start", "tool_execution_end"]);
});
