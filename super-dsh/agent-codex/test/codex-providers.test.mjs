// src/codex-providers.ts — the adapter-owned multi-provider store behind the
// Hub's codex settings panel. The store is the LIST; the SELECTION is
// materialized into the native ~/.codex files (codex-native-config.ts).
//
// Pinned here: the round trip, the 0600 posture (the file carries API keys),
// the fail-soft read (a corrupt store must not take the world down), and the
// referential rule that `selected` can never name a provider that is not in
// the list.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const {
  providerStorePath,
  readProviderStore,
  writeProviderStore,
  upsertProvider,
  removeProvider,
  selectProvider,
  isProviderId,
  isWireProtocol,
} = await import("../dist/codex-providers.js");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "superd-codex-providers-"));
}

/** One complete, valid entry; tests override the field under test. */
function entry(overrides = {}) {
  return {
    id: "zai-plan",
    label: "Z.ai Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    protocol: "responses",
    auth: { kind: "apiKey", value: "sk-test-1" },
    models: [{ id: "glm-5.2", displayName: "GLM-5.2", contextWindow: 1000000 }],
    ...overrides,
  };
}

test("providerStorePath anchors inside the world home", () => {
  const home = tempHome();
  assert.equal(providerStorePath(home), join(home, "codex-providers.json"));
});

test("upsertProvider round-trips through the file, 0600 on disk", () => {
  const home = tempHome();
  const store = upsertProvider({ version: 1, providers: [] }, entry());
  writeProviderStore(home, store);

  const path = providerStorePath(home);
  // the store carries API keys: it must never be group/world readable.
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.providers.map((p) => p.id), ["zai-plan"]);
  assert.equal(raw.providers[0].auth.value, "sk-test-1");

  assert.deepEqual(readProviderStore(home), { version: 1, providers: [entry()] });
});

test("upsertProvider replaces in place and appends new ids", () => {
  let store = { version: 1, providers: [] };
  store = upsertProvider(store, entry());
  store = upsertProvider(store, entry({ id: "deepseek", label: "DeepSeek" }));
  assert.deepEqual(store.providers.map((p) => p.id), ["zai-plan", "deepseek"]);

  store = upsertProvider(store, entry({ label: "Z.ai Plan (renamed)" }));
  assert.deepEqual(store.providers.map((p) => p.id), ["zai-plan", "deepseek"]);
  assert.equal(store.providers[0].label, "Z.ai Plan (renamed)");
});

test("readProviderStore is empty for a missing file and for malformed JSON", () => {
  const home = tempHome();
  assert.deepEqual(readProviderStore(home), { version: 1, providers: [] });

  writeFileSync(providerStorePath(home), "{ not json at all");
  assert.deepEqual(readProviderStore(home), { version: 1, providers: [] });

  // a well-formed file that is not a store shape degrades the same way
  writeFileSync(providerStorePath(home), JSON.stringify({ version: 1, providers: "nope" }));
  assert.deepEqual(readProviderStore(home), { version: 1, providers: [] });
});

test("readProviderStore drops unusable entries instead of the whole store", () => {
  const home = tempHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(
    providerStorePath(home),
    JSON.stringify({
      version: 1,
      providers: [
        entry(),
        { id: "no-label", baseUrl: "https://x/v1", protocol: "responses", auth: { kind: "env", name: "K" }, models: [{ id: "m" }] },
        { id: "bad protocol", label: "L", baseUrl: "https://x/v1", protocol: "grpc", auth: { kind: "apiKey", value: "k" }, models: [{ id: "m" }] },
        { id: "no-models", label: "L", baseUrl: "https://x/v1", protocol: "responses", auth: { kind: "apiKey", value: "k" }, models: [] },
        entry({ id: "second" }),
      ],
      selected: "not-in-list",
    }),
  );
  const store = readProviderStore(home);
  assert.deepEqual(store.providers.map((p) => p.id), ["zai-plan", "second"]);
  // `selected` naming a dropped provider is a dangling reference: cleared, not kept.
  assert.equal(store.selected, undefined);
});

test("selectProvider refuses an unknown id and clears on null", () => {
  const base = upsertProvider({ version: 1, providers: [] }, entry());
  assert.throws(() => selectProvider(base, "ghost"), /unknown provider/);
  assert.deepEqual(selectProvider(base, null), { version: 1, providers: [entry()] });
  assert.deepEqual(selectProvider(base, "zai-plan"), { version: 1, providers: [entry()], selected: "zai-plan" });
});

test("removeProvider drops the entry and any selection pointing at it", () => {
  let store = { version: 1, providers: [] };
  store = upsertProvider(store, entry());
  store = upsertProvider(store, entry({ id: "deepseek" }));
  store = selectProvider(store, "deepseek");

  assert.deepEqual(removeProvider(store, "deepseek"), { version: 1, providers: [entry()] });
  // removing an id that is not selected leaves the selection alone
  const kept = removeProvider(selectProvider(store, "zai-plan"), "deepseek");
  assert.equal(kept.selected, "zai-plan");
  assert.deepEqual(kept.providers.map((p) => p.id), ["zai-plan"]);
});

test("isProviderId / isWireProtocol are the single source of truth", () => {
  assert.equal(isProviderId("zai-plan"), true);
  assert.equal(isProviderId("zai_plan"), false);
  assert.equal(isProviderId("-leading"), false);
  assert.equal(isProviderId(""), false);
  assert.equal(isProviderId(7), false);
  assert.equal(isWireProtocol("responses"), true);
  assert.equal(isWireProtocol("chat"), true);
  assert.equal(isWireProtocol("grpc"), false);
});
