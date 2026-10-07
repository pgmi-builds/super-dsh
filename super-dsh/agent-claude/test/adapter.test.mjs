// agent-claude/test/adapter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { ClaudeLlmAdapter, CLAUDE_PROVIDER_ID, routeIds, routableProvider } = await import("../dist/adapter.js");
const { setModelCatalog, readModelCatalog } = await import("../dist/models.js");

test("the adapter serves exactly the observed catalog under the claude route", async () => {
  setModelCatalog([
    { id: "opus", label: "Opus", description: "most capable", contextWindow: 200000 },
    { id: "sonnet", label: "Sonnet" },
  ], "sonnet");
  const adapter = new ClaudeLlmAdapter();
  assert.equal(CLAUDE_PROVIDER_ID, "claude");
  assert.equal(adapter.providerInfo(CLAUDE_PROVIDER_ID).id, "claude");
  assert.deepEqual((await adapter.listModels(CLAUDE_PROVIDER_ID)).map((m) => m.id), ["opus", "sonnet"]);
  const resolved = await adapter.resolveModel(CLAUDE_PROVIDER_ID, "opus");
  assert.equal(resolved.context?.contextWindow, 200000);
  await assert.rejects(() => adapter.resolveModel(CLAUDE_PROVIDER_ID, "gpt"), /does not serve model/);
});

test("an empty catalog stays empty: no placeholder model is ever invented", () => {
  setModelCatalog([]);
  assert.deepEqual(readModelCatalog().models, []);
  assert.equal(readModelCatalog().defaultModel, undefined);
});

test("stream() refuses loudly rather than fabricating a wire route", () => {
  const adapter = new ClaudeLlmAdapter();
  assert.throws(() => adapter.stream({}), /does not stream/);
});

// --- Additional pins for the Task 6 self-review checklist -------------------

const { catalogFromInit } = await import("../dist/models.js");

test("setModelCatalog overwrites rather than merges, and drops a stale default", () => {
  setModelCatalog([{ id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" }], "opus");
  setModelCatalog([{ id: "sonnet", label: "Sonnet" }]);
  const snapshot = readModelCatalog();
  assert.deepEqual(snapshot.models.map((m) => m.id), ["sonnet"]);
  assert.equal(snapshot.defaultModel, undefined);
});

test("readModelCatalog hands back a detached, immutable snapshot", () => {
  const input = [{ id: "opus", label: "Opus" }];
  setModelCatalog(input, "opus");
  input[0].label = "mutated after the write";
  const first = readModelCatalog();
  assert.throws(() => { first.models.push({ id: "invented", label: "Invented" }); }, TypeError);
  assert.throws(() => { first.models[0].label = "tampered"; }, TypeError);
  const second = readModelCatalog();
  assert.deepEqual(second.models.map((m) => m.id), ["opus"]);
  assert.equal(second.models[0].label, "Opus");
});

test("resolveModel only maps a positive contextWindow, never a zero one", async () => {
  const adapter = new ClaudeLlmAdapter();
  setModelCatalog([
    { id: "zero", label: "Zero", contextWindow: 0 },
    { id: "none", label: "None" },
  ]);
  assert.equal((await adapter.resolveModel(CLAUDE_PROVIDER_ID, "zero")).context, undefined);
  assert.equal((await adapter.resolveModel(CLAUDE_PROVIDER_ID, "none")).context, undefined);
});

test("a default that names no member of the observed catalog is dropped", () => {
  setModelCatalog([{ id: "opus", label: "Opus" }], "sonnet");
  assert.equal(readModelCatalog().defaultModel, undefined);
  setModelCatalog([{ id: "opus", label: "Opus" }], "opus");
  assert.equal(readModelCatalog().defaultModel, "opus");
  setModelCatalog([], "opus");
  assert.deepEqual(readModelCatalog().models, []);
  assert.equal(readModelCatalog().defaultModel, undefined);
});

test("catalogFromInit derives one real entry from the runtime's own model, or none", () => {
  assert.deepEqual(catalogFromInit({ model: "claude-opus-4-1" }), [{ id: "claude-opus-4-1", label: "claude-opus-4-1" }]);
  assert.deepEqual(catalogFromInit({}), []);
  assert.deepEqual(catalogFromInit({ model: "" }), []);
  assert.deepEqual(catalogFromInit({ model: "   " }), []);
  assert.deepEqual(catalogFromInit({ model: 42 }), []);
});

// --- Per-provider routes reach the DSH selector (2026-10-04 F-A rework) ---
// The adapter now mirrors the codex twin's one-route-per-provider shape: the
// fixed `claude` route serves the OBSERVED catalog only (raw ids), and each
// curated provider (route id = provider id) serves its own models[] RAW. The
// selection id string stays `deepseek/deepseek-flash` — the route half simply
// moved from the hardcoded `claude` to the provider id itself. Pinned here:
// routeIds order, per-route listModels/resolveModel (raw ids), observed-only
// without a worldHome, and the live read (a panel edit needs no re-registration).

const { writeProviderStore, readProviderStore, upsertProvider } = await import("../dist/claude-providers.js");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

function curatedHome() {
  return mkdtempSync(join(tmpdir(), "superd-claude-adapter-"));
}

/** One complete, valid store entry; tests override the field under test. */
function deepseekEntry(overrides = {}) {
  return {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    auth: { kind: "apiKey", value: "sk-test" },
    models: [
      { id: "deepseek-flash", displayName: "DeepSeek Flash", contextWindow: 128000 },
      { id: "deepseek-chat" },
    ],
    origin: "user",
    ...overrides,
  };
}

/** A second provider, so route ordering and providerInfo are pinnable. */
function glmEntry(overrides = {}) {
  return {
    id: "glm",
    label: "GLM (Z.AI)",
    baseUrl: "https://api.z.ai/api/anthropic",
    auth: { kind: "authToken", value: "zai-secret" },
    models: [{ id: "glm-5.3", displayName: "GLM-5.3", contextWindow: 1000000 }],
    origin: "user",
    ...overrides,
  };
}

test("routeIds yields the fixed claude route first, then one route per provider with models", () => {
  const store = { providers: [deepseekEntry(), glmEntry()], removed: [] };
  assert.deepEqual(routeIds(store), ["claude", "deepseek", "glm"]);
  // A provider with no models registers no route (the codex twin's rule).
  assert.deepEqual(routeIds({ providers: [deepseekEntry(), glmEntry({ models: [] })], removed: [] }), ["claude", "deepseek"]);
  assert.equal(routableProvider({ ...deepseekEntry(), models: [] }), false);
  assert.equal(routableProvider(deepseekEntry()), true);
});

test("the claude route serves observed-only; a provider route serves its curated models RAW", async () => {
  const home = curatedHome();
  writeProviderStore(home, { providers: [deepseekEntry(), glmEntry()], removed: [] });
  setModelCatalog([{ id: "sonnet", label: "Sonnet" }], "sonnet");
  const adapter = new ClaudeLlmAdapter(home);
  assert.deepEqual((await adapter.listModels(CLAUDE_PROVIDER_ID)).map((m) => m.id), ["sonnet"]);
  assert.deepEqual((await adapter.listModels("deepseek")).map((m) => m.id), ["deepseek-flash", "deepseek-chat"]);
  assert.deepEqual((await adapter.listModels("deepseek")).map((m) => m.name), ["DeepSeek Flash", "deepseek-chat"]);
  assert.deepEqual((await adapter.listModels("glm")).map((m) => m.id), ["glm-5.3"]);
  assert.deepEqual(await adapter.listModels("ghost"), []);
});

test("resolveModel resolves a raw provider/model pair; the id echoes the request verbatim", async () => {
  const home = curatedHome();
  writeProviderStore(home, { providers: [deepseekEntry()], removed: [] });
  setModelCatalog([]);
  const adapter = new ClaudeLlmAdapter(home);
  const resolved = await adapter.resolveModel("deepseek", "deepseek-flash");
  assert.equal(resolved.provider, "deepseek");
  assert.equal(resolved.id, "deepseek-flash");
  assert.equal(resolved.name, "DeepSeek Flash");
  assert.equal(resolved.context?.contextWindow, 128000);
  const bare = await adapter.resolveModel("deepseek", "deepseek-chat");
  assert.equal(bare.name, "deepseek-chat");
  assert.equal(bare.context, undefined);
  await assert.rejects(() => adapter.resolveModel("deepseek", "nope"), /does not serve model/);
  await assert.rejects(() => adapter.resolveModel("ghost", "model"), /does not serve model/);
});

test("the claude route serves no composite id — curated models live under their provider routes", async () => {
  const home = curatedHome();
  writeProviderStore(home, { providers: [deepseekEntry()], removed: [] });
  setModelCatalog([{ id: "sonnet", label: "Sonnet" }], "sonnet");
  const adapter = new ClaudeLlmAdapter(home);
  await assert.rejects(() => adapter.resolveModel(CLAUDE_PROVIDER_ID, "deepseek/deepseek-flash"), /does not serve model/);
  assert.equal((await adapter.resolveModel(CLAUDE_PROVIDER_ID, "sonnet")).provider, "claude");
});

test("providerInfo names the provider route by its label, and the claude route by its group", () => {
  const home = curatedHome();
  writeProviderStore(home, { providers: [deepseekEntry()], removed: [] });
  const adapter = new ClaudeLlmAdapter(home);
  assert.deepEqual(adapter.providerInfo(CLAUDE_PROVIDER_ID), { id: "claude", name: "Claude" });
  assert.deepEqual(adapter.providerInfo("deepseek"), { id: "deepseek", name: "DeepSeek" });
  assert.deepEqual(adapter.providerInfo("ghost"), { id: "ghost", name: "ghost" });
});

test("no worldHome = observed-only for the claude route; provider routes serve nothing", async () => {
  const home = curatedHome();
  writeProviderStore(home, { providers: [deepseekEntry()], removed: [] });
  setModelCatalog([{ id: "opus", label: "Opus" }]);
  const adapter = new ClaudeLlmAdapter();
  assert.deepEqual((await adapter.listModels(CLAUDE_PROVIDER_ID)).map((m) => m.id), ["opus"]);
  assert.deepEqual(await adapter.listModels("deepseek"), []);
  await assert.rejects(() => adapter.resolveModel("deepseek", "deepseek-flash"), /does not serve model/);
});

test("the store is read live: a panel edit lands without re-registration", async () => {
  const home = curatedHome();
  writeProviderStore(home, { providers: [deepseekEntry()], removed: [] });
  setModelCatalog([]);
  const adapter = new ClaudeLlmAdapter(home);
  assert.equal((await adapter.listModels("deepseek")).length, 2);
  const glm = glmEntry();
  writeProviderStore(home, upsertProvider(readProviderStore(home), glm));
  assert.deepEqual((await adapter.listModels("glm")).map((m) => m.id), ["glm-5.3"]);
  assert.equal((await adapter.resolveModel("glm", "glm-5.3")).name, "GLM-5.3");
});
