// agent-claude/test/adapter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { ClaudeLlmAdapter, CLAUDE_PROVIDER_ID } = await import("../dist/adapter.js");
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

// --- Curated provider models reach the DSH selector (2026-10-04 fix round) ---
// The adapter's second source: the multi-provider store
// (`<worldHome>/claude-providers.json`) minted as composite ids. Pinned here:
// the merge (observed first, dedupe by id, observed wins), the composite
// resolve (id echoes the request verbatim — the llm contract's
// `resolved.id === model` check — while the RAW model id is the wire half),
// observed-only behavior without a worldHome, and the live read (a panel edit
// needs no re-registration).

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

test("a curated store's models reach the selector as composite ids after the observed ones", async () => {
  const home = curatedHome();
  writeProviderStore(home, { providers: [deepseekEntry()], removed: [] });
  setModelCatalog([{ id: "sonnet", label: "Sonnet" }], "sonnet");
  const adapter = new ClaudeLlmAdapter(home);
  const models = await adapter.listModels(CLAUDE_PROVIDER_ID);
  assert.deepEqual(models.map((m) => m.id), ["sonnet", "deepseek/deepseek-flash", "deepseek/deepseek-chat"]);
  assert.deepEqual(models.map((m) => m.name), ["Sonnet", "DeepSeek Flash", "deepseek-chat"]);
});

test("resolveModel resolves a curated composite, echoing it verbatim; the raw id is the wire half", async () => {
  const home = curatedHome();
  writeProviderStore(home, { providers: [deepseekEntry()], removed: [] });
  setModelCatalog([]);
  const adapter = new ClaudeLlmAdapter(home);
  const resolved = await adapter.resolveModel(CLAUDE_PROVIDER_ID, "deepseek/deepseek-flash");
  assert.equal(resolved.provider, "claude");
  assert.equal(resolved.id, "deepseek/deepseek-flash");
  assert.equal(resolved.name, "DeepSeek Flash");
  assert.equal(resolved.context?.contextWindow, 128000);
  // No displayName → the raw model id doubles as the label; no contextWindow → no context.
  const bare = await adapter.resolveModel(CLAUDE_PROVIDER_ID, "deepseek/deepseek-chat");
  assert.equal(bare.name, "deepseek-chat");
  assert.equal(bare.context, undefined);
  // A composite that names no store provider/model is unknown, not native.
  await assert.rejects(() => adapter.resolveModel(CLAUDE_PROVIDER_ID, "deepseek/nope"), /does not serve model/);
  await assert.rejects(() => adapter.resolveModel(CLAUDE_PROVIDER_ID, "ghost/model"), /does not serve model/);
});

test("no worldHome = observed-only, even with a curated store on disk", async () => {
  const home = curatedHome();
  writeProviderStore(home, { providers: [deepseekEntry()], removed: [] });
  setModelCatalog([{ id: "opus", label: "Opus" }]);
  const adapter = new ClaudeLlmAdapter();
  assert.deepEqual((await adapter.listModels(CLAUDE_PROVIDER_ID)).map((m) => m.id), ["opus"]);
  await assert.rejects(() => adapter.resolveModel(CLAUDE_PROVIDER_ID, "deepseek/deepseek-flash"), /does not serve model/);
});

test("observed wins the id dedupe, and resolveModel follows the same precedence", async () => {
  const home = curatedHome();
  writeProviderStore(home, { providers: [deepseekEntry()], removed: [] });
  setModelCatalog([{ id: "deepseek/deepseek-flash", label: "Observed Flash", description: "live session report" }]);
  const adapter = new ClaudeLlmAdapter(home);
  const models = await adapter.listModels(CLAUDE_PROVIDER_ID);
  assert.equal(models.filter((m) => m.id === "deepseek/deepseek-flash").length, 1);
  assert.equal(models[0].name, "Observed Flash");
  const resolved = await adapter.resolveModel(CLAUDE_PROVIDER_ID, "deepseek/deepseek-flash");
  assert.equal(resolved.name, "Observed Flash");
  assert.equal(resolved.description, "live session report");
  // The curated-only model is still appended after the observed one.
  assert.equal(models.at(-1).id, "deepseek/deepseek-chat");
});

test("the store is read live: a panel edit lands without re-registration", async () => {
  const home = curatedHome();
  writeProviderStore(home, { providers: [deepseekEntry()], removed: [] });
  setModelCatalog([]);
  const adapter = new ClaudeLlmAdapter(home);
  assert.equal((await adapter.listModels(CLAUDE_PROVIDER_ID)).length, 2); // prime: the next read must see the edit
  const glm = { ...deepseekEntry(), id: "glm", models: [{ id: "glm-5.2", displayName: "GLM-5.2" }] };
  writeProviderStore(home, upsertProvider(readProviderStore(home), glm)); // panel save = read-modify-write
  assert.deepEqual(
    (await adapter.listModels(CLAUDE_PROVIDER_ID)).map((m) => m.id),
    ["deepseek/deepseek-flash", "deepseek/deepseek-chat", "glm/glm-5.2"],
  );
  assert.equal((await adapter.resolveModel(CLAUDE_PROVIDER_ID, "glm/glm-5.2")).name, "GLM-5.2");
});
