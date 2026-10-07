// dev3 2026-10-04 case A regression (docs/test-reports/2026-10-04-omp-session-log-corrupt-repair-dev3.md):
// models may add unknown fields to tool-call arguments; the omp runtime strips
// them at parse time, so EXECUTION args diverge from ADVERTISED args. dsh's
// strict v4 validator refuses the stored log unless `tool/call.arguments` ≡ the
// assistant frame's advertised arguments byte-for-byte. `toolCalls()` must
// carry the ADVERTISED原文 (the pending entry the tool_execution_start handler
// prefers) — never the runtime-parsed args.
import test from "node:test";
import assert from "node:assert/strict";
const { toolCalls, convertContent } = await import("../dist/agent.js");

test("dev3 case A: toolCalls carries the advertised arguments convertContent writes to the assistant frame", () => {
  const blocks = [
    { type: "thinking", thinking: "reading the page" },
    {
      type: "toolCall",
      id: "call_16c7502df89d4f4d95f5fb95",
      name: "read",
      // The model added an `i` intent field the tool schema does not declare:
      arguments: JSON.stringify({ i: "Viewing linked webmcp demo page", path: "https://example.test/page" }),
    },
  ];
  const advertised = convertContent(blocks).find((b) => b.type === "tool-call");
  const pending = toolCalls(blocks);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].callId, "call_16c7502df89d4f4d95f5fb95");
  assert.equal(pending[0].name, "read");
  // THE invariant: a tool_execution_start frame that prefers pending.arguments
  // writes exactly what the assistant frame advertised.
  assert.equal(pending[0].arguments, advertised.arguments);
});

test("dev3 case A control: stripped execution args diverge and must never win when an advertisement exists", () => {
  const blocks = [{ type: "toolCall", id: "call_x", name: "read", arguments: JSON.stringify({ i: "intent", path: "p" }) }];
  const pending = toolCalls(blocks)[0];
  const executionStripped = JSON.stringify({ path: "p" });
  assert.notEqual(pending.arguments, executionStripped, "pending must not be the schema-stripped shape");
  assert.equal(pending.arguments, JSON.stringify({ i: "intent", path: "p" }));
});

test("toolCalls normalizes object-form advertised arguments the same way convertContent does", () => {
  const blocks = [{ type: "toolCall", id: "call_y", name: "write", arguments: { path: "p", text: "t" } }];
  const advertised = convertContent(blocks).find((b) => b.type === "tool-call");
  const pending = toolCalls(blocks)[0];
  assert.equal(pending.arguments, advertised.arguments);
});
