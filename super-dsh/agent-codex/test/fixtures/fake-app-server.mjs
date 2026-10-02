// Programmable fake `codex app-server` for the transport/client unit tests.
//
// Speaks the real wire: newline-delimited JSON-RPC 2.0 with the `jsonrpc`
// header omitted, server→client notifications and server→client requests.
// Behaviour is driven entirely by the JSON in $FAKE_APPSERVER_CONFIG so each
// test can script exactly the frame sequence it needs — no real codex binary,
// no model, no network.
//
// Supported config keys (all optional):
//   threads        { [threadId]: true }             ids `thread/start` may mint (default minting)
//   resumeIds      string[]                         ids `thread/resume` accepts (else an error)
//   turnScript     ScriptStep[]                     frames emitted after a successful `turn/start`
//   interruptStatus "completed"|"interrupted"|"failed"|"never"   `turn/completed` status after `turn/interrupt`
//   steerEcho      boolean                          echo a `test/steered` notification after `turn/steer`
//   serverRequest  { method, params } | null        a server request issued after `turn/start`
//   failTurnStart  boolean                          answer `turn/start` with a JSON-RPC error
//   notInitialized boolean                          answer everything except initialize with an error
//   nonJsonLine    string | null                    raw line written to stdout on `test/noise`
//   exitAfterInitialize boolean                     exit(0) right after answering `initialize`
//   exitCode       number                           exit code used by `test/exit`
//
// ScriptStep is one of:
//   { "notification": { "method": "...", "params": {...} }, "delayMs": 0 }
//   { "request": { "method": "...", "params": {...} } }      // server→client request
//   { "reply": { "id": <id of a previous client request> } }  // unused, kept for clarity
//
// The fake also answers three ad-hoc testing methods:
//   test/emit     { method, params }  → emit that notification
//   test/echo     { value }           → result { value }
//   test/overloaded {}                → JSON-RPC error -32001 (documented backpressure)
//   test/hang     {}                  → never answers
//   test/exit     {}                  → exit(exitCode ?? 0)
//   test/noise    {}                  → write nonJsonLine to stdout

import { readFileSync } from "node:fs";

const config = JSON.parse(process.env.FAKE_APPSERVER_CONFIG ?? "{}");
let nextId = 1000;
const pendingReplies = new Map(); // id → resolver for a server→client request
let lineBuffer = "";
const recorded = [];
let turnCounter = 0;
let currentTurnId = null;

process.stdout.setDefaultEncoding?.("utf8");
process.stdin.setEncoding("utf8");

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  write(params === undefined ? { method } : { method, params });
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function emitScriptStep(step) {
  if (step.notification) notify(step.notification.method, step.notification.params);
  if (step.request) {
    const id = `srv-${nextId++}`;
    pendingReplies.set(id, step.request.method);
    write({ id, method: step.request.method, params: step.request.params ?? {} });
  }
}

async function runTurnScript() {
  for (const step of config.turnScript ?? []) {
    await delay(step.delayMs ?? 0);
    emitScriptStep(step);
  }
}

async function handleServerRequest(id, method, params) {
  if (method === "initialize") return { userAgent: "fake/0.0.0", codexHome: "/fake/.codex", platformFamily: "unix", platformOs: "linux" };
  if (method === "thread/start") {
    const threadId = config.threadId ?? "thread-fake-1";
    return { thread: { id: threadId }, model: "fake-model", modelProvider: "fake", cwd: "/fake", approvalPolicy: "never", sandbox: "danger-full-access" };
  }
  if (method === "thread/resume") {
    if (Array.isArray(config.resumeIds) && !config.resumeIds.includes(params?.threadId)) {
      throw { code: -32602, message: `no such thread ${String(params?.threadId)}` };
    }
    return { thread: { id: params?.threadId } };
  }
  if (method === "turn/start") {
    if (config.failTurnStart === true) throw { code: -32603, message: "turn/start refused by the fake" };
    turnCounter += 1;
    currentTurnId = `turn-fake-${turnCounter}`;
    const turn = { id: currentTurnId, items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    setImmediate(() => {
      notify("turn/started", { threadId: params?.threadId, turn });
      void runTurnScript();
      if (config.serverRequest) {
        const id = `srv-${nextId++}`;
        pendingReplies.set(id, config.serverRequest.method);
        write({ id, method: config.serverRequest.method, params: config.serverRequest.params ?? {} });
      }
    });
    return { turn };
  }
  if (method === "turn/steer") {
    if (config.steerEcho === true) {
      const input = params?.input ?? [];
      setImmediate(() =>
        notify("item/started", {
          threadId: params?.threadId,
          turnId: params?.expectedTurnId ?? currentTurnId,
          item: { type: "userMessage", id: `steer-user-${nextId++}`, clientId: null, content: input },
        }),
      );
    }
    return {};
  }
  if (method === "turn/interrupt") {
    const status = config.interruptStatus ?? "interrupted";
    if (status !== "never") {
      setImmediate(() =>
        notify("turn/completed", {
          threadId: params?.threadId,
          turn: { id: params?.turnId ?? currentTurnId, items: [], status, error: null, startedAt: 1, completedAt: 2, durationMs: 1 },
        }),
      );
    }
    return {};
  }
  if (method === "test/emit") {
    notify(params?.method, params?.params);
    return {};
  }
  if (method === "test/echo") return { value: params?.value };
  if (method === "test/requests") return { requests: recorded };
  if (method === "test/overloaded") throw { code: -32001, message: "Server overloaded; retry later." };
  if (method === "test/noise") {
    process.stdout.write(`${config.nonJsonLine ?? "this is not json"}\n`);
    return {};
  }
  if (method === "test/hang") return await new Promise(() => { });
  if (method === "test/exit") {
    setImmediate(() => process.exit(config.exitCode ?? 0));
    return {};
  }
  throw { code: -32601, message: `fake app-server does not implement ${method}` };
}

async function handleLine(line) {
  if (line.trim() === "") return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // A response to a server→client request we issued.
  if (message.id !== undefined && message.method === undefined) {
    const method = pendingReplies.get(message.id);
    pendingReplies.delete(message.id);
    notify("test/answered", { id: message.id, method, result: message.result ?? null, error: message.error ?? null });
    return;
  }
  if (typeof message.method !== "string") return;
  if (message.id === undefined) return; // client notification (`initialized`)
  if (!message.method.startsWith("test/")) recorded.push({ method: message.method, params: message.params ?? null });
  if (config.notInitialized === true && message.method !== "initialize") {
    write({ id: message.id, error: { code: -32600, message: "not initialized" } });
    return;
  }
  try {
    const result = await handleServerRequest(message.id, message.method, message.params);
    if (message.method === "initialize" && config.exitAfterInitialize === true) {
      write({ id: message.id, result });
      setImmediate(() => process.exit(0));
      return;
    }
    write({ id: message.id, result: result ?? {} });
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error) write({ id: message.id, error: { code: error.code, message: error.message } });
    else write({ id: message.id, error: { code: -32603, message: String(error) } });
  }
}

process.stdin.on("data", (chunk) => {
  lineBuffer += chunk;
  let index;
  while ((index = lineBuffer.indexOf("\n")) >= 0) {
    const line = lineBuffer.slice(0, index);
    lineBuffer = lineBuffer.slice(index + 1);
    void handleLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));
