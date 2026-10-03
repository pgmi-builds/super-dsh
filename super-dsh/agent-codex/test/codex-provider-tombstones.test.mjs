// Removal must be durable, and an unchanged config must cost nothing (2026-10-04).
//
// The store is canonical and the native `config.toml` is a SOURCE folded into it
// on every reconcile. Two consequences need pinning, and both were found by
// running the thing rather than by reading it:
//
//  1. a reconcile of an UNCHANGED config must report no change. Auth was
//     compared by reference against a freshly re-parsed object, so every tick
//     rewrote a 0600 file that holds API keys;
//  2. the panel's remove button must survive the next reconcile. The provider is
//     still declared in the user's own config.toml, so without a tombstone the
//     sync would add it straight back — a delete button that undoes itself
//     within ten minutes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const {
  endpointKey,
  providerStorePath,
  readProviderStore,
  removeProvider,
  syncNativeProviders,
  upsertProvider,
  writeProviderStore,
} = await import("../dist/codex-providers.js");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "superd-codex-tombstone-"));
}

const ZAI_URL = "https://api.z.ai/api/coding/paas/v4";

function entry(overrides = {}) {
  return {
    id: "zai-plan",
    label: "Z.ai Plan",
    baseUrl: ZAI_URL,
    protocol: "responses",
    auth: { kind: "apiKey", value: "sk-test-1" },
    models: [{ id: "glm-5.2" }],
    ...overrides,
  };
}

function native(overrides = {}) {
  return {
    nativeId: "zai-plan",
    baseUrl: ZAI_URL,
    protocol: "responses",
    auth: { kind: "apiKey", value: "" },
    models: [],
    ...overrides,
  };
}

test("a removed endpoint is tombstoned and the reconcile does not resurrect it", () => {
  const store = upsertProvider({ version: 1, providers: [] }, entry());
  const dropped = removeProvider(store, "zai-plan");

  assert.deepEqual(dropped.providers, []);
  assert.deepEqual(dropped.removed, [endpointKey(ZAI_URL)], "the endpoint is the identity that gets remembered");

  const reconciled = syncNativeProviders(dropped, [native()]);
  assert.deepEqual(reconciled.added, [], "the user's removal must outlive a reconcile");
  assert.deepEqual(reconciled.store.providers, []);
  assert.deepEqual(reconciled.store.removed, dropped.removed, "and the tombstone is carried through the sync");
});

test("the reconcile still refreshes the providers that were NOT removed", () => {
  // The tombstone is per-endpoint, not a global mute: a second provider declared
  // alongside the removed one must still be imported.
  const dropped = removeProvider(
    upsertProvider({ version: 1, providers: [] }, entry()),
    "zai-plan",
  );
  const reconciled = syncNativeProviders(dropped, [
    native(),
    native({ nativeId: "deepseek", baseUrl: "https://api.deepseek.com/v1", auth: { kind: "env", name: "DEEPSEEK_API_KEY" } }),
  ]);
  assert.deepEqual(reconciled.added, ["deepseek"]);
  assert.deepEqual(reconciled.store.providers.map((provider) => provider.id), ["deepseek"]);
});

test("re-adding a provider clears its tombstone, so it is not skipped forever", () => {
  const dropped = removeProvider(upsertProvider({ version: 1, providers: [] }, entry()), "zai-plan");
  const restored = upsertProvider(dropped, entry());

  assert.equal(restored.removed, undefined, "an explicit add overrules the earlier removal");
  assert.deepEqual(restored.providers.map((provider) => provider.id), ["zai-plan"]);
  // …and the provider is importable again, not silently skipped.
  assert.deepEqual(syncNativeProviders(restored, [native()]).added, []);
});

test("removing an unknown id touches neither the list nor the tombstones", () => {
  const store = upsertProvider({ version: 1, providers: [] }, entry());
  const after = removeProvider(store, "never-existed");
  assert.deepEqual(after.providers.map((provider) => provider.id), ["zai-plan"]);
  assert.equal(after.removed, undefined, "nothing to tombstone");
});

test("the tombstone list round-trips through the file, and an empty one is omitted", () => {
  const home = tempHome();
  const dropped = removeProvider(upsertProvider({ version: 1, providers: [] }, entry()), "zai-plan");
  writeProviderStore(home, dropped);
  assert.deepEqual(readProviderStore(home).removed, dropped.removed);

  writeProviderStore(home, { version: 1, providers: [] });
  assert.equal(readProviderStore(home).removed, undefined);
  // Absent, not `[]`: the file stays free of empty noise.
  assert.equal(JSON.parse(readFileSync(providerStorePath(home), "utf8")).removed, undefined);
});

test("a reconcile of an unchanged env provider reports nothing and returns an equivalent store", () => {
  // The measured defect: `next.auth` came from a fresh re-parse of config.toml,
  // so reference equality marked every sync as a change and the 10-minute timer
  // rewrote the secrets file forever.
  const store = upsertProvider(
    { version: 1, providers: [] },
    entry({ id: "deepseek", baseUrl: "https://api.deepseek.com/v1", auth: { kind: "env", name: "DEEPSEEK_API_KEY" }, models: [{ id: "deepseek-flash" }] }),
  );
  const incoming = {
    nativeId: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "responses",
    auth: { kind: "env", name: "DEEPSEEK_API_KEY" },
    models: ["deepseek-flash"],
  };

  const first = syncNativeProviders(store, [incoming]);
  const second = syncNativeProviders(first.store, [incoming]);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.updated, [], "an unchanged provider is not an update");
  assert.deepEqual(second.store, first.store, "so the caller can skip the write");
});
