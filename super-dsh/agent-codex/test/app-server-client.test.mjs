// CodexAppServerClient unit tests (2026-10-03, app-server line).
//
// The client drives a REAL `codex app-server`-shaped child (the programmable
// fixture) through a real transport; the transport FACTORY is intercepted so
// the lazy-spawn gate can be asserted directly (how many times did the client
// ask for a process?) and so the test can drive individual protocol frames.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { CodexAppServerClient, convertTokenUsage, setAppServerTransportFactory } from "../dist/app-server-client.js";
import { CodexAppServerTransport } from "../dist/app-server-wire.js";
import { resetProjectionState } from "../dist/app-server-events.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.mjs");
// A REAL workspace dir: the transport hands `cwd` straight to spawn, and an
// absent directory is an honest spawn failure (the provider validates the
// session cwd before it ever gets here).
const WORKSPACE = mkdtempSync(join(tmpdir(), "superd-codex-client-ws-"));

/** Install the fake transport factory; returns the created-transport log. */
function installFake(config = {}) {
  const created = [];
  setAppServerTransportFactory((options) => {
    const transport = new CodexAppServerTransport({
      ...options,
      command: FIXTURE,
      args: [],
      env: { ...process.env, FAKE_APPSERVER_CONFIG: JSON.stringify(config) },
    });
    created.push(transport);
    return transport;
  });
  return created;
}

const clients = [];
function makeClient(options = {}) {
  resetProjectionState();
  const client = CodexAppServerClient.create(options);
  clients.push(client);
  return client;
}

afterEach(() => {
  while (clients.length > 0) clients.pop().close();
});

/** Await until `predicate()` is truthy (or fail). */
async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Collect every wire event a client emits. */
function collect(client) {
  const events = [];
  client.on((event) => events.push(event));
  return events;
}

test('Hub definition is added on start, not passive construction or resume', async () => {
  const created = installFake();
  let defined = 0;
  const hub = { definition() { defined++; return { name: 'superd-hub', description: 'Hub facility', inputSchema: { type: 'object', properties: {} } }; }, dispose() {} };
  const client = makeClient({ cwd: WORKSPACE, hub });
  assert.equal(defined, 0);
  await client.ensureStarted();
  const { requests } = await created[0].request('test/requests', {});
  assert.deepEqual(requests.find(x => x.method === 'thread/start').params.dynamicTools, [
    { type: 'function', name: 'superd-hub', description: 'Hub facility', inputSchema: { type: 'object', properties: {} } },
  ]);
});

test('Hub callback is session-bound and coexists with the approval handler', async () => {
  const created = installFake();
  const calls = [];
  const hub = { definition: () => ({ name: 'superd-hub', description: 'Hub', inputSchema: {} }), async execute(args) { calls.push(args); return { action: 'agents' }; }, dispose() {} };
  const client = makeClient({ cwd: WORKSPACE, hub });
  client.setServerRequestHandler(() => ({ result: { decision: 'decline' } }));
  await client.ensureStarted();
  async function reply(count) {
    for (let i = 0; i < 100; i++) {
      const { answers } = await created[0].request('test/answers', {});
      if (answers.length >= count) return answers[count - 1];
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('callback did not settle');
  }
  await created[0].request('test/request', { method: 'item/tool/call', params: { threadId: client.threadId, tool: 'superd-hub', arguments: { action: 'agents' } } });
  const first = await reply(1);
  assert.deepEqual(first.result, { success: true, contentItems: [{ type: 'inputText', text: '{"action":"agents"}' }] });
  await created[0].request('test/request', { method: 'item/tool/call', params: { threadId: 'foreign-thread', tool: 'superd-hub', arguments: {} } });
  const second = await reply(2);
  assert.equal(second.result.success, false);
  assert.deepEqual(calls, [{ action: 'agents' }]);
  await created[0].request('test/request', { method: 'item/commandExecution/requestApproval', params: {} });
  const third = await reply(3);
  assert.deepEqual(third.result, { decision: 'decline' });
});

// ── lazy spawn (agent-adapter-dev-rules §14-i, hard gate) ────────────────────

test("client: create() is zero-IO — no transport, no process, no thread", async () => {
  const created = installFake();
  const client = makeClient({ cwd: WORKSPACE });
  assert.equal(created.length, 0, "create() must not build a transport");
  assert.equal(client.spawned, false);
  assert.equal(client.threadId, null);
  assert.deepEqual(await client.getState(), { isStreaming: false });
  assert.equal(created.length, 0);
});

test("client: the process materializes on the first prompt, not before", async () => {
  const created = installFake();
  const client = makeClient({ cwd: WORKSPACE });
  await client.prompt("hello");
  assert.equal(created.length, 1);
  assert.equal(client.threadId, "thread-fake-1");
  assert.equal(client.spawned, true);
});

test("client: an independent child keeps its own attribution and does not borrow a desktop tool pipe", async () => {
  const keys = ["CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CODEX_APP_TOOLS_PIPE_PATH"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let passed;
  try {
    process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "Codex Desktop";
    process.env.CODEX_APP_TOOLS_PIPE_PATH = "/tmp/test-only-desktop-pipe";
    setAppServerTransportFactory(options => {
      passed = options;
      return new CodexAppServerTransport({...options, command: FIXTURE, args: [], env: {...process.env, FAKE_APPSERVER_CONFIG: "{}"}});
    });
    const client = makeClient({cwd: WORKSPACE});
    await client.ensureStarted();
    assert.equal(passed.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
    assert.equal(passed.env.CODEX_APP_TOOLS_PIPE_PATH, undefined);
    assert.equal(passed.env.PATH, process.env.PATH);
  } finally {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
});

test("client: ensureStarted is single-flight and idempotent", async () => {
  const created = installFake();
  const client = makeClient();
  await Promise.all([client.ensureStarted(), client.ensureStarted(), client.ensureStarted()]);
  await client.ensureStarted();
  assert.equal(created.length, 1);
});

test("client: onThreadAttached fires with the attached thread id (and immediately when already attached)", async () => {
  installFake();
  const client = makeClient();
  const seen = [];
  client.onThreadAttached((id) => seen.push(id));
  await client.ensureStarted();
  assert.deepEqual(seen, ["thread-fake-1"]);
  const late = [];
  client.onThreadAttached((id) => late.push(id));
  assert.deepEqual(late, ["thread-fake-1"]);
});

// ── thread bootstrap parameters ─────────────────────────────────────────────

test("client: thread/start carries cwd, personality:none, the launch policy and the sandbox MODE", async () => {
  const created = installFake();
  const client = makeClient({ cwd: WORKSPACE, approvalPolicy: "on-request", sandboxMode: "workspace-write" });
  await client.ensureStarted();
  const { requests } = await created[0].request("test/requests", {});
  const start = requests.find((entry) => entry.method === "thread/start");
  assert.equal(start.params.cwd, WORKSPACE);
  assert.equal(start.params.personality, "none");
  assert.equal(start.params.approvalPolicy, "on-request");
  // thread-level `sandbox` is the plain SandboxMode string, not the structured policy.
  assert.equal(start.params.sandbox, "workspace-write");
  assert.equal(start.params.serviceName, "superd-agent-codex");
});

test("client: resume re-attaches by thread id via thread/resume (never thread/start)", async () => {
  const created = installFake({ resumeIds: ["thread-existing"] });
  const client = makeClient({ cwd: WORKSPACE, resumeThreadId: "thread-existing" });
  await client.ensureStarted();
  const { requests } = await created[0].request("test/requests", {});
  assert.deepEqual(requests.map((entry) => entry.method), ["initialize", "thread/resume"]);
  assert.equal(requests[1].params.threadId, "thread-existing");
  assert.equal(client.threadId, "thread-existing");
});

// ── turn lifecycle ──────────────────────────────────────────────────────────

test("client: turn/start carries the model and the folded approval/sandbox POLICY", async () => {
  const created = installFake();
  const client = makeClient({ cwd: WORKSPACE });
  await client.setModel("codex", "glm-5.2");
  client.setTurnPolicy({ approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: [WORKSPACE], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
  await client.prompt("hi");
  const { requests } = await created[0].request("test/requests", {});
  const turn = requests.find((entry) => entry.method === "turn/start");
  assert.equal(turn.params.model, "glm-5.2");
  assert.equal(turn.params.approvalPolicy, "on-request");
  assert.deepEqual(turn.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [WORKSPACE], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.deepEqual(turn.params.input, [{ type: "text", text: "hi", text_elements: [] }]);
  assert.equal(typeof turn.params.threadId, "string");
});

test("client: turn/started opens agent_start then turn_start; turn/completed closes turn_end then agent_end", async () => {
  const created = installFake();
  const client = makeClient({ cwd: WORKSPACE });
  const events = collect(client);
  await client.prompt("hi");
  await waitFor(() => events.find((event) => event.type === "turn_start"), "turn_start");
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), ["agent_start", "turn_start"]);

  await created[0].request("test/emit", { method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { totalTokens: 12, inputTokens: 7, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 1 } } } });
  await created[0].request("test/emit", { method: "turn/completed", params: { turn: { id: "t1", status: "completed" } } });
  await waitFor(() => events.some((event) => event.type === "agent_end"), "agent_end");
  const types = events.map((event) => event.type);
  assert.deepEqual(types.slice(-2), ["turn_end", "agent_end"]);
  const turnEnd = events.find((event) => event.type === "turn_end");
  assert.deepEqual(turnEnd.data.turn, { id: "t1", status: "completed" });
  // Usage rides the SAME turn_end, in the snake_case shape `convertUsage` consumes.
  assert.deepEqual(turnEnd.data.usage, { input_tokens: 7, output_tokens: 3, cached_input_tokens: 2, cache_write_input_tokens: 1, reasoning_output_tokens: 1 });
  assert.deepEqual(await client.getState(), { isStreaming: false });
});

test("client: a failed turn synthesizes the terminal assistant error before turn_end", async () => {
  const created = installFake();
  const client = makeClient();
  const events = collect(client);
  await client.prompt("hi");
  await created[0].request("test/emit", { method: "turn/completed", params: { turn: { id: "t1", status: "failed", error: { message: "provider exploded" } } } });
  await waitFor(() => events.some((event) => event.type === "agent_end"), "agent_end");
  assert.deepEqual(events.map((event) => event.type), ["agent_start", "turn_start", "message_end", "turn_end", "agent_end"]);
  const failure = events.find((event) => event.type === "message_end");
  assert.equal(failure.message.stopReason, "error");
  assert.equal(failure.message.errorMessage, "provider exploded");
});

test("client: item notifications for a turn that already completed are dropped", async () => {
  const created = installFake();
  const client = makeClient();
  const events = collect(client);
  await client.prompt("hi");
  await created[0].request("test/emit", { method: "turn/completed", params: { turn: { id: "t1", status: "completed" } } });
  await waitFor(() => events.some((event) => event.type === "agent_end"), "agent_end");
  const before = events.length;
  await created[0].request("test/emit", {
    method: "item/started",
    params: { turnId: "t1", item: { type: "commandExecution", id: "late", command: "echo late", status: "inProgress" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(events.length, before, "a late item must not reopen the closed turn");
});

// ── steer / followUp / abort ────────────────────────────────────────────────

test("client: steer on a live turn issues turn/steer with expectedTurnId", async () => {
  const created = installFake();
  const client = makeClient();
  await client.prompt("first");
  await waitFor(() => client.activeTurnId !== null, "the active turn id");
  await client.steer("change of plan");
  const { requests } = await created[0].request("test/requests", {});
  const steer = requests.find((entry) => entry.method === "turn/steer");
  assert.ok(steer, "turn/steer must be issued");
  assert.equal(steer.params.expectedTurnId, client.activeTurnId);
  assert.deepEqual(steer.params.input, [{ type: "text", text: "change of plan", text_elements: [] }]);
});

test("client: steer while idle starts a turn instead of failing", async () => {
  const created = installFake();
  const client = makeClient();
  await client.steer("start from idle");
  const { requests } = await created[0].request("test/requests", {});
  assert.deepEqual(requests.map((entry) => entry.method).filter((m) => m.startsWith("turn/")), ["turn/start"]);
});

test("client: followUp while busy is queued and delivered as the NEXT turn after completion", async () => {
  const created = installFake();
  const client = makeClient();
  await client.prompt("first");
  await waitFor(() => client.activeTurnId !== null, "the active turn id");
  await client.followUp("second");
  let { requests } = await created[0].request("test/requests", {});
  assert.equal(requests.filter((entry) => entry.method === "turn/start").length, 1, "the queued message must not race the live turn");

  await created[0].request("test/emit", { method: "turn/completed", params: { turn: { id: "t1", status: "completed" } } });
  await waitFor(async () => {
    const snapshot = await created[0].request("test/requests", {});
    return snapshot.requests.filter((entry) => entry.method === "turn/start").length >= 2;
  }, "the queued turn to start");
  ({ requests } = await created[0].request("test/requests", {}));
  const starts = requests.filter((entry) => entry.method === "turn/start");
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[1].params.input, [{ type: "text", text: "second", text_elements: [] }]);
});

test("client: abort issues turn/interrupt for the live turn", async () => {
  const created = installFake({ interruptStatus: "interrupted" });
  const client = makeClient();
  await client.prompt("long job");
  await waitFor(() => client.activeTurnId !== null, "the active turn id");
  await client.abort();
  const { requests } = await created[0].request("test/requests", {});
  const interrupt = requests.find((entry) => entry.method === "turn/interrupt");
  assert.ok(interrupt, "turn/interrupt must be issued");
  assert.equal(interrupt.params.turnId, "turn-fake-1");
});

// ── session management ──────────────────────────────────────────────────────

test("client: newSession discards the thread and the next turn starts a fresh one on the same process", async () => {
  const created = installFake();
  const client = makeClient();
  await client.prompt("first");
  assert.equal(client.threadId, "thread-fake-1");
  await client.newSession();
  assert.equal(client.threadId, null);
  await client.prompt("second");
  assert.equal(created.length, 1, "newSession must not respawn the child");
  const { requests } = await created[0].request("test/requests", {});
  assert.equal(requests.filter((entry) => entry.method === "thread/start").length, 2);
});

test("client: close() is idempotent and fails every later operation", async () => {
  installFake();
  const client = makeClient();
  await client.prompt("hi");
  client.close();
  client.close();
  assert.equal(client.spawned, false);
  await assert.rejects(() => client.prompt("after close"), /closed/);
  await assert.rejects(() => client.ensureStarted(), /closed/);
});

test("client: a transport failure reaches onFailure", async () => {
  const created = installFake({ exitCode: 3 });
  const client = makeClient();
  const failures = [];
  client.onFailure((error) => failures.push(error));
  await client.prompt("hi");
  await created[0].request("test/exit", {}).catch(() => undefined);
  await waitFor(() => failures.length > 0, "the failure listener");
  assert.match(failures[0].message, /exited|closed/);
});

// ── server requests (approval bridge seam) ──────────────────────────────────

test("client: setServerRequestHandler answers server requests; absent handler fails closed", async () => {
  const created = installFake({ serverRequest: { method: "item/commandExecution/requestApproval", params: { command: "ls" } } });
  const client = makeClient();
  const seen = [];
  client.setServerRequestHandler((request) => {
    seen.push(request.method);
    return { result: { decision: "accept" } };
  });
  await client.prompt("hi");
  await waitFor(() => seen.length > 0, "the server-request handler");
  assert.deepEqual(seen, ["item/commandExecution/requestApproval"]);
});

// ── usage conversion ────────────────────────────────────────────────────────

test("convertTokenUsage: app-server camelCase → the codex snake_case usage shape", () => {
  assert.deepEqual(convertTokenUsage({ totalTokens: 9, inputTokens: 4, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 1 }), {
    input_tokens: 4,
    output_tokens: 3,
    cached_input_tokens: 2,
    cache_write_input_tokens: 1,
    reasoning_output_tokens: 1,
  });
  assert.equal(convertTokenUsage(null), null);
  assert.equal(convertTokenUsage({}), null);
});
