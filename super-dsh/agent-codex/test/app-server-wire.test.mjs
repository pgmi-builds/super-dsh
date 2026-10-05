// app-server transport unit tests (2026-10-03, app-server line).
//
// The real wire is exercised end to end — a REAL child process speaking the
// real framing (`test/fixtures/fake-app-server.mjs`), so request/response
// correlation, notification dispatch, server-request round-trips, EOF
// handling and process-group teardown are all pinned against observable
// behaviour rather than a mocked stream.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { CodexAppServerTransport, CodexWireError, SERVER_OVERLOADED_CODE } from "../dist/app-server-wire.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.mjs");

test("native command is directly executable and receives unchanged app-server argv", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-native-wire-"));
  const command = join(dir, "codex");
  // A POSIX executable catches routing it through Node: Node cannot parse
  // this launcher. Its response reports the actual arguments it received.
  writeFileSync(command, '#!/bin/sh\nIFS= read -r frame\nprintf \'{"id":1,"result":{"args":["%s","%s","%s"]}}\\n\' "$1" "$2" "$3"\ncat >/dev/null\n', { mode: 0o700 });
  const transport = new CodexAppServerTransport({ command, args: ["app-server", "-c", "model_provider=openai"], requestTimeoutMs: 2000 });
  try {
    assert.equal(transport.pid, undefined, "construction must not spawn a process");
    transport.start();
    assert.deepEqual(await transport.request("initialize", {}), { args: ["app-server", "-c", "model_provider=openai"] });
  } finally {
    transport.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transport uses its supplied env CODEX_BIN only at start, preserving lazy construction", async () => {
  const env = { ...process.env, CODEX_BIN: "/missing-before-start" };
  const transport = new CodexAppServerTransport({ env, args: [], requestTimeoutMs: 2000 });
  try {
    assert.equal(transport.pid, undefined);
    // Resolving in the constructor would fail on the original missing path.
    env.CODEX_BIN = FIXTURE;
    transport.start();
    assert.deepEqual(await transport.request("test/echo", { value: "env-override" }), { value: "env-override" });
  } finally {
    transport.close();
  }
});

/** Spawn a transport over the fake with one config, and collect diagnostics. */
function makeTransport(config = {}, extra = {}) {
  const notifications = [];
  const stderr = [];
  const exits = [];
  const transport = new CodexAppServerTransport({
    command: FIXTURE,
    args: [],
    env: { ...process.env, FAKE_APPSERVER_CONFIG: JSON.stringify(config) },
    requestTimeoutMs: extra.requestTimeoutMs ?? 5_000,
    onNotification: (notification) => notifications.push(notification),
    onStderr: (chunk) => stderr.push(chunk),
    onExit: (info) => exits.push(info),
    ...(extra.onServerRequest === undefined ? {} : { onServerRequest: extra.onServerRequest }),
  });
  transport.start();
  return { transport, notifications, stderr, exits };
}

/** Resolve once `predicate` sees a matching notification (or reject on timeout). */
function waitForNotification(notifications, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const found = notifications.find(predicate);
      if (found !== undefined) return resolve(found);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for a notification (saw: ${notifications.map((n) => n.method).join(", ")})`));
      setTimeout(poll, 5).unref?.();
      return undefined;
    };
    poll();
  });
}

test("app-server wire: requests correlate by id and resolve with the server result", async () => {
  const { transport } = makeTransport();
  try {
    const [first, second] = await Promise.all([transport.request("test/echo", { value: "a" }), transport.request("test/echo", { value: "b" })]);
    assert.deepEqual(first, { value: "a" });
    assert.deepEqual(second, { value: "b" });
    assert.equal(transport.pendingCount, 0);
  } finally {
    transport.close();
  }
});

test("app-server wire: protocol errors surface as CodexWireError with the server's code", async () => {
  const { transport } = makeTransport();
  try {
    await assert.rejects(
      () => transport.request("does/not/exist", {}),
      (error) => {
        assert.ok(error instanceof CodexWireError);
        assert.equal(error.code, -32601);
        assert.match(error.message, /does\/not\/exist/);
        return true;
      },
    );
  } finally {
    transport.close();
  }
});

test("app-server wire: the documented overload backpressure code is preserved verbatim", async () => {
  const { transport } = makeTransport();
  try {
    await assert.rejects(
      () => transport.request("test/overloaded", {}),
      (error) => {
        assert.ok(error instanceof CodexWireError);
        assert.equal(error.code, SERVER_OVERLOADED_CODE);
        return true;
      },
    );
  } finally {
    transport.close();
  }
});

test("app-server wire: server notifications reach the listener with their params", async () => {
  const { transport, notifications } = makeTransport();
  try {
    await transport.request("test/emit", { method: "turn/started", params: { turn: { id: "t1" } } });
    const seen = await waitForNotification(notifications, (n) => n.method === "turn/started");
    assert.deepEqual(seen.params, { turn: { id: "t1" } });
  } finally {
    transport.close();
  }
});

test("app-server wire: server requests round-trip through the handler and write the answer back", async () => {
  const seen = [];
  const { transport, notifications } = makeTransport(
    { serverRequest: { method: "item/commandExecution/requestApproval", params: { command: "rm -rf /" } } },
    {
      onServerRequest: (request) => {
        seen.push(request);
        return { result: { decision: "decline" } };
      },
    },
  );
  try {
    await transport.request("turn/start", { threadId: "th", input: [] });
    const answered = await waitForNotification(notifications, (n) => n.method === "test/answered");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "item/commandExecution/requestApproval");
    assert.deepEqual(seen[0].params, { command: "rm -rf /" });
    assert.deepEqual(answered.params.result, { decision: "decline" });
  } finally {
    transport.close();
  }
});

test("app-server wire: a THROWING server-request handler answers with a JSON-RPC error instead of hanging", async () => {
  const { transport, notifications } = makeTransport(
    { serverRequest: { method: "item/fileChange/requestApproval", params: {} } },
    {
      onServerRequest: () => {
        throw new Error("no answerer");
      },
    },
  );
  try {
    await transport.request("turn/start", { threadId: "th", input: [] });
    const answered = await waitForNotification(notifications, (n) => n.method === "test/answered");
    assert.equal(answered.params.error.code, -32603);
    assert.match(answered.params.error.message, /no answerer/);
  } finally {
    transport.close();
  }
});

test("app-server wire: a server request with no handler is refused, never left pending", async () => {
  const { transport, notifications } = makeTransport({ serverRequest: { method: "mcpServer/elicitation/request", params: {} } });
  try {
    await transport.request("turn/start", { threadId: "th", input: [] });
    const answered = await waitForNotification(notifications, (n) => n.method === "test/answered");
    assert.equal(answered.params.error.code, -32601);
  } finally {
    transport.close();
  }
});

test("app-server wire: a non-JSON stdout line is diagnostics, not protocol (framing survives)", async () => {
  const { transport, notifications, stderr } = makeTransport({ nonJsonLine: "<html>gateway noise</html>" });
  try {
    await transport.request("test/noise", {});
    // Framing must survive the garbage line: the next request still answers.
    assert.deepEqual(await transport.request("test/echo", { value: "after-noise" }), { value: "after-noise" });
    assert.equal(notifications.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(stderr.some((chunk) => chunk.includes("non-JSON stdout")), `stderr: ${stderr.join("")}`);
  } finally {
    transport.close();
  }
});

test("app-server wire: a request times out with a method-named error", async () => {
  const { transport } = makeTransport();
  try {
    await assert.rejects(
      () => transport.request("test/hang", {}, { timeoutMs: 150 }),
      /test\/hang timed out after 150ms/,
    );
    assert.equal(transport.pendingCount, 0);
  } finally {
    transport.close();
  }
});

test("app-server wire: child exit fails every pending request and reports the exit", async () => {
  const { transport, exits } = makeTransport({ exitCode: 7 });
  try {
    const hanging = transport.request("test/hang", {});
    await transport.request("test/exit", {});
    const error = await hanging.catch((failure) => failure);
    assert.ok(error instanceof Error, `expected an Error, saw ${String(error)}`);
    assert.match(error.message, /exited/);
    assert.equal(transport.pendingCount, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(exits.length >= 1, "onExit must fire");
    assert.equal(exits[0].code, 7);
  } finally {
    transport.close();
  }
});

test("app-server wire: close() is idempotent, kills the child, and rejects later requests", async () => {
  const { transport } = makeTransport();
  await transport.request("initialize", {});
  const pid = transport.pid;
  assert.equal(typeof pid, "number");
  transport.close();
  transport.close();
  assert.equal(transport.alive, false);
  await assert.rejects(() => transport.request("test/echo", { value: 1 }), /not running/);
  // The child is really reaped (SIGTERM to the group, SIGKILL as backstop).
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`child ${String(pid)} survived close()`);
});
