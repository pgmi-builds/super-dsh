// Upgrade round tests (§16a consumer surface):
//  - thinking deltas → reasoning block in assistant/message content;
//  - usage event → Dash TokenUsage on assistant/message (incl. reasoningTokens);
//  - no usage → NO usage field (never fabricated);
//  - approval ask-mode round trip: allow + deny (deny = no service, fail closed);
//  - model id encoding: parseModelId (slug, slug@level, invalid);
//  - provider display name "Google".
import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

const { AgyAgent, convertAgyUsage } = await import("../dist/agent.js");
const { AgyLlmAdapter, AGY_PROVIDER_ID } = await import("../dist/adapter.js");
const { effortsFor, parseModelId, modelIds, AGY_MODEL_CATALOG } = await import("../dist/models.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFakeSession() {
  const events = [];
  let seq = 0;
  return {
    id: "session-test",
    events,
    snapshotEvents: () => [...events],
    append: (type, data, opts) => {
      seq += 1;
      const event = { type, seq, time: Date.now(), data, ...(opts ?? {}) };
      events.push(event);
      return event;
    },
  };
}

function makeFakeClient({ chunks = ["OK"], thinking = [], usage = undefined, approval = undefined } = {}) {
  const approvalOps = [];
  let approvalHandler = undefined;
  return {
    get conversationId() { return "conv-1"; },
    get lastUsage() { return usage; },
    _approvalOps: approvalOps,
    setApprovalHandler(handler) { approvalHandler = handler; },
    onThinkingDelta: undefined,
    async *turn(text) {
      for (const t of thinking) this.onThinkingDelta?.(t);
      if (approval !== undefined) {
        const allow = await approvalHandler(approval.req);
        approvalOps.push({ id: approval.req.id, allow });
      }
      for (const chunk of chunks) yield chunk;
      return chunks.join("");
    },
    async close() { },
  };
}

function makeRuntimeInfo() {
  return { session: { cwd: "/tmp" }, awaitingKey: false, onSaveApiKey: () => {}, onTurnDone: () => {} };
}

function makeUserMessage(text) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

const assistantEvent = (session) => session.events.find((e) => e.type === "assistant/message");

async function runAgent(ctx, client) {
  const session = makeFakeSession();
  const agent = new AgyAgent(ctx, "s1", { provider: AGY_PROVIDER_ID, model: "gemini-3.7-flash" }, session, client, undefined, makeRuntimeInfo());
  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(20);
  return session;
}

test("thinking deltas become a reasoning block; usage lands as TokenUsage", async () => {
  const client = makeFakeClient({
    chunks: ["Answer"],
    thinking: ["thought one ", "thought two"],
    usage: { input_tokens: 10, output_tokens: 6, thinking_tokens: 4, total_tokens: 20 },
  });
  const session = await runAgent(new Context(), client);
  const ev = assistantEvent(session);
  assert.ok(ev, "assistant/message appended");
  const content = ev.data.message.content;
  assert.equal(content[0].type, "reasoning");
  assert.equal(content[0].text, "thought one thought two");
  assert.equal(content[1].type, "text");
  assert.equal(content[1].text, "Answer");
  assert.deepEqual(ev.data.usage, { inputTokens: 10, outputTokens: 6, totalTokens: 16, reasoningTokens: 4 });
});

test("no usage event → no usage field (never fabricated)", async () => {
  const client = makeFakeClient({ chunks: ["Hi"] });
  const session = await runAgent(new Context(), client);
  const ev = assistantEvent(session);
  assert.ok(ev);
  assert.equal(ev.data.message.content.some((b) => b.type === "reasoning"), false, "no reasoning without thinking");
  assert.equal("usage" in ev.data, false, "no usage key when bridge skipped it");
});

test("usage with thinking_tokens > output drops reasoningTokens (fold safety)", () => {
  assert.equal(convertAgyUsage({ input_tokens: 5, output_tokens: 3, thinking_tokens: 9, total_tokens: 8 }).reasoningTokens, undefined);
  assert.equal(convertAgyUsage(undefined), undefined);
  assert.equal(convertAgyUsage({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0, total_tokens: 0 }), undefined);
});

test("approval ask-mode: allowed-once → allow op", async () => {
  const ctx = new Context();
  ctx.get = (name) => (name === "approval"
    ? { request: async () => "allowed-once" }
    : undefined);
  const client = makeFakeClient({
    chunks: ["done"],
    approval: { req: { id: "a-1", tool: "run_command", args: "ls" } },
  });
  const session = await runAgent(ctx, client);
  assert.deepEqual(client._approvalOps, [{ id: "a-1", allow: true }]);
  const end = session.events.find((e) => e.type === "turn/end");
  assert.equal(end.data.reason.kind, "completed");
});

test("approval ask-mode: no approval service → deny (fail closed)", async () => {
  const client = makeFakeClient({
    chunks: ["done"],
    approval: { req: { id: "a-2", tool: "run_command", args: "rm -rf /" } },
  });
  const session = await runAgent(new Context(), client);
  assert.deepEqual(client._approvalOps, [{ id: "a-2", allow: false }]);
  const end = session.events.find((e) => e.type === "turn/end");
  assert.equal(end.data.reason.kind, "completed");
});

test("model ids are plain slugs; @level legacy ids still parse", () => {
  assert.deepEqual(parseModelId("gemini-3.7-flash"), { slug: "gemini-3.7-flash" });
  assert.deepEqual(parseModelId("gemini-3.7-flash@high"), { slug: "gemini-3.7-flash", thinkingLevel: "high" });
  assert.equal(parseModelId("not-a-model"), undefined);
  assert.equal(parseModelId(undefined), undefined);
  assert.equal(modelIds().length, 4, "four slugs the CLI actually serves");
  for (const id of modelIds()) assert.ok(parseModelId(id) !== undefined, `round-trip ${id}`);
  // Per-model vocabularies exactly as the CLI reports them (dev3 2026-10-02):
  // the flash family takes medium, 3.1-pro does NOT — which is precisely why
  // the adapter stopped transmitting an invented default.
  assert.deepEqual(effortsFor("gemini-3.6-flash"), ["low", "medium", "high"]);
  assert.deepEqual(effortsFor("gemini-3.1-pro"), ["low", "high"]);
  assert.equal(effortsFor("gemini-3.1-pro").includes("medium"), false, "3.1-pro rejects medium");
  // Retired ids are absent from the catalog rather than offered and refused.
  assert.equal(parseModelId("gemini-2.5-flash"), undefined);
  assert.equal(parseModelId("gemini-3.5-flash"), undefined);
});

test("provider display name is Google; list uses variant ids/labels", async () => {
  const adapter = new AgyLlmAdapter();
  assert.equal(adapter.providerInfo(AGY_PROVIDER_ID).name, "Google");
  const models = await adapter.listModels(AGY_PROVIDER_ID);
  assert.ok(models.some((m) => m.id === "gemini-3.7-flash" && m.name === "Gemini 3.7 Flash"));
  assert.ok(models.some((m) => m.id === "gemini-3.8-flash" && m.name === "Gemini 3.8 Flash"));
  // The pro model carries a NARROWER vocabulary than the flash family.
  const pro = await adapter.resolveModel(AGY_PROVIDER_ID, "gemini-3.1-pro");
  assert.equal(pro.reasoning.defaultEffort, "low");
  assert.deepEqual(pro.reasoning.efforts.map((e) => e.id), ["low", "high"]);
  await assert.rejects(() => adapter.resolveModel(AGY_PROVIDER_ID, "gemini-2.5-pro"), /does not serve/);
  await assert.rejects(() => adapter.resolveModel(AGY_PROVIDER_ID, "bogus"), /MODEL_NOT_FOUND|does not serve/);
});
