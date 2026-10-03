// RC-3 boot model probe: one ephemeral SDK query asks `supportedModels()` at
// provider boot; the mapped rows OVERWRITE the sonnet-only boot catalog
// (setModelCatalog overwrite semantics), and the CLI's alias roster — not a
// fabricated list — is what the picker gains. Sonnet survives ONLY as the
// probe-failure fallback.
import test from "node:test";
import assert from "node:assert/strict";

const { setClaudeFactory, resetClaudeClientState, probeClaudeModels } = await import("../dist/claude-client.js");
const { modelEntryFromSdk, setModelCatalog, readModelCatalog, CLAUDE_DEFAULT_MODEL } = await import("../dist/models.js");
const { ClaudeLlmAdapter, CLAUDE_PROVIDER_ID } = await import("../dist/adapter.js");
const { ClaudeProvider } = await import("../dist/index.js");
const { sdkEntryPath, sdkRuntimeLayout, resolveClaudeBinary, SDK_PACKAGE, SDK_PACKAGE_VERSION } = await import("../dist/sdk-runtime.js");
const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { dirname, join } = await import("node:path");
const { Context } = await import("@deepseek-ai/cordis");

const SDK_ROWS = [
  { value: "sonnet", displayName: "Sonnet", description: "balanced", resolvedModel: "claude-sonnet-5", supportedEffortLevels: ["low", "medium", "high"] },
  { value: "opus", displayName: "Opus", description: "most capable", resolvedModel: "claude-opus-5" },
  { value: "haiku", displayName: "Haiku", description: "fastest", resolvedModel: "claude-haiku-4" },
  { value: "fable", displayName: "Fable", description: "" },
];

function mockProbeFactory(rows, record = { closed: 0, options: null }) {
  setClaudeFactory(({ prompt, options }) => {
    record.options = options;
    record.prompt = prompt;
    return {
      interrupt: async () => { },
      setModel: async () => { },
      setPermissionMode: async () => { },
      supportedModels: async () => rows,
      supportedCommands: async () => [],
      close() { record.closed += 1; },
      [Symbol.asyncIterator]() {
        return (async function*() { })();
      },
    };
  });
  return record;
}

test("the probe spawns one ephemeral query (no prompt, persistSession off) and closes it", async () => {
  resetClaudeClientState();
  const record = mockProbeFactory(SDK_ROWS);
  const models = await probeClaudeModels();
  assert.equal(models.length, 4);
  assert.equal(record.closed, 1, "the probe query is closed exactly once");
  assert.equal(record.options.persistSession, false, "the probe session persists nothing in the native home");
  assert.notEqual(record.prompt, undefined, "the streaming-input queue is the prompt");
});

test("modelEntryFromSdk maps resolvedModel into the description and efforts into reasoningEfforts; contextWindow stays unset", () => {
  const [sonnet] = modelEntryFromSdk(SDK_ROWS[0]);
  assert.equal(sonnet.id, "sonnet");
  assert.equal(sonnet.label, "Sonnet");
  assert.equal(sonnet.description, "balanced (resolves to claude-sonnet-5)");
  assert.deepEqual([...sonnet.reasoningEfforts], ["low", "medium", "high"]);
  assert.equal(sonnet.contextWindow, undefined, "contextWindow is left unset (not genuinely known)");

  const [fable] = modelEntryFromSdk(SDK_ROWS[3]);
  assert.equal(fable.description, undefined, "no description stays absent");
  assert.equal(fable.reasoningEfforts, undefined, "no efforts stays absent");

  // Id-identical resolvedModel is not appended; junk rows are skipped.
  const [same] = modelEntryFromSdk({ value: "x", displayName: "X", resolvedModel: "x" });
  assert.equal(same.description, undefined);
  assert.deepEqual(modelEntryFromSdk({ nope: true }), []);
  assert.deepEqual(modelEntryFromSdk(null), []);
});

test("a successful probe grows the catalog past the sonnet fallback; resolveModel serves the efforts", async () => {
  resetClaudeClientState();
  mockProbeFactory(SDK_ROWS);
  const models = await probeClaudeModels();
  setModelCatalog(models.flatMap((model) => modelEntryFromSdk(model)), CLAUDE_DEFAULT_MODEL);

  const catalog = readModelCatalog();
  assert.deepEqual(catalog.models.map((model) => model.id), ["sonnet", "opus", "haiku", "fable"]);
  assert.equal(catalog.defaultModel, "sonnet", "sonnet is a real CLI alias, so it stays the default");
  assert.equal(catalog.models.length > 1, true, "the catalog grew past the sonnet fallback");

  const adapter = new ClaudeLlmAdapter();
  const resolved = await adapter.resolveModel(CLAUDE_PROVIDER_ID, "sonnet");
  assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.name), ["low", "medium", "high"]);
  assert.deepEqual(resolved.reasoning.efforts.map((effort) => String(effort.id).length > 0), [true, true, true]);
  const opus = await adapter.resolveModel(CLAUDE_PROVIDER_ID, "opus");
  assert.equal(opus.description, "most capable (resolves to claude-opus-5)");
});

test("a probe failure rejects — the boot catalog (sonnet only) is kept as the fallback", async () => {
  resetClaudeClientState();
  setModelCatalog([{ id: CLAUDE_DEFAULT_MODEL, label: CLAUDE_DEFAULT_MODEL }], CLAUDE_DEFAULT_MODEL);
  setClaudeFactory(() => {
    throw new Error("claude CLI missing");
  });
  await assert.rejects(() => probeClaudeModels(), /claude CLI missing/);
  const catalog = readModelCatalog();
  assert.deepEqual(catalog.models.map((model) => model.id), [CLAUDE_DEFAULT_MODEL]);
});

test("a wedged probe (supportedModels never answers) times out and closes the query", async () => {
  resetClaudeClientState();
  const record = { closed: 0 };
  setClaudeFactory(() => ({
    interrupt: async () => { },
    setModel: async () => { },
    setPermissionMode: async () => { },
    supportedModels: () => new Promise(() => { }),
    close() { record.closed += 1; },
    [Symbol.asyncIterator]() {
      return (async function* () { })();
    },
  }));
  // The probe's timeout is unref'd (it must never pin a real process), so the
  // test holds the event loop itself while the race runs.
  const keepAlive = setTimeout(() => { }, 5_000);
  try {
    await assert.rejects(() => probeClaudeModels({ timeoutMs: 50 }), /timed out/);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(record.closed, 1, "the wedged query is still closed (no subprocess leak)");
});

// --- boot-probe worldHome wiring pin (the Task 2 wiring gap) ---
//
// `ClaudeProvider`'s constructor fires `#probeBootModels()`, which must pass
// `worldHome: this.home`. With no worldHome, `resolveFactory(undefined)` throws
// "client needs worldHome" and the probe's `.catch` swallows it: the catalog
// stays sonnet-only and this test never observes the fake model. The marker and
// entry below exist ONLY under this test's home, so a probe that resolved any
// other home (or none) cannot reach them.
//
// A factory-injection pin cannot discriminate here: `resolveFactory` returns an
// injected factory BEFORE it ever looks at worldHome, so "reached the factory"
// proves nothing about the wiring. This test therefore drives the production
// resolution path with an injected executable resolver only (the default).

/** Seed a fake durable SDK runtime so the real `resolveFactory(worldHome)` path
 * runs with zero network: the marker identity matches the pin, the entry exists,
 * and the entry advertises one model. */
function seedFakeSdkRuntime(home, modelId) {
  const entry = sdkEntryPath(home);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, [
    "export function query() {",
    "  return {",
    `    supportedModels: async () => [{ value: ${JSON.stringify(modelId)}, displayName: "Fake Probe" }],`,
    "    close() {},",
    "    [Symbol.asyncIterator]() { return (async function* () {})(); },",
    "  };",
    "}",
    "",
  ].join("\n"));
  const mode = resolveClaudeBinary() !== undefined ? "host-binary" : "bundled-payload";
  writeFileSync(sdkRuntimeLayout(home).marker, JSON.stringify({
    sdkPackage: SDK_PACKAGE, sdkVersion: SDK_PACKAGE_VERSION, mode, createdAt: Date.now(),
  }));
}

test("the boot probe resolves its SDK runtime from the adapter's world home (`this.home`)", async () => {
  resetClaudeClientState(); // no injected factory: the production resolveFactory(worldHome) path
  setModelCatalog([{ id: CLAUDE_DEFAULT_MODEL, label: CLAUDE_DEFAULT_MODEL }], CLAUDE_DEFAULT_MODEL);
  const home = mkdtempSync(join(tmpdir(), "superd-claude-boot-probe-"));
  seedFakeSdkRuntime(home, "fake-boot-probe-model");

  const ctx = new Context();
  ctx.provide("dshHomePath", home);
  ctx.provide("agents", { setFactory() { } });
  new ClaudeProvider(ctx); // the constructor fires #probeBootModels()

  const observed = () => readModelCatalog().models.some((model) => model.id === "fake-boot-probe-model");
  const deadline = Date.now() + 5_000;
  while (!observed() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    observed(),
    "the boot probe must rebuild the catalog from the SDK runtime under this.home — with no worldHome it throws 'client needs worldHome' and stays sonnet-only",
  );
});
