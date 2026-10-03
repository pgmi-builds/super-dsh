// src/claude-providers.ts — the adapter-owned multi-provider store behind the
// Hub's Claude settings panel. The store is CANONICAL and the native
// `settings.json` env block is a SOURCE that `syncNativeProviders` folds into it.
//
// Pinned here: the round trip, the 0600 + tmp+rename posture (the file carries
// API keys), the fail-soft read (a corrupt store must not take the world down),
// the endpoint identity that keeps a re-sync from duplicating the user's
// provider, the tombstone that keeps a removal durable across reconciles, and
// the rule that a sync ADDS and REFRESHES but never deletes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
} = await import("../dist/claude-providers.js");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "superd-claude-providers-"));
}

/** One complete, valid entry; tests override the field under test. */
function entry(overrides = {}) {
  return {
    id: "zai-plan",
    label: "Z.ai Plan",
    baseUrl: "https://api.z.ai/api/anthropic",
    auth: { kind: "authToken", value: "sk-test-1" },
    models: [{ id: "glm-5.2", displayName: "GLM-5.2", contextWindow: 1000000 }],
    aliases: { sonnet: "glm-5.2", opus: "glm-5.2", haiku: "glm-5.3-flash" },
    origin: "user",
    ...overrides,
  };
}

/**
 * One provider exactly as `claude-native-config.ts` hands it to the sync: the
 * settings.json env block carries no provider name, only an endpoint, a key,
 * and whatever models the `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL`
 * values reveal.
 */
function native(overrides = {}) {
  return {
    baseUrl: "https://api.deepseek.com/anthropic",
    auth: { kind: "apiKey", value: "" },
    models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
    aliases: { sonnet: "deepseek-chat", opus: "deepseek-reasoner", haiku: "deepseek-chat" },
    ...overrides,
  };
}

// ------------------------------------------------------------------ the file

test("providerStorePath anchors inside the world home", () => {
  const home = tempHome();
  assert.equal(providerStorePath(home), join(home, "claude-providers.json"));
});

test("writeProviderStore is 0600, goes through tmp+rename, and creates the world home", () => {
  // The store carries API keys: it must never be group/world readable, not even
  // for the instant before a rewrite — so every write is a fresh 0600 temp file
  // renamed over the old one, and the directory holds no `.tmp-*` residue.
  const home = join(tempHome(), "nested/deeper");
  const store = upsertProvider({ providers: [], removed: [] }, entry());
  writeProviderStore(home, store);

  const path = providerStorePath(home);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(home), ["claude-providers.json"], "no temp residue: the rename completed");

  writeProviderStore(home, upsertProvider(store, entry({ id: "deepseek" })));
  assert.equal(statSync(path).mode & 0o777, 0o600, "a rewrite keeps the posture");
  assert.deepEqual(readdirSync(home), ["claude-providers.json"]);
  assert.deepEqual(readProviderStore(home).providers.map((p) => p.id), ["zai-plan", "deepseek"]);
});

test("upsertProvider round-trips through the file; `removed` is always present", () => {
  const home = tempHome();
  const store = upsertProvider({ providers: [], removed: [] }, entry());
  writeProviderStore(home, store);

  const raw = JSON.parse(readFileSync(providerStorePath(home), "utf8"));
  // No schema version field and no omit-when-empty branch: the claude store is
  // exactly { providers, removed }.
  assert.deepEqual(Object.keys(raw).sort(), ["providers", "removed"]);
  assert.deepEqual(raw.removed, []);
  assert.equal(raw.providers[0].auth.value, "sk-test-1");
  assert.deepEqual(raw.providers[0].aliases, entry().aliases, "aliases persist like any other field");

  // A read normalizes provenance: an entry that carries none is the user's.
  writeFileSync(providerStorePath(home), JSON.stringify({ providers: [{ ...entry(), origin: undefined }] }));
  assert.deepEqual(readProviderStore(home), { providers: [entry()], removed: [] });
});

// ------------------------------------------------------------------- fail-soft

test("readProviderStore is empty for a missing file, malformed JSON, and a wrong shape", () => {
  const home = tempHome();
  assert.deepEqual(readProviderStore(home), { providers: [], removed: [] });

  writeFileSync(providerStorePath(home), "{ not json at all");
  assert.deepEqual(readProviderStore(home), { providers: [], removed: [] });

  // a well-formed file that is not a store shape degrades the same way
  writeFileSync(providerStorePath(home), JSON.stringify({ providers: "nope" }));
  assert.deepEqual(readProviderStore(home), { providers: [], removed: [] });
  writeFileSync(providerStorePath(home), JSON.stringify([entry()]));
  assert.deepEqual(readProviderStore(home), { providers: [], removed: [] });
});

test("readProviderStore drops unusable entries but keeps a provider with no models yet", () => {
  const home = tempHome();
  writeFileSync(
    providerStorePath(home),
    JSON.stringify({
      providers: [
        entry(),
        // no label — nothing to render in the panel
        { id: "no-label", baseUrl: "https://x/anthropic", auth: { kind: "apiKey", value: "k" }, models: [{ id: "m" }] },
        // an id outside the provider-id alphabet
        { id: "bad-id!", label: "L", baseUrl: "https://x/anthropic", auth: { kind: "apiKey", value: "k" }, models: [] },
        // the codex "env" auth shape — this build has no by-reference auth
        { id: "env-auth", label: "L", baseUrl: "https://x/anthropic", auth: { kind: "env", name: "K" }, models: [] },
        // an auth kind this build does not understand
        { id: "bad-auth", label: "L", baseUrl: "https://x/anthropic", auth: { kind: "magic" }, models: [] },
        // an auth without a value slot at all
        { id: "no-value", label: "L", baseUrl: "https://x/anthropic", auth: { kind: "authToken" }, models: [] },
        // no endpoint at all — nothing to dedupe or call
        { id: "no-base-url", label: "L", auth: { kind: "apiKey", value: "k" }, models: [] },
        // an EMPTY value is a real state, not junk: "Super D holds no copy of
        // this key" is how a provider seeded from the user's settings arrives.
        { id: "empty-key", label: "L", baseUrl: "https://x/anthropic", auth: { kind: "apiKey", value: "" }, models: [] },
        // VALID: a folded provider whose settings name no models has an empty
        // list — inventing one would be a lie.
        { id: "no-models", label: "L", baseUrl: "https://x/anthropic", auth: { kind: "apiKey", value: "k" }, models: [], origin: "native" },
        // a garbage aliases field drops the aliases, not the entry
        { id: "bad-aliases", label: "L", baseUrl: "https://x/anthropic", auth: { kind: "apiKey", value: "k" }, models: [], aliases: "sonnet" },
        entry({ id: "second" }),
      ],
    }),
  );
  const store = readProviderStore(home);
  assert.deepEqual(
    store.providers.map((p) => p.id),
    ["zai-plan", "empty-key", "no-models", "bad-aliases", "second"],
  );
  assert.deepEqual(store.providers[1].auth, { kind: "apiKey", value: "" });
  assert.deepEqual(store.providers[2].models, []);
  assert.equal(store.providers[2].origin, "native");
  assert.equal(store.providers[3].aliases, undefined);
});

test("readProviderStore keeps only usable tombstones", () => {
  const home = tempHome();
  writeFileSync(
    providerStorePath(home),
    JSON.stringify({ providers: [], removed: ["https://x/anthropic", "", 7, null, "   "] }),
  );
  assert.deepEqual(readProviderStore(home), { providers: [], removed: ["https://x/anthropic"] });

  // a non-array `removed` is noise, not a corrupt store
  writeFileSync(providerStorePath(home), JSON.stringify({ providers: [entry()], removed: "https://x" }));
  assert.deepEqual(readProviderStore(home), { providers: [entry()], removed: [] });
});

// -------------------------------------------------------------------- editing

test("upsertProvider replaces in place and appends new ids", () => {
  let store = { providers: [], removed: [] };
  store = upsertProvider(store, entry());
  store = upsertProvider(store, entry({ id: "deepseek", label: "DeepSeek" }));
  assert.deepEqual(store.providers.map((p) => p.id), ["zai-plan", "deepseek"]);

  store = upsertProvider(store, entry({ label: "Z.ai Plan (renamed)" }));
  assert.deepEqual(store.providers.map((p) => p.id), ["zai-plan", "deepseek"]);
  assert.equal(store.providers[0].label, "Z.ai Plan (renamed)");
});

test("removeProvider drops one entry, tombstones its endpoint, and dedupes", () => {
  let store = { providers: [], removed: [] };
  store = upsertProvider(store, entry());
  store = upsertProvider(store, entry({ id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic" }));
  store = upsertProvider(store, entry({ id: "zai-alias", baseUrl: "https://api.z.ai/api/anthropic/" }));

  // Nothing native is touched: removing a provider shortens the canonical list
  // and tombstones its endpoint so the next reconcile cannot add it back.
  let dropped = removeProvider(store, "deepseek");
  assert.deepEqual(dropped.providers.map((p) => p.id), ["zai-plan", "zai-alias"]);
  assert.deepEqual(dropped.removed, [endpointKey("https://api.deepseek.com/anthropic")]);

  // The same endpoint spelled differently tombstones the same key — no duplicates.
  dropped = removeProvider(dropped, "zai-alias");
  assert.deepEqual(dropped.providers, [entry()]);
  assert.deepEqual(dropped.removed, [endpointKey("https://api.deepseek.com/anthropic"), endpointKey("https://api.z.ai/api/anthropic")]);

  // An unknown id tombstones nothing.
  const ghost = removeProvider(dropped, "ghost");
  assert.deepEqual(ghost.providers, dropped.providers);
  assert.deepEqual(ghost.removed, dropped.removed);
});

test("re-adding a provider clears its tombstone, so it is not skipped forever", () => {
  const dropped = removeProvider(upsertProvider({ providers: [], removed: [] }, entry()), "zai-plan");
  assert.deepEqual(dropped.removed, [endpointKey("https://api.z.ai/api/anthropic")]);

  const restored = upsertProvider(dropped, entry());
  assert.deepEqual(restored.removed, [], "an explicit add overrules the earlier removal");
  assert.deepEqual(restored.providers.map((p) => p.id), ["zai-plan"]);
  // …and the provider is importable again, not silently skipped.
  assert.deepEqual(
    syncNativeProviders(restored, [native({ baseUrl: "https://api.z.ai/api/anthropic" })]).updated,
    ["zai-plan"],
  );
});

// --------------------------------------------------------------- id alphabet

test("isProviderId is the single source of truth for the id alphabet", () => {
  assert.equal(isProviderId("zai-plan"), true);
  assert.equal(isProviderId("glm"), true);
  assert.equal(isProviderId("deepseek2"), true);
  assert.equal(isProviderId("zai_plan"), false);
  assert.equal(isProviderId("-leading"), false);
  assert.equal(isProviderId("has/slash"), false);
  assert.equal(isProviderId(""), false);
  assert.equal(isProviderId(7), false);
});

// --------------------------------------------------------------- endpoint identity

test("endpointKey folds scheme case, host case, a trailing slash and the default port", () => {
  const key = endpointKey("https://api.z.ai/api/anthropic");
  // A hand-written settings env has no identity but its URL, so the key must
  // ignore everything that is spelling rather than identity.
  assert.equal(endpointKey("HTTPS://API.Z.ai:443/api/anthropic/"), key);
  assert.equal(endpointKey("  https://api.z.ai/api/anthropic  "), key);
  // the http default port is noise too, but a NON-default port is a distinction
  assert.equal(endpointKey("http://api.z.ai:80/anthropic"), endpointKey("http://api.z.ai/anthropic"));
  assert.notEqual(endpointKey("http://api.z.ai:8080/anthropic"), endpointKey("http://api.z.ai/anthropic"));
  // two endpoints on one host are two endpoints
  assert.notEqual(endpointKey("https://api.z.ai/api/paas/v4"), key);
  // unparsable input still gets a stable, case-folded key instead of throwing
  assert.equal(endpointKey("not a url"), "not a url");
  assert.equal(endpointKey("NOT A URL"), "not a url");
});

test("providerIdFromEndpoint mints a valid, stable id per endpoint", () => {
  const deepseek = providerIdFromEndpoint("https://api.deepseek.com/anthropic");
  const zai = providerIdFromEndpoint("https://api.z.ai/api/anthropic");
  const zaiPaas = providerIdFromEndpoint("https://api.z.ai/api/paas/v4");

  for (const id of [deepseek, zai, zaiPaas]) assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(providerIdFromEndpoint("HTTPS://API.DEEPSEEK.COM/anthropic/"), deepseek, "stable across spellings of one endpoint");
  assert.notEqual(zai, zaiPaas, "two endpoints on one host must not collide");
  assert.ok(deepseek.startsWith("api-deepseek-com"), deepseek);
});

test("uniqueProviderId keeps a free id and mints a valid, free one when taken", () => {
  assert.equal(uniqueProviderId("zai-plan", []), "zai-plan");
  assert.equal(uniqueProviderId("zai-plan", ["other"]), "zai-plan");

  const salted = uniqueProviderId("zai-plan", ["zai-plan"]);
  assert.notEqual(salted, "zai-plan");
  assert.match(salted, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(uniqueProviderId("zai-plan", ["zai-plan"]), salted, "stable for one wanted value");

  // an unusable name is slugified rather than rejected
  const slugged = uniqueProviderId("My Provider!", []);
  assert.match(slugged, /^[a-z0-9][a-z0-9-]*$/);
  assert.ok(slugged.startsWith("my-provider"), slugged);

  // when even the salted candidate is taken it falls back to a numbered one
  assert.equal(uniqueProviderId("zai-plan", ["zai-plan", salted]), "zai-plan-2");
});

// --------------------------------------------------------------- syncNativeProviders

test("syncNativeProviders refreshes the entry the endpoint names and keeps the user's id and label", () => {
  const store = upsertProvider(
    { providers: [], removed: [] },
    entry({
      id: "my-deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/anthropic",
      auth: { kind: "apiKey", value: "" },
      models: [{ id: "deepseek-chat" }],
      aliases: { sonnet: "deepseek-chat" },
    }),
  );

  const result = syncNativeProviders(store, [native()]);

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.updated, ["my-deepseek"]);
  assert.equal(result.store.providers.length, 1, "matching by endpoint must not append a duplicate");
  const refreshed = result.store.providers[0];
  assert.equal(refreshed.id, "my-deepseek", "the user's id survives a refresh");
  assert.equal(refreshed.label, "DeepSeek", "the panel's label survives a refresh");
  assert.equal(refreshed.baseUrl, "https://api.deepseek.com/anthropic");
  assert.deepEqual(refreshed.auth, { kind: "apiKey", value: "" }); // native held no key either
  // existing order first, then what only the native env knew about
  assert.deepEqual(refreshed.models.map((m) => m.id), ["deepseek-chat", "deepseek-reasoner"]);
  assert.deepEqual(refreshed.aliases, native().aliases, "the native env block is the statement about aliases");
});

test("syncNativeProviders matches on the endpoint across URL spellings, not on the string", () => {
  // The case this exists for: the user edits the base URL in the panel, or the
  // native file spells the same endpoint differently. Deduping on the raw
  // string would append a second copy of the same service on every sync.
  const store = upsertProvider(
    { providers: [], removed: [] },
    entry({ id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic" }),
  );

  const result = syncNativeProviders(store, [native({ baseUrl: "HTTPS://API.deepseek.com:443/anthropic/" })]);

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.updated, ["deepseek"]);
  assert.deepEqual(result.store.providers.map((p) => p.id), ["deepseek"], "the endpoint is the dedupe key");
  assert.equal(result.store.providers[0].baseUrl, "HTTPS://API.deepseek.com:443/anthropic/", "the endpoint is refreshed to the native spelling");
});

test("syncNativeProviders appends an unmatched native provider labelled with its endpoint", () => {
  const result = syncNativeProviders({ providers: [], removed: [] }, [native()]);

  assert.deepEqual(result.added, [providerIdFromEndpoint("https://api.deepseek.com/anthropic")]);
  assert.deepEqual(result.updated, []);
  const [added] = result.store.providers;
  // A settings env block has no friendly name to copy; the URL is the only
  // name it supplies, and inventing one would be a lie.
  assert.equal(added.label, "https://api.deepseek.com/anthropic");
  assert.equal(added.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(added.origin, "native");
  assert.deepEqual(added.models.map((m) => m.id), ["deepseek-chat", "deepseek-reasoner"]);
  assert.deepEqual(added.aliases, native().aliases);
});

test("syncNativeProviders gives every unmatched endpoint its own valid id", () => {
  const result = syncNativeProviders({ providers: [], removed: [] }, [
    native({ baseUrl: "https://api.z.ai/api/anthropic" }),
    native({ baseUrl: "https://api.z.ai/api/paas/v4" }),
    native({ baseUrl: "   " }),
  ]);

  assert.equal(result.added.length, 2, "an empty baseUrl is not a provider");
  assert.equal(new Set(result.added).size, 2, "two endpoints on one host need two ids");
  for (const id of result.added) {
    assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
    assert.equal(id, id.toLowerCase());
  }
});

test("syncNativeProviders never deletes: an entry whose endpoint left the settings stays", () => {
  const store = upsertProvider(
    { providers: [], removed: [] },
    entry({ id: "legacy", baseUrl: "https://legacy.example/anthropic", origin: "user" }),
  );

  const result = syncNativeProviders(store, [native()]);

  // A provider dropped from the settings env may still be one the user runs
  // through Super D, so the sync only ever adds and refreshes.
  assert.deepEqual(result.store.providers.map((p) => p.id), ["legacy", providerIdFromEndpoint("https://api.deepseek.com/anthropic")]);
  assert.equal(result.store.providers[0].origin, "user", "the untouched entry keeps its provenance");
});

test("syncNativeProviders unions model lists and never truncates what it already knew", () => {
  const store = upsertProvider(
    { providers: [], removed: [] },
    entry({
      id: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic",
      models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner", displayName: "Reasoner" }],
    }),
  );

  const result = syncNativeProviders(store, [
    native({
      models: [{ id: "deepseek-reasoner" }, { id: "deepseek-flash" }, { id: "deepseek-chat" }, { id: "deepseek-flash" }],
    }),
  ]);
  assert.deepEqual(
    result.store.providers[0].models.map((m) => m.id),
    ["deepseek-chat", "deepseek-reasoner", "deepseek-flash"],
    "existing order kept, new ids appended, duplicates dropped",
  );
  assert.equal(result.store.providers[0].models[1].displayName, "Reasoner", "an existing entry's decoration is not clobbered");
});

test("syncNativeProviders adopts native auth only when the entry holds no secret", () => {
  // An empty value means "Super D holds no key", so the native statement wins…
  const emptyKey = upsertProvider(
    { providers: [], removed: [] },
    entry({ id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", auth: { kind: "apiKey", value: "" }, models: [], aliases: native().aliases }),
  );
  const refilled = syncNativeProviders(emptyKey, [native({ auth: { kind: "authToken", value: "sk-native" }, models: [], })]);
  assert.deepEqual(refilled.store.providers[0].auth, { kind: "authToken", value: "sk-native" });
  assert.deepEqual(refilled.updated, ["deepseek"]);

  // …but a stored NON-EMPTY key must survive: dropping it in favour of the
  // native file would silently break a provider the user already configured.
  // The rest of the entry already matches, so a correct sync reports NOTHING.
  const keyed = upsertProvider(
    { providers: [], removed: [] },
    entry({
      id: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic",
      auth: { kind: "apiKey", value: "sk-mine" },
      models: [{ id: "deepseek-chat" }],
      aliases: native().aliases,
    }),
  );
  const kept = syncNativeProviders(keyed, [native({ auth: { kind: "authToken", value: "sk-native" }, models: [{ id: "deepseek-chat" }] })]);
  assert.deepEqual(kept.store.providers[0].auth, { kind: "apiKey", value: "sk-mine" });
  assert.deepEqual(kept.updated, [], "holding on to the key is not a change");
});

test("syncNativeProviders keeps an entry's aliases when the native env declares none", () => {
  // The fold never deletes: aliases only arrive from the native env block, so
  // an import that carries none leaves whatever the entry already had.
  const store = upsertProvider(
    { providers: [], removed: [] },
    entry({ id: "glm", baseUrl: "https://api.z.ai/api/anthropic", models: [], aliases: { sonnet: "glm-5.2" } }),
  );
  const result = syncNativeProviders(store, [
    native({ baseUrl: "https://api.z.ai/api/anthropic", auth: { kind: "authToken", value: "sk-mine" }, models: [], aliases: undefined }),
  ]);
  assert.deepEqual(result.store.providers[0].aliases, { sonnet: "glm-5.2" });
  assert.deepEqual(result.updated, [], "nothing moved, so nothing is reported");
});

test("a removed endpoint is tombstoned and the reconcile does not resurrect it", () => {
  const store = upsertProvider({ providers: [], removed: [] }, entry());
  const dropped = removeProvider(store, "zai-plan");

  assert.deepEqual(dropped.providers, []);
  assert.deepEqual(dropped.removed, [endpointKey("https://api.z.ai/api/anthropic")], "the endpoint is the identity that gets remembered");

  const reconciled = syncNativeProviders(dropped, [native({ baseUrl: "https://api.z.ai/api/anthropic" })]);
  assert.deepEqual(reconciled.added, [], "the user's removal must outlive a reconcile");
  assert.deepEqual(reconciled.store.providers, []);
  assert.deepEqual(reconciled.store.removed, dropped.removed, "and the tombstone is carried through the sync");
});

test("the reconcile still refreshes the providers that were NOT removed", () => {
  // The tombstone is per-endpoint, not a global mute: a second provider folded
  // in alongside the removed one must still be imported.
  const dropped = removeProvider(upsertProvider({ providers: [], removed: [] }, entry()), "zai-plan");
  const reconciled = syncNativeProviders(dropped, [
    native({ baseUrl: "https://api.z.ai/api/anthropic" }),
    native(),
  ]);
  assert.deepEqual(reconciled.added, [providerIdFromEndpoint("https://api.deepseek.com/anthropic")]);
  assert.deepEqual(reconciled.store.providers.map((p) => p.id), [providerIdFromEndpoint("https://api.deepseek.com/anthropic")]);
});

test("a reconcile of an unchanged provider reports nothing and returns an equivalent store", () => {
  // `next.auth` and `next.aliases` arrive as freshly parsed objects on every
  // tick, so the sync must compare them STRUCTURALLY — reference equality would
  // mark every reconcile as a change and rewrite a 0600 file that holds keys.
  const first = syncNativeProviders({ providers: [], removed: [] }, [native()]);
  const second = syncNativeProviders(first.store, [native()]);

  assert.deepEqual(second.added, []);
  assert.deepEqual(second.updated, [], "an unchanged provider is not an update");
  assert.deepEqual(second.store, first.store, "so the caller can skip the write");
});

test("the store round-trips tombstones and an empty list through the file", () => {
  const home = tempHome();
  const dropped = removeProvider(upsertProvider({ providers: [], removed: [] }, entry()), "zai-plan");
  writeProviderStore(home, dropped);
  assert.deepEqual(readProviderStore(home), dropped);

  // Unlike the codex store, `removed` is always carried — the file has no
  // omit-when-empty branch to test for.
  writeProviderStore(home, { providers: [], removed: [] });
  assert.deepEqual(readProviderStore(home), { providers: [], removed: [] });
  assert.deepEqual(JSON.parse(readFileSync(providerStorePath(home), "utf8")).removed, []);
});
