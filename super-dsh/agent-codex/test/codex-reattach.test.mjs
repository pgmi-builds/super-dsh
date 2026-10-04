// Moving a LIVE session onto another provider (2026-10-04) — the turn-boundary
// switch the whole feature exists for.
//
// A provider is a property of the CHILD PROCESS, not of the thread: `turn/start`
// carries a model but no provider field, and a `thread/resume` aimed at a thread
// a live app-server already holds re-joins it instead of reloading it, so the
// override is accepted and silently ignored (measured 2026-10-03: asked for
// `zhipu-cn`, got `deepseek` back). The death of the child is therefore the only
// boundary at which a provider can change — and the thread id must survive it,
// or the conversation is lost.
//
// This suite drives a real transport against the programmable fake app-server,
// so it pins the actual frame sequence rather than a mock's expectations.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { CodexAgent } from "../dist/agent.js";

import { CodexAppServerClient, setAppServerTransportFactory } from "../dist/app-server-client.js";
import { CodexAppServerTransport } from "../dist/app-server-wire.js";
import { resetProjectionState } from "../dist/app-server-events.js";
import { syntheticKeyName } from "../dist/codex-launch.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.mjs");
const WORKSPACE = mkdtempSync(join(tmpdir(), "superd-codex-reattach-ws-"));

/**
 * Install a recording transport factory. Each created entry carries the argv/env
 * the client asked for AND every JSON-RPC request that transport actually saw.
 */
function installFake(config = {}) {
  const created = [];
  setAppServerTransportFactory((options) => {
    const transport = new CodexAppServerTransport({
      ...options,
      command: FIXTURE,
      args: [],
      env: { ...process.env, FAKE_APPSERVER_CONFIG: JSON.stringify(config) },
    });
    const calls = [];
    const original = transport.request.bind(transport);
    transport.request = (method, params, extra) => {
      calls.push({ method, params });
      return original(method, params, extra);
    };
    created.push({ transport, options, calls });
    return transport;
  });
  return created;
}

const clients = [];
function makeClient(options) {
  resetProjectionState();
  const client = CodexAppServerClient.create(options);
  clients.push(client);
  return client;
}

afterEach(() => {
  while (clients.length > 0) clients.pop().close();
});

/**
 * Run one turn to completion on `created[index]`. The fake never completes a turn
 * by itself (that is what makes it scriptable), so the test emits the closing
 * notification the way a real app-server would.
 */
async function runTurn(client, created, index, text) {
  const done = new Promise((resolve) => {
    const off = client.on((event) => {
      if (event.type !== "agent_end") return;
      off();
      resolve();
    });
  });
  await client.prompt(text);
  await created[index].transport.request("test/emit", {
    method: "turn/completed",
    params: { turn: { id: `t-${index}-${text}`, status: "completed" } },
  });
  await done;
}

/** The n-th `turn/start` one transport saw, or undefined. */
function turnStarts(entry) {
  return entry.calls.filter((call) => call.method === "turn/start");
}

test("a cold agent pins the selected model on the first thread and turn despite a native default", async (t) => {
  const created = installFake();
  const client = makeClient({ cwd: WORKSPACE, model: "gpt-native-default" });
  const ctx = new Context();
  ctx.provide("sessionProjections", {
    stateOf: () => ({ pending: { provider: "deepseek", model: "deepseek-flash" } }),
  });
  const events = [];
  const session = {
    id: "session-cold-route", snapshotEvents: () => [...events],
    requestHeader: () => undefined,
    append(type, data) {
      const event = { type, data, seq: events.length + 1, time: Date.now() };
      events.push(event);
      return event;
    },
  };
  const agent = new CodexAgent(ctx, session.id, { model: "gpt-native-default" }, session, client, undefined, {
    launchFor: () => ({ argv: ["-c", 'model_provider="deepseek"'], env: {} }),
    systemPrompt: () => undefined,
  });
  t.after(() => agent.dispose());
  agent.send(createUserMessage({ content: [{ type: "text", text: "cold route" }], source: { kind: "user" } }), "next-turn", true);
  for (let i = 0; i < 100 && !created[0]?.calls.some(call => call.method === "turn/start"); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const thread = created[0]?.calls.find(call => call.method === "thread/start");
  const turn = created[0]?.calls.find(call => call.method === "turn/start");
  assert.ok(turn, "the real agent must reach the wire turn");
  assert.equal(thread.params.modelProvider, "deepseek");
  assert.equal(thread.params.model, "deepseek-flash");
  assert.equal(turn.params.model, "deepseek-flash");
});

test("reattach kills the child, spawns the next provider, and resumes the SAME thread", async () => {
  const created = installFake();
  const client = makeClient({
    cwd: WORKSPACE,
    launch: { argv: ["-c", 'model_provider="alpha"'], env: { ALPHA_API_KEY: "a" } },
    providerId: "alpha",
  });

  // The first child is spawned by the first real prompt, with alpha's launch.
  await client.ensureStarted();
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].options.args, ["app-server", "-c", 'model_provider="alpha"']);
  const thread = client.threadId;
  assert.ok(thread);
  await runTurn(client, created, 0, "hello from alpha");

  // The switch: a NEW child, pinned to beta, resuming the thread alpha created.
  await client.reattach(
    { argv: ["-c", 'model_provider="beta"'], env: { [syntheticKeyName("beta")]: "beta-secret" } },
    "beta",
    "beta-1",
  );

  assert.equal(created.length, 2, "a provider switch costs a new process");
  assert.deepEqual(created[1].options.args, ["app-server", "-c", 'model_provider="beta"']);
  assert.equal(created[1].options.env[syntheticKeyName("beta")], "beta-secret");

  // The thread is CARRIED ACROSS the restart — this is what keeps the
  // conversation, and it is why the switch has to happen between turns.
  assert.equal(client.threadId, thread, "the Codex thread must survive the child restart");
  assert.equal(client.appliedProvider, "beta");

  const resume = created[1].calls.find((call) => call.method === "thread/resume");
  assert.ok(resume !== undefined, "the new child must resume, not start a fresh thread");
  assert.equal(resume.params.threadId, thread);
  assert.equal(resume.params.modelProvider, "beta");
  assert.equal(resume.params.model, "beta-1");

  // The old child is gone, and the new one serves the next turn.
  assert.equal(created[0].transport.alive, false, "the previous child must be killed, not left running");
  await runTurn(client, created, 1, "hello from beta");
  assert.equal(turnStarts(created[0]).length, 1);
  assert.equal(turnStarts(created[1]).length, 1);
  assert.equal(turnStarts(created[1])[0].params.model, "beta-1");
});

test("reattach on a session that never spawned costs nothing and needs no resume", async () => {
  const created = installFake();
  const client = makeClient({ cwd: WORKSPACE, providerId: "alpha" });

  // No prompt yet: the lazy-spawn gate means there is no process to replace, so
  // a switch here must not create one either.
  await client.reattach({ argv: ["-c", 'model_provider="beta"'], env: {} }, "beta", "beta-1");
  assert.equal(created.length, 0, "choosing a provider must never cost a process");
  assert.equal(client.appliedProvider, "beta");

  await client.ensureStarted();
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].options.args, ["app-server", "-c", 'model_provider="beta"']);
  assert.equal(created[0].calls.some((call) => call.method === "thread/resume"), false);
});

test("a reattach is invisible to the failure path: the killed child is not a crash", async () => {
  const created = installFake();
  const client = makeClient({ cwd: WORKSPACE, launch: { argv: [], env: {} }, providerId: "alpha" });
  await client.ensureStarted();
  await runTurn(client, created, 0, "first");
  await client.reattach({ argv: [], env: {} }, "beta", "beta-1");
  // Without a transport-generation guard the dying child's `exit` reaches the
  // client's failure path and every later operation throws. Getting a state
  // answer and another completed turn proves it did not.
  assert.deepEqual(await client.getState(), { isStreaming: false });
  await runTurn(client, created, 1, "second");
});

test("the per-turn model override rides turn/start, which is what makes a model-only switch live", async () => {
  const created = installFake();
  const client = makeClient({
    cwd: WORKSPACE,
    launch: { argv: [], env: {} },
    providerId: "alpha",
    model: "alpha-1",
  });
  await client.ensureStarted();
  await runTurn(client, created, 0, "one");
  // Same provider: no restart, just a new model for the next turn.
  await client.setModel("alpha", "alpha-2");
  await runTurn(client, created, 0, "two");
  assert.equal(created.length, 1, "a model-only switch must not restart the child");
  assert.deepEqual(turnStarts(created[0]).map((call) => call.params.model), ["alpha-1", "alpha-2"]);
});
