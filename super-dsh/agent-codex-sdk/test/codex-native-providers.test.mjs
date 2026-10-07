// Reading EVERY provider a native `config.toml` declares (2026-10-04).
//
// This is the sync's source. It is deliberately NOT `readNativeSelection`: the
// user's file can hold several `[model_providers.<id>]` tables while codex runs
// exactly one of them, and the whole point of the canonical store is to know
// about all of them. The catch this suite exists to pin is the model list: a
// codex catalog is per-provider-IN-FORCE, so only the table named by the
// top-level `model_provider` can be given models at all. Every other provider
// must arrive with an EMPTY list rather than a guessed one.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { readNativeProviders, readNativeSelection, writeProviderCatalog, providerCatalogPath } =
  await import("../dist/codex-native-config.js");

/** A codex home with `config.toml` (and optionally a catalog) written. */
function codexHome(configText, catalog) {
  const home = mkdtempSync(join(tmpdir(), "superd-codex-native-providers-"));
  if (configText !== undefined) writeFileSync(join(home, "config.toml"), configText);
  if (catalog !== undefined) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "models.json"), JSON.stringify(catalog));
  }
  return home;
}

const TWO_PROVIDERS = `model_provider = "zhipu-cn"
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

const CATALOG = { models: [{ slug: "glm-5.3-flash" }, { slug: "glm-4.7" }] };

test("every provider table is read, and only the provider IN FORCE gets models", () => {
  const home = codexHome(TWO_PROVIDERS, CATALOG);
  const providers = readNativeProviders(home);
  assert.deepEqual(providers.map((entry) => entry.id), ["deepseek", "zhipu-cn"], "file order is preserved");

  const byId = new Map(providers.map((entry) => [entry.id, entry]));

  // The in-force provider: the catalog's slugs UNION the model config.toml
  // names, because a fixed catalog list can lag a newer `model` key.
  const active = byId.get("zhipu-cn");
  assert.equal(active.active, true);
  assert.deepEqual([...active.models], ["glm-5.3-flash", "glm-4.7"]);
  assert.equal(active.baseUrl, "https://open.bigmodel.cn/api/v1");
  assert.equal(active.protocol, "responses");
  assert.deepEqual(active.auth, { kind: "env", name: "ZHIPU_API_KEY" });
  assert.equal(active.label, "zhipu-cn");

  // Not in force: codex gives us no way to know what it serves, so it must be
  // empty rather than a copy of the other provider's list.
  const dormant = byId.get("deepseek");
  assert.equal(dormant.active, false);
  assert.deepEqual([...dormant.models], []);
  assert.equal(dormant.baseUrl, "https://api.deepseek.com/v1");
  assert.deepEqual(dormant.auth, { kind: "env", name: "DEEPSEEK_API_KEY" });
});

test("the configured model is visible even when the catalog does not list it", () => {
  const home = codexHome(
    `model_provider = "zhipu-cn"
model = "glm-5.4-preview"
model_catalog_json = "models.json"

[model_providers.zhipu-cn]
base_url = "https://open.bigmodel.cn/api/v1"
wire_api = "responses"
env_key = "ZHIPU_API_KEY"
`,
    CATALOG,
  );
  // cc-switch ships a fixed catalog list; config.toml may name something newer,
  // and it is the model actually running, so it has to be selectable.
  assert.deepEqual([...readNativeProviders(home)[0].models], ["glm-5.4-preview", "glm-5.3-flash", "glm-4.7"]);
});

test("a missing catalog still yields the configured model, and a missing file yields nothing", () => {
  const home = codexHome(`model_provider = "solo"
model = "solo-1"
model_catalog_json = "does-not-exist.json"

[model_providers.solo]
base_url = "https://solo.invalid/v1"
wire_api = "responses"
env_key = "SOLO_KEY"
`);
  assert.deepEqual([...readNativeProviders(home)[0].models], ["solo-1"]);
  assert.deepEqual(readNativeProviders(mkdtempSync(join(tmpdir(), "superd-codex-empty-"))), []);
});

test("requires_openai_auth reads as the SEEDED apiKey shape, not as a missing key", () => {
  const home = codexHome(`[model_providers.cc]
name = "cc-switch style"
base_url = "https://api.example.com/v1"
wire_api = "responses"
requires_openai_auth = true
`);
  const [provider] = readNativeProviders(home);
  // An empty value is the real state "the runtime's own auth.json holds this
  // one" — the same shape the store uses, so no conversion is needed.
  assert.deepEqual(provider.auth, { kind: "apiKey", value: "" });
});

test("wire_api defaults to responses when absent and is reported verbatim when it is chat", () => {
  const home = codexHome(`[model_providers.a]
base_url = "https://a.invalid/v1"
env_key = "A"

[model_providers.b]
base_url = "https://b.invalid/v1"
wire_api = "chat"
env_key = "B"
`);
  const byId = new Map(readNativeProviders(home).map((entry) => [entry.id, entry]));
  assert.equal(byId.get("a").protocol, "responses");
  // Reading must be faithful: the panel is where `chat` is refused, not the reader.
  assert.equal(byId.get("b").protocol, "chat");
});

test("a nested sub-table does not clobber its provider's own keys", () => {
  const home = codexHome(`[model_providers.deep]
base_url = "https://deep.invalid/v1"
wire_api = "responses"
env_key = "DEEP"

[model_providers.deep.something]
base_url = "https://nested.invalid/v1"
`);
  const [provider] = readNativeProviders(home);
  assert.equal(provider.baseUrl, "https://deep.invalid/v1");
  assert.equal(provider.auth.name, "DEEP");
});

test("a table with no base_url is skipped, and the bare model_providers header is not a provider", () => {
  const home = codexHome(`[model_providers]

[model_providers.nothing]
name = "nothing"
`);
  // There is nothing to dedupe a provider by without an endpoint, so it cannot
  // enter a list whose identity IS the endpoint.
  assert.deepEqual(readNativeProviders(home), []);
});

test("the in-force read and the whole-list read agree about the active provider", () => {
  const home = codexHome(TWO_PROVIDERS, CATALOG);
  const selection = readNativeSelection(home);
  const active = readNativeProviders(home).find((entry) => entry.active);
  assert.equal(selection.providerId, active.id);
  assert.equal(selection.model, "glm-5.3-flash");
  assert.equal(selection.baseUrl, active.baseUrl);
});

test("the per-provider catalog lives in the world home and holds exactly that provider's models", () => {
  const home = codexHome(TWO_PROVIDERS, CATALOG);
  const worldHome = mkdtempSync(join(tmpdir(), "superd-codex-world-"));
  const entry = readNativeProviders(home).find((candidate) => candidate.active);
  const path = writeProviderCatalog(worldHome, home, {
    id: entry.id,
    label: entry.label,
    baseUrl: entry.baseUrl,
    protocol: entry.protocol,
    auth: entry.auth,
    models: entry.models.map((id) => ({ id })),
  });
  assert.equal(path, providerCatalogPath(worldHome, "zhipu-cn"));
  // Written into OUR tree: `~/.codex` is read-only for this adapter now.
  assert.ok(path.startsWith(worldHome));
  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(written.models.map((model) => model.slug), ["glm-5.3-flash", "glm-4.7"]);
  // Idempotent: a second materialization of the same list does not churn.
  assert.equal(writeProviderCatalog(worldHome, home, {
    id: entry.id,
    label: entry.label,
    baseUrl: entry.baseUrl,
    protocol: entry.protocol,
    auth: entry.auth,
    models: entry.models.map((id) => ({ id })),
  }), path);
});
