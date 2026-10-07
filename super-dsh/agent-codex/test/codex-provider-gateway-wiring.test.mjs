// src/codex-provider-gateway.ts (wiring) — the service the Hub panel addresses.
//
// The panel talks to `/hub/api?agent=codex` with `method: 'codexProviders/<op>'`,
// and `superd-hub/src/client/agent-settings.ts` hard-codes that namespace. This
// pins the join between the two halves — the exact thing that silently 404s when
// it drifts — plus the D7 rule that constructing the service reads and writes
// nothing (the panel's first `get` is what touches disk), and the `onChange`
// hook every mutation fires so the provider can re-register its model routes.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { Context } = await import("@deepseek-ai/cordis");
const { CodexProvidersGateway, readProvidersView } = await import("../dist/codex-provider-gateway.js");
const provider = await import("../dist/index.js");

function tempHome(name) {
  return mkdtempSync(join(tmpdir(), `superd-codex-wire-${name}-`));
}

test("the adapter still exports its provider (the bundle entry point)", () => {
  assert.equal(typeof provider.CodexProvider, "function");
  assert.equal(provider.default, provider.CodexProvider);
});

test("the wired service answers on the namespace the hub panel addresses", () => {
  const worldHome = tempHome("world");
  const codexHome = tempHome("codex");
  const ctx = new Context();
  const gateway = new CodexProvidersGateway(ctx, worldHome, () => codexHome);

  // this string is duplicated verbatim in superd-hub/src/client/agent-settings.ts
  assert.equal(gateway.typertRemote.namespace, "codexProviders");
  assert.equal(gateway.name, "codexProviders");
  for (const method of ["get", "save", "remove"]) {
    assert.equal(typeof gateway[method], "function", `${method} must be a Remote method`);
  }
  // The selection Remote was retired: which provider a session runs on is DSH's
  // own per-session `model/selection`, not something this panel writes.
  assert.equal(gateway.select, undefined, "the retired selection Remote must be gone");
});

test("construction is side-effect free, and a read of an unconfigured home writes nothing", async () => {
  const worldHome = tempHome("world-idle");
  const codexHome = tempHome("codex-idle");
  const ctx = new Context();

  const gateway = new CodexProvidersGateway(ctx, worldHome, () => codexHome);
  assert.deepEqual(readdirSync(worldHome), [], "constructing writes nothing to the adapter home");
  assert.deepEqual(readdirSync(codexHome), [], "nor to the runtime's home");

  const view = await gateway.get();
  assert.deepEqual(readdirSync(worldHome), [], "reading an unconfigured runtime imports nothing to store");
  assert.deepEqual(view.providers, []);
  assert.equal(view.native, null);
  // `syncedAt` is the read's own clock, so pin it before comparing: the
  // assertion is about the projected state, not about timing.
  const again = readProvidersView(worldHome, codexHome);
  assert.deepEqual({ ...view, syncedAt: 0 }, { ...again, syncedAt: 0 });
  assert.equal(typeof view.syncedAt, "number", "a read reports when it reconciled");
});

test("the wired methods are the same functions the tests above pin", async () => {
  const worldHome = tempHome("world-live");
  const codexHome = tempHome("codex-live");
  writeFileSync(
    join(codexHome, "config.toml"),
    'model_provider = "deepseek"\nmodel = "deepseek-flash"\n\n[model_providers.deepseek]\nname = "DeepSeek"\nbase_url = "https://api.deepseek.com/v1"\nwire_api = "responses"\nenv_key = "DEEPSEEK_API_KEY"\n',
  );
  const gateway = new CodexProvidersGateway(new Context(), worldHome, () => codexHome);
  const view = await gateway.get();
  assert.deepEqual(view.providers.map((p) => p.id), ["deepseek"]);
  assert.equal(view.native?.providerId, "deepseek");
});

test("the gateway notifies its owner after get, save and remove", async () => {
  const worldHome = tempHome("world-onchange");
  const codexHome = tempHome("codex-onchange");
  const calls = [];
  const gateway = new CodexProvidersGateway(new Context(), worldHome, () => codexHome, () => {
    calls.push("changed");
  });

  assert.equal(calls.length, 0, "constructing a gateway must not fire onChange");

  await gateway.get();
  assert.equal(calls.length, 1, "get re-registers the routes it just reconciled");

  await gateway.save({
    provider: {
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      protocol: "responses",
      auth: { kind: "apiKey", value: "sk-or" },
      models: [],
    },
  });
  assert.equal(calls.length, 2, "save must refresh the model routes");

  await gateway.remove({ id: "openrouter" });
  assert.equal(calls.length, 3, "remove must refresh the model routes");
});
