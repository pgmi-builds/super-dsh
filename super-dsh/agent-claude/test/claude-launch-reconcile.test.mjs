// agent-claude/test/claude-launch-reconcile.test.mjs
// Provider flip = child swap between turns; model switch = live setModel.
//
// These four scenarios pin the exact route-reconciliation contract between the
// ClaudeAgent and its per-session ClaudeSdkClient:
//   1. a provider move on a spawned client closes the old child and builds a
//      replacement through the injected factory, resuming the same SDK thread;
//   2. a model move on the SAME provider is a live `setModel` with the RAW id
//      (never a composite key);
//   3. a DSH-side composite selection (`glm/glm-5.2`) splits back into its
//      provider/model halves;
//   4. a legacy/unknown provider id resolves to NATIVE_LAUNCH (no injection).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";

const { ClaudeAgent } = await import("../dist/agent.js");
const { createUserMessage } = await import("@deepseek-ai/dsh-llm");

/** A minimal Session stand-in (append captured; no persistence). */
function fakeSession() {
  const events = [];
  return {
    id: "session-reconcile",
    snapshotEvents: () => events.slice(),
    requestHeader: () => undefined,
    append(type, data) {
      const event = { type, data: structuredClone(data) };
      events.push(event);
      return { seq: events.length, time: Date.now(), data: event.data };
    },
  };
}

/** A scripted ClaudeSdkClient stand-in with the route-reconciliation surface. */
function fakeClient({ spawned = false, threadId = null, appliedProvider = null } = {}) {
  const listeners = new Set();
  return {
    spawned,
    threadId,
    appliedProvider,
    closed: false,
    calls: { setLaunch: [], setModel: [], ensureStarted: 0, setPermissionMode: [] },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setLaunch(launch) {
      this.calls.setLaunch.push(launch);
      this.appliedProvider = launch.providerId;
    },
    async setModel(model) {
      this.calls.setModel.push(model);
    },
    async setPermissionMode(mode) {
      this.calls.setPermissionMode.push(mode);
    },
    async ensureStarted() {
      this.calls.ensureStarted += 1;
      this.spawned = true;
    },
    close() {
      this.closed = true;
    },
  };
}

/** The launch the fake store produces for a provider id (mirrors claudeLaunchFor). */
function fakeLaunchFor(providerId, model) {
  if (providerId === "glm") {
    return {
      providerId: "glm",
      env: { ANTHROPIC_BASE_URL: "https://glm.example/anthropic", ANTHROPIC_AUTH_TOKEN: "<glm key>", ANTHROPIC_MODEL: model },
      model,
    };
  }
  if (providerId === "deepseek") {
    return {
      providerId: "deepseek",
      env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_API_KEY: "<deepseek key>", ANTHROPIC_MODEL: model },
      model,
    };
  }
  return undefined;
}

test("applyRoute case 3: provider flip closes and replaces the client, resume keeps threadId", async () => {
  const oldClient = fakeClient({ spawned: true, threadId: "u1", appliedProvider: "deepseek" });
  const replacements = [];
  const clientFactory = (overrides = {}) => {
    const replacement = fakeClient({ appliedProvider: overrides.launch?.providerId ?? null });
    replacements.push({ config: overrides, client: replacement });
    return replacement;
  };
  const agent = new ClaudeAgent(
    new Context(), "s", {}, fakeSession(), oldClient, undefined,
    { launchFor: fakeLaunchFor }, clientFactory,
  );
  await agent.applyRouteForTest({ provider: "glm", model: "glm-5.2" });

  assert.equal(oldClient.closed, true, "the old child is closed at the turn boundary");
  assert.equal(replacements.length, 1, "exactly one replacement client is built");
  assert.equal(replacements[0].config.resumeSessionId, "u1", "the replacement resumes the old SDK thread");
  assert.equal(replacements[0].config.launch.providerId, "glm");
  assert.equal(replacements[0].config.launch.env.ANTHROPIC_AUTH_TOKEN, "<glm key>");
  assert.equal(replacements[0].client.calls.ensureStarted, 1, "the replacement is started");
  await agent.dispose();
});

test("applyRoute case 2: same provider routes to live setModel with the raw id", async () => {
  const client = fakeClient({ spawned: true, threadId: "u1", appliedProvider: "deepseek" });
  let reattached = false;
  const clientFactory = () => {
    reattached = true;
    return fakeClient();
  };
  const agent = new ClaudeAgent(
    new Context(), "s", {}, fakeSession(), client, undefined,
    { launchFor: fakeLaunchFor }, clientFactory,
  );
  await agent.applyRouteForTest({ provider: "deepseek", model: "deepseek-flash" });

  assert.equal(reattached, false, "same provider must never swap the child");
  assert.equal(client.closed, false, "the live child is untouched");
  assert.deepEqual(client.calls.setModel, ["deepseek-flash"], "setModel receives the RAW id");
  await agent.dispose();
});

test("composite id resolution: selection 'glm/glm-5.2' → provider glm, model glm-5.2", async () => {
  const ctx = new Context();
  ctx.provide("sessionProjections", {
    stateOf: (_session, key) => (key === "modelSelection" ? { pending: { provider: "claude", model: "glm/glm-5.2" } } : undefined),
  });
  const agent = new ClaudeAgent(
    ctx, "s", {}, fakeSession(), fakeClient(), undefined,
    { launchFor: fakeLaunchFor },
  );
  assert.deepEqual(agent.resolveRouteForTest(), { provider: "glm", model: "glm-5.2" });
  await agent.dispose();
});

test("unknown provider id in a legacy selection → NATIVE_LAUNCH (no injection)", async () => {
  const client = fakeClient({ spawned: false, threadId: null, appliedProvider: null });
  const agent = new ClaudeAgent(
    new Context(), "s", {}, fakeSession(), client, undefined,
    { launchFor: () => undefined },
  );
  await agent.applyRouteForTest({ provider: "unknown-pro", model: "x" });

  assert.equal(client.calls.setLaunch.length, 1);
  assert.equal(client.calls.setLaunch[0].providerId, null, "no provider is injected");
  assert.deepEqual(client.calls.setLaunch[0].env, {}, "empty env — the native settings decide");
  assert.equal(client.calls.ensureStarted, 1, "the lazy-spawn gate starts the child");
  await agent.dispose();
});

/** Flush the delivery chain and any queued microtasks (the flip's agent_end). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A recording Session: appends are captured in order (read via `.events`). */
function recordingSession() {
  let seq = 0;
  const events = [];
  return {
    id: "session-flip",
    events,
    snapshotEvents: () => events.slice(),
    requestHeader: () => undefined,
    append(type, data, opts) {
      const event = { type, seq: seq++, time: Date.now(), data: structuredClone(data), ...(opts ?? {}) };
      events.push(event);
      return event;
    },
  };
}

/** A scripted client whose close() reproduces the real reader loop's post-close
 *  agent_end (emitted on the next microtask through the still-registered listener). */
function flippingClient({ spawned = false, threadId = null, appliedProvider = null, emitAgentEndOnClose = false } = {}) {
  const listeners = new Set();
  const calls = { setPermissionMode: [], ensureStarted: 0, prompt: 0 };
  return {
    spawned,
    threadId,
    appliedProvider,
    closed: false,
    calls,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setLaunch(launch) {
      this.appliedProvider = launch.providerId;
    },
    async setModel() { },
    async setPermissionMode(mode) { calls.setPermissionMode.push(mode); },
    async ensureStarted() { calls.ensureStarted += 1; this.spawned = true; },
    async prompt() { calls.prompt += 1; },
    async followUp() { },
    async steer() { },
    async interrupt() { },
    async supportedModels() { return []; },
    async supportedCommands() { return []; },
    async getState() { return { isStreaming: false }; },
    get cwd() { return "/fake/cwd"; },
    close() {
      this.closed = true;
      if (emitAgentEndOnClose) {
        queueMicrotask(() => { for (const listener of [...listeners]) listener({ type: "agent_end" }); });
      }
    },
  };
}

test("provider flip quarantines the superseded client's agent_end — no spurious turn/end, request/context still emitted", async () => {
  const session = recordingSession();
  const ctx = new Context();
  ctx.provide("sessionProjections", {
    stateOf: (_session, key) => (key === "modelSelection" ? { pending: { provider: "claude", model: "glm/glm-5.2" } } : undefined),
  });

  const oldClient = flippingClient({ spawned: true, threadId: "u1", appliedProvider: "deepseek", emitAgentEndOnClose: true });
  const replacement = flippingClient({});
  const clientFactory = (overrides = {}) => {
    replacement.appliedProvider = overrides.launch?.providerId ?? null;
    return replacement;
  };

  const agent = new ClaudeAgent(
    ctx, "session-flip", {}, session, oldClient, undefined,
    { launchFor: fakeLaunchFor }, clientFactory,
  );

  agent.prompt(createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } }));
  await settle();

  const types = session.events.map((event) => event.type);
  assert.equal(types.includes("turn/end"), false,
    "the superseded client's stale agent_end must not close the flip turn before turn/start");
  assert.equal(types.includes("turn/start"), true, "turn/start opens the new turn");
  assert.ok(types.includes("request/context"),
    "request/context is still emitted for the new turn (turnOpen survived the swap)");

  await agent.dispose();
});
