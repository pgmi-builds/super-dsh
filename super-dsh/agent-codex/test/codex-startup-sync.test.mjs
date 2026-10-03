// What the adapter does the moment it loads (2026-10-04).
//
// The store is canonical and the user's `config.toml` is a source, so adapter
// STARTUP is a reconcile: read every `[model_providers.<id>]` table, fold it in
// by endpoint, and register one `ctx.llm` route per provider that has models.
// The gateway's `get` performs the same reconcile on demand, which is why this
// entry point can pass unnoticed while the panel still looks right — so it is
// pinned here against a world home that has no store at all.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";

const { CodexProvider } = await import("../dist/index.js");
const { readProviderStore, providerStorePath, writeProviderStore } = await import("../dist/codex-providers.js");

const CATALOG = { models: [{ slug: "glm-5.3-flash" }, { slug: "glm-4.7" }] };

const NATIVE_CONFIG = `model_provider = "zhipu-cn"
model = "glm-5.3-flash"
model_catalog_json = "models.json"

[projects."/home/u1/workspaces/base"]
trust_level = "trusted"

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
env_key = "DEEPSEEK_API_KEY"

[model_providers.zhipu-cn]
name = "zhipu-cn"
base_url = "https://open.bigmodel.cn/api/v1"
wire_api = "responses"
env_key = "ZHIPU_API_KEY"
`;

/** A native codex home, and a world home with (optionally) a pre-existing store. */
function homes(store) {
  const codexHome = mkdtempSync(join(tmpdir(), "superd-codex-startup-native-"));
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "models.json"), JSON.stringify(CATALOG));
  writeFileSync(join(codexHome, "config.toml"), NATIVE_CONFIG);

  const worldHome = mkdtempSync(join(tmpdir(), "superd-codex-startup-world-"));
  if (store !== undefined) writeProviderStore(worldHome, store);

  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  return {
    codexHome,
    worldHome,
    restore() {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    },
  };
}

/** A stub context that records `ctx.llm` route registrations. */
function recordingContext(worldHome) {
  const registrations = [];
  const ctx = new Context();
  ctx.provide("dshHomePath", worldHome);
  ctx.provide("agents", { setFactory() { } });
  ctx.provide("llm", {
    registerAdapter(providers, adapter) {
      const handle = () => { };
      handle.replace = (next) => registrations.push({ op: "replace", providers: next });
      registrations.push({ op: "register", providers, adapter });
      return handle;
    },
  });
  return { ctx, registrations };
}

/**
 * The route set the adapter ended up holding.
 *
 * Boot is two-phase on purpose: the store's own routes register first (so a
 * malformed config.toml cannot cost the world its provider list) and the
 * reconcile then re-points them with `replace`. What matters is where it lands.
 *
 * @param registrations - every `register`/`replace` the stub llm saw.
 * @returns the providers of the last one.
 */
function finalRoutes(registrations) {
  assert.ok(registrations.length > 0, "the adapter registered no routes at all");
  return registrations[registrations.length - 1].providers;
}

test("a first load folds every native provider into an empty store, deduped by endpoint", () => {
  const f = homes(undefined);
  try {
    assert.equal(existsSync(providerStorePath(f.worldHome)), false, "nothing is written before the provider loads");
    const { ctx } = recordingContext(f.worldHome);
    new CodexProvider(ctx);

    const store = readProviderStore(f.worldHome);
    assert.deepEqual(store.providers.map((provider) => provider.id), ["deepseek", "zhipu-cn"]);
    for (const provider of store.providers) {
      // A hand-written codex config supplies no name, so the endpoint URL is it.
      assert.equal(provider.label, provider.baseUrl);
      assert.equal(provider.origin, "native");
    }
    // Only the provider IN FORCE has a discoverable catalog; the other must stay
    // empty rather than inherit the in-force provider's models.
    const zhipu = store.providers.find((provider) => provider.id === "zhipu-cn");
    const deepseek = store.providers.find((provider) => provider.id === "deepseek");
    assert.deepEqual(zhipu.models.map((model) => model.id), ["glm-5.3-flash", "glm-4.7"]);
    assert.deepEqual(deepseek.models, []);
  } finally {
    f.restore();
  }
});

test("a provider with no models registers no route, so the selector never shows an empty group", () => {
  const f = homes(undefined);
  try {
    const { ctx, registrations } = recordingContext(f.worldHome);
    new CodexProvider(ctx);
    assert.deepEqual(finalRoutes(registrations), ["zhipu-cn"]);
  } finally {
    f.restore();
  }
});

test("startup reconciles an existing store instead of replacing it", () => {
  // The panel's own list must survive a boot: the sync ADDS and REFRESHES, it
  // never rewrites the list wholesale.
  const f = homes({
    version: 1,
    providers: [{
      id: "hand-added",
      label: "my proxy",
      baseUrl: "https://proxy.invalid/v1",
      protocol: "responses",
      auth: { kind: "apiKey", value: "sk-kept" },
      models: [{ id: "m-1" }],
    }],
  });
  try {
    const { ctx, registrations } = recordingContext(f.worldHome);
    new CodexProvider(ctx);

    const store = readProviderStore(f.worldHome);
    assert.deepEqual(store.providers.map((provider) => provider.id), ["hand-added", "deepseek", "zhipu-cn"]);
    // The user's secret is not dropped by a reconcile that has no opinion on it.
    assert.deepEqual(store.providers[0].auth, { kind: "apiKey", value: "sk-kept" });
    // Two phases (the store's routes first, then the reconcile's `replace`),
    // and the second phase adds the newly imported provider to the same set.
    assert.deepEqual(finalRoutes(registrations), ["hand-added", "zhipu-cn"]);
  } finally {
    f.restore();
  }
});

test("a second load of an unchanged config writes nothing and re-points the same routes", () => {
  const f = homes(undefined);
  try {
    const first = recordingContext(f.worldHome);
    new CodexProvider(first.ctx);
    const stamp = statSync(providerStorePath(f.worldHome)).mtimeNs;

    const second = recordingContext(f.worldHome);
    new CodexProvider(second.ctx);

    // The 10-minute timer calls exactly this path, so "no change ⇒ no write" is
    // what keeps a 0600 file holding API keys from churning on every tick.
    assert.equal(statSync(providerStorePath(f.worldHome)).mtimeNs, stamp, "an unchanged reconcile must not rewrite the store");
    assert.deepEqual(finalRoutes(second.registrations), ["zhipu-cn"]);
  } finally {
    f.restore();
  }
});
