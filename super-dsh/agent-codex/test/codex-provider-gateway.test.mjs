// src/codex-provider-gateway.ts — the adapter-owned Remote behind the Hub's
// Codex settings panel (2026-10-03 user ruling).
//
// The panel's whole contract lives here, and it is deliberately testable without
// a Cordis Context: every operation is a plain function over (worldHome,
// codexHome); the TypertRemoteService subclass is a five-line delegation shell.
//
// Pinned here:
//   - the view NEVER carries an API key value, only `hasKey` — the panel can set
//     a key and see that one exists, and can never read one back;
//   - both wire protocols are advertised, but `chat` is unavailable and carries
//     the binary's own sentence as its hint (codex 0.154 refuses it at config
//     load, so offering it unmarked would let a user brick their own runtime);
//   - save validates at the boundary and names the offending field;
//   - an empty store seeds itself from the user's live config.toml on first read,
//     so the panel opens on what is actually in force rather than on nothing;
//   - selecting writes the native config BEFORE recording the choice, so a failed
//     write never leaves a selection that is not in force.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const {
  readProvidersView,
  saveProvider,
  removeProviderEntry,
  selectProviderEntry,
  normalizeSaveRequest,
  PROTOCOL_OPTIONS,
} = await import("../dist/codex-provider-gateway.js");
const { providerStorePath, readProviderStore } = await import("../dist/codex-providers.js");

function tempHome(name) {
  return mkdtempSync(join(tmpdir(), `superd-codex-gw-${name}-`));
}

/** The user's live config: one env-keyed provider, already in force. */
const NATIVE_CONFIG = `model_provider = "deepseek"
model = "deepseek-flash"
model_catalog_json = "cc-switch-model-catalog.json"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
env_key = "DEEPSEEK_API_KEY"
`;

function seeded() {
  const worldHome = tempHome("world");
  const codexHome = tempHome("codex");
  writeFileSync(join(codexHome, "config.toml"), NATIVE_CONFIG);
  writeFileSync(join(codexHome, "cc-switch-model-catalog.json"), JSON.stringify({ models: [{ slug: "deepseek-flash", display_name: "DeepSeek Flash", base_instructions: "tpl", priority: 1 }] }));
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

// ------------------------------------------------------------------ seeding

test("an empty store seeds itself from the live config.toml and says so", () => {
  const { worldHome, codexHome } = seeded();
  assert.ok(!existsSync(providerStorePath(worldHome)), "nothing stored yet");

  const view = readProvidersView(worldHome, codexHome);
  assert.deepEqual(view.providers.map((p) => p.id), ["deepseek"]);
  assert.equal(view.providers[0].baseUrl, "https://api.deepseek.com/v1");
  assert.equal(view.providers[0].protocol, "responses");
  assert.deepEqual(view.providers[0].models.map((m) => m.id), ["deepseek-flash"]);
  assert.equal(view.providers[0].authKind, "env");
  assert.equal(view.selected, "deepseek");
  assert.match(view.note ?? "", /imported .* from your Codex config/i);
  // the seed is persisted, so the second read is a plain read
  assert.deepEqual(readProviderStore(worldHome).providers.map((p) => p.id), ["deepseek"]);
  assert.equal(readProvidersView(worldHome, codexHome).providers.length, 1);
});

test("seeding is skipped (with a reason) when the config names nothing usable", () => {
  const worldHome = tempHome("world-empty");
  const codexHome = tempHome("codex-empty");
  const view = readProvidersView(worldHome, codexHome);
  assert.deepEqual(view.providers, []);
  assert.equal(view.selected, null);
  assert.equal(view.effective, null);
  assert.ok(!existsSync(providerStorePath(worldHome)), "an empty read writes nothing");
});

// ------------------------------------------------------------------ key privacy

test("the view reports hasKey and never carries the key value", () => {
  const { worldHome, codexHome } = seeded();
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

test("hasKey is false when nothing holds a key, and selecting then leaves auth.json alone", () => {
  const { worldHome, codexHome } = seeded();
  const empty = { provider: { ...SAVE.provider, id: "keyless", auth: { kind: "apiKey", value: "" } } };
  let view = saveProvider(worldHome, codexHome, empty);
  assert.equal(view.providers.find((p) => p.id === "keyless")?.hasKey, false);

  view = selectProviderEntry(worldHome, codexHome, { id: "keyless" });
  assert.equal(view.effective?.providerId, "keyless");
  assert.ok(!existsSync(join(codexHome, "auth.json")), "there was no key to write");
  assert.match(readFileSync(join(codexHome, "config.toml"), "utf8"), /requires_openai_auth = true/);
});

// ------------------------------------------------------------------ validation

test("normalizeSaveRequest rejects bad input and names the field", () => {
  const cases = [
    [{ provider: { ...SAVE.provider, id: "Bad Id" } }, /id/],
    [{ provider: { ...SAVE.provider, label: "" } }, /label/],
    [{ provider: { ...SAVE.provider, baseUrl: "not-a-url" } }, /baseUrl/],
    [{ provider: { ...SAVE.provider, protocol: "grpc" } }, /protocol/],
    [{ provider: { ...SAVE.provider, protocol: "chat" } }, /chat/],
    [{ provider: { ...SAVE.provider, models: [] } }, /models/],
    [{ provider: { ...SAVE.provider, models: [{ id: "" }] } }, /models/],
    [{ provider: { ...SAVE.provider, auth: { kind: "magic" } } }, /auth/],
    [{}, /provider/],
    [null, /provider/],
  ];
  for (const [request, pattern] of cases) {
    assert.throws(() => normalizeSaveRequest(request), pattern, JSON.stringify(request));
  }
});

test("normalizeSaveRequest fills defaults and accepts ftp-free http(s) only", () => {
  const entry = normalizeSaveRequest({ provider: { ...SAVE.provider, baseUrl: "http://localhost:8080/v1" } });
  assert.equal(entry.baseUrl, "http://localhost:8080/v1");
  assert.throws(() => normalizeSaveRequest({ provider: { ...SAVE.provider, baseUrl: "ftp://x/v1" } }), /baseUrl/);
  // a model without a display name falls back to its id
  const named = normalizeSaveRequest({ provider: { ...SAVE.provider, models: [{ id: "m" }] } });
  assert.equal(named.models[0].id, "m");
});

// ------------------------------------------------------------------ mutations

test("save -> select writes the native config, then the store records the choice", () => {
  const { worldHome, codexHome } = seeded();
  let view = saveProvider(worldHome, codexHome, SAVE);
  assert.deepEqual(view.providers.map((p) => p.id).sort(), ["deepseek", "openrouter"]);
  assert.equal(view.selected, "deepseek", "saving does not switch");
  assert.equal(view.effective?.providerId, "deepseek");

  view = selectProviderEntry(worldHome, codexHome, { id: "openrouter" });
  assert.equal(view.selected, "openrouter");
  assert.equal(view.effective?.providerId, "openrouter");
  assert.equal(view.effective?.model, "glm-5.2");
  assert.equal(readProviderStore(worldHome).selected, "openrouter");

  const config = readFileSync(join(codexHome, "config.toml"), "utf8");
  assert.match(config, /^model_provider = "openrouter"$/m);
  assert.match(config, /^model = "glm-5\.2"$/m);
  assert.match(config, /^\[model_providers\.deepseek\]$/m, "the previous provider stays usable");
  assert.equal(JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")).OPENAI_API_KEY, "sk-or-secret");
});

test("selecting an unknown provider is refused and changes nothing", () => {
  const { worldHome, codexHome } = seeded();
  const before = readFileSync(join(codexHome, "config.toml"), "utf8");
  assert.throws(() => selectProviderEntry(worldHome, codexHome, { id: "ghost" }), /unknown provider/);
  assert.equal(readFileSync(join(codexHome, "config.toml"), "utf8"), before);
});

test("select(null) clears the explicit choice and leaves the runtime where it is", () => {
  const { worldHome, codexHome } = seeded();
  saveProvider(worldHome, codexHome, SAVE);
  selectProviderEntry(worldHome, codexHome, { id: "openrouter" });
  const view = selectProviderEntry(worldHome, codexHome, null);
  assert.equal(view.selected, null);
  // clearing a preference is not a request to unconfigure Codex
  assert.equal(view.effective?.providerId, "openrouter");
  assert.equal(readProviderStore(worldHome).selected, undefined);
});

test("removing a provider drops it, and removing the active one still says what runs", () => {
  const { worldHome, codexHome } = seeded();
  saveProvider(worldHome, codexHome, SAVE);
  selectProviderEntry(worldHome, codexHome, { id: "openrouter" });

  const view = removeProviderEntry(worldHome, codexHome, { id: "openrouter" });
  assert.deepEqual(view.providers.map((p) => p.id), ["deepseek"]);
  assert.equal(view.selected, null);
  // the native config is untouched: codex keeps running the provider we removed
  assert.equal(view.effective?.providerId, "openrouter");
  assert.match(view.note ?? "", /openrouter/);
  assert.throws(() => removeProviderEntry(worldHome, codexHome, {}), /id/);
});

test("the view always reports the paths the panel is going to write", () => {
  const { worldHome, codexHome } = seeded();
  const view = readProvidersView(worldHome, codexHome);
  assert.deepEqual(view.paths, {
    store: providerStorePath(worldHome),
    config: join(codexHome, "config.toml"),
    auth: join(codexHome, "auth.json"),
    catalog: join(codexHome, "superd-model-catalog.json"),
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
