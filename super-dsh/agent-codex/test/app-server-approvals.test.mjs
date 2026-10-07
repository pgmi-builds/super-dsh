// src/app-server-approvals.ts — the codex app-server approval server-request
// seam: request recognition/normalization, the DSH outcome → Codex decision
// mapping, the fail-closed answers, the timeout parser, and the async
// transport handler that must never leave a request unanswered.
import assert from "node:assert/strict";
import test from "node:test";

const { APPROVAL_METHODS, DEFAULT_APPROVAL_TIMEOUT_MS, approvalResponse, describeApprovalRequest, failClosedResponse, isGrant, makeApprovalHandler, parseApprovalTimeout } =
  await import("../dist/app-server-approvals.js");

const agent = {};

function answererReturning(outcome) {
  return { request: async () => outcome };
}

test("describeApprovalRequest normalizes all four approval methods", () => {
  assert.deepEqual(APPROVAL_METHODS, {
    command: ["item/commandExecution/requestApproval", "execCommandApproval"],
    fileChange: ["item/fileChange/requestApproval", "applyPatchApproval"],
  });

  // modern command: reason preferred, command text as the fallback
  assert.deepEqual(
    describeApprovalRequest("item/commandExecution/requestApproval", { itemId: "item-9", callId: "legacy-9", reason: "needs network", command: "curl x" }),
    { kind: "command", toolName: "command_execution", callId: "item-9", reason: "needs network" },
  );
  assert.deepEqual(
    describeApprovalRequest("item/commandExecution/requestApproval", { itemId: "item-9", command: "curl x" }),
    { kind: "command", toolName: "command_execution", callId: "item-9", reason: "curl x" },
  );
  // legacy command: callId when no itemId, argv array joined into the reason
  assert.deepEqual(
    describeApprovalRequest("execCommandApproval", { callId: "call-1", command: ["curl", "-s", "https://x"] }),
    { kind: "command", toolName: "command_execution", callId: "call-1", reason: "curl -s https://x" },
  );

  // fileChange: reason only, no command fallback
  assert.deepEqual(
    describeApprovalRequest("item/fileChange/requestApproval", { itemId: "fc-1", reason: "writes files", grantRoot: "/tmp" }),
    { kind: "fileChange", toolName: "file_change", callId: "fc-1", reason: "writes files" },
  );
  assert.deepEqual(
    describeApprovalRequest("applyPatchApproval", { callId: "legacy-fc", reason: "patch" }),
    { kind: "fileChange", toolName: "file_change", callId: "legacy-fc", reason: "patch" },
  );
  assert.deepEqual(describeApprovalRequest("item/fileChange/requestApproval", { callId: "fc-2" }), {
    kind: "fileChange",
    toolName: "file_change",
    callId: "fc-2",
  });
});

test("describeApprovalRequest returns null for every non-approval method", () => {
  for (const method of ["item/tool/requestUserInput", "mcpServer/elicitation/request", "turn/started", "unknown/method"]) {
    assert.equal(describeApprovalRequest(method, { itemId: "x", reason: "y" }), null, method);
  }
});

test("isGrant: only allowed-once grants", () => {
  assert.equal(isGrant("allowed-once"), true);
  for (const outcome of ["rejected", "cancelled", "unavailable"]) {
    assert.equal(isGrant(outcome), false, outcome);
  }
});

test("approvalResponse: modern accept/decline vs legacy approved/structured denial", () => {
  assert.deepEqual(approvalResponse("item/commandExecution/requestApproval", "allowed-once"), { result: { decision: "accept" } });
  assert.deepEqual(approvalResponse("item/fileChange/requestApproval", "allowed-once"), { result: { decision: "accept" } });
  assert.deepEqual(approvalResponse("execCommandApproval", "allowed-once"), { result: { decision: "approved" } });
  assert.deepEqual(approvalResponse("applyPatchApproval", "allowed-once"), { result: { decision: "approved" } });

  for (const outcome of ["rejected", "cancelled", "unavailable"]) {
    assert.deepEqual(approvalResponse("item/commandExecution/requestApproval", outcome), { result: { decision: "decline" } });
    assert.deepEqual(approvalResponse("item/fileChange/requestApproval", outcome), { result: { decision: "decline" } });
    assert.deepEqual(approvalResponse("execCommandApproval", outcome), {
      result: { decision: { denied: { rejection: `denied by the user (${outcome})` } } },
    });
    assert.deepEqual(approvalResponse("applyPatchApproval", outcome), {
      result: { decision: { denied: { rejection: `denied by the user (${outcome})` } } },
    });
  }
});

test("failClosedResponse: structured no-ops, otherwise JSON-RPC method-not-found", () => {
  assert.deepEqual(failClosedResponse("item/tool/requestUserInput"), { result: { answers: {} } });
  assert.deepEqual(failClosedResponse("mcpServer/elicitation/request"), { result: { action: "decline", content: null, _meta: null } });
  assert.deepEqual(failClosedResponse("whatever/else"), {
    error: { code: -32601, message: 'Super D does not handle the app-server request "whatever/else"' },
  });
});

test("parseApprovalTimeout: default for absent/blank/garbage, honours zero and positives", () => {
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 300_000);
  assert.equal(parseApprovalTimeout(undefined), DEFAULT_APPROVAL_TIMEOUT_MS);
  assert.equal(parseApprovalTimeout(""), DEFAULT_APPROVAL_TIMEOUT_MS);
  assert.equal(parseApprovalTimeout("   "), DEFAULT_APPROVAL_TIMEOUT_MS);
  assert.equal(parseApprovalTimeout("0"), 0);
  assert.equal(parseApprovalTimeout("1500"), 1500);
  assert.equal(parseApprovalTimeout("abc"), DEFAULT_APPROVAL_TIMEOUT_MS);
  assert.equal(parseApprovalTimeout("-5"), DEFAULT_APPROVAL_TIMEOUT_MS);
});

test("makeApprovalHandler: no answerer declines without consulting the answerer", async () => {
  let lookups = 0;
  let callIds = 0;
  const handler = makeApprovalHandler({
    getApproval: () => {
      lookups += 1;
      return undefined;
    },
    agent,
    timeoutMs: 0,
    asCallId: () => {
      callIds += 1;
      return "never";
    },
  });

  assert.deepEqual(await handler({ method: "item/commandExecution/requestApproval", params: { itemId: "item-1" } }), {
    result: { decision: "decline" },
  });
  assert.equal(lookups, 1);
  assert.equal(callIds, 0);

  // the legacy name maps onto the structured denial
  assert.deepEqual(await handler({ method: "execCommandApproval", params: {} }), {
    result: { decision: { denied: { rejection: "denied by the user (unavailable)" } } },
  });
});

test("makeApprovalHandler: allowed-once approves, rejected declines", async () => {
  const approve = makeApprovalHandler({ getApproval: () => answererReturning("allowed-once"), agent, timeoutMs: 0 });
  assert.deepEqual(await approve({ method: "item/commandExecution/requestApproval", params: {} }), { result: { decision: "accept" } });

  const decline = makeApprovalHandler({ getApproval: () => answererReturning("rejected"), agent, timeoutMs: 0 });
  assert.deepEqual(await decline({ method: "item/fileChange/requestApproval", params: {} }), { result: { decision: "decline" } });

  const legacy = makeApprovalHandler({ getApproval: () => answererReturning("allowed-once"), agent, timeoutMs: 0 });
  assert.deepEqual(await legacy({ method: "applyPatchApproval", params: {} }), { result: { decision: "approved" } });
});

test("makeApprovalHandler: forwards agent, toolName, branded callId and the abort signal", async () => {
  const seen = [];
  const handler = makeApprovalHandler({
    getApproval: () => ({
      request: async (request) => {
        seen.push(request);
        return "allowed-once";
      },
    }),
    agent,
    timeoutMs: 0,
    asCallId: (raw) => `call:${raw}`,
  });

  assert.deepEqual(await handler({ method: "item/commandExecution/requestApproval", params: { itemId: "item-7" } }), {
    result: { decision: "accept" },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agent, agent);
  assert.equal(seen[0].toolName, "command_execution");
  assert.equal(seen[0].callId, "call:item-7");
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(seen[0]).sort(), ["agent", "callId", "signal", "toolName"]);

  // the human-facing reason rides along when the request supplies one
  await handler({ method: "item/commandExecution/requestApproval", params: { itemId: "item-8", reason: "needs network" } });
  assert.equal(seen[1].reason, "needs network");
});

test("makeApprovalHandler: a throwing answerer declines and never rejects", async () => {
  const handler = makeApprovalHandler({
    getApproval: () => ({
      request: async () => {
        throw new Error("no open turn");
      },
    }),
    agent,
    timeoutMs: 0,
  });

  await assert.doesNotReject(async () => {
    assert.deepEqual(await handler({ method: "item/commandExecution/requestApproval", params: {} }), {
      result: { decision: "decline" },
    });
  });
});

test("makeApprovalHandler: a non-approval method gets the fail-closed answer without asking", async () => {
  let lookups = 0;
  let asked = 0;
  const handler = makeApprovalHandler({
    getApproval: () => {
      lookups += 1;
      return {
        request: async () => {
          asked += 1;
          return "allowed-once";
        },
      };
    },
    agent,
    timeoutMs: 0,
  });

  assert.deepEqual(await handler({ method: "item/tool/requestUserInput", params: {} }), { result: { answers: {} } });
  assert.deepEqual(await handler({ method: "mcpServer/elicitation/request", params: {} }), {
    result: { action: "decline", content: null, _meta: null },
  });
  assert.deepEqual(await handler({ method: "totally/unknown", params: {} }), {
    error: { code: -32601, message: 'Super D does not handle the app-server request "totally/unknown"' },
  });
  assert.equal(lookups, 0);
  assert.equal(asked, 0);
});

test("makeApprovalHandler: a timeout declines and aborts the forwarded signal", async () => {
  let signal;
  const handler = makeApprovalHandler({
    getApproval: () => ({
      request: (request) => {
        signal = request.signal;
        return new Promise(() => { });
      },
    }),
    agent,
    timeoutMs: 20,
  });
  // The handler's timeout timer is unref'd: a referenced handle keeps the
  // event loop alive so the timer can fire before the test drains.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.deepEqual(await handler({ method: "item/commandExecution/requestApproval", params: {} }), {
      result: { decision: "decline" },
    });
  } finally {
    clearTimeout(keepAlive);
  }
  assert.ok(signal !== undefined);
  assert.equal(signal.aborted, true);
});
