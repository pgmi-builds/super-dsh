// src/claude-provider-gateway.ts — the adapter-owned Remote behind the Hub's
// Claude settings panel (2026-10-04 multi-provider ruling).
//
// The panel's whole contract lives here, and it is deliberately testable without
// a Cordis Context: every operation is a plain function over (worldHome,
// claudeHome); the TypertRemoteService subclass is a short delegation shell.
//
// Pinned here:
//   - the view NEVER carries a key value, only `hasKey` — and that goes for the
//     key the panel saved AND the key folded in from the user's own settings
//     env (JSON.stringify the whole view; neither secret may appear);
//   - save validates at the boundary and names the offending field; auth accepts
//     exactly `authToken` | `apiKey` (claude has no env-by-name shape — that is
//     the codex alphabet, and asking for it must be refused loudly), and an
//     empty model list is legal because a folded provider may not know its
//     models;
//   - an edit that does not re-type the key keeps the stored one, per kind;
//   - the store is populated from the live settings.json by a SYNC, not by a
//     seed, and the sync writes the store only when something actually moved;
//   - NOTHING NATIVE IS WRITTEN: save/remove touch the store alone, and removing
//     a native-declared provider tombstones its endpoint so the next reconcile
//     cannot bring it back;
//   - `native` is a read-only projection of the user's settings env — the
//     endpoint in force and the model their own CLI runs, nothing more;
//   - `aliases` is native-fold-derived state the panel never writes: an edit
//     drops them and the next reconcile re-derives them.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const {
  readProvidersView,
  saveProvider,
  removeProviderEntry,
  syncFromNative,
  normalizeSaveRequest,
  ClaudeProvidersGateway,
} = await import("../dist/claude-provider-gateway.js");
const { providerStorePath, readProviderStore, writeProviderStore } = await import("../dist/claude-providers.js");

function tempHome(name) {
  return mkdtempSync(join(tmpdir(), `superd-claude-gw-${name}-`));
}

/** The measured live shape (spec §1): one DeepSeek endpoint keyed by `ANTHROPIC_API_KEY`, two alias models. */
const NATIVE_SETTINGS = {
  permissions: { allow: ["Bash(ls:*)"] },
  env: {
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_API_KEY: "sk-native-secret",
    ANTHROPIC_MODEL: "deepseek-flash",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-flash",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
    API_TIMEOUT_MS: "3000000",
  },
};

/** A world home plus a native home whose settings.json declares the live shape. */
function seeded() {
  const worldHome = tempHome("world");
  const claudeHome = tempHome("claude");
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify(NATIVE_SETTINGS, null, 2));
  return { worldHome, claudeHome };
}

/** A store entry that already matches the native fold exactly, under the user's own id. */
const MATCHING_ENTRY = {
  id: "deepseek",
  label: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic",
  auth: { kind: "apiKey", value: "sk-native-secret" },
  models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
  aliases: { sonnet: "deepseek-flash", opus: "deepseek-v4-pro" },
  origin: "user",
};

/** One panel save: the GLM Coding Plan endpoint, keyed the Bearer way. */
const SAVE = {
  provider: {
    id: "glm",
    label: "GLM Coding Plan",
    baseUrl: "https://api.z.ai/api/anthropic",
    auth: { kind: "authToken", value: "zai-plan-token" },
    models: [{ id: "glm-5.3", displayName: "GLM-5.3", contextWindow: 1000000 }],
  },
};

// ------------------------------------------------------------------ sync from native

test("an empty store is populated from the live settings.json by the sync", () => {
  const { worldHome, claudeHome } = seeded();
  assert.ok(!existsSync(providerStorePath(worldHome)), "nothing stored yet");

  const view = readProvidersView(worldHome, claudeHome);
  assert.equal(view.providers.length, 1);
  const folded = view.providers[0];
  assert.equal(folded.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(folded.authKind, "apiKey");
  assert.equal(folded.hasKey, true);
  // the only models a settings env reveals are the DEFAULT_*_MODEL alias values
  assert.deepEqual(folded.models.map((m) => m.id), ["deepseek-flash", "deepseek-v4-pro"]);
  assert.ok(!("protocol" in folded), "claude has no wire-protocol face");
  assert.ok(!("envName" in folded), "claude has no env-by-name auth shape");

  // `native` is what the user's own Claude runs — informational, no action.
  assert.deepEqual(view.native, { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash" });
  assert.ok(!("selected" in view), "the selection moved to DSH's per-session model choice");
  assert.match(view.note ?? "", /Imported 1 provider\(s\) from your Claude settings\.json\./);

  // the import is persisted, so the second read is a plain read
  assert.equal(readProviderStore(worldHome).providers.length, 1);
  const again = readProvidersView(worldHome, claudeHome);
  assert.equal(again.providers.length, 1);
  assert.equal(again.note, undefined, "a quiet reconcile says nothing");
  assert.ok(typeof again.syncedAt === "number");
});

test("a read of a home that declares nothing imports nothing and writes nothing", () => {
  const worldHome = tempHome("world-empty");
  const claudeHome = tempHome("claude-empty");
  const view = readProvidersView(worldHome, claudeHome);
  assert.deepEqual(view.providers, []);
  assert.equal(view.native, null);
  assert.ok(!existsSync(providerStorePath(worldHome)), "an empty read writes nothing");
});

test("a native setup without a base URL still reports its model, and folds nothing", () => {
  // A settings env on the default Anthropic endpoint carries a perfectly
  // meaningful ANTHROPIC_MODEL but no endpoint to dedupe a provider by.
  const claudeHome = tempHome("claude-modelonly");
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ env: { ANTHROPIC_MODEL: "sonnet" } }));
  const view = readProvidersView(tempHome("world-modelonly"), claudeHome);
  assert.deepEqual(view.providers, []);
  assert.deepEqual(view.native, { model: "sonnet" });
});

test("syncFromNative writes the store only when something moved", () => {
  const { worldHome, claudeHome } = seeded();
  // The entry already matches the native table AND holds its own key, so the
  // two are fully comparable and the sync has nothing left to report.
  writeProviderStore(worldHome, { providers: [MATCHING_ENTRY], removed: [] });

  const first = syncFromNative(worldHome, claudeHome);
  assert.deepEqual(first.added, []);
  assert.deepEqual(first.updated, []);

  const path = providerStorePath(worldHome);
  const stamp = statSync(path, { bigint: true }).mtimeNs;
  const second = syncFromNative(worldHome, claudeHome);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.updated, []);
  // The guarantee the caller relies on: an unchanged sync leaves no trace on disk.
  assert.equal(statSync(path, { bigint: true }).mtimeNs, stamp);

  // A change the endpoint still names IS folded in and reported — here a new alias model.
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
    ...NATIVE_SETTINGS,
    env: { ...NATIVE_SETTINGS.env, ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4.5" },
  }));
  const third = syncFromNative(worldHome, claudeHome);
  assert.deepEqual(third.updated, ["deepseek"]);
  assert.ok(third.store.providers[0].models.some((m) => m.id === "deepseek-v4.5"));
});

// ------------------------------------------------------------------ key privacy

test("the view reports hasKey and never carries a key value — stored or folded", () => {
  const { worldHome, claudeHome } = seeded();
  const imported = readProvidersView(worldHome, claudeHome); // the panel's first get folds sk-native-secret in
  const after = saveProvider(worldHome, claudeHome, SAVE);
  const mine = after.providers.find((p) => p.id === "glm");
  assert.equal(mine?.authKind, "authToken");
  assert.equal(mine?.hasKey, true);
  for (const view of [imported, after]) {
    assert.ok(!JSON.stringify(view).includes("zai-plan-token"), "the saved key must never cross the wire");
    assert.ok(!JSON.stringify(view).includes("sk-native-secret"), "the folded native key must never cross the wire");
  }
  // the store DOES hold both — the panel is write-only for keys, not blind
  assert.equal(readProviderStore(worldHome).providers.find((p) => p.id === "glm").auth.value, "zai-plan-token");
});

test("hasKey is false when nothing holds a key, and saving writes only the store", () => {
  const { worldHome, claudeHome } = seeded();
  readProvidersView(worldHome, claudeHome);
  const empty = { provider: { ...SAVE.provider, id: "keyless", auth: { kind: "apiKey", value: "" } } };
  const view = saveProvider(worldHome, claudeHome, empty);
  assert.equal(view.providers.find((p) => p.id === "keyless")?.hasKey, false);
  // Claude has no auth-manager file to fall back on, so nothing else may appear
  // in the native home either.
  assert.deepEqual(readdirSync(claudeHome), ["settings.json"], "no native file is created");
});

// ------------------------------------------------------------------ validation

test("normalizeSaveRequest rejects bad input and names the field", () => {
  const cases = [
    [{ provider: { ...SAVE.provider, id: "Bad Id" } }, /id/],
    [{ provider: { ...SAVE.provider, id: undefined } }, /id/],
    [{ provider: { ...SAVE.provider, id: "glm/x" } }, /id/],
    [{ provider: { ...SAVE.provider, label: "" } }, /label/],
    [{ provider: { ...SAVE.provider, baseUrl: "not-a-url" } }, /baseUrl/],
    [{ provider: { ...SAVE.provider, baseUrl: "ftp://x/anthropic" } }, /baseUrl/],
    [{ provider: { ...SAVE.provider, models: "nope" } }, /models/],
    [{ provider: { ...SAVE.provider, models: [{ id: "" }] } }, /models/],
    [{ provider: { ...SAVE.provider, auth: { kind: "magic" } } }, /auth/],
    // the codex env-by-name shape is not a claude kind — the refusal names it
    [{ provider: { ...SAVE.provider, auth: { kind: "env", name: "GLM_API_KEY" } } }, /"env"/],
    [{ provider: { ...SAVE.provider, auth: { kind: "apiKey" } } }, /auth\.value/],
    [{}, /provider/],
    [null, /provider/],
  ];
  for (const [request, pattern] of cases) {
    assert.throws(() => normalizeSaveRequest(request), pattern, JSON.stringify(request));
  }
  // the refusal names the two accepted kinds, so the panel can render it
  assert.throws(
    () => normalizeSaveRequest({ provider: { ...SAVE.provider, auth: { kind: "magic" } } }),
    /auth\.kind must be "authToken" or "apiKey" \(got "magic"\)/,
  );
});

test("normalizeSaveRequest accepts an empty model list and plain shapes", () => {
  // A provider folded in from a settings env that names no alias model has no
  // discoverable models, so the panel must be able to save the state it was
  // handed instead of inventing one.
  const empty = normalizeSaveRequest({ provider: { ...SAVE.provider, models: [] } });
  assert.deepEqual(empty.models, []);
  assert.equal(empty.origin, "user");
  assert.ok(!("aliases" in empty), "aliases are native-fold-derived; the panel never writes them");

  const entry = normalizeSaveRequest({ provider: { ...SAVE.provider, baseUrl: "http://localhost:8080/anthropic" } });
  assert.equal(entry.baseUrl, "http://localhost:8080/anthropic");
  assert.deepEqual(entry.auth, { kind: "authToken", value: "zai-plan-token" });
  // a model without a display name falls back to its id
  const named = normalizeSaveRequest({ provider: { ...SAVE.provider, models: [{ id: "m" }] } });
  assert.equal(named.models[0].id, "m");
  assert.deepEqual(Object.keys(named.models[0]), ["id"]);
});

// ------------------------------------------------------------------ mutations

test("saving a provider writes only the store and leaves the native home byte-identical", () => {
  const { worldHome, claudeHome } = seeded();
  const settingsBefore = readFileSync(join(claudeHome, "settings.json"));

  const view = saveProvider(worldHome, claudeHome, SAVE);

  assert.deepEqual(view.providers.map((p) => p.id), ["glm"], "save does not sync; get does");
  // The native home is a read-only SOURCE: the panel's writes land in the
  // adapter's own store and nowhere else.
  assert.deepEqual(readFileSync(join(claudeHome, "settings.json")), settingsBefore);
  assert.equal(readProviderStore(worldHome).providers[0].auth.value, "zai-plan-token");
  assert.equal(view.syncedAt, undefined, "a mutation reports no reconcile time it did not run");
});

test("removing a provider drops it from the store and leaves the native home alone", () => {
  const { worldHome, claudeHome } = seeded();
  const settingsBefore = readFileSync(join(claudeHome, "settings.json"));
  readProvidersView(worldHome, claudeHome); // imports the native endpoint

  const removed = removeProviderEntry(worldHome, claudeHome, { id: readProviderStore(worldHome).providers[0].id });

  assert.deepEqual(removed.providers, []);
  // Leaving the list is not unconfiguring Claude Code: the native file still
  // names what it named, and the view still reports it as in force.
  assert.deepEqual(readFileSync(join(claudeHome, "settings.json")), settingsBefore);
  assert.equal(removed.native?.baseUrl, "https://api.deepseek.com/anthropic");
  assert.throws(() => removeProviderEntry(worldHome, claudeHome, {}), /id/);
});

test("a removed native provider is not resurrected by the next reconcile", () => {
  const { worldHome, claudeHome } = seeded();
  const first = readProvidersView(worldHome, claudeHome);
  removeProviderEntry(worldHome, claudeHome, { id: first.providers[0].id });
  // The settings env still declares the endpoint; the tombstone is what keeps
  // a delete button meaningful in a panel whose get() reconciles.
  const after = readProvidersView(worldHome, claudeHome);
  assert.deepEqual(after.providers, []);
  assert.equal(after.note, undefined, "a skipped import is not a change worth a note");
});

test("the view reports the paths the panel is going to read and write", () => {
  const { worldHome, claudeHome } = seeded();
  const view = readProvidersView(worldHome, claudeHome);
  assert.deepEqual(view.paths, {
    store: providerStorePath(worldHome),
    settings: join(claudeHome, "settings.json"),
  });
});

// ------------------------------------------------------------------ edit in place

test("saving an existing id edits it in place and keeps its stored key when none is re-typed", () => {
  const { worldHome, claudeHome } = seeded();
  saveProvider(worldHome, claudeHome, SAVE);
  const view = saveProvider(worldHome, claudeHome, {
    provider: { ...SAVE.provider, label: "GLM (renamed)", auth: { kind: "authToken", value: "" } },
  });
  assert.equal(view.providers.filter((p) => p.id === "glm").length, 1);
  assert.equal(view.providers.find((p) => p.id === "glm")?.label, "GLM (renamed)");
  assert.equal(view.providers.find((p) => p.id === "glm")?.hasKey, true, "the key survived the edit");
  assert.equal(readProviderStore(worldHome).providers.find((p) => p.id === "glm").auth.value, "zai-plan-token");
  // the keep is per kind: re-typing the OTHER kind with an empty value keeps
  // nothing — a secret of the other shape is not this provider's key
  const switched = saveProvider(worldHome, claudeHome, {
    provider: { ...SAVE.provider, auth: { kind: "apiKey", value: "" } },
  });
  assert.equal(switched.providers.find((p) => p.id === "glm")?.hasKey, false);
  assert.deepEqual(readProviderStore(worldHome).providers.find((p) => p.id === "glm").auth, { kind: "apiKey", value: "" });
});

test("a panel edit of a folded provider drops its aliases; the next reconcile re-derives them", () => {
  const { worldHome, claudeHome } = seeded();
  const first = readProvidersView(worldHome, claudeHome);
  const id = first.providers[0].id;
  const edited = saveProvider(worldHome, claudeHome, {
    provider: {
      id,
      label: "DeepSeek (renamed)",
      baseUrl: "https://api.deepseek.com/anthropic",
      auth: { kind: "apiKey", value: "" },
      models: [{ id: "deepseek-flash" }],
    },
  });
  const entry = readProviderStore(worldHome).providers.find((p) => p.id === id);
  assert.equal(entry.label, "DeepSeek (renamed)");
  assert.equal(entry.aliases, undefined, "the panel never writes aliases");
  assert.equal(entry.auth.value, "sk-native-secret", "the empty value kept the folded key");
  assert.equal(edited.providers[0].hasKey, true);
  // the reconcile owns aliases: the endpoint is still declared, so they come back
  const resynced = readProvidersView(worldHome, claudeHome);
  const restored = readProviderStore(worldHome).providers.find((p) => p.id === id);
  assert.deepEqual(restored.aliases, { sonnet: "deepseek-flash", opus: "deepseek-v4-pro" });
  assert.equal(restored.label, "DeepSeek (renamed)", "the sync keeps the user's label");
  assert.match(resynced.note ?? "", /refreshed/);
});

// ------------------------------------------------------------------ the shell

test("the gateway class is the delegation shell it claims to be", async () => {
  const { remoteMethods } = await import("@deepseek-ai/dsh-typert-protocol");
  assert.equal(typeof ClaudeProvidersGateway, "function");
  // A minimal stand-in Context carries construction — Service only stores it and
  // calls ctx.reflect.provide — so the shell itself is pinnable with no Cordis
  // runtime and no real home.
  const worldHome = tempHome("shell-world");
  const claudeHome = tempHome("shell-claude");
  let changes = 0;
  const gateway = new ClaudeProvidersGateway(
    { reflect: { provide: () => {} } },
    worldHome,
    () => claudeHome,
    () => { changes += 1; },
  );
  // the wire face: the namespace the hub carrier claims, plus the three
  // @Remote methods recorded on the prototype at first instantiation
  assert.equal(gateway.typertRemote.namespace, "claudeProviders");
  assert.deepEqual(remoteMethods(gateway).map((marker) => marker.method), ["get", "save", "remove"]);
  const view = await gateway.get();
  assert.deepEqual(view.providers, []);
  assert.deepEqual(view.paths, { store: providerStorePath(worldHome), settings: join(claudeHome, "settings.json") });
  assert.ok(!existsSync(providerStorePath(worldHome)), "a read of nothing writes nothing");
  const saved = await gateway.save(SAVE);
  assert.equal(saved.providers.find((p) => p.id === "glm")?.hasKey, true);
  assert.equal(readProviderStore(worldHome).providers[0].id, "glm");
  const removed = await gateway.remove({ id: "glm" });
  assert.deepEqual(removed.providers, []);
  assert.equal(changes, 3, "every operation re-registers the provider's routes");
});
