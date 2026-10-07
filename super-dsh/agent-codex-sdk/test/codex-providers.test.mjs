// src/codex-providers.ts — the adapter-owned multi-provider store behind the
// Hub's codex settings panel. The store is now CANONICAL and the native
// `config.toml` is a SOURCE that `syncNativeProviders` folds into it.
//
// Pinned here: the round trip, the 0600 posture (the file carries API keys),
// the fail-soft read (a corrupt store must not take the world down), the
// endpoint identity that keeps a re-sync from duplicating the user's provider,
// and the rule that a sync ADDS and REFRESHES but never deletes.
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
  endpointKey,
  providerIdFromEndpoint,
  uniqueProviderId,
  syncNativeProviders,
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

/** One provider exactly as `codex-native-config.ts` hands it to the sync. */
function native(overrides = {}) {
  return {
    nativeId: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "responses",
    auth: { kind: "env", name: "DEEPSEEK_API_KEY" },
    models: [],
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

  // A read normalizes provenance: an entry that carries none is the user's.
  assert.deepEqual(readProviderStore(home), { version: 1, providers: [{ ...entry(), origin: "user" }] });
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

test("readProviderStore drops unusable entries but keeps a provider with no models yet", () => {
  const home = tempHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(
    providerStorePath(home),
    JSON.stringify({
      version: 1,
      providers: [
        entry(),
        // no label — nothing to render in the panel
        { id: "no-label", baseUrl: "https://x/v1", protocol: "responses", auth: { kind: "env", name: "K" }, models: [{ id: "m" }] },
        // an id that could never be a TOML table name
        { id: "bad-id!", label: "L", baseUrl: "https://x/v1", protocol: "responses", auth: { kind: "apiKey", value: "k" }, models: [] },
        // an unknown wire protocol
        { id: "bad-protocol", label: "L", baseUrl: "https://x/v1", protocol: "grpc", auth: { kind: "apiKey", value: "k" }, models: [] },
        // no endpoint at all — nothing to dedupe or call
        { id: "no-base-url", label: "L", protocol: "responses", auth: { kind: "apiKey", value: "k" }, models: [] },
        // an auth shape this build does not understand
        { id: "bad-auth", label: "L", baseUrl: "https://x/v1", protocol: "responses", auth: { kind: "magic" }, models: [] },
        // VALID: a native provider that is not the one in force has no
        // discoverable models, and an empty list is a real state, not junk.
        { id: "no-models", label: "L", baseUrl: "https://x/v1", protocol: "responses", auth: { kind: "apiKey", value: "k" }, models: [], origin: "native" },
        entry({ id: "second" }),
      ],
    }),
  );
  const store = readProviderStore(home);
  assert.deepEqual(store.providers.map((p) => p.id), ["zai-plan", "no-models", "second"]);
  assert.deepEqual(store.providers[1].models, []);
  assert.equal(store.providers[1].origin, "native");
});

test("a legacy store that still carries selected parses, and the field is ignored", () => {
  const home = tempHome();
  writeFileSync(providerStorePath(home), JSON.stringify({ version: 1, providers: [entry()], selected: "zai-plan" }));

  const store = readProviderStore(home);
  assert.deepEqual(store.providers.map((p) => p.id), ["zai-plan"]);
  // The global selection was retired in favour of DSH's own per-session
  // `model/selection`, so the stale field is dropped rather than resurrected.
  assert.ok(!("selected" in store));
});

test("removeProvider drops one entry and leaves the rest untouched", () => {
  let store = { version: 1, providers: [] };
  store = upsertProvider(store, entry());
  store = upsertProvider(store, entry({ id: "deepseek" }));

  // There is no selection to clear any more: removing a provider only shortens
  // the canonical list, it never unconfigures anything native.
  // There is no selection to clear any more, and nothing native is touched:
  // removing a provider shortens the canonical list and tombstones its endpoint
  // so the next reconcile cannot add it straight back.
  const dropped = removeProvider(store, "deepseek");
  assert.deepEqual(dropped.providers, [entry()]);
  assert.deepEqual(dropped.removed, [endpointKey("https://api.z.ai/api/coding/paas/v4")]);

  const ghost = removeProvider(store, "ghost");
  assert.deepEqual(ghost.providers.map((p) => p.id), ["zai-plan", "deepseek"]);
  assert.equal(ghost.removed, undefined, "an unknown id tombstones nothing");
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

// --------------------------------------------------------------- endpoint identity

test("endpointKey folds scheme case, host case, a trailing slash and the default port", () => {
  const key = endpointKey("https://api.z.ai/api/coding/paas/v4");
  // Codex treats two tables with the same base_url as the same service, so the
  // key must ignore everything that is spelling rather than identity.
  assert.equal(endpointKey("HTTPS://API.Z.ai:443/api/coding/paas/v4/"), key);
  assert.equal(endpointKey("  https://api.z.ai/api/coding/paas/v4  "), key);
  // the http default port is noise too, but a NON-default port is a distinction
  assert.equal(endpointKey("http://api.z.ai:80/v1"), endpointKey("http://api.z.ai/v1"));
  assert.notEqual(endpointKey("http://api.z.ai:8080/v1"), endpointKey("http://api.z.ai/v1"));
  // two endpoints on one host are two endpoints
  assert.notEqual(endpointKey("https://api.z.ai/api/anthropic"), key);
  // unparsable input still gets a stable, case-folded key instead of throwing
  assert.equal(endpointKey("not a url"), "not a url");
  assert.equal(endpointKey("NOT A URL"), "not a url");
});

test("providerIdFromEndpoint mints a valid, stable id per endpoint", () => {
  const deepseek = providerIdFromEndpoint("https://api.deepseek.com/v1");
  const zai = providerIdFromEndpoint("https://api.z.ai/api/coding/paas/v4");
  const anthropic = providerIdFromEndpoint("https://api.z.ai/api/anthropic");

  for (const id of [deepseek, zai, anthropic]) assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(providerIdFromEndpoint("HTTPS://API.DEEPSEEK.COM/v1/"), deepseek, "stable across spellings of one endpoint");
  assert.notEqual(zai, anthropic, "two endpoints on one host must not collide");
  assert.ok(deepseek.startsWith("api-deepseek-com"), deepseek);
});

test("uniqueProviderId keeps a free id and mints a valid, free one when taken", () => {
  assert.equal(uniqueProviderId("zai-plan", []), "zai-plan");
  assert.equal(uniqueProviderId("zai-plan", ["other"]), "zai-plan");

  const salted = uniqueProviderId("zai-plan", ["zai-plan"]);
  assert.notEqual(salted, "zai-plan");
  assert.match(salted, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(uniqueProviderId("zai-plan", ["zai-plan"]), salted, "stable for one wanted value");

  // an unusable native table name is slugified rather than rejected
  const slugged = uniqueProviderId("My Provider!", []);
  assert.match(slugged, /^[a-z0-9][a-z0-9-]*$/);
  assert.ok(slugged.startsWith("my-provider"), slugged);

  // when even the salted candidate is taken it falls back to a numbered one
  assert.equal(uniqueProviderId("zai-plan", ["zai-plan", salted]), "zai-plan-2");
});

// --------------------------------------------------------------- syncNativeProviders

test("syncNativeProviders refreshes the entry a native table names by id", () => {
  const store = upsertProvider(
    { version: 1, providers: [] },
    entry({
      id: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://old.example/v1",
      auth: { kind: "env", name: "OLD_KEY" },
      models: [{ id: "deepseek-chat" }],
    }),
  );

  const result = syncNativeProviders(store, [native({ models: ["deepseek-flash"] })]);

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.updated, ["deepseek"]);
  assert.equal(result.store.providers.length, 1, "matching by id must not append a duplicate");
  const refreshed = result.store.providers[0];
  assert.equal(refreshed.id, "deepseek");
  assert.equal(refreshed.label, "DeepSeek", "the panel's label survives a refresh");
  assert.equal(refreshed.baseUrl, "https://api.deepseek.com/v1");
  assert.deepEqual(refreshed.auth, { kind: "env", name: "DEEPSEEK_API_KEY" });
  // existing order first, then what only the native table knew about
  assert.deepEqual(refreshed.models.map((m) => m.id), ["deepseek-chat", "deepseek-flash"]);
});

test("syncNativeProviders matches on the endpoint even when the native id changed", () => {
  // The case this exists for: the user edits the base URL in the panel, so the
  // stored id and the config.toml table name no longer agree. Deduping by id
  // would append a second copy of the same service on every sync.
  const store = upsertProvider(
    { version: 1, providers: [] },
    entry({ id: "zai-plan", auth: { kind: "env", name: "ZAI_API_KEY" } }),
  );

  const result = syncNativeProviders(store, [
    native({ nativeId: "zai", baseUrl: "https://API.z.ai/api/coding/paas/v4/", auth: { kind: "env", name: "ZAI_API_KEY" } }),
  ]);

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.updated, ["zai-plan"]);
  assert.deepEqual(result.store.providers.map((p) => p.id), ["zai-plan"], "the endpoint is the dedupe key");
  assert.equal(endpointKey(result.store.providers[0].baseUrl), endpointKey("https://api.z.ai/api/coding/paas/v4"));
});

test("syncNativeProviders appends an unmatched native provider labelled with its endpoint", () => {
  const result = syncNativeProviders({ version: 1, providers: [] }, [native({ models: ["deepseek-flash"] })]);

  assert.deepEqual(result.added, ["deepseek"]);
  assert.deepEqual(result.updated, []);
  const [added] = result.store.providers;
  assert.equal(added.id, "deepseek");
  // A hand-written config.toml has no friendly name to copy; the URL is the
  // only name it supplies, and inventing one would be a lie.
  assert.equal(added.label, "https://api.deepseek.com/v1");
  assert.equal(added.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(added.origin, "native");
  assert.deepEqual(added.models.map((m) => m.id), ["deepseek-flash"]);
});

test("syncNativeProviders gives a native table without a usable id a valid, non-colliding one", () => {
  const result = syncNativeProviders({ version: 1, providers: [] }, [
    native({ nativeId: "My Provider!" }),
    native({ nativeId: "My Provider!", baseUrl: "https://other.example/v1" }),
    { baseUrl: "https://third.example/v1", protocol: "responses", auth: { kind: "apiKey", value: "" }, models: [] },
  ]);

  assert.equal(result.added.length, 3);
  assert.equal(new Set(result.added).size, 3, "every appended provider needs its own id");
  for (const id of result.added) {
    assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
    assert.equal(id, id.toLowerCase());
  }
  // with no native table name at all the endpoint itself is the naming source
  assert.equal(result.added[2], providerIdFromEndpoint("https://third.example/v1"));
});

test("syncNativeProviders never deletes: an entry whose endpoint left the config stays", () => {
  const store = upsertProvider(
    { version: 1, providers: [] },
    entry({ id: "legacy", baseUrl: "https://legacy.example/v1", auth: { kind: "env", name: "LEGACY_KEY" }, origin: "user" }),
  );

  const result = syncNativeProviders(store, [native()]);

  assert.deepEqual(result.added, ["deepseek"]);
  // A provider dropped from config.toml may still be one the user runs through
  // Super D, so the sync only ever adds and refreshes.
  assert.deepEqual(result.store.providers.map((p) => p.id), ["legacy", "deepseek"]);
  assert.equal(result.store.providers[0].origin, "user", "the untouched entry keeps its provenance");
});

test("syncNativeProviders unions model lists and never truncates what it already knew", () => {
  const store = upsertProvider(
    { version: 1, providers: [] },
    entry({
      id: "deepseek",
      auth: { kind: "env", name: "DEEPSEEK_API_KEY" },
      models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner", displayName: "Reasoner" }],
    }),
  );

  const result = syncNativeProviders(store, [native({ models: ["deepseek-reasoner", "deepseek-flash", "deepseek-chat"] })]);
  assert.deepEqual(
    result.store.providers[0].models.map((m) => m.id),
    ["deepseek-chat", "deepseek-reasoner", "deepseek-flash"],
    "existing order kept, new ids appended, duplicates dropped",
  );
});

test("syncNativeProviders adopts native auth only when the entry holds no secret", () => {
  // An `env` entry defers to the process environment, so the native table is
  // the better statement of how to authenticate.
  const envStore = upsertProvider({ version: 1, providers: [] }, entry({ id: "deepseek", auth: { kind: "env", name: "OLD_KEY" } }));
  const adopted = syncNativeProviders(envStore, [native({ auth: { kind: "apiKey", value: "" } })]);
  assert.deepEqual(adopted.store.providers[0].auth, { kind: "apiKey", value: "" });
  assert.deepEqual(adopted.updated, ["deepseek"]);

  // An empty apiKey value means "Super D holds no key", so the native table wins.
  const emptyKey = upsertProvider({ version: 1, providers: [] }, entry({ id: "deepseek", auth: { kind: "apiKey", value: "" } }));
  const refilled = syncNativeProviders(emptyKey, [native()]);
  assert.deepEqual(refilled.store.providers[0].auth, { kind: "env", name: "DEEPSEEK_API_KEY" });

  // A stored NON-EMPTY key must survive: dropping it in favour of "look in
  // auth.json" would silently break a provider the user already configured.
  const keyed = upsertProvider({ version: 1, providers: [] }, entry({ id: "deepseek", auth: { kind: "apiKey", value: "sk-mine" } }));
  const kept = syncNativeProviders(keyed, [native()]);
  assert.deepEqual(kept.store.providers[0].auth, { kind: "apiKey", value: "sk-mine" });
});

test("syncNativeProviders is a no-op when the entry already matches the native table", () => {
  // An entry holding its OWN key is fully comparable to the native table, so a
  // repeat sync has nothing left to report and the caller can skip the write.
  const store = upsertProvider(
    { version: 1, providers: [] },
    entry({
      id: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      auth: { kind: "apiKey", value: "sk-mine" },
      models: [{ id: "deepseek-flash" }],
    }),
  );

  const result = syncNativeProviders(store, [native({ models: ["deepseek-flash"] })]);

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.store, store, "the returned store is equivalent, so the caller can skip the write");
});

test("syncNativeProviders never duplicates an entry, even when it re-adopts auth", () => {
  // An env-shaped entry is the case that used to slip past the no-op branch:
  // `next.auth` arrives as a freshly parsed object, so reference equality
  // reported a change on every reconcile (fixed — auth compares structurally,
  // pinned in codex-provider-tombstones.test.mjs). What matters here is that the
  // list itself is neither duplicated nor truncated by a re-adoption.
  const store = upsertProvider(
    { version: 1, providers: [] },
    entry({ id: "deepseek", auth: { kind: "env", name: "DEEPSEEK_API_KEY" }, models: [{ id: "deepseek-flash" }] }),
  );

  const first = syncNativeProviders(store, [native({ models: ["deepseek-flash"] })]);
  const again = syncNativeProviders(first.store, [native({ models: ["deepseek-flash"] })]);

  assert.deepEqual(again.added, []);
  assert.equal(again.store.providers.length, 1);
  assert.deepEqual(again.store, first.store, "and the list is never duplicated or truncated");
});
