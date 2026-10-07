// On-the-fly provider injection for the SDK transport (2026-10-04).
//
// The app-server line hands a provider to a child as `--config` argv. This
// transport has no argv: it hands the same data to `new Codex({ config })`, and
// the SDK flattens that object into identical dotted `--config` pairs ("flatten
// it into dotted paths and serialize values as TOML literals so they are
// compatible with the CLI's `--config` parsing"). This suite pins the object
// shape, and every clause in it was measured against the real 0.154 binary
// first:
//
//   - a HYPHENATED id is legal in a dotted path (probed: `zhipu-cn`);
//   - `model_catalog_json` is resolved against the process CWD when it arrives
//     as an override, so the injected path must be ABSOLUTE (a relative one
//     failed `ENOENT`);
//   - `env_key` is the one auth shape that never consults the auth manager, so a
//     stored key rides the CHILD's environment under a synthetic name — which is
//     also what makes a keyed provider usable behind a ChatGPT login, where
//     `requires_openai_auth` is silently shadowed.
//
// `env` is the SDK's REPLACE-semantics map, so it holds additions only; the
// caller composes `{ ...process.env, ...launch.env }` before constructing Codex.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";

const { providerSdkLaunch, syntheticKeyName, NATIVE_SDK_LAUNCH } = await import("../dist/codex-sdk-launch.js");
const { providerCatalogPath } = await import("../dist/codex-native-config.js");

function homes() {
  return {
    worldHome: mkdtempSync(join(tmpdir(), "superd-codex-sdk-world-")),
    codexHome: mkdtempSync(join(tmpdir(), "superd-codex-sdk-native-")),
  };
}

/** The `[model_providers.<id>]` table inside an emitted config, or undefined. */
function providerTable(config, id) {
  return config.model_providers?.[id];
}

const ENV_PROVIDER = {
  id: "zhipu-cn",
  label: "https://open.bigmodel.cn/api/v1",
  baseUrl: "https://open.bigmodel.cn/api/v1",
  protocol: "responses",
  auth: { kind: "env", name: "ZHIPU_API_KEY" },
  models: [{ id: "glm-5.3-flash" }, { id: "glm-4.7" }],
};

test("an env-shaped provider is pinned by env_key and adds nothing to the child's environment", () => {
  const { worldHome, codexHome } = homes();
  const launch = providerSdkLaunch(worldHome, codexHome, ENV_PROVIDER);
  // The hyphen is deliberate: this is the id shape that had to be probed.
  assert.deepEqual(providerTable(launch.config, "zhipu-cn"), {
    name: "https://open.bigmodel.cn/api/v1",
    base_url: "https://open.bigmodel.cn/api/v1",
    wire_api: "responses",
    env_key: "ZHIPU_API_KEY",
  });
  assert.equal(launch.config.model_provider, "zhipu-cn");
  assert.equal(launch.providerId, "zhipu-cn");
  // The user's own environment already holds the key: we must not invent one.
  assert.deepEqual(launch.env, {});
  assert.equal(providerTable(launch.config, "zhipu-cn").requires_openai_auth, undefined);
});

test("a stored key is handed to the child under a synthetic env_key, never through auth.json", () => {
  const { worldHome, codexHome } = homes();
  const launch = providerSdkLaunch(worldHome, codexHome, {
    ...ENV_PROVIDER,
    id: "my-proxy",
    auth: { kind: "apiKey", value: "sk-secret" },
  });
  const name = syntheticKeyName("my-proxy");
  assert.equal(name, "SUPERD_CODEX_KEY_MY_PROXY");
  assert.equal(providerTable(launch.config, "my-proxy").env_key, name);
  assert.deepEqual(launch.env, { [name]: "sk-secret" });
  // requires_openai_auth would route the call through the auth manager, which is
  // exactly the path a ChatGPT login shadows.
  assert.equal(providerTable(launch.config, "my-proxy").requires_openai_auth, undefined);
});

test("an apiKey entry with an empty value defers to the runtime's own auth.json", () => {
  const { worldHome, codexHome } = homes();
  const launch = providerSdkLaunch(worldHome, codexHome, {
    ...ENV_PROVIDER,
    id: "seeded",
    auth: { kind: "apiKey", value: "" },
  });
  // The seeded shape: Super D holds no copy, so the only honest statement is
  // "this provider authenticates like the runtime does".
  assert.equal(providerTable(launch.config, "seeded").requires_openai_auth, true);
  assert.equal(providerTable(launch.config, "seeded").env_key, undefined);
  assert.deepEqual(launch.env, {});
});

test("the model catalog is written to the WORLD home and injected as an absolute path", () => {
  const { worldHome, codexHome } = homes();
  const launch = providerSdkLaunch(worldHome, codexHome, ENV_PROVIDER);
  const injected = launch.config.model_catalog_json;
  assert.equal(typeof injected, "string", "a provider with models must inject a catalog");
  assert.ok(isAbsolute(injected), `the override must be absolute (codex resolves it against cwd): ${injected}`);
  assert.equal(injected, providerCatalogPath(worldHome, "zhipu-cn"));
  // It lives in OUR tree; nothing is written into the native home.
  assert.ok(existsSync(injected));
  assert.equal(existsSync(join(codexHome, "superd-model-catalog.json")), false);
  const catalog = JSON.parse(readFileSync(injected, "utf8"));
  assert.deepEqual(catalog.models.map((entry) => entry.slug), ["glm-5.3-flash", "glm-4.7"]);
});

test("a provider with no models injects no catalog and claims no models", () => {
  const { worldHome, codexHome } = homes();
  // The state a provider imported from a config.toml that is not the one in
  // force arrives in: codex's catalog is per-provider-in-force, so its model list
  // is genuinely unknown. Registering a route for it would be an invention.
  const launch = providerSdkLaunch(worldHome, codexHome, { ...ENV_PROVIDER, id: "empty-one", models: [] });
  assert.equal(launch.config.model_catalog_json, undefined);
  assert.equal(existsSync(providerCatalogPath(worldHome, "empty-one")), false);
  // The provider itself is still fully pinned — only the model list is unknown.
  assert.equal(launch.config.model_provider, "empty-one");
});

test("the no-injection launch is empty, which is the legacy route's honest fallback", () => {
  assert.deepEqual(NATIVE_SDK_LAUNCH, { config: {}, env: {}, providerId: "" });
});
