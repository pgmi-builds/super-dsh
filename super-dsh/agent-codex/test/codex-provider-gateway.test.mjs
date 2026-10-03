// src/codex-provider-gateway.ts — the adapter-owned Remote behind the Hub's
// Codex settings panel (2026-10-03 user ruling; reworked 2026-10-04).
//
// The panel's whole contract lives here, and it is deliberately testable without
// a Cordis Context: every operation is a plain function over (worldHome,
// codexHome); the TypertRemoteService subclass is a short delegation shell.
//
// Pinned here:
//   - the view NEVER carries an API key value, only `hasKey` — the panel can set
//     a key and see that one exists, and can never read one back;
//   - both wire protocols are advertised, but `chat` is unavailable and carries
//     the binary's own sentence as its hint (codex 0.154 refuses it at config
//     load, so offering it unmarked would let a user brick their own runtime);
//   - save validates at the boundary and names the offending field, and an empty
//     model list is legal because an imported provider may not know its models;
//   - the store is populated from the live config.toml by a SYNC, not by a seed,
//     and the sync writes the store only when something actually moved;
//   - NOTHING NATIVE IS WRITTEN ANY MORE: save/remove touch the store alone.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const {
  readProvidersView,
  saveProvider,
  removeProviderEntry,
  syncFromNative,
  normalizeSaveRequest,
  PROTOCOL_OPTIONS,
} = await import("../dist/codex-provider-gateway.js");
const { providerStorePath, readProviderStore, writeProviderStore } = await import("../dist/codex-providers.js");

function tempHome(name) {
  return mkdtempSync(join(tmpdir(), `superd-codex-gw-${name}-`));
}

/** A realistic live config: one provider in force, plus one merely declared. */
const NATIVE_CONFIG = `model_provider = "deepseek"
model = "deepseek-flash"
model_catalog_json = "cc-switch-model-catalog.json"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
env_key = "DEEPSEEK_API_KEY"

[model_providers.zai-plan]
name = "Z.ai Plan"
base_url = "https://api.z.ai/api/coding/paas/v4"
wire_api = "responses"
env_key = "ZAI_API_KEY"
`;

/** One provider the panel already saved, holding its own key. */
function stored(id, baseUrl, models = []) {
  return {
    id,
    label: id,
    baseUrl,
    protocol: "responses",
    auth: { kind: "apiKey", value: `sk-${id}` },
    models,
    origin: "user",
  };
}

function seeded() {
  const worldHome = tempHome("world");
  const codexHome = tempHome("codex");
  writeFileSync(join(codexHome, "config.toml"), NATIVE_CONFIG);
  writeFileSync(
    join(codexHome, "cc-switch-model-catalog.json"),
    JSON.stringify({ models: [{ slug: "deepseek-flash", display_name: "DeepSeek Flash", base_instructions: "tpl", priority: 1 }] }),
  );
  return { worldHome, codexHome };
}

const SAVE = {
  provider: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "responses",
    auth: { kind: "apiKey", value: "sk-or-secret" },
    models: [{ id: "glm-5.2", displayName: "GLM-5.2", contextWindow: 1000000 }],
  },
};

// ------------------------------------------------------------------ protocols

test("both wire protocols are advertised, but chat says why it is unusable", () => {
  const chat = PROTOCOL_OPTIONS.find((option) => option.value === "chat");
  const responses = PROTOCOL_OPTIONS.find((option) => option.value === "responses");
  assert.equal(responses?.available, true);
  assert.equal(chat?.available, false);
  // the binary's own sentence, so the reason is never our paraphrase
  assert.match(chat?.hint ?? "", /wire_api = "chat"` is no longer supported/);
  assert.match(chat?.hint ?? "", /set `wire_api = "responses"`/);
});

// ------------------------------------------------------------------ sync from native

test("an empty store is populated from the live config.toml by the sync", () => {
  const { worldHome, codexHome } = seeded();
  assert.ok(!existsSync(providerStorePath(worldHome)), "nothing stored yet");

  const view = readProvidersView(worldHome, codexHome);
  assert.deepEqual(view.providers.map((p) => p.id), ["deepseek", "zai-plan"]);
  const deepseek = view.providers.find((p) => p.id === "deepseek");
  assert.equal(deepseek?.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(deepseek?.protocol, "responses");
  assert.equal(deepseek?.authKind, "env");
  // Only the provider IN FORCE has a discoverable catalog; the declared-but-idle
  // one arrives with an empty list rather than an invented one.
  assert.deepEqual(deepseek?.models.map((m) => m.id), ["deepseek-flash"]);
  assert.deepEqual(view.providers.find((p) => p.id === "zai-plan")?.models, []);

  // `native` is what the user's own codex CLI runs — informational, no action.
  assert.deepEqual(view.native, { providerId: "deepseek", model: "deepseek-flash" });
  assert.ok(!("selected" in view), "the selection moved to DSH's per-session model choice");
  assert.ok(!("effective" in view), "`effective` was renamed to `native`");
  assert.match(view.note ?? "", /Imported 2 provider\(s\)/);

  // the import is persisted, so the second read is a plain read
  assert.deepEqual(readProviderStore(worldHome).providers.map((p) => p.id), ["deepseek", "zai-plan"]);
  assert.equal(readProvidersView(worldHome, codexHome).providers.length, 2);
});

test("a read of a home that declares nothing imports nothing and writes nothing", () => {
  const worldHome = tempHome("world-empty");
  const codexHome = tempHome("codex-empty");
  const view = readProvidersView(worldHome, codexHome);
  assert.deepEqual(view.providers, []);
  assert.equal(view.native, null);
  assert.ok(!existsSync(providerStorePath(worldHome)), "an empty read writes nothing");
});

test("syncFromNative writes the store only when something moved", () => {
  const worldHome = tempHome("world-sync");
  const codexHome = tempHome("codex-sync");
  writeFileSync(join(codexHome, "config.toml"), NATIVE_CONFIG);
  writeFileSync(join(codexHome, "cc-switch-model-catalog.json"), JSON.stringify({ models: [{ slug: "deepseek-flash" }] }));
  // Both entries already match the native tables AND hold their own keys, so
  // they are fully comparable and the sync has nothing left to report.
  writeProviderStore(worldHome, {
    version: 1,
    providers: [
      stored("deepseek", "https://api.deepseek.com/v1", [{ id: "deepseek-flash" }]),
      stored("zai-plan", "https://api.z.ai/api/coding/paas/v4"),
    ],
  });

  const first = syncFromNative(worldHome, codexHome);
  assert.deepEqual(first.added, []);
  assert.deepEqual(first.updated, []);

  const path = providerStorePath(worldHome);
  const stamp = statSync(path, { bigint: true }).mtimeNs;
  const second = syncFromNative(worldHome, codexHome);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.updated, []);
  // The guarantee the caller relies on: an unchanged sync leaves no trace on disk.
  assert.equal(statSync(path, { bigint: true }).mtimeNs, stamp);

  // A change in the native file IS folded in and reported.
  writeFileSync(join(codexHome, "config.toml"), NATIVE_CONFIG.replace("https://api.deepseek.com/v1", "https://api.deepseek.com/v2"));
  const third = syncFromNative(worldHome, codexHome);
  assert.deepEqual(third.updated, ["deepseek"]);
  assert.equal(third.store.providers.find((p) => p.id === "deepseek")?.baseUrl, "https://api.deepseek.com/v2");
});

// ------------------------------------------------------------------ key privacy

test("the view reports hasKey and never carries the key value", () => {
  const { worldHome, codexHome } = seeded();
  readProvidersView(worldHome, codexHome); // the panel's first get imports the native list
  const after = saveProvider(worldHome, codexHome, SAVE);
  const mine = after.providers.find((p) => p.id === "openrouter");
  assert.equal(mine?.authKind, "apiKey");
  assert.equal(mine?.hasKey, true);
  assert.ok(!JSON.stringify(after).includes("sk-or-secret"), "the key must never cross the wire");
  // an env provider's variable NAME is not a secret — the panel shows it so the
  // user knows which variable to export; only the stored key value is withheld.
  assert.equal(after.providers.find((p) => p.id === "deepseek")?.envName, "DEEPSEEK_API_KEY");
});

test("hasKey is also true for a seeded keyed provider whose key lives in auth.json", () => {
  const worldHome = tempHome("world-nokey");
  const codexHome = tempHome("codex-nokey");
  writeFileSync(join(codexHome, "config.toml"), NATIVE_CONFIG.replace('env_key = "DEEPSEEK_API_KEY"', "requires_openai_auth = true"));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "in-file" }));
  const view = readProvidersView(worldHome, codexHome);
  assert.equal(view.providers[0].authKind, "apiKey");
  assert.equal(view.providers[0].hasKey, true);
});

test("hasKey is false when nothing holds a key, and saving writes only the store", () => {
  const { worldHome, codexHome } = seeded();
  readProvidersView(worldHome, codexHome);
  const empty = { provider: { ...SAVE.provider, id: "keyless", auth: { kind: "apiKey", value: "" } } };
  const view = saveProvider(worldHome, codexHome, empty);
  assert.equal(view.providers.find((p) => p.id === "keyless")?.hasKey, false);
  // Nothing native is written any more — the old build would have materialized
  // the (empty) key into the runtime's auth.json here.
  assert.ok(!existsSync(join(codexHome, "auth.json")), "no native auth.json is created");
});

// ------------------------------------------------------------------ validation

test("normalizeSaveRequest rejects bad input and names the field", () => {
  const cases = [
    [{ provider: { ...SAVE.provider, id: "Bad Id" } }, /id/],
    [{ provider: { ...SAVE.provider, id: undefined } }, /id/],
    [{ provider: { ...SAVE.provider, label: "" } }, /label/],
    [{ provider: { ...SAVE.provider, baseUrl: "not-a-url" } }, /baseUrl/],
    [{ provider: { ...SAVE.provider, protocol: "grpc" } }, /protocol/],
    [{ provider: { ...SAVE.provider, protocol: "chat" } }, /chat/],
    [{ provider: { ...SAVE.provider, models: "nope" } }, /models/],
    [{ provider: { ...SAVE.provider, models: [{ id: "" }] } }, /models/],
    [{ provider: { ...SAVE.provider, auth: { kind: "magic" } } }, /auth/],
    [{}, /provider/],
    [null, /provider/],
  ];
  for (const [request, pattern] of cases) {
    assert.throws(() => normalizeSaveRequest(request), pattern, JSON.stringify(request));
  }
});

test("normalizeSaveRequest accepts an empty model list", () => {
  // A provider imported from a native config that is not in force has no
  // discoverable models, so the panel must be able to save the state it was
  // handed instead of inventing one.
  const empty = normalizeSaveRequest({ provider: { ...SAVE.provider, models: [] } });
  assert.deepEqual(empty.models, []);
  assert.equal(empty.origin, "user");

  const entry = normalizeSaveRequest({ provider: { ...SAVE.provider, baseUrl: "http://localhost:8080/v1" } });
  assert.equal(entry.baseUrl, "http://localhost:8080/v1");
  assert.throws(() => normalizeSaveRequest({ provider: { ...SAVE.provider, baseUrl: "ftp://x/v1" } }), /baseUrl/);
  // a model without a display name falls back to its id
  const named = normalizeSaveRequest({ provider: { ...SAVE.provider, models: [{ id: "m" }] } });
  assert.equal(named.models[0].id, "m");
});

// ------------------------------------------------------------------ mutations

test("saving a provider writes only the store and leaves the native home byte-identical", () => {
  const { worldHome, codexHome } = seeded();
  const configBefore = readFileSync(join(codexHome, "config.toml"));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "native-key" }, null, 2));
  const authBefore = readFileSync(join(codexHome, "auth.json"));

  const view = saveProvider(worldHome, codexHome, SAVE);

  assert.deepEqual(view.providers.map((p) => p.id), ["openrouter"], "save does not sync; get does");
  // The 2026-10-04 rework turned the native home into a read-only SOURCE: the
  // panel's writes land in the adapter's own store and nowhere else.
  assert.deepEqual(readFileSync(join(codexHome, "config.toml")), configBefore);
  assert.deepEqual(readFileSync(join(codexHome, "auth.json")), authBefore);
  assert.equal(readProviderStore(worldHome).providers[0].auth.value, "sk-or-secret");
});

test("removing a provider drops it from the store and leaves the native home alone", () => {
  const { worldHome, codexHome } = seeded();
  const configBefore = readFileSync(join(codexHome, "config.toml"));
  readProvidersView(worldHome, codexHome); // imports deepseek + zai-plan

  const removed = removeProviderEntry(worldHome, codexHome, { id: "zai-plan" });

  assert.deepEqual(removed.providers.map((p) => p.id), ["deepseek"]);
  // Leaving the list is not unconfiguring Codex: the native file still names
  // what it named, and the view still reports it as in force.
  assert.deepEqual(readFileSync(join(codexHome, "config.toml")), configBefore);
  assert.equal(removed.native?.providerId, "deepseek");
  assert.throws(() => removeProviderEntry(worldHome, codexHome, {}), /id/);
});

test("the view reports the paths the panel is going to read and write", () => {
  const { worldHome, codexHome } = seeded();
  const view = readProvidersView(worldHome, codexHome);
  assert.deepEqual(view.paths, {
    store: providerStorePath(worldHome),
    config: join(codexHome, "config.toml"),
    auth: join(codexHome, "auth.json"),
    // a DIRECTORY: one catalog file per provider now lives under the world home
    catalogs: join(worldHome, "codex-catalogs"),
  });
});

// ------------------------------------------------------------------ edit in place

test("saving an existing id edits it in place and keeps its stored key when none is re-typed", () => {
  const { worldHome, codexHome } = seeded();
  saveProvider(worldHome, codexHome, SAVE);
  const view = saveProvider(worldHome, codexHome, {
    provider: { ...SAVE.provider, label: "OpenRouter (renamed)", auth: { kind: "apiKey", value: "" } },
  });
  assert.equal(view.providers.filter((p) => p.id === "openrouter").length, 1);
  assert.equal(view.providers.find((p) => p.id === "openrouter")?.label, "OpenRouter (renamed)");
  assert.equal(view.providers.find((p) => p.id === "openrouter")?.hasKey, true, "the key survived the edit");
  assert.equal(readProviderStore(worldHome).providers.find((p) => p.id === "openrouter").auth.value, "sk-or-secret");
});

// ------------------------------------------------------------------ shadowed key

// Measured 2026-10-03: with `auth_mode: chatgpt` in the runtime's auth.json,
// codex refreshes the OAuth token first and never falls through to the
// OPENAI_API_KEY in the same file — a `requires_openai_auth` provider looks
// configured and cannot run. The panel must not stay silent about that.
test("a keyed provider behind a ChatGPT login is called out", () => {
  const { worldHome, codexHome } = seeded();
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: "sk-x", tokens: {} }));
  writeFileSync(
    join(codexHome, "config.toml"),
    'model_provider = "keyed"\nmodel = "m"\n\n[model_providers.keyed]\nname = "K"\nbase_url = "https://api.deepseek.com/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n',
  );
  const view = readProvidersView(worldHome, codexHome);
  assert.match(view.note ?? "", /ChatGPT account, which takes precedence/);

  // An env-shaped provider is unaffected, so the note must not appear for one.
  writeFileSync(join(codexHome, "config.toml"), NATIVE_CONFIG);
  const envView = readProvidersView(tempHome("world-env"), codexHome);
  assert.ok(!(envView.note ?? "").includes("takes precedence"));
});
